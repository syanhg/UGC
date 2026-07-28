import { readFile, writeFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { MEDIA_TYPES } from "./config.js";
import { ensureDataDir, fromCwd, fromData, within } from "./paths.js";
/** The name to show for photo `index`, falling back to the file name. */
export function photoLabel(avatar, index) {
    const label = avatar.photoLabels?.[index];
    return label ?? basename(avatar.refs[index] ?? '');
}
export const AVATARS_PATH = fromData('avatars.json');
const AVATAR_DIR = 'refs';
const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
/** Turns a design-tool layer name into something the registry will accept. */
export function slugifyName(name) {
    return name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}
export function assertValidName(name) {
    if (!NAME_PATTERN.test(name)) {
        throw new Error(`Avatar name "${name}" is invalid. Use letters, digits, dashes, and ` +
            `underscores, starting with a letter or digit (e.g. "sofia", "marcus-2").`);
    }
}
export async function loadAvatars() {
    if (!existsSync(AVATARS_PATH))
        return {};
    try {
        return JSON.parse(await readFile(AVATARS_PATH, 'utf8'));
    }
    catch (err) {
        throw new Error(`avatars.json is not valid JSON: ${err.message}`);
    }
}
async function saveAvatars(registry) {
    ensureDataDir();
    await writeFile(AVATARS_PATH, `${JSON.stringify(registry, null, 2)}\n`);
}
/**
 * Resolves an avatar's photo directory, refusing anything that would escape the
 * data directory. `avatars.json` is a plain file a user can hand-edit, and this
 * path is handed to a recursive delete — a key like "../.." must not be able to
 * turn `ugc avatar rm` into a wipe of the home directory.
 */
function avatarDir(name) {
    assertValidName(name);
    return within(fromData(AVATAR_DIR), name);
}
/** Absolute path for a stored, data-dir-relative ref. */
export function refPath(ref) {
    return within(fromData(), ref);
}
export async function getAvatar(name) {
    const registry = await loadAvatars();
    const avatar = registry[name];
    if (!avatar) {
        const known = Object.keys(registry);
        throw new Error(`No avatar named "${name}".` +
            (known.length
                ? ` Known avatars: ${known.join(', ')}`
                : ` Register one first:\n  ugc avatar add ${name} <photo.jpg>`));
    }
    // The registry stores paths, not image data, so a moved or deleted photo
    // only surfaces here — catch it before spending a generation call on it.
    const missing = avatar.refs.filter((ref) => !existsSync(refPath(ref)));
    if (missing.length) {
        throw new Error(`Avatar "${name}" references files that no longer exist:\n  ${missing.join('\n  ')}\n` +
            `Re-register it:  ugc avatar rm ${name} && ugc avatar add ${name} <photo.jpg>`);
    }
    return avatar;
}
export async function addAvatar({ name, sources, labels, seed, mode, model, notes, source, force = false, }) {
    assertValidName(name);
    if (!sources.length) {
        throw new Error(`ugc avatar add ${name} needs at least one photo`);
    }
    const registry = await loadAvatars();
    const existing = registry[name];
    if (existing && !force) {
        throw new Error(`Avatar "${name}" already exists. Replace it with --force, ` +
            `or remove it first:  ugc avatar rm ${name}`);
    }
    const dir = join(AVATAR_DIR, name);
    const absDir = avatarDir(name);
    // Clear old photos so a replacement that ships fewer images does not leave
    // the extras behind and silently keep referencing them.
    ensureDataDir();
    if (existing)
        await rm(absDir, { recursive: true, force: true });
    await mkdir(absDir, { recursive: true });
    // Photos are copied in rather than referenced in place, so moving or
    // deleting the original later cannot silently change the avatar.
    const refs = [];
    for (const [index, source] of sources.entries()) {
        // Source photos are whatever the user typed at their shell, so these are
        // the one thing here that resolves against the working directory.
        const abs = fromCwd(source);
        if (!existsSync(abs))
            throw new Error(`Photo not found: ${source}`);
        const ext = extname(abs).toLowerCase();
        if (!MEDIA_TYPES[ext]) {
            throw new Error(`Unsupported photo type "${ext}" in ${source} (use jpg, png, or webp)`);
        }
        const dest = join(dir, `${String(index + 1).padStart(2, '0')}${ext}`);
        await copyFile(abs, refPath(dest));
        refs.push(dest);
    }
    const avatar = {
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
export async function removeAvatar(name) {
    const registry = await loadAvatars();
    const avatar = registry[name];
    if (!avatar)
        throw new Error(`No avatar named "${name}"`);
    // Resolved and bounds-checked *before* the registry is written, so a name
    // that cannot be safely deleted fails without first losing its entry.
    const dir = avatarDir(name);
    delete registry[name];
    await saveAvatars(registry);
    await rm(dir, { recursive: true, force: true });
    return avatar;
}
//# sourceMappingURL=avatars.js.map