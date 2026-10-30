/**
 * Path sandbox: every path the tools touch is locked to the library root.
 *
 * Two checks run for every operation:
 *   1. Lexical check — after cleaning and resolving, the path must sit
 *      inside the root (rejects `..` escapes and absolute outside paths).
 *   2. Realpath check — the nearest existing ancestor is resolved through
 *      symlinks and must also sit inside the *real* root. This closes the
 *      hole where a symlink inside the root points outside it, for both
 *      existing files and not-yet-created save targets (whose parent chain
 *      may itself contain a symlink).
 *
 * The root itself is resolved once at startup (after mkdir -p), so a root
 * that is itself a symlink is handled correctly.
 */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { SandboxError } from './errors.js';
/**
 * Clean a user-supplied path: trim whitespace, strip surrounding single or
 * double quotes (repeatedly, in case of double-quoting), expand a leading
 * `~` to the home directory, and normalize separators (backslashes become
 * forward slashes) and `.`/`..` segments.
 */
export function cleanPath(input) {
    let p = input.trim();
    // Strip surrounding quotes, one layer at a time.
    for (;;) {
        if (p.length >= 2 &&
            ((p.startsWith('"') && p.endsWith('"')) ||
                (p.startsWith("'") && p.endsWith("'")))) {
            p = p.slice(1, -1).trim();
            continue;
        }
        break;
    }
    if (p === '~') {
        return homedir();
    }
    if (p.startsWith('~/') || p.startsWith('~\\')) {
        return path.join(homedir(), p.slice(2));
    }
    // Normalize Windows-style separators so `a\b` and `a/b` mean the same.
    const unified = p.replace(/\\/g, '/');
    return path.normalize(unified);
}
/** True when `target` is `dir` itself or lives underneath it. */
export function isInside(dir, target) {
    const rel = path.relative(dir, target);
    return (rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)));
}
/**
 * Resolve a user-supplied path against the root and run the lexical check.
 * Returns an absolute path. Throws SandboxError on escape.
 */
export function resolveInRoot(rootDir, input) {
    const cleaned = cleanPath(input);
    const absolute = path.isAbsolute(cleaned)
        ? path.resolve(cleaned)
        : path.resolve(rootDir, cleaned);
    if (!isInside(rootDir, absolute)) {
        throw new SandboxError(`Path escapes the MemDrive root (${rootDir}): ${JSON.stringify(input)}`);
    }
    return absolute;
}
/**
 * Resolve the real (symlink-free) location of a path that may not exist
 * yet: walk up to the nearest existing ancestor, realpath it, then re-join
 * the remaining segments.
 */
async function realLocation(absolutePath) {
    const missing = [];
    let current = absolutePath;
    for (;;) {
        try {
            const real = await fs.realpath(current);
            let result = real;
            for (let i = missing.length - 1; i >= 0; i -= 1) {
                result = path.join(result, missing[i]);
            }
            return result;
        }
        catch (error) {
            const code = error.code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') {
                throw error;
            }
            const parent = path.dirname(current);
            if (parent === current) {
                // Reached the filesystem root without finding anything real.
                return absolutePath;
            }
            missing.push(path.basename(current));
            current = parent;
        }
    }
}
/**
 * Assert that `absolutePath` (already lexically inside the root) also
 * resolves inside the real root once symlinks are followed. Returns the
 * absolute path unchanged. Throws SandboxError on escape.
 */
export async function assertInsideRealRoot(rootRealDir, absolutePath) {
    const real = await realLocation(absolutePath);
    if (!isInside(rootRealDir, real)) {
        throw new SandboxError(`Path escapes the MemDrive root through a symlink: ${absolutePath} -> ${real}`);
    }
    return absolutePath;
}
/**
 * Full sandbox gate for one user-supplied path: lexical check + realpath
 * check. Returns the absolute path to use.
 */
export async function sandboxPath(rootDir, rootRealDir, input) {
    const absolute = resolveInRoot(rootDir, input);
    return assertInsideRealRoot(rootRealDir, absolute);
}
/** Root-relative POSIX-style path (forward slashes) for display and storage. */
export function toDisplayPath(rootDir, absolutePath) {
    const rel = path.relative(rootDir, absolutePath);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
}
