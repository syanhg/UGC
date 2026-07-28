import { experimental_generateVideo as generateVideo, NoVideoGeneratedError } from 'ai';
import { google } from '@ai-sdk/google';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, basename } from 'node:path';
import { fromRoot } from './paths.ts';
import { MEDIA_TYPES, type Config } from './config.ts';
import { fetchWithRetry } from './files.ts';

/**
 * Reference images become data URLs so the same local face file can be reused
 * across every clip without uploading it somewhere first.
 */
async function loadRef(path: string): Promise<string> {
  if (/^https?:\/\//.test(path)) return path;

  // Avatar refs are stored project-relative; --ref is made absolute by the CLI.
  const abs = fromRoot(path);
  if (!existsSync(abs)) {
    throw new Error(
      `Reference image not found: ${path}\n` +
        `Register an avatar instead:  ugc avatar add <name> <photo.jpg>\n` +
        `Or point "refs" in ugc.config.json at a photo that exists.`,
    );
  }

  const ext = extname(abs).toLowerCase();
  const mediaType = MEDIA_TYPES[ext];
  if (!mediaType) {
    throw new Error(`Unsupported reference image type "${ext}" (use jpg, png, or webp)`);
  }

  return `data:${mediaType};base64,${(await readFile(abs)).toString('base64')}`;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'clip';
}

/**
 * Veo uploads the finished clip to the Files API and hands back a URL for the
 * SDK to fetch. That fetch 503s often enough to matter, and by then the clip is
 * already rendered and billed — so retry rather than lose it. Files stay
 * retrievable for 48 hours, so a total failure here is recoverable by hand.
 */
async function downloadWithRetry({
  url,
  abortSignal,
}: {
  url: URL;
  abortSignal?: AbortSignal;
}): Promise<{ data: Uint8Array; mediaType: string | undefined }> {
  try {
    const res = await fetchWithRetry(url.toString(), { signal: abortSignal });
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mediaType: res.headers.get('content-type') ?? undefined,
    };
  } catch (err) {
    throw new Error(
      `The clip rendered but could not be downloaded: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `It stays on Google's Files API for 48 hours — recover it with "ugc pull".`,
    );
  }
}

export interface GenerateOptions {
  prompt: string;
  config: Config;
  seed?: number;
  label?: string;
}

export interface GenerateResult {
  file: string;
  warnings: string[];
}

export async function generateClip({
  prompt,
  config,
  seed,
  label,
}: GenerateOptions): Promise<GenerateResult> {
  const fullPrompt = config.stylePrompt
    ? `${prompt}\n\n${config.stylePrompt}`
    : prompt;

  // t2v ignores references entirely, so don't touch the filesystem for them —
  // a stale "refs" entry in the config shouldn't fail a text-only clip.
  const refs =
    config.mode === 't2v'
      ? []
      : await Promise.all(config.refs.map(loadRef));

  if (config.mode !== 't2v' && refs.length === 0) {
    throw new Error(
      `Mode "${config.mode}" needs at least one reference image. ` +
        `Add one to "refs" in ugc.config.json, or set mode to "t2v".`,
    );
  }

  // i2v pins the face as the opening frame; r2v passes refs as identity
  // references so the model can move the subject freely and still match.
  const referenceArgs =
    config.mode === 'i2v'
      ? { prompt: { image: refs[0], text: fullPrompt } }
      : config.mode === 'r2v'
        ? { prompt: fullPrompt, inputReferences: refs }
        : { prompt: fullPrompt };

  const { video, warnings } = await generateVideo({
    model: google.video(config.model),
    ...referenceArgs,
    duration: config.duration,
    aspectRatio: config.aspectRatio,
    ...(config.resolution ? { resolution: config.resolution } : {}),
    generateAudio: config.generateAudio,
    ...(seed !== undefined ? { seed } : {}),
    abortSignal: AbortSignal.timeout(10 * 60_000),
    download: downloadWithRetry,
    providerOptions: {
      google: {
        // Video jobs are queued server-side; give them room to finish.
        pollTimeoutMs: 10 * 60_000,
        // Veo refuses to render people unless this is set. "allow_adult" is
        // the setting a UGC avatar needs; the wider "allow_all" also permits
        // minors, which nothing here should ever be doing.
        personGeneration: config.personGeneration,
      },
    },
  });

  await mkdir(fromRoot(config.outDir), { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}_${slugify(label ?? prompt)}.mp4`;
  const file = fromRoot(config.outDir, name);

  await writeFile(file, video.uint8Array);

  return {
    file,
    warnings: warnings.map((w) =>
      'message' in w && w.message
        ? String(w.message)
        : `${w.type}: ${'setting' in w ? String(w.setting) : 'unsupported'}`,
    ),
  };
}

/**
 * The Files API takes its key as a query parameter, so a failed download quotes
 * the key back inside the error message — and from there into logs and scroll
 * buffers. Strip it before anything is printed.
 */
function redact(message: string): string {
  return message.replace(/([?&]key=)[^&\s]+/g, '$1<redacted>');
}

export function explainError(err: unknown): string {
  if (NoVideoGeneratedError.isInstance(err)) {
    return (
      `The model accepted the request but returned no video.\n` +
      `Cause: ${err.cause ?? 'unknown'}\n` +
      `This is usually a safety filter — try softening the prompt or using a different reference photo.`
    );
  }

  const message = redact(err instanceof Error ? err.message : String(err));

  if (/api key|unauthor|401|403/i.test(message)) {
    return (
      `Auth failed: ${message}\n\n` +
      `Set your Gemini API key:\n  export GOOGLE_GENERATIVE_AI_API_KEY="..."\n` +
      `Get one at https://aistudio.google.com/apikey`
    );
  }

  if (/billing|quota|429|resource_exhausted|free tier/i.test(message)) {
    return (
      `${message}\n\n` +
      `Veo is not on the Gemini free tier. Enable billing on the Google Cloud ` +
      `project behind your key, or try a cheaper model:\n` +
      `  --model veo-3.1-fast-generate-preview`
    );
  }

  if (/timeout|aborted/i.test(message)) {
    return `Generation timed out after 10 minutes: ${message}\nThe job may still be running provider-side. Try a shorter duration or the "-fast" variant of your model.`;
  }

  return message;
}

export { basename };
