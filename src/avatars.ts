import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { MEDIA_TYPES, type Mode } from './config.ts';
import { fromCwd, fromRoot } from './paths.ts';

/**
 * A registered subject. The point of the registry is that everything which
 * affects likeness — the photos, the seed, the identity description — is
 * captured once at `add` time and replayed identically on every clip after.
 */
export interface Avatar {
  name: string;
  /** Project-relative paths to the copies under refs/<name>/. */
  refs: string[];
  /** Locked at registration so repeat runs of a prompt reproduce exactly. */
  seed: number;
  mode?: Mode;
  model?: string;
  /** Identity description appended to the global style prompt. */
  notes?: string;
  createdAt: string;
}

type Registry = Record<string, Avatar>;

export const AVATARS_PATH = fromRoot('avatars.json');
const AVATAR_DIR = 'refs';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

export function assertValidName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Avatar name "${name}" is invalid. Use letters, digits, dashes, and ` +
        `underscores, starting with a letter or digit (e.g. "sofia", "marcus-2").`,
    );
  }
}

export async function loadAvatars(): Promise<Registry> {
  if (!existsSync(AVATARS_PATH)) return {};

  try {
    return JSON.parse(await readFile(AVATARS_PATH, 'utf8')) as Registry;
  } catch (err) {
    throw new Error(`avatars.json is not valid JSON: ${(err as Error).message}`);
  }
}

async function saveAvatars(registry: Registry): Promise<void> {
  await writeFile(AVATARS_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

export async function getAvatar(name: string): Promise<Avatar> {
  const registry = await loadAvatars();
  const avatar = registry[name];

  if (!avatar) {
    const known = Object.keys(registry);
    throw new Error(
      `No avatar named "${name}".` +
        (known.length
          ? ` Known avatars: ${known.join(', ')}`
          : ` Register one first:\n  ugc avatar add ${name} <photo.jpg>`),
    );
  }

  // The registry stores paths, not image data, so a moved or deleted photo
  // only surfaces here — catch it before spending a generation call on it.
  const missing = avatar.refs.filter((ref) => !existsSync(fromRoot(ref)));
  if (missing.length) {
    throw new Error(
      `Avatar "${name}" references files that no longer exist:\n  ${missing.join('\n  ')}\n` +
        `Re-register it:  ugc avatar rm ${name} && ugc avatar add ${name} <photo.jpg>`,
    );
  }

  return avatar;
}

export interface AddAvatarOptions {
  name: string;
  sources: string[];
  seed?: number;
  mode?: Mode;
  model?: string;
  notes?: string;
}

export async function addAvatar({
  name,
  sources,
  seed,
  mode,
  model,
  notes,
}: AddAvatarOptions): Promise<Avatar> {
  assertValidName(name);

  if (!sources.length) {
    throw new Error(`ugc avatar add ${name} needs at least one photo`);
  }

  const registry = await loadAvatars();
  if (registry[name]) {
    throw new Error(
      `Avatar "${name}" already exists. Remove it first:  ugc avatar rm ${name}`,
    );
  }

  const dir = join(AVATAR_DIR, name);
  await mkdir(fromRoot(dir), { recursive: true });

  // Photos are copied in rather than referenced in place, so moving or
  // deleting the original later cannot silently change the avatar.
  const refs: string[] = [];
  for (const [index, source] of sources.entries()) {
    // Source photos are whatever the user typed at their shell, so these are
    // the one thing here that resolves against the working directory.
    const abs = fromCwd(source);
    if (!existsSync(abs)) throw new Error(`Photo not found: ${source}`);

    const ext = extname(abs).toLowerCase();
    if (!MEDIA_TYPES[ext]) {
      throw new Error(
        `Unsupported photo type "${ext}" in ${source} (use jpg, png, or webp)`,
      );
    }

    const dest = join(dir, `${String(index + 1).padStart(2, '0')}${ext}`);
    await copyFile(abs, fromRoot(dest));
    refs.push(dest);
  }

  const avatar: Avatar = {
    name,
    refs,
    seed: seed ?? Math.floor(Math.random() * 1_000_000),
    ...(mode ? { mode } : {}),
    ...(model ? { model } : {}),
    ...(notes ? { notes } : {}),
    createdAt: new Date().toISOString(),
  };

  registry[name] = avatar;
  await saveAvatars(registry);

  return avatar;
}

export async function removeAvatar(name: string): Promise<Avatar> {
  const registry = await loadAvatars();
  const avatar = registry[name];
  if (!avatar) throw new Error(`No avatar named "${name}"`);

  delete registry[name];
  await saveAvatars(registry);
  await rm(fromRoot(AVATAR_DIR, name), {
    recursive: true,
    force: true,
  });

  return avatar;
}
