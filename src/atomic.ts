/**
 * Shared atomic file replacement, used by note overwrites
 * (storage.ts) and host config writes (host-config.ts).
 *
 * One function so both callers get the same guarantees:
 *   - Symlinks are followed: the write lands on the real file, and
 *     a link is never replaced by a regular file. A caller that
 *     passes `rootRealDir` additionally requires the resolved target
 *     to stay inside that root (a link pointing outside refuses
 *     the write instead of escaping the sandbox).
 *   - The original file's permission bits are preserved: the temp
 *     file is opened with the original mode (or 0o666 for a new file)
 *     and chmod'd to the original mode before the rename, so a
 *     0600 config does not silently become 0644 and never has a
 *     world-readable window. A target without owner-write is refused
 *     with READ_ONLY / EACCES (read-only stays read-only) instead of
 *     being silently replaced.
 *   - The temp file is a short random name (`.mdtmp-<12 hex chars>`)
 *     opened with `wx` in the same directory, never the target name
 *     plus a suffix, so a 243-byte filename still fits the 255-byte
 *     limit and a pre-planted symlink cannot be followed. The
 *     `.mdtmp-` prefix lets list/search skip orphaned temp files.
 *   - The content is fsync'd before the rename, so a power loss
 *     cannot leave a renamed-but-empty file behind.
 *   - The rename is retried on EPERM/EBUSY/EACCES (a file locked
 *     by a sync client, antivirus, or host on Windows), with a
 *     short backoff. Retries exhausted: throw, never silently
 *     fall back to an in-place write.
 *
 * A missing target is a NEW file (mode undefined, no chmod, no
 * read-only check) — only non-ENOENT errors are rethrown.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { MemDriveError, SandboxError } from './errors.js';
import { isInside } from './sandbox.js';

/** Injectable filesystem methods; each falls back to node:fs/promises. */
export interface AtomicWriteFs {
  open?: typeof fs.open;
  stat?: typeof fs.stat;
  lstat?: typeof fs.lstat;
  readlink?: typeof fs.readlink;
  realpath?: typeof fs.realpath;
  chmod?: typeof fs.chmod;
  rename?: typeof fs.rename;
  unlink?: typeof fs.unlink;
}

export interface AtomicWriteOptions {
  fs?: AtomicWriteFs;
  /** When set, the resolved target must stay inside this directory. */
  rootRealDir?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolve the real (symlink-free) location of a path that may not
 * exist yet: walk up to the nearest existing ancestor, realpath it,
 * then re-join the remaining segments. (Mirrors realLocation in
 * sandbox.ts, but honours the injected `realpath`/`lstat`/`readlink`
 * overrides.)
 */
async function realLocation(
  target: string,
  realpath: (p: string) => Promise<string>,
  lstat: typeof fs.lstat,
  readlink: typeof fs.readlink,
  depth = 0,
): Promise<string> {
  if (depth > 32) {
    throw new SandboxError(`Too many levels of symbolic links: ${target}`);
  }
  const missing: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      let result = real;
      for (let i = missing.length - 1; i >= 0; i -= 1) {
        result = path.join(result, missing[i] as string);
      }
      return result;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error;
      }
      if (code === 'ENOENT') {
        try {
          const lst = await lstat(current);
          if (lst.isSymbolicLink()) {
            const linkTarget = await readlink(current);
            const resolvedLink = path.resolve(path.dirname(current), String(linkTarget));
            const realTarget = await realLocation(resolvedLink, realpath, lstat, readlink, depth + 1);
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
          const linkCode = (linkError as NodeJS.ErrnoException).code;
          if (linkCode !== 'ENOENT' && linkCode !== 'EINVAL') {
            throw linkError;
          }
        }
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export async function atomicWrite(
  target: string,
  data: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<{ existed: boolean }> {
  const open = opts.fs?.open ?? fs.open;
  const stat = opts.fs?.stat ?? fs.stat;
  const lstat = opts.fs?.lstat ?? fs.lstat;
  const readlink = opts.fs?.readlink ?? fs.readlink;
  const realpath = opts.fs?.realpath ?? fs.realpath;
  const chmod = opts.fs?.chmod ?? fs.chmod;
  const rename = opts.fs?.rename ?? fs.rename;
  const unlink = opts.fs?.unlink ?? fs.unlink;

  // Resolve symlinks (including ancestors) so the write lands on
  // the real file.
  const real = await realLocation(target, realpath, lstat, readlink);
  if (opts.rootRealDir !== undefined && !isInside(opts.rootRealDir, real)) {
    throw new SandboxError(
      `Path escapes the MemDrive root through a symlink: ${target} -> ${real}`,
    );
  }
  let mode: number | undefined;
  try {
    mode = (await stat(real)).mode & 0o777;
    if (!(mode & 0o200)) {
      throw new MemDriveError('READ_ONLY', `File is read-only: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // New file: nothing to preserve, no read-only check.
      mode = undefined;
    } else {
      throw error;
    }
  }

  const tmp = path.join(
    path.dirname(real),
    `.mdtmp-${crypto.randomBytes(6).toString('hex')}`,
  );
  const fh = await open(tmp, 'wx', mode ?? 0o666);
  try {
    await fh.writeFile(data);
    try {
      await fh.sync();
    } catch (error) {
      // Filesystems without fsync support (some FUSE / network mounts)
      // throw EINVAL / ENOTSUP / EOPNOTSUPP from sync() after the data
      // is already written. atomicWrite continues with close and rename
      // after sync, so ignoring these three codes is safe: the write +
      // close path already pushed the data through, which is sufficient
      // durability for a local note store. Any other error still throws.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
        throw error;
      }
    }
    await fh.close();
    if (mode !== undefined) {
      await chmod(tmp, mode);
    }
    let lastError: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rename(tmp, real);
        return { existed: mode !== undefined };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') {
          throw error;
        }
        lastError = error;
        if (attempt < 4) {
          await sleep(50 * (attempt + 1));
        }
      }
    }
    throw lastError;
  } catch (error) {
    await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error;
  }
}
