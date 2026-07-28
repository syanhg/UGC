import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { MEDIA_TYPES, type Mode } from './config.ts';
import { ensureDataDir, fromCwd, fromData, within } from './paths.ts';

/**
 * A registered subject. The point of the registry is that everything which
 * affects likeness — the photos, the seed, the identity description — is
 * captured once at `add` time and replayed identically on every clip after.
 */
/**
 * Where an avatar's photos came from, when they came from a design tool.
 * Recorded so a re-sync targets the same node rather than relying on names
 * matching, and so `avatar list` can show what is local-only versus synced.
 */
export interface AvatarSource {
  kind: 'paper' | 'figma';
  fileName: string;
  nodeId: string;
  syncedAt: string;
}

export interface Avatar {
  name: string;
  /** Paths to the copies under <data dir>/refs/<name>/, relative to the data dir. */
  refs: string[];
  /**
   * Display name per entry in `refs`, in the same order. Design-tool layer
   * names go here, so a photo can be picked by the name it has in the design
   * file rather than by the meaningless "01.png" it was copied to.
   */
  photoLabels?: string[];
  /** Locked at registration so repeat runs of a prompt reproduce exactly. */
  seed: number;
  mode?: Mode;
  model?: string;
  /** Identity description appended to the global style prompt. */
  notes?: string;
  source?: AvatarSource;
  createdAt: string;
}

/** The name to show for photo `index`, falling back to the file name. */
export function photoLabel(avatar: Avatar, index: number): string {
  const label = avatar.photoLabels?.[index];
  return label ?? basename(avatar.refs[index] ?? '');
}

type Registry = Record<string, Avatar>;

export const AVATARS_PATH = fromData('avatars.json');
const AVATAR_DIR = 'refs';

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;

/** Turns a design-tool layer name into something the registry will accept. */
export function slugifyName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

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
  ensureDataDir();
  await writeFile(AVATARS_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}

/**
 * Resolves an avatar's photo directory, refusing anything that would escape the
 * data directory. `avatars.json` is a plain file a user can hand-edit, and this
 * path is handed to a recursive delete — a key like "../.." must not be able to
 * turn `ugc avatar rm` into a wipe of the home directory.
 */
function avatarDir(name: string): string {
  assertValidName(name);
  return within(fromData(AVATAR_DIR), name);
}

/** Absolute path for a stored, data-dir-relative ref. */
export function refPath(ref: string): string {
  return within(fromData(), ref);
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
  const missing = avatar.refs.filter((ref) => !existsSync(refPath(ref)));
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
  /** Display names for `sources`, in the same order. */
  labels?: string[];
  seed?: number;
  mode?: Mode;
  model?: string;
  notes?: string;
  source?: AvatarSource;
  /** Replace an existing avatar rather than refusing. Needed to re-sync. */
  force?: boolean;
}

export async function addAvatar({
  name,
  sources,
  labels,
  seed,
  mode,
  model,
  notes,
  source,
  force = false,
}: AddAvatarOptions): Promise<Avatar> {
  assertValidName(name);

  if (!sources.length) {
    throw new Error(`ugc avatar add ${name} needs at least one photo`);
  }

  const registry = await loadAvatars();
  const existing = registry[name];

  if (existing && !force) {
    throw new Error(
      `Avatar "${name}" already exists. Replace it with --force, ` +
        `or remove it first:  ugc avatar rm ${name}`,
    );
  }

  const dir = join(AVATAR_DIR, name);
  const absDir = avatarDir(name);

  // Clear old photos so a replacement that ships fewer images does not leave
  // the extras behind and silently keep referencing them.
  ensureDataDir();
  if (existing) await rm(absDir, { recursive: true, force: true });
  await mkdir(absDir, { recursive: true });

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
    await copyFile(abs, refPath(dest));
    refs.push(dest);
  }

  const avatar: Avatar = {
    name,
    refs,
    ...(labels?.length ? { photoLabels: labels } : {}),
    // A re-synced avatar keeps its original seed, so clips generated before
    // and after a photo update stay comparable.
    seed: seed ?? existing?.seed ?? Math.floor(Math.random() * 1_000_000),
    ...(mode ?? existing?.mode ? { mode: mode ?? existing?.mode } : {}),
    ...(model ?? existing?.model ? { model: model ?? existing?.model } : {}),
    ...(notes ?? existing?.notes ? { notes: notes ?? existing?.notes } : {}),
    ...(source ?? existing?.source ? { source: source ?? existing?.source } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  registry[name] = avatar;
  await saveAvatars(registry);

  return avatar;
}

export async function removeAvatar(name: string): Promise<Avatar> {
  const registry = await loadAvatars();
  const avatar = registry[name];
  if (!avatar) throw new Error(`No avatar named "${name}"`);

  // Resolved and bounds-checked *before* the registry is written, so a name
  // that cannot be safely deleted fails without first losing its entry.
  const dir = avatarDir(name);

  delete registry[name];
  await saveAvatars(registry);
  await rm(dir, { recursive: true, force: true });

  return avatar;
}
