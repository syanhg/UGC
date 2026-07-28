import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fromCwd, fromData } from './paths.ts';

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
 * default. Only the two safe settings are modelled: Veo also accepts
 * "allow_all", which permits generating minors, and this tool refuses to pass
 * it through — see assertPersonGeneration.
 */
export type PersonGeneration = 'dont_allow' | 'allow_adult';

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

/**
 * What Veo 3.1 actually accepts. Kept here so the interactive pickers and the
 * flag validators cannot drift apart, and so an invalid combination fails
 * locally rather than after a round trip.
 */
export const ASPECT_RATIOS = ['9:16', '16:9'] as const;
export const DURATIONS = [4, 6, 8] as const;
export const RESOLUTION_TIERS = {
  '720p': '1280x720',
  '1080p': '1920x1080',
} as const satisfies Record<string, Resolution>;

export type ResolutionTier = keyof typeof RESOLUTION_TIERS;

/** Names the tier a stored WxH belongs to, for display. */
export function resolutionTier(value: Resolution | undefined): string {
  if (!value) return 'default';

  const found = Object.entries(RESOLUTION_TIERS).find(
    ([, dims]) => dims === value,
  );
  return found?.[0] ?? value;
}

/**
 * Refuses "allow_all". That setting lets Veo render minors, and this tool
 * animates a real photograph of a face into someone speaking to camera — the
 * one combination that has no legitimate use here. Blocked at the config
 * boundary rather than documented as discouraged, because a default someone
 * can flip in a JSON file is not a safeguard.
 */
export function assertPersonGeneration(value: string): PersonGeneration {
  if (value === 'allow_all') {
    throw new Error(
      'personGeneration "allow_all" is not supported: it permits generating ' +
        'minors. Use "allow_adult" (adults only) or "dont_allow" (no people).',
    );
  }

  if (value !== 'allow_adult' && value !== 'dont_allow') {
    throw new Error(
      `personGeneration must be "allow_adult" or "dont_allow" (got "${value}")`,
    );
  }

  return value;
}

export function parseAspectRatio(value: string): AspectRatio {
  if (!/^\d+:\d+$/.test(value)) {
    throw new Error(`Aspect ratio must look like "9:16" (got "${value}")`);
  }
  if (!ASPECT_RATIOS.includes(value as (typeof ASPECT_RATIOS)[number])) {
    throw new Error(
      `Veo supports ${ASPECT_RATIOS.join(' and ')} only (got "${value}")`,
    );
  }
  return value as AspectRatio;
}

export function parseDuration(value: number): number {
  if (!DURATIONS.includes(value as (typeof DURATIONS)[number])) {
    throw new Error(
      `Duration must be ${DURATIONS.join(', ')} seconds (got ${value})`,
    );
  }
  return value;
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

/**
 * The global config, shared by every project. Lives beside the avatar library
 * so a single `ugc` install has one set of defaults wherever it is run.
 */
export const GLOBAL_CONFIG_PATH = fromData('config.json');

/**
 * A per-directory override, if the directory you are standing in has one. Lets
 * one campaign keep its own framing and aspect ratio without disturbing the
 * global defaults.
 */
export const LOCAL_CONFIG_NAME = 'ugc.config.json';

async function readConfigFile(path: string): Promise<Partial<Config>> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Partial<Config>;
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

/** Config files that apply here, lowest precedence first. */
export function configSources(): string[] {
  const local = fromCwd(LOCAL_CONFIG_NAME);
  return [GLOBAL_CONFIG_PATH, local].filter(
    (path, index, all) => existsSync(path) && all.indexOf(path) === index,
  );
}

export async function loadConfig(): Promise<Config> {
  let config = { ...DEFAULTS };

  for (const path of configSources()) {
    config = { ...config, ...(await readConfigFile(path)) };
  }

  // Validate the string-shaped fields here so a typo in a config file fails
  // immediately instead of surfacing as a provider error mid-batch.
  config.aspectRatio = parseAspectRatio(config.aspectRatio);
  config.personGeneration = assertPersonGeneration(config.personGeneration);
  if (config.resolution) config.resolution = parseResolution(config.resolution);

  return config;
}
