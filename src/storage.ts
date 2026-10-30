/**
 * Storage backends.
 *
 * The tools talk only to the `StorageBackend` interface, using root-relative
 * POSIX-style paths ('' means the root itself). This MVP ships one backend,
 * `LocalStorageBackend` (plain filesystem). A WebDAV backend can be added
 * later by implementing the same interface — no tool code changes.
 *
 * The backend performs NO sandbox checks: callers must validate paths with
 * the sandbox module before calling in. The backend trusts its inputs.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

import { SEARCH_CONTENT_MAX_BYTES } from './config.js';
import { MemDriveError } from './errors.js';

export interface DirEntry {
  /** Entry name (no path separators). */
  name: string;
  /** Root-relative POSIX path of the entry. */
  relPath: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
}

export type WriteMode = 'new' | 'overwrite' | 'append';

export interface StorageBackend {
  /** List the immediate children of a directory ('' = root). */
  listDirectory(relDir: string): Promise<DirEntry[]>;

  /** Read a whole file as bytes. */
  readFile(relPath: string): Promise<Buffer>;

  /** Metadata for a path, or null when it does not exist. */
  stat(
    relPath: string,
  ): Promise<{ size: number; isDirectory: boolean; modifiedAt: string } | null>;

  /** True when the path exists (file or directory). */
  exists(relPath: string): Promise<boolean>;

  /**
   * Write bytes to a file, creating parent directories as needed.
   * 'new' fails when the file already exists; 'overwrite' replaces it;
   * 'append' creates it when missing and appends otherwise.
   * Returns whether the file was newly created.
   */
  writeFile(relPath: string, data: Buffer, mode: WriteMode): Promise<{ created: boolean }>;

  /** Create a directory and any missing parents. No-op when it exists. */
  ensureDir(relDir: string): Promise<void>;

  /**
   * Recursively walk `relDir`, returning root-relative paths of files whose
   * name or (for small text files) content contains `keyword`
   * (case-insensitive substring). Implementations may cap the result count.
   */
  search(keyword: string, relDir: string, maxResults: number): Promise<string[]>;
}

/**
 * Filesystem backend. `rootDir` must be an absolute path; callers guarantee
 * every relative path stays inside it (sandbox module).
 */
export class LocalStorageBackend implements StorageBackend {
  private readonly rootDir: string;

  public constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  private absolute(relPath: string): string {
    return relPath === '' ? this.rootDir : path.join(this.rootDir, relPath);
  }

  public async listDirectory(relDir: string): Promise<DirEntry[]> {
    const dirAbs = this.absolute(relDir);
    const dirents = await fs.readdir(dirAbs, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const dirent of dirents) {
      const entryAbs = path.join(dirAbs, dirent.name);
      let size = 0;
      let modifiedAt = '';
      try {
        const st = await fs.stat(entryAbs);
        size = st.isDirectory() ? 0 : st.size;
        modifiedAt = st.mtime.toISOString();
      } catch {
        // Entry vanished between readdir and stat; skip its metadata.
      }
      entries.push({
        name: dirent.name,
        relPath: (relDir === '' ? '' : `${relDir}/`) + dirent.name,
        type: dirent.isDirectory() ? 'directory' : 'file',
        size,
        modifiedAt,
      });
    }
    entries.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  public async readFile(relPath: string): Promise<Buffer> {
    return fs.readFile(this.absolute(relPath));
  }

  public async stat(
    relPath: string,
  ): Promise<{ size: number; isDirectory: boolean; modifiedAt: string } | null> {
    try {
      const st = await fs.stat(this.absolute(relPath));
      return {
        size: st.size,
        isDirectory: st.isDirectory(),
        modifiedAt: st.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  public async exists(relPath: string): Promise<boolean> {
    return (await this.stat(relPath)) !== null;
  }

  public async writeFile(
    relPath: string,
    data: Buffer,
    mode: WriteMode,
  ): Promise<{ created: boolean }> {
    const target = this.absolute(relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (mode === 'new') {
      try {
        const handle = await fs.open(target, 'wx');
        try {
          await handle.writeFile(data);
        } finally {
          await handle.close();
        }
        return { created: true };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new MemDriveError(
            'ALREADY_EXISTS',
            `File already exists: ${relPath}. Use mode "overwrite" to replace it or "append" to add to it.`,
          );
        }
        throw error;
      }
    }
    if (mode === 'append') {
      const existed = await this.exists(relPath);
      await fs.appendFile(target, data);
      return { created: !existed };
    }
    await fs.writeFile(target, data);
    return { created: true };
  }

  public async ensureDir(relDir: string): Promise<void> {
    if (relDir === '') {
      return;
    }
    await fs.mkdir(this.absolute(relDir), { recursive: true });
  }

  public async search(
    keyword: string,
    relDir: string,
    maxResults: number,
  ): Promise<string[]> {
    const needle = keyword.toLowerCase();
    const hits: string[] = [];
    const queue: string[] = [relDir];
    while (queue.length > 0 && hits.length < maxResults) {
      const current = queue.shift() as string;
      let entries: DirEntry[];
      try {
        entries = await this.listDirectory(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (hits.length >= maxResults) {
          break;
        }
        if (entry.type === 'directory') {
          queue.push(entry.relPath);
          continue;
        }
        if (entry.name.toLowerCase().includes(needle)) {
          hits.push(entry.relPath);
          continue;
        }
        // Content match for small files only; binary content is skipped.
        if (entry.size > 0 && entry.size <= SEARCH_CONTENT_MAX_BYTES) {
          try {
            const data = await this.readFile(entry.relPath);
            if (looksLikeText(data) && data.toString('utf8').toLowerCase().includes(needle)) {
              hits.push(entry.relPath);
            }
          } catch {
            // Unreadable file: name match already failed, move on.
          }
        }
      }
    }
    return hits;
  }
}

/** Heuristic: no NUL byte in the first 8 KB means probably text. */
function looksLikeText(data: Buffer): boolean {
  const sample = data.subarray(0, 8192);
  return !sample.includes(0);
}
