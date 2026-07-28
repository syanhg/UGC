import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fromRoot } from './paths.ts';

const API = 'https://generativelanguage.googleapis.com/v1beta/files';

/**
 * Veo writes finished clips to the Gemini Files API and keeps them for 48
 * hours. That window is a safety net: if a download fails after the clip has
 * been rendered and billed, the work is still there to be collected.
 */
export interface RemoteFile {
  name: string;
  displayName?: string;
  mimeType: string;
  createTime: string;
  expirationTime: string;
  state: string;
  source?: string;
}

/**
 * Google's file download endpoint returns intermittent 503s that have lasted
 * minutes, not seconds. By the time this runs the clip is rendered and billed,
 * so waiting is strictly cheaper than failing — hence a window measured in
 * minutes. Backs off 2s, 4s, 8s, 16s, then 30s a try, ~2.5 minutes total.
 */
export async function fetchWithRetry(
  url: string,
  { attempts = 8, signal }: { attempts?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return res;
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (attempt < attempts) {
        await new Promise((r) =>
          setTimeout(r, Math.min(2_000 * 2 ** (attempt - 1), 30_000)),
        );
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function apiKey(): string {
  const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!key) {
    throw new Error(
      'GOOGLE_GENERATIVE_AI_API_KEY is not set.\n' +
        'Get one at https://aistudio.google.com/apikey',
    );
  }
  return key;
}

export async function listGeneratedClips(): Promise<RemoteFile[]> {
  const res = await fetch(`${API}?key=${apiKey()}&pageSize=100`);
  if (!res.ok) {
    throw new Error(`Listing files failed: ${res.status} ${res.statusText}`);
  }

  const { files = [] } = (await res.json()) as { files?: RemoteFile[] };

  return files
    .filter((f) => f.state === 'ACTIVE' && f.mimeType?.startsWith('video/'))
    .sort((a, b) => a.createTime.localeCompare(b.createTime));
}

export function fileId(file: RemoteFile): string {
  return file.name.replace(/^files\//, '');
}

/**
 * Google's displayName is a sentence, not a filename — "Veo-3.1-fast-generate-
 * preview generated clip, operation name: ...". Keep only the model.
 */
export function localNameFor(file: RemoteFile): string {
  const stamp = file.createTime.replace(/[:.]/g, '-').slice(0, 19);
  const model = /^([\w.-]+?)\s+generated clip/i.exec(file.displayName ?? '')?.[1];
  return `${stamp}_${(model ?? 'veo').toLowerCase()}_${fileId(file)}.mp4`;
}

/**
 * Which clips have already been pulled, keyed by Google's file id. Tracked in a
 * manifest rather than inferred from filenames, so renaming or moving a clip
 * after pulling it does not cause the next pull to fetch it again.
 */
const MANIFEST = '.ugc-pulled.json';

async function loadManifest(): Promise<Record<string, string>> {
  const path = fromRoot(MANIFEST);
  if (!existsSync(path)) return {};

  try {
    return JSON.parse(await readFile(path, 'utf8')) as Record<string, string>;
  } catch {
    // A corrupt manifest should cost a duplicate download, not a crash.
    return {};
  }
}

export async function markPulled(file: RemoteFile, path: string): Promise<void> {
  const manifest = await loadManifest();
  manifest[fileId(file)] = path;
  await writeFile(fromRoot(MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function alreadyPulled(file: RemoteFile): Promise<boolean> {
  return fileId(file) in (await loadManifest());
}

export async function downloadClip(
  file: RemoteFile,
  outDir: string,
): Promise<{ path: string; skipped: boolean }> {
  await mkdir(fromRoot(outDir), { recursive: true });
  const path = fromRoot(outDir, localNameFor(file));

  if (existsSync(path) || (await alreadyPulled(file))) {
    return { path, skipped: true };
  }

  const res = await fetchWithRetry(
    `${API}/${fileId(file)}:download?alt=media&key=${apiKey()}`,
  );

  await writeFile(path, new Uint8Array(await res.arrayBuffer()));
  await markPulled(file, path);
  return { path, skipped: false };
}
