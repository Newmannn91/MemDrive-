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
export function cleanPath(input: string): string {
  if (input.includes('\0')) {
    throw new SandboxError(`Path contains a NUL byte: ${JSON.stringify(input)}`);
  }
  let p = input.trim();
  // Strip surrounding quotes, one layer at a time.
  for (;;) {
    if (
      p.length >= 2 &&
      ((p.startsWith('"') && p.endsWith('"')) ||
        (p.startsWith("'") && p.endsWith("'")))
    ) {
      p = p.slice(1, -1).trim();
      continue;
    }
    break;
  }
  // Normalize Windows-style separators so `a\b` and `a/b` mean the same.
  const unified = p.replace(/\\/g, '/');
  if (unified === '~') {
    return homedir();
  }
  if (unified.startsWith('~/')) {
    return path.join(homedir(), unified.slice(2));
  }
  return path.normalize(unified);
}

export function decodeUserPath(input: string): string {
  // Strip a query suffix (not part of the on-disk path), then
  // percent-decode. Do NOT strip `#`: it is a legitimate filename
  // character in user-supplied paths (e.g. a `C#` directory) — only
  // Obsidian embeds use `#` as an anchor, and those never reach this
  // helper (resolveImageAbs handles Obsidian refs in its own branch,
  // and resolveImageRef strips `#` for Obsidian refs itself). A bad
  // escape keeps the raw input. Callers that need a literal `%` in a
  // filename check the literal path first (see sandboxPath /
  // resolveImageAbs).
  const cutAt = input.search(/\?/);
  const stripped = cutAt === -1 ? input : input.slice(0, cutAt);
  try {
    return decodeURIComponent(stripped);
  } catch {
    return stripped;
  }
}

/** True when `target` is `dir` itself or lives underneath it. */
export function isInside(dir: string, target: string): boolean {
  let d = dir;
  let t = target;
  // On case-insensitive filesystems (macOS/Windows) the configured
  // root's case may differ from the on-disk case, and macOS stores
  // filenames NFD while input is usually NFC. Compare NFC-normalized,
  // lowercased paths there so a case/normalization mismatch does not
  // falsely report an escape. Linux stays exact (case-sensitive FS).
  if (process.platform === 'darwin' || process.platform === 'win32') {
    d = dir.normalize('NFC').toLowerCase();
    t = target.normalize('NFC').toLowerCase();
  }
  const rel = path.relative(d, t);
  return (
    rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel))
  );
}

/** Windows reserved device names (checked against the segment stem, ignoring extension). */
const WINDOWS_RESERVED_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

/**
 * Validate path segments for cross-platform safety. Rejects Windows
 * reserved device names (CON, NUL, COM1–COM9, LPT1–LPT9, ignoring the
 * extension), NTFS alternate-data-stream segments (`a.md:$DATA`),
 * segments ending in a dot or space (Windows strips them, so the
 * on-disk name would differ from the requested one), and UNC paths.
 * A file that is safe on macOS/Linux but unreadable on Windows is a
 * sync-time trap, so the check runs on every platform.
 */
export function validateCrossPlatformSegments(input: string): void {
  const unified = input.replace(/\\/g, '/');
  if (unified.startsWith('//')) {
    throw new SandboxError(`UNC paths are not allowed: ${JSON.stringify(input)}`);
  }
  const segments = unified.split('/').filter((s) => s.length > 0 && s !== '.' && s !== '..');
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i] as string;
    if (seg.includes(':')) {
      throw new SandboxError(
        `Path segment contains ':' (NTFS alternate data stream): ${JSON.stringify(seg)}`,
      );
    }
    if (/[<>"|?*\x00-\x1f]/.test(seg)) {
      throw new SandboxError(
        `Path segment contains a character not allowed on Windows: ${JSON.stringify(seg)}`,
      );
    }
    if (seg.endsWith('.') || seg.endsWith(' ')) {
      throw new SandboxError(
        `Path segment ends with a dot or space (not portable to Windows): ${JSON.stringify(seg)}`,
      );
    }
    const stem = (seg.split('.')[0] as string).trimEnd().toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      throw new SandboxError(
        `Path segment is a Windows reserved device name: ${JSON.stringify(seg)}`,
      );
    }
  }
}

/**
 * Resolve a user-supplied path against the root and run the lexical check.
 * Returns an absolute path. Throws SandboxError on escape.
 */
export function resolveInRoot(rootDir: string, input: string): string {
  const cleaned = cleanPath(input);
  const absolute = path.isAbsolute(cleaned)
    ? path.resolve(cleaned)
    : path.resolve(rootDir, cleaned);
  if (!isInside(rootDir, absolute)) {
    throw new SandboxError(
      `Path escapes the MemDrive root (${rootDir}): ${JSON.stringify(input)}`,
    );
  }
  return absolute;
}

/**
 * Resolve the real (symlink-free) location of a path that may not exist
 * yet: walk up to the nearest existing ancestor, realpath it, then re-join
 * the remaining segments.
 */
async function realLocation(absolutePath: string, depth = 0): Promise<string> {
  if (depth > 32) {
    throw new SandboxError(`Too many levels of symbolic links: ${absolutePath}`);
  }
  const missing: string[] = [];
  let current = absolutePath;
  for (;;) {
    try {
      const real = await fs.realpath(current);
      let result = real;
      for (let i = missing.length - 1; i >= 0; i -= 1) {
        result = path.join(result, missing[i] as string);
      }
      return result;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') {
        throw new SandboxError(`Too many levels of symbolic links: ${absolutePath}`);
      }
      if (code === 'ERR_INVALID_ARG_VALUE') {
        throw new SandboxError(`Invalid path (NUL byte or invalid argument): ${absolutePath}`);
      }
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      if (code === 'ENOENT') {
        try {
          const lst = await fs.lstat(current);
          if (lst.isSymbolicLink()) {
            const linkTarget = await fs.readlink(current);
            const parentReal = await realLocation(path.dirname(current), depth + 1);
            const resolvedLink = path.resolve(parentReal, linkTarget);
            const realTarget = await realLocation(resolvedLink, depth + 1);
            let result = realTarget;
            for (let i = missing.length - 1; i >= 0; i -= 1) {
              result = path.join(result, missing[i] as string);
            }
            return result;
          }
        } catch (linkError) {
          if (linkError instanceof SandboxError) {
            throw linkError;
          }
          // Not an existing symlink; continue walking up to parent.
        }
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
export async function assertInsideRealRoot(
  rootRealDir: string,
  absolutePath: string,
): Promise<string> {
  const real = await realLocation(absolutePath);
  if (!isInside(rootRealDir, real)) {
    throw new SandboxError(
      `Path escapes the MemDrive root through a symlink: ${absolutePath} -> ${real}`,
    );
  }
  return absolutePath;
}

/**
 * Full sandbox gate for one user-supplied path: lexical check +
 * realpath check. Returns the absolute path to use.
 */
export async function sandboxPath(
  rootDir: string,
  rootRealDir: string,
  input: string,
): Promise<string> {
  // A user/model-supplied path may be percent-encoded
  // (`assets/my%20pic.png`); decode it, but prefer the literal path
  // when it exists (a file can legitimately contain `%` in its name).
  const decoded = decodeUserPath(input);
  if (decoded !== input) {
    try {
      const literalAbs = resolveInRoot(rootDir, input);
      await fs.stat(literalAbs);
      return assertInsideRealRoot(rootRealDir, literalAbs);
    } catch {
      // Literal path does not exist (or escapes): fall through to decoded.
    }
  }
  const absolute = resolveInRoot(rootDir, decoded);
  return assertInsideRealRoot(rootRealDir, absolute);
}

/**
 * Same as sandboxPath, plus the cross-platform segment check — for
 * WRITES only (save_file). Reads keep 0.7.0 behavior: a file saved
 * elsewhere (or synced in) as `meeting 10:30.md` or `aux.notes.md`
 * is a legal name on Linux/macOS and must still open; rejecting it
 * on read broke existing libraries.
 */
export async function sandboxPathForWrite(
  rootDir: string,
  rootRealDir: string,
  input: string,
): Promise<string> {
  const absolute = resolveInRoot(rootDir, input);
  // Cross-platform check on the root-relative part only (the root
  // itself is the user's own directory and may legitimately contain
  // any name).
  validateCrossPlatformSegments(path.relative(rootDir, absolute));
  return assertInsideRealRoot(rootRealDir, absolute);
}

/** Root-relative POSIX-style path (forward slashes) for display and storage. */
export function toDisplayPath(rootDir: string, absolutePath: string): string {
  // On case-insensitive filesystems the root's case/NFD form may differ
  // from the on-disk case, so path.relative on the raw inputs can produce
  // ../../../... even though isInside accepts the path. Match leading
  // segments on normalized forms, then return that many trailing segments
  // from the ORIGINAL absolutePath so the returned case is preserved.
  const norm = (p: string): string =>
    process.platform === 'darwin' || process.platform === 'win32'
      ? p.normalize('NFC').toLowerCase()
      : p;
  const dSegs = norm(rootDir).split(path.sep).filter((s) => s.length > 0);
  const tSegs = norm(absolutePath).split(path.sep).filter((s) => s.length > 0);
  let common = 0;
  while (common < dSegs.length && common < tSegs.length && dSegs[common] === tSegs[common]) {
    common += 1;
  }
  if (common < dSegs.length) {
    // Not inside the root (should not happen for sandbox-checked paths).
    const rawRel = path.relative(rootDir, absolutePath);
    return rawRel === '' ? '.' : rawRel.split(path.sep).join('/');
  }
  const origSegs = absolutePath.split(path.sep).filter((s) => s.length > 0);
  const tail = origSegs.slice(common);
  return tail.length === 0 ? '.' : tail.join('/');
}
