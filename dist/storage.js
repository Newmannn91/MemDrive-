/**
 * Storage backends.
 *
 * The tools talk only to the `StorageBackend` interface, using root-relative
 * POSIX-style paths ('' means the root itself). This MVP ships one backend,
 * `LocalStorageBackend` (plain filesystem). Local only, by design.
 *
 * The backend performs NO sandbox checks: callers must validate paths with
 * the sandbox module before calling in. The backend trusts its inputs.
 * The one exception is `search`: the walk discovers entries the caller
 * never validated, so it skips any entry whose real location escapes the
 * root (a symlink inside the root pointing outside it) instead of
 * reading its content.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './atomic.js';
import { SEARCH_CONTENT_MAX_BYTES } from './config.js';
import { MemDriveError } from './errors.js';
import { assertInsideRealRoot, isInside } from './sandbox.js';
/**
 * Filesystem backend. `rootDir` must be an absolute path; callers guarantee
 * every relative path stays inside it (sandbox module).
 */
export class LocalStorageBackend {
    rootDir;
    constructor(rootDir) {
        this.rootDir = rootDir;
    }
    absolute(relPath) {
        return relPath === '' ? this.rootDir : path.join(this.rootDir, relPath);
    }
    async listDirectory(relDir) {
        const dirAbs = this.absolute(relDir);
        const dirents = await fs.readdir(dirAbs, { withFileTypes: true });
        const entries = [];
        for (const dirent of dirents) {
            // Skip orphaned atomic-write temp files: a crash between
            // write and rename leaves `.mdtmp-<pid>-<n>` behind, and it
            // must never be listed (or searched) as a note.
            if (dirent.name.startsWith('.mdtmp-')) {
                continue;
            }
            const entryAbs = path.join(dirAbs, dirent.name);
            let st;
            try {
                st = await fs.stat(entryAbs);
            }
            catch {
                // Entry vanished between readdir and stat (or broken symlink); skip it.
                continue;
            }
            const isDir = st.isDirectory();
            entries.push({
                name: dirent.name,
                relPath: (relDir === '' ? '' : `${relDir}/`) + dirent.name,
                type: isDir ? 'directory' : 'file',
                size: isDir ? 0 : st.size,
                modifiedAt: st.mtime.toISOString(),
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
    async readFile(relPath) {
        return fs.readFile(this.absolute(relPath));
    }
    async stat(relPath) {
        try {
            const st = await fs.stat(this.absolute(relPath));
            return {
                size: st.size,
                isDirectory: st.isDirectory(),
                modifiedAt: st.mtime.toISOString(),
            };
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
    async exists(relPath) {
        return (await this.stat(relPath)) !== null;
    }
    async writeFile(relPath, data, mode) {
        const target = this.absolute(relPath);
        let rootRealDir;
        try {
            rootRealDir = await fs.realpath(this.rootDir);
        }
        catch {
            rootRealDir = this.rootDir;
        }
        await assertInsideRealRoot(rootRealDir, target);
        await fs.mkdir(path.dirname(target), { recursive: true });
        if (mode === 'new') {
            try {
                const handle = await fs.open(target, 'wx');
                try {
                    await handle.writeFile(data);
                }
                finally {
                    await handle.close();
                }
                return { created: true };
            }
            catch (error) {
                if (error.code === 'EEXIST') {
                    throw new MemDriveError('ALREADY_EXISTS', `File already exists: ${relPath}. Use mode "overwrite" to replace it or "append" to add to it.`);
                }
                throw error;
            }
        }
        if (mode === 'append') {
            const existed = await this.exists(relPath);
            await fs.appendFile(target, data);
            return { created: !existed };
        }
        // Atomic replace via the shared helper (resolves symlinks with
        // a sandbox check, preserves permissions, refuses read-only
        // targets, fsyncs, retries Windows locks). Returns whether the
        // file existed, so overwrite of an existing file reports
        // created:false. ('new' uses 'wx' and 'append' is untouched.)
        const { existed } = await atomicWrite(target, data, { rootRealDir });
        return { created: !existed };
    }
    async ensureDir(relDir) {
        if (relDir === '') {
            return;
        }
        await fs.mkdir(this.absolute(relDir), { recursive: true });
    }
    async search(keyword, relDir, maxResults) {
        const needle = keyword.toLowerCase();
        const hits = [];
        // The search root was sandbox-checked by the caller, but the walk
        // discovers entries the caller never validated. A symlink inside
        // the root may point at a file outside it, and fs.stat follows
        // symlinks, so without this check its content would be read and
        // matched. Resolve the real root once and skip any entry whose
        // real location escapes it. Within-root symlinks behave like the
        // files they point at, matching read_file's sandbox rule.
        let rootRealDir;
        try {
            rootRealDir = await fs.realpath(this.rootDir);
        }
        catch {
            rootRealDir = this.rootDir;
        }
        const visitedDirs = new Set([rootRealDir]);
        const queue = [relDir];
        while (queue.length > 0 && hits.length < maxResults) {
            const current = queue.shift();
            let entries;
            try {
                entries = await this.listDirectory(current);
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (hits.length >= maxResults) {
                    break;
                }
                let real;
                try {
                    real = await fs.realpath(this.absolute(entry.relPath));
                    if (!isInside(rootRealDir, real)) {
                        continue;
                    }
                }
                catch {
                    // Vanished or broken link: nothing readable here.
                    continue;
                }
                if (entry.type === 'directory') {
                    if (!visitedDirs.has(real)) {
                        visitedDirs.add(real);
                        queue.push(entry.relPath);
                    }
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
                    }
                    catch {
                        // Unreadable file: name match already failed, move on.
                    }
                }
            }
        }
        return hits;
    }
}
/** Heuristic: no NUL byte in the first 8 KB means probably text. */
function looksLikeText(data) {
    const sample = data.subarray(0, 8192);
    return !sample.includes(0);
}
