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
import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './atomic.js';
import { SEARCH_CONTENT_MAX_BYTES } from './config.js';
import { MemDriveError, NotFoundError } from './errors.js';
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
                isSymlink: dirent.isSymbolicLink(),
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
    async hashFile(relPath) {
        const hash = crypto.createHash('sha256');
        const stream = createReadStream(this.absolute(relPath));
        for await (const chunk of stream) {
            hash.update(chunk);
        }
        return hash.digest('hex');
    }
    async stat(relPath) {
        try {
            const st = await fs.stat(this.absolute(relPath));
            return {
                size: st.size,
                isDirectory: st.isDirectory(),
                modifiedAt: st.mtime.toISOString(),
                blocks: st.blocks,
            };
        }
        catch (error) {
            if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
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
                    try {
                        await handle.sync();
                    }
                    catch (error) {
                        // Filesystems without fsync support (some FUSE / network
                        // mounts) throw EINVAL / ENOTSUP / EOPNOTSUPP from sync()
                        // after the data is already written; failing the call here
                        // would leave the file on disk and turn a retry into
                        // ALREADY_EXISTS. The write + close path already pushed
                        // the data through, which is sufficient durability for a
                        // local note store. Any other error still throws.
                        const code = error.code;
                        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
                            throw error;
                        }
                    }
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
            const handle = await fs.open(target, 'a');
            try {
                const st = await handle.stat();
                if (!(st.mode & 0o200)) {
                    throw new MemDriveError('READ_ONLY', `File is read-only: ${relPath}`);
                }
                await handle.writeFile(data);
                try {
                    await handle.sync();
                }
                catch (error) {
                    // Filesystems without fsync support (some FUSE / network
                    // mounts) throw EINVAL / ENOTSUP / EOPNOTSUPP from sync()
                    // after the data is already written; failing the call here
                    // would leave the file on disk and turn a retry into
                    // ALREADY_EXISTS. The write + close path already pushed
                    // the data through, which is sufficient durability for a
                    // local note store. Any other error still throws.
                    const code = error.code;
                    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
                        throw error;
                    }
                }
            }
            finally {
                await handle.close();
            }
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
    async moveFile(srcRel, destRel) {
        const srcAbs = this.absolute(srcRel);
        const destAbs = this.absolute(destRel);
        let rootRealDir;
        try {
            rootRealDir = await fs.realpath(this.rootDir);
        }
        catch {
            rootRealDir = this.rootDir;
        }
        await assertInsideRealRoot(rootRealDir, srcAbs);
        await assertInsideRealRoot(rootRealDir, destAbs);
        try {
            await fs.mkdir(path.dirname(destAbs), { recursive: true });
            try {
                await fs.link(srcAbs, destAbs);
            }
            catch (linkError) {
                const linkCode = linkError.code;
                if (linkCode === 'EPERM' ||
                    linkCode === 'ENOSYS' ||
                    linkCode === 'EOPNOTSUPP' ||
                    linkCode === 'ENOTSUP' ||
                    linkCode === 'EXDEV' ||
                    linkCode === 'EMLINK') {
                    try {
                        await fs.copyFile(srcAbs, destAbs, fs.constants.COPYFILE_EXCL);
                    }
                    catch (copyError) {
                        if (copyError.code !== 'EEXIST') {
                            await fs.unlink(destAbs).catch(() => undefined); // only clean up a partial target we created
                        }
                        throw copyError;
                    }
                }
                else {
                    throw linkError;
                }
            }
            try {
                await fs.unlink(srcAbs);
            }
            catch (e) {
                await fs.unlink(destAbs).catch(() => undefined); // rollback: delete the created target, source file remains
                throw e;
            }
        }
        catch (error) {
            const code = error.code;
            if (code === 'EEXIST') {
                throw new MemDriveError('ALREADY_EXISTS', `Destination already exists: ${destRel}. Refusing to overwrite.`);
            }
            if (code === 'ENOENT') {
                throw new NotFoundError(`File not found: ${srcRel}`);
            }
            throw error;
        }
    }
    async search(keyword, relDir, maxResults, fileTypes) {
        const needle = keyword.toLowerCase();
        const wantedExts = fileTypes !== undefined && fileTypes.length > 0
            ? new Set(fileTypes.map((e) => (e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)))
            : null;
        const hits = [];
        // [Issue 4 & Issue 6] Refuse direct scan inside top-level archive/ so its
        // behavior matches the indexed search path.
        const lowerRelDir = relDir.toLowerCase();
        if (lowerRelDir === 'archive' || lowerRelDir.startsWith('archive/')) {
            return hits;
        }
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
        // Resolve the archive dir realpath (if it exists) so symlinks into
        // archive/ are excluded, not just the literal top-level name.
        let archiveReal = null;
        try {
            archiveReal = await fs.realpath(this.absolute('archive'));
        }
        catch {
            archiveReal = null;
        }
        // When a relDir scope is given, confine the walk to its realpath.
        let scopeReal = null;
        if (relDir !== '') {
            try {
                scopeReal = await fs.realpath(this.absolute(relDir));
            }
            catch {
                scopeReal = null;
            }
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
                    if (archiveReal !== null && isInside(archiveReal, real)) {
                        continue;
                    }
                    if (scopeReal !== null && !isInside(scopeReal, real)) {
                        continue;
                    }
                }
                catch {
                    // Vanished or broken link: nothing readable here.
                    continue;
                }
                if (entry.type === 'directory') {
                    // [Issue 6] Case-insensitive check for top-level archive/
                    if (current === '' && entry.name.toLowerCase() === 'archive') {
                        continue;
                    }
                    if (!visitedDirs.has(real)) {
                        visitedDirs.add(real);
                        queue.push(entry.relPath);
                    }
                    continue;
                }
                if (wantedExts !== null && !wantedExts.has(path.extname(entry.name).toLowerCase())) {
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
