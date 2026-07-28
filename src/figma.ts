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

async function api<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'X-Figma-Token': token() },
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 403 || res.status === 404) {
      throw new Error(
        `Figma returned ${res.status} for ${path}.\n` +
          `Either the token lacks access to this file, or the file key is wrong.\n` +
          `${detail.slice(0, 200)}`,
      );
    }
    throw new Error(`Figma request failed: ${res.status} ${res.statusText}`);
  }

  return (await res.json()) as T;
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

export interface FigmaAvatar {
  /** The layer name, which becomes the avatar name. */
  name: string;
  nodeId: string;
  imageRefs: string[];
}

function imageRefsIn(node: Node): string[] {
  const here = (node.fills ?? [])
    .filter((f) => f.type === 'IMAGE' && f.imageRef)
    .map((f) => f.imageRef as string);

  return [...here, ...(node.children ?? []).flatMap(imageRefsIn)];
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
      imageRefs: imageRefsIn(node),
    }))
    .filter((a) => a.imageRefs.length > 0);

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
