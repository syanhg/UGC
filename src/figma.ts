import { MEDIA_TYPES } from './config.ts';

const API = 'https://api.figma.com/v1';

function token(): string {
  const value = process.env.FIGMA_TOKEN;
  if (!value) {
    throw new Error(
      'FIGMA_TOKEN is not set.\n' +
        'Create one at https://figma.com → Settings → Security → Personal access tokens,\n' +
        'then add it to .env:  FIGMA_TOKEN=figd_...',
    );
  }
  return value;
}

async function api<T>(path: string, attempts = 4): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: { 'X-Figma-Token': token() },
    });

    if (res.ok) return (await res.json()) as T;

    // Figma rate-limits per token and tells you how long to wait. Honour it
    // rather than failing a sync that would succeed a moment later.
    if (res.status === 429 && attempt < attempts) {
      const retryAfter = Number(res.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 60_000)
        : Math.min(5_000 * 2 ** (attempt - 1), 60_000);

      console.log(
        `  Figma rate limit — waiting ${Math.round(waitMs / 1000)}s (${attempt}/${attempts - 1})`,
      );
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const detail = await res.text().catch(() => '');
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `Figma returned ${res.status} for ${path}.\n` +
          `Either the token lacks access to this file, or the file key is wrong.\n` +
          `${detail.slice(0, 200)}`,
      );
    }
    if (res.status === 429) {
      throw new Error(
        `Figma rate limit still in effect after ${attempts - 1} retries. ` +
          `Wait a few minutes and run "ugc avatar sync" again — ` +
          `your local avatars are unaffected.`,
      );
    }
    throw new Error(`Figma request failed: ${res.status} ${res.statusText}`);
  }
}

/** Accepts a bare file key or any Figma file URL. */
export function parseFileKey(input: string): string {
  const match = /figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/.exec(input);
  return match ? match[1] : input;
}

interface Node {
  id: string;
  name: string;
  type: string;
  fills?: { type: string; imageRef?: string }[];
  children?: Node[];
}

interface FileResponse {
  name: string;
  lastModified: string;
  document: Node;
}

export interface FigmaPhoto {
  imageRef: string;
  /** The layer name in Figma, so the CLI can refer to photos as you named them. */
  label: string;
}

export interface FigmaAvatar {
  /** The section name, which becomes the avatar name. */
  name: string;
  nodeId: string;
  photos: FigmaPhoto[];
}

function photosIn(node: Node): FigmaPhoto[] {
  const here = (node.fills ?? [])
    .filter((f) => f.type === 'IMAGE' && f.imageRef)
    .map((f) => ({ imageRef: f.imageRef as string, label: node.name }));

  return [...here, ...(node.children ?? []).flatMap(photosIn)];
}

export interface ReadFileResult {
  fileName: string;
  pageName: string;
  avatars: FigmaAvatar[];
}

/**
 * One top-level layer on the page becomes one avatar, named after the layer.
 * Every image inside that layer's subtree becomes one of its reference photos,
 * so a single rectangle gives one photo and a frame of several gives several.
 */
export async function readAvatars(
  fileKey: string,
  pageName?: string,
): Promise<ReadFileResult> {
  // depth is bounded because avatar layers are shallow; it keeps the response
  // small on files that also hold unrelated design work.
  const file = await api<FileResponse>(`/files/${fileKey}?depth=4`);

  const pages = file.document.children ?? [];
  const page = pageName
    ? pages.find((p) => p.name === pageName)
    : pages[0];

  if (!page) {
    throw new Error(
      `No page named "${pageName}" in ${file.name}. ` +
        `Pages: ${pages.map((p) => p.name).join(', ')}`,
    );
  }

  const avatars = (page.children ?? [])
    .map((node) => ({
      name: node.name,
      nodeId: node.id,
      photos: photosIn(node),
    }))
    .filter((a) => a.photos.length > 0);

  return { fileName: file.name, pageName: page.name, avatars };
}

/**
 * Maps every image hash in the file to a temporary download URL. The map
 * includes images from deleted layers too, so always drive from node refs
 * rather than iterating this.
 */
export async function imageUrls(
  fileKey: string,
): Promise<Record<string, string>> {
  const { meta } = await api<{ meta: { images: Record<string, string> } }>(
    `/files/${fileKey}/images`,
  );
  return meta.images ?? {};
}

const EXTENSIONS: Record<string, string> = Object.fromEntries(
  Object.entries(MEDIA_TYPES).map(([ext, mime]) => [mime, ext]),
);

/**
 * Downloads an original uploaded image. These are the source files rather than
 * re-exports, which matters: a rescaled or recompressed reference photo is a
 * worse identity anchor than the original.
 */
export async function downloadImage(
  url: string,
): Promise<{ data: Uint8Array; ext: string }> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Image download failed: ${res.status} ${res.statusText}`);
  }

  const mime = (res.headers.get('content-type') ?? '').split(';')[0].trim();
  const ext = EXTENSIONS[mime];
  if (!ext) {
    throw new Error(
      `Unsupported image type "${mime || 'unknown'}" — Veo takes jpg, png, or webp`,
    );
  }

  return { data: new Uint8Array(await res.arrayBuffer()), ext };
}
