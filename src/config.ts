import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type Mode = 'i2v' | 'r2v' | 't2v';
export type AspectRatio = `${number}:${number}`;
export type Resolution = `${number}x${number}`;

/** The image formats a reference photo may use, shared by the registry and the generator. */
export const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/**
 * Veo will not render recognisable people unless this is widened from its
 * default. "allow_all" additionally permits minors — avatars here are adults.
 */
export type PersonGeneration = 'dont_allow' | 'allow_adult' | 'allow_all';

export interface Config {
  model: string;
  mode: Mode;
  refs: string[];
  duration: number;
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  generateAudio: boolean;
  personGeneration: PersonGeneration;
  outDir: string;
  stylePrompt: string;
}

export function parseAspectRatio(value: string): AspectRatio {
  if (!/^\d+:\d+$/.test(value)) {
    throw new Error(`Aspect ratio must look like "9:16" (got "${value}")`);
  }
  return value as AspectRatio;
}

/**
 * To Veo, resolution is a quality tier — 720p, 1080p — and orientation comes
 * from the aspect ratio instead. The provider recognises only the landscape
 * spelling of each tier ("1280x720"), so a vertical clip is still "1280x720"
 * plus a 9:16 aspect. Writing "720x1280" for a vertical video is the natural
 * mistake, so normalise to the long edge first rather than rejecting it.
 */
export function parseResolution(value: string): Resolution {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) {
    throw new Error(`Resolution must look like "1280x720" (got "${value}")`);
  }

  const [width, height] = [Number(match[1]), Number(match[2])];
  return `${Math.max(width, height)}x${Math.min(width, height)}`;
}

const DEFAULTS: Config = {
  model: 'veo-3.1-generate-preview',
  mode: 'i2v',
  refs: [],
  duration: 8,
  aspectRatio: '9:16',
  generateAudio: true,
  personGeneration: 'allow_adult',
  outDir: 'out',
  stylePrompt: '',
};

export const CONFIG_PATH = resolve(process.cwd(), 'ugc.config.json');

export async function loadConfig(): Promise<Config> {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };

  let parsed: Partial<Config>;
  try {
    parsed = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  } catch (err) {
    throw new Error(
      `ugc.config.json is not valid JSON: ${(err as Error).message}`,
    );
  }

  const config = { ...DEFAULTS, ...parsed };

  // Validate the string-shaped fields here so a typo in the config file fails
  // immediately instead of surfacing as a provider error mid-batch.
  config.aspectRatio = parseAspectRatio(config.aspectRatio);
  if (config.resolution) config.resolution = parseResolution(config.resolution);

  return config;
}
