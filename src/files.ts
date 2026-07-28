import { writeFile, mkdir } from 'node:fs/promises';
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
 * Google's file download endpoint returns intermittent 503s. By the time it is
 * called the clip is already rendered and billed, so retrying is much cheaper
 * than regenerating. Backs off 2s, 4s, 8s, 16s.
 */
export async function fetchWithRetry(
  url: string,
  { attempts = 5, signal }: { attempts?: number; signal?: AbortSignal } = {},
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
        await new Promise((r) => setTimeout(r, 2_000 * 2 ** (attempt - 1)));
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

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 48) || 'clip'
  );
}

/** A stable local name, so pulling the same clip twice does not duplicate it. */
export function localNameFor(file: RemoteFile): string {
  const stamp = file.createTime.replace(/[:.]/g, '-').slice(0, 19);
  const id = file.name.replace(/^files\//, '');
  return `${stamp}_${slugify(file.displayName ?? id)}_${id}.mp4`;
}

export async function downloadClip(
  file: RemoteFile,
  outDir: string,
): Promise<{ path: string; skipped: boolean }> {
  await mkdir(fromRoot(outDir), { recursive: true });
  const path = fromRoot(outDir, localNameFor(file));

  if (existsSync(path)) return { path, skipped: true };

  const id = file.name.replace(/^files\//, '');
  const res = await fetchWithRetry(`${API}/${id}:download?alt=media&key=${apiKey()}`);

  await writeFile(path, new Uint8Array(await res.arrayBuffer()));
  return { path, skipped: false };
}
