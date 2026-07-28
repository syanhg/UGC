import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
/**
 * Where the avatar library, config, and key live. Deliberately *not* the
 * install directory: `ugc` is installed globally, and a global install lands
 * somewhere owned by root or wiped on upgrade — writing avatars and API keys
 * there is either a permission error or a way to lose them silently.
 *
 * Override with UGC_HOME to keep separate libraries side by side.
 */
export const DATA_DIR = process.env.UGC_HOME
    ? resolve(process.cwd(), process.env.UGC_HOME)
    : resolve(homedir(), '.ugc');
/**
 * Created 0700 because `.env` lives here. On a shared machine the default
 * umask would otherwise leave a billable API key world-readable.
 */
export function ensureDataDir() {
    mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    return DATA_DIR;
}
/** Resolves a path inside the data directory. */
export function fromData(...segments) {
    return resolve(DATA_DIR, ...segments);
}
/**
 * Resolves a path the user typed, which is relative to their shell. Output
 * directories and photo arguments anchor here — a CLI that writes somewhere
 * other than where you ran it is a CLI you have to go looking for files in.
 */
export function fromCwd(...segments) {
    return resolve(process.cwd(), ...segments);
}
/**
 * Guards a path that came from user-controlled data — a config value, or a key
 * in a hand-edited avatars.json — against escaping the directory it is meant
 * to be confined to. Returns the resolved absolute path.
 */
export function within(base, ...segments) {
    const target = resolve(base, ...segments);
    const root = resolve(base);
    if (target !== root && !target.startsWith(`${root}/`)) {
        throw new Error(`Refusing to use "${segments.join('/')}": it resolves outside ${root}`);
    }
    return target;
}
//# sourceMappingURL=paths.js.map