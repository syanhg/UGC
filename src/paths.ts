import { resolve } from 'node:path';

/**
 * The project directory, found from this file rather than from the working
 * directory. `ugc` is installed globally and run from anywhere, but there is
 * only ever one avatar library, one config, and one key — and they live here,
 * beside the code, not wherever the shell happens to be.
 */
export const PROJECT_ROOT = resolve(import.meta.dirname, '..');

/** Resolves a project-relative path. Absolute paths pass through unchanged. */
export function fromRoot(...segments: string[]): string {
  return resolve(PROJECT_ROOT, ...segments);
}

/**
 * Resolves a path the user typed, which is relative to their shell — the one
 * case where the working directory is the right anchor.
 */
export function fromCwd(path: string): string {
  return resolve(process.cwd(), path);
}
