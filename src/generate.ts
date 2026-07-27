import { experimental_generateVideo as generateVideo, NoVideoGeneratedError } from 'ai';
import { gateway } from '@ai-sdk/gateway';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';
import type { Config } from './config.ts';

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Reference images become data URLs so the same local face file can be reused
 * across every clip without uploading it somewhere first.
 */
async function loadRef(path: string): Promise<string> {
  if (/^https?:\/\//.test(path)) return path;

  const abs = resolve(process.cwd(), path);
  if (!existsSync(abs)) {
    throw new Error(
      `Reference image not found: ${path}\n` +
        `Drop a photo of your face at that path, or point "refs" in ugc.config.json somewhere else.`,
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
    model: gateway.video(config.model),
    ...referenceArgs,
    duration: config.duration,
    aspectRatio: config.aspectRatio,
    ...(config.resolution ? { resolution: config.resolution } : {}),
    generateAudio: config.generateAudio,
    ...(seed !== undefined ? { seed } : {}),
    abortSignal: AbortSignal.timeout(10 * 60_000),
    providerOptions: {
      // Video jobs are queued server-side; give them room to finish.
      gateway: { pollTimeoutMs: 10 * 60_000 },
    },
  });

  await mkdir(resolve(process.cwd(), config.outDir), { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const name = `${stamp}_${slugify(label ?? prompt)}.mp4`;
  const file = resolve(process.cwd(), config.outDir, name);

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

export function explainError(err: unknown): string {
  if (NoVideoGeneratedError.isInstance(err)) {
    return (
      `The model accepted the request but returned no video.\n` +
      `Cause: ${err.cause ?? 'unknown'}\n` +
      `This is usually a safety filter — try softening the prompt or using a different reference photo.`
    );
  }

  const message = err instanceof Error ? err.message : String(err);

  if (/api key|unauthor|401|403/i.test(message)) {
    return (
      `Auth failed: ${message}\n\n` +
      `Set your gateway key:\n  export AI_GATEWAY_API_KEY="..."\n` +
      `Get one at https://vercel.com/dashboard → AI Gateway → API Keys`
    );
  }

  if (/timeout|aborted/i.test(message)) {
    return `Generation timed out after 10 minutes: ${message}\nThe job may still be running provider-side. Try a shorter duration or the "-fast" variant of your model.`;
  }

  return message;
}

export { basename };
