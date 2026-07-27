import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type Mode = 'i2v' | 'r2v' | 't2v';
export type AspectRatio = `${number}:${number}`;
export type Resolution = `${number}x${number}`;

export interface Config {
  model: string;
  mode: Mode;
  refs: string[];
  duration: number;
  aspectRatio: AspectRatio;
  resolution?: Resolution;
  generateAudio: boolean;
  outDir: string;
  stylePrompt: string;
}

export function parseAspectRatio(value: string): AspectRatio {
  if (!/^\d+:\d+$/.test(value)) {
    throw new Error(`Aspect ratio must look like "9:16" (got "${value}")`);
  }
  return value as AspectRatio;
}

export function parseResolution(value: string): Resolution {
  if (!/^\d+x\d+$/.test(value)) {
    throw new Error(`Resolution must look like "720x1280" (got "${value}")`);
  }
  return value as Resolution;
}

const DEFAULTS: Config = {
  model: 'google/veo-3.1-generate-001',
  mode: 'i2v',
  refs: [],
  duration: 8,
  aspectRatio: '9:16',
  generateAudio: true,
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
