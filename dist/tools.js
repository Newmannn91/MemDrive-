/**
 * The eleven MemDrive tools.
 *
 * Interaction contract (enforced via the tool descriptions the model
 * reads): before calling save_file, the model MUST show the user the
 * exact destination path and filename and get confirmation. The server
 * never pops up a GUI and never asks questions itself — all confirmation
 * happens in the chat, through the model.
 *
 * Every handler catches its own errors and returns an MCP `isError`
 * result with a readable message. Handlers never throw, so one bad call
 * can never take the server down.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { z } from 'zod';
import { IMAGE_PREVIEW_MAX_BYTES, READ_MAX_IMAGES, SAVE_IMAGES_MAX_DOWNLOAD_BYTES, SAVE_IMAGES_MAX_TOTAL_BYTES, SAVE_MAX_IMAGES, SEARCH_MAX_RESULTS, SVG_EXTENSION, TEXT_MAX_BYTES, resolveIndexCacheDir, resolveResponseBudgetBytes, resolveSearchMaxBytes, } from './config.js';
import { MemDriveError, NotFoundError } from './errors.js';
import { acquireImage, base64Length, detectImageMime, encodeImageSrc, extensionForMime, makePreview, maxBinaryForBase64Budget, mimeFromExtension, scanMarkdownImages, } from './images.js';
import { assertInsideRealRoot, decodeUserPath, isInside, sandboxPath, sandboxPathForWrite, toDisplayPath, } from './sandbox.js';
import { LocalSearchIndex, MARKDOWN_EXTENSIONS, } from './search-index.js';
import { openFolderInViewer, openInViewer } from './viewer.js';
/** True when a path must never appear in a cleanup plan: any
    path segment starting with '.', or anything under archive/.
    Paths are POSIX-style (forward slashes). */
function isSkippedPlanPath(p) {
    const lower = p.toLowerCase();
    if (lower === 'archive' || lower.startsWith('archive/'))
        return true;
    return p.split('/').some((seg) => seg.startsWith('.'));
}
/** True when the path can be written through the sandbox. A
    path that fails (for example a name containing ':') is
    never proposed in a plan, because apply could not
    execute it. */
async function isWritablePlanPath(ctx, p) {
    try {
        await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, p);
        await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, `archive/${p}`);
        return true;
    }
    catch {
        return false;
    }
}
export async function buildCleanupPlan(ctx) {
    const diag = await ctx.searchIndex.scanDiagnostics();
    const statAndHash = async (p) => {
        try {
            const st = await ctx.backend.stat(p);
            if (st === null)
                return null;
            if (st.isDirectory)
                return null;
            const mtimeMs = new Date(st.modifiedAt).getTime();
            const size = st.size;
            const sha256 = await ctx.backend.hashFile(p);
            const st2 = await ctx.backend.stat(p);
            if (st2 === null)
                return null;
            if (new Date(st2.modifiedAt).getTime() !== mtimeMs || st2.size !== size)
                return null;
            return { sha256, mtimeMs };
        }
        catch {
            return null;
        }
    };
    const cmpPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
    const actions = [];
    const seenPaths = new Set();
    for (const p of [...diag.emptyFiles].sort(cmpPath)) {
        if (isSkippedPlanPath(p))
            continue;
        if (!(await isWritablePlanPath(ctx, p)))
            continue;
        const info = await statAndHash(p);
        if (info === null)
            continue;
        if (seenPaths.has(p))
            continue;
        actions.push({
            action: 'archive',
            path: p,
            sha256: info.sha256,
            mtimeMs: info.mtimeMs,
            reason: 'empty file (0 bytes)',
            kind: 'empty',
        });
        seenPaths.add(p);
    }
    const dupActions = [];
    for (const group of diag.duplicateGroups) {
        const entries = [];
        for (const p of group) {
            if (isSkippedPlanPath(p))
                continue;
            const info = await statAndHash(p);
            if (info !== null) {
                entries.push({ path: p, sha256: info.sha256, mtimeMs: info.mtimeMs });
            }
        }
        entries.sort((a, b) => a.mtimeMs !== b.mtimeMs ? a.mtimeMs - b.mtimeMs : cmpPath(a.path, b.path));
        const first = entries[0];
        if (first === undefined || entries.length < 2)
            continue;
        const keeper = first.path;
        for (const entry of entries.slice(1)) {
            if (entry.sha256 !== first.sha256)
                continue;
            if (seenPaths.has(entry.path))
                continue;
            if (!(await isWritablePlanPath(ctx, entry.path)))
                continue;
            dupActions.push({
                action: 'archive',
                path: entry.path,
                sha256: entry.sha256,
                mtimeMs: entry.mtimeMs,
                reason: `duplicate of ${keeper} (kept: earliest modified time)`,
                kind: 'duplicate',
                keeper,
            });
            seenPaths.add(entry.path);
        }
    }
    dupActions.sort((a, b) => cmpPath(a.path, b.path));
    actions.push(...dupActions);
    for (const p of [...diag.orphanCandidates].sort(cmpPath)) {
        if (isSkippedPlanPath(p))
            continue;
        if (!(await isWritablePlanPath(ctx, p)))
            continue;
        const info = await statAndHash(p);
        if (info === null)
            continue;
        if (seenPaths.has(p))
            continue;
        actions.push({
            action: 'archive',
            path: p,
            sha256: info.sha256,
            mtimeMs: info.mtimeMs,
            reason: 'orphan attachment candidate (unreferenced for over 24h)',
            kind: 'orphan',
        });
        seenPaths.add(p);
    }
    // A plan holds at most 200 actions, so the preview stays within
    // the host's response budget and the preview always matches the
    // plan file exactly.
    const PLAN_ACTION_LIMIT = 200;
    const limited = actions.length > PLAN_ACTION_LIMIT;
    if (limited)
        actions.splice(PLAN_ACTION_LIMIT);
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:T.]/g, '').slice(0, 14); // YYYYMMDDHHmmss UTC
    const planId = `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
    const createdAt = now.toISOString();
    const withheldLine = diag.scanIncomplete
        ? `Orphan scan withheld: ${diag.skippedNotes.length} note(s) could not be read (see diagnostics_only).`
        : null;
    const preview = actions.length === 0
        ? [
            'Cleanup scan complete: no candidates.',
            ...(diag.brokenImageRefs.length > 0
                ? [`Broken image references (${diag.brokenImageRefs.length}) need manual fixing; no file action is proposed for them.`]
                : []),
            ...(withheldLine === null ? [] : [withheldLine]),
        ].join('\n')
        : [
            `Cleanup plan ${planId} (${actions.length} actions):`,
            ...actions.map((a) => `- ${a.action} ${a.path} (${a.reason})`),
            'Notes:',
            '- Similar content is not proposed automatically; only exact SHA-256 duplicates are listed.',
            `- Broken image references (${diag.brokenImageRefs.length}) need manual fixing; no file action is proposed for them.`,
            `- This plan is a proposal only; nothing has been changed. Execute it with the \`apply_plan\` tool or by running \`memdrive-mcp apply ${planId}\` in a terminal.`,
            ...(limited
                ? ['- Plan limit reached (200 actions); apply this batch, then run plan_cleanup again for the next batch.']
                : []),
            ...(withheldLine === null ? [] : [`- ${withheldLine}`]),
        ].join('\n');
    return { plan: { planId, createdAt, actions }, preview };
}
export async function handlePlanCleanup(ctx) {
    const { plan, preview } = await buildCleanupPlan(ctx);
    if (plan.actions.length > 0) {
        const cacheDir = resolveIndexCacheDir(ctx.rootRealDir);
        await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(path.join(cacheDir, `plan-${plan.planId}.json`), JSON.stringify(plan, null, 2), { encoding: 'utf8', mode: 0o600 });
    }
    return okResult(preview);
}
export async function handleApplyPlan(ctx, planId) {
    const { lines, exitCode } = await runApplyCleanup(planId.trim(), ctx, { incrementalRefresh: true });
    const text = lines.join('\n');
    return exitCode === 0 ? okResult(text) : { content: [textBlock(text)], isError: true };
}
/** True when a plan-file path is safe to act on: relative, no
    '..', not under archive/, and no dot-segment. Lexical
    only; runApplyCleanup also normalizes each path through
    sandboxPathForWrite. */
function isSafePlanPath(p) {
    if (p.length === 0)
        return false;
    if (p.includes('\0'))
        return false;
    if (p.includes('\\'))
        return false;
    if (p.startsWith('/'))
        return false;
    if (/^[A-Za-z]:/.test(p))
        return false;
    const lower = p.toLowerCase();
    if (lower === 'archive' || lower.startsWith('archive/'))
        return false;
    return !p.split('/').some((seg) => seg === '..' || seg === '' || seg.startsWith('.'));
}
function isValidCleanupPlan(value, expectedPlanId) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const obj = value;
    if (obj['planId'] !== expectedPlanId ||
        typeof obj['createdAt'] !== 'string' ||
        obj['createdAt'].length === 0 ||
        !Array.isArray(obj['actions'])) {
        return false;
    }
    for (const item of obj['actions']) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            return false;
        }
        const act = item;
        if (act['action'] !== 'archive' ||
            typeof act['path'] !== 'string' ||
            act['path'].length === 0 ||
            typeof act['sha256'] !== 'string' ||
            act['sha256'].length === 0 ||
            typeof act['mtimeMs'] !== 'number' ||
            !Number.isFinite(act['mtimeMs']) ||
            typeof act['reason'] !== 'string' ||
            (act['kind'] !== 'empty' && act['kind'] !== 'duplicate' && act['kind'] !== 'orphan')) {
            return false;
        }
        if (!isSafePlanPath(act['path'])) {
            return false;
        }
        if (act['kind'] === 'duplicate') {
            if (typeof act['keeper'] !== 'string' ||
                act['keeper'].length === 0 ||
                !isSafePlanPath(act['keeper'])) {
                return false;
            }
        }
        else if (act['keeper'] !== undefined) {
            return false;
        }
    }
    return true;
}
export async function runApplyCleanup(planId, ctx, options) {
    if (!/^\d{14}-[0-9a-f]{6}$/.test(planId)) {
        return { lines: [`Plan file is invalid: ${planId}`], exitCode: 1 };
    }
    const cacheDir = resolveIndexCacheDir(ctx.rootRealDir);
    const planPath = path.join(cacheDir, `plan-${planId}.json`);
    let raw;
    try {
        raw = await fs.readFile(planPath, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            return { lines: [`Plan not found: ${planId}`], exitCode: 1 };
        }
        return { lines: [`Plan file is invalid: ${planId}`], exitCode: 1 };
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { lines: [`Plan file is invalid: ${planId}`], exitCode: 1 };
    }
    if (!isValidCleanupPlan(parsed, planId)) {
        return { lines: [`Plan file is invalid: ${planId}`], exitCode: 1 };
    }
    const createdMs = Date.parse(parsed.createdAt);
    if (!Number.isFinite(createdMs) || Date.now() - createdMs > 7 * 24 * 60 * 60 * 1000) {
        return { lines: [`Plan expired: ${planId} (plans are valid for 7 days)`], exitCode: 1 };
    }
    const lines = [];
    let executed = 0;
    const executedPaths = [];
    let skipped = 0;
    const recordSkipped = (action, reason) => {
        lines.push(`skipped: ${action.action} ${action.path} — ${reason}`);
        skipped++;
    };
    let diag;
    try {
        diag = await ctx.searchIndex.scanDiagnostics();
    }
    catch (error) {
        return { lines: [`Diagnostics unavailable: ${error instanceof Error ? error.message : String(error)}. Plan not applied.`], exitCode: 1 };
    }
    for (const action of parsed.actions) {
        let absolute;
        try {
            absolute = await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, action.path);
        }
        catch {
            recordSkipped(action, 'path not allowed for writing');
            continue;
        }
        action.path = toDisplayPath(ctx.rootDir, absolute);
        if (isSkippedPlanPath(action.path)) {
            recordSkipped(action, 'path not allowed for writing');
            continue;
        }
        let st;
        try {
            st = await ctx.backend.stat(action.path);
        }
        catch (error) {
            recordSkipped(action, error instanceof Error ? error.message : String(error));
            continue;
        }
        if (st === null) {
            recordSkipped(action, 'file not found (it moved or was deleted after the plan was created)');
            continue;
        }
        if (st.isDirectory) {
            recordSkipped(action, 'path is a directory, not a file');
            continue;
        }
        let currentSha;
        let st2;
        try {
            currentSha = await ctx.backend.hashFile(action.path);
            st2 = await ctx.backend.stat(action.path);
        }
        catch (error) {
            recordSkipped(action, error instanceof Error ? error.message : String(error));
            continue;
        }
        if (st2 === null) {
            recordSkipped(action, 'file not found (it moved or was deleted after the plan was created)');
            continue;
        }
        const currentMtimeMs = new Date(st2.modifiedAt).getTime();
        if (currentMtimeMs !== new Date(st.modifiedAt).getTime()) {
            recordSkipped(action, 'file changed during verification');
            continue;
        }
        if (currentSha !== action.sha256) {
            recordSkipped(action, 'content changed since the plan was created');
            continue;
        }
        if (currentMtimeMs !== action.mtimeMs) {
            recordSkipped(action, 'modification time changed since the plan was created');
            continue;
        }
        let noLongerReason = null;
        if (action.kind === 'empty') {
            if (!diag.emptyFiles.includes(action.path))
                noLongerReason = 'no longer an empty file';
        }
        else if (action.kind === 'orphan') {
            if (!diag.orphanCandidates.includes(action.path))
                noLongerReason = 'no longer an orphan attachment candidate';
        }
        else if (action.kind === 'duplicate') {
            const keeper = action.keeper ?? null;
            if (keeper === null || keeper === action.path) {
                noLongerReason = 'no longer a duplicate of its keeper';
            }
            else if (!isSafePlanPath(keeper)) {
                noLongerReason = 'no longer a duplicate of its keeper';
            }
            else {
                let keeperExists = false;
                try {
                    keeperExists = (await ctx.backend.stat(keeper)) !== null;
                }
                catch {
                    keeperExists = false;
                }
                if (!keeperExists) {
                    noLongerReason = 'keeper no longer on disk';
                }
                else if (!diag.duplicateGroups.some((g) => g.includes(action.path) && g.includes(keeper))) {
                    noLongerReason = 'no longer a duplicate of its keeper';
                }
            }
        }
        if (noLongerReason !== null) {
            recordSkipped(action, noLongerReason);
            continue;
        }
        try {
            if (action.action === 'archive') {
                const destRel = `archive/${action.path}`;
                try {
                    await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, destRel);
                }
                catch {
                    recordSkipped(action, 'archive destination not allowed for writing');
                    continue;
                }
                if (await ctx.backend.exists(destRel)) {
                    recordSkipped(action, 'archive destination already exists');
                    continue;
                }
                await ctx.backend.moveFile(action.path, destRel);
                lines.push(`executed: ${action.action} ${action.path}`);
                executed++;
                executedPaths.push(action.path);
            }
        }
        catch (error) {
            recordSkipped(action, error instanceof Error ? error.message : String(error));
        }
    }
    if (options?.incrementalRefresh) {
        for (const p of executedPaths)
            ctx.searchIndex.markDirty(p);
    }
    else {
        try {
            const buildResult = await ctx.searchIndex.buildAll();
            if (buildResult !== 'built') {
                for (const p of executedPaths)
                    ctx.searchIndex.markDirty(p);
                lines.push(`warning: search index rebuild ${buildResult}; search results may be stale until the next rebuild.`);
            }
        }
        catch (error) {
            for (const p of executedPaths)
                ctx.searchIndex.markDirty(p);
            lines.push(`warning: search index rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    const allSkipped = executed === 0 && skipped > 0;
    lines.push(`Applied plan ${planId}: ${executed} executed, ${skipped} skipped.` +
        (allSkipped ? ' All actions were skipped; nothing was executed.' : ''));
    return { lines, exitCode: allSkipped ? 1 : 0 };
}
function textBlock(text) {
    return { type: 'text', text };
}
function okResult(text) {
    return { content: [textBlock(text)] };
}
function errorResult(message) {
    return { content: [textBlock(`Error: ${message}`)], isError: true };
}
function relOf(ctx, absolutePath) {
    return toDisplayPath(ctx.rootDir, absolutePath);
}
function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    if (bytes < 1_000_000) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / 1_000_000).toFixed(2)} MB`;
}
function looksBinary(data) {
    return data.subarray(0, 8192).includes(0);
}
/** UTF-8 byte length of a string (what the transport actually sends). */
function utf8Bytes(text) {
    return Buffer.byteLength(text, 'utf8');
}
/**
 * Total response budget for one read_file call, resolved fresh on
 * every call from MEMDRIVE_RESPONSE_BUDGET_BYTES (default 950,000;
 * clamped to 100,000–50,000,000 by resolveResponseBudgetBytes).
 */
function responseBudgetBytes() {
    return resolveResponseBudgetBytes(process.env['MEMDRIVE_RESPONSE_BUDGET_BYTES']);
}
/**
 * Bytes reserved for the one-line header of a direct image read when
 * sizing its preview. The header is far shorter than this; the reserve
 * only guarantees the header + base64 together stay inside the budget,
 * and the final total is re-checked before returning.
 */
const DIRECT_IMAGE_HEADER_RESERVE_BYTES = 512;
/**
 * Hard upper bound on on-disk file size before reading a file into memory
 * in read_file or edit_tags, preventing multi-GB files from exhausting RAM.
 */
const MAX_READ_FILE_BYTES = 256_000_000;
/**
 * Assemble the text block of a read_file result so that
 * text bytes + `imageBase64Total` never exceed `budget`. The body is
 * truncated (UTF-8-safe) to make room for the notes section; when the
 * notes alone fill the allowance, the body is dropped and the notes
 * are truncated instead, so image paths and skip reasons survive.
 */
function assembleText(body, notes, budget, imageBase64Total) {
    const allowedTextBytes = budget - imageBase64Total;
    if (allowedTextBytes <= 0) {
        return '';
    }
    if (notes.length === 0) {
        return truncateUtf8(body, allowedTextBytes);
    }
    const notesSection = `\n\n[MemDrive notes]\n${notes.map((n) => `- ${n}`).join('\n')}`;
    const notesBytes = utf8Bytes(notesSection);
    const bodyBytes = utf8Bytes(body);
    if (bodyBytes + notesBytes <= allowedTextBytes) {
        return body + notesSection;
    }
    if (imageBase64Total === 0) {
        if (notesBytes >= allowedTextBytes) {
            return truncateUtf8(notesSection, allowedTextBytes);
        }
        return truncateUtf8(body, allowedTextBytes - notesBytes) + notesSection;
    }
    // When images are included, text body is guaranteed first; notes use remaining text allowance.
    const fittedBody = truncateUtf8(body, allowedTextBytes);
    const remainingForNotes = allowedTextBytes - utf8Bytes(fittedBody);
    if (remainingForNotes <= 0) {
        return fittedBody;
    }
    return fittedBody + truncateUtf8(notesSection, remainingForNotes);
}
function timestampStem(date) {
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return (`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
        `-${pad(date.getMilliseconds(), 3)}`);
}
/* ------------------------------------------------------------------ */
/* list_directory                                                      */
/* ------------------------------------------------------------------ */
async function handleListDirectory(ctx, inputPath) {
    const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath ?? '');
    const rel = relOf(ctx, absolute);
    const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
    if (stat === null) {
        throw new NotFoundError(`Directory not found: ${rel}`);
    }
    if (!stat.isDirectory) {
        throw new MemDriveError('NOT_A_DIRECTORY', `${rel} is a file, not a directory. Use read_file to read it.`);
    }
    const entries = await ctx.backend.listDirectory(rel === '.' ? '' : rel);
    if (entries.length === 0) {
        return okResult(`Directory ${rel} is empty.`);
    }
    const lines = [`Directory: ${rel} (${entries.length} entries)`, ''];
    for (const entry of entries) {
        const meta = entry.type === 'directory'
            ? '[dir] '
            : `[file] ${formatBytes(entry.size)} · modified ${entry.modifiedAt} · `;
        lines.push(`${meta}${entry.name}`);
    }
    return okResult(lines.join('\n'));
}
/** Output cap for one search_files result (bytes): the search cap, never above the response budget. */
function searchOutputCapBytes() {
    return Math.min(resolveSearchMaxBytes(process.env['MEMDRIVE_SEARCH_MAX_BYTES']), responseBudgetBytes());
}
/** Format a read-only diagnostics report (0.9.0 maintenance preview; never modifies anything). */
export function formatDiagnostics(diag, scope) {
    const lines = ['Library diagnostics (read-only — nothing was modified):', ''];
    lines.push(`Empty files (${diag.emptyFiles.length}):`);
    for (const f of diag.emptyFiles) {
        lines.push(`- ${f}`);
    }
    lines.push('', `Duplicate groups (${diag.duplicateGroups.length}, same content SHA-256):`);
    for (const group of diag.duplicateGroups) {
        lines.push(`- ${group.join(', ')}`);
    }
    lines.push('', `Broken image references (${diag.brokenImageRefs.length}):`);
    for (const ref of diag.brokenImageRefs) {
        lines.push(`- ${ref.file}: ${ref.src}`);
    }
    if (diag.scanIncomplete) {
        lines.push('', `Scan incomplete: ${diag.skippedNotes.length} note(s) could not be read, so the orphan list is withheld (this does NOT mean there are no orphans):`);
        for (const n of diag.skippedNotes) {
            lines.push(`- ${n.file} (${n.reason})`);
        }
        if (scope !== undefined && scope !== '') {
            const outsideScope = diag.skippedNotes.filter((n) => n.file !== scope && !n.file.startsWith(`${scope}/`));
            if (outsideScope.length > 0) {
                lines.push(`Note: ${outsideScope.length} of the skipped note(s) above lie outside the requested scope (${scope}), but a note anywhere in the library may reference an image inside the scope, so they still withhold the orphan list.`);
            }
        }
    }
    lines.push('', `Orphan attachment candidates (${diag.orphanCandidates.length}, unreferenced images older than 24h):`);
    for (const f of diag.orphanCandidates) {
        lines.push(`- ${f}`);
    }
    if (diag.tags.length === 0) {
        lines.push('', 'Tags in use (0): none');
    }
    else {
        lines.push('', `Tags in use (${diag.tags.length}):`);
        for (const { tag, count } of diag.tags) {
            lines.push(`- ${tag} (${count})`);
        }
    }
    return lines.join('\n');
}
/**
 * Exported for the protocol tests (like resolveContainingFolder):
 * the fallback and pagination paths are only reachable through this
 * handler, and a fresh index is the only way to force the fallback.
 */
export async function handleSearchFiles(ctx, keyword, inputPath, opts) {
    const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath ?? '');
    const rel = relOf(ctx, absolute);
    const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
    if (stat === null) {
        throw new NotFoundError(`Directory not found: ${rel}`);
    }
    if (!stat.isDirectory) {
        throw new MemDriveError('NOT_A_DIRECTORY', `${rel} is a file, not a directory. Search a directory path instead.`);
    }
    const scopeRel = rel === '.' ? '' : rel;
    const cap = searchOutputCapBytes();
    // Read-only diagnostics (maintenance preview). Keyword is ignored.
    if (opts.diagnosticsOnly === true) {
        const diag = await ctx.searchIndex.scanDiagnostics(scopeRel);
        return okResult(truncateUtf8(formatDiagnostics(diag, scopeRel), cap));
    }
    if (keyword.trim() === '') {
        throw new MemDriveError('INVALID_ARGUMENT', 'search_files needs a keyword (omit it only for diagnostics_only).');
    }
    // Explicit rebuild (e.g. after a bulk import or a cache clear).
    // When the rebuild does not run, say why instead of silently
    // searching the old index: 'locked' (another process — or this
    // process's own background build after a restart — is building)
    // is not the same as 'failed' (the rebuild itself threw, F1).
    let rebuildSkipped = false;
    let rebuildFailed = false;
    if (opts.rebuildIndex === true) {
        const result = await ctx.searchIndex.buildAll();
        rebuildSkipped = result === 'locked';
        rebuildFailed = result === 'failed';
    }
    const rebuildNote = rebuildFailed
        ? 'Note: rebuild failed — the index could not be saved to disk. Try rebuild_index again, and check the server log if it keeps failing.'
        : 'Note: rebuild skipped — the index is currently being built (by another MemDrive process or a background build); try rebuild_index again in a moment.';
    const withRebuildNote = (text) => rebuildSkipped || rebuildFailed ? `${rebuildNote}\n\n${text}` : text;
    // Kick off the background build on first use; searches fall back to
    // a direct scan until it finishes.
    if (ctx.searchIndex.getStatus() === 'unbuilt') {
        void ctx.searchIndex.ensureReady().catch(() => undefined);
    }
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20)), SEARCH_MAX_RESULTS);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const query = {
        keyword,
        path: scopeRel,
        exactPhrase: opts.exactPhrase,
        fileTypes: opts.fileTypes,
        tags: opts.tags,
        dateFrom: opts.dateFrom,
        dateTo: opts.dateTo,
        modifiedAfter: opts.modifiedAfter,
        modifiedBefore: opts.modifiedBefore,
        limit,
        offset,
    };
    const outcome = await ctx.searchIndex.search(query);
    if (!outcome.ready) {
        // Index still building: direct scan (0.7.0 behavior). The file
        // type filter and pagination still apply; tags, dates, and the
        // exact phrase cannot be checked by a direct scan, and the
        // result says so instead of silently pretending they were.
        const wantedExts = (opts.fileTypes ?? []).map((e) => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`);
        const hits = await ctx.backend.search(keyword, scopeRel, SEARCH_MAX_RESULTS, wantedExts.length > 0 ? wantedExts : undefined);
        const ignored = [];
        if ((opts.tags ?? []).length > 0) {
            ignored.push('tags');
        }
        if (opts.dateFrom !== undefined || opts.dateTo !== undefined) {
            ignored.push('dates');
        }
        if (opts.modifiedAfter !== undefined || opts.modifiedBefore !== undefined) {
            ignored.push('modification times');
        }
        if (opts.exactPhrase !== undefined) {
            ignored.push('exact_phrase');
        }
        if (hits.length === 0) {
            return okResult(withRebuildNote(`No files matching ${JSON.stringify(keyword)} under ${rel}. (Search index is still building; this was a direct scan.)`));
        }
        const needle = keyword.toLowerCase();
        const pageHits = hits.slice(offset, offset + limit);
        const hitLines = [];
        for (const hit of pageHits) {
            const name = hit.split('/').pop() ?? hit;
            let kind = 'content';
            let excerpt = '';
            if (name.toLowerCase().includes(needle)) {
                kind = 'name';
            }
            else {
                try {
                    const data = await ctx.backend.readFile(hit);
                    if (!looksBinary(data)) {
                        const text = data.toString('utf8');
                        const line = text
                            .split('\n')
                            .find((l) => l.toLowerCase().includes(needle));
                        if (line !== undefined) {
                            excerpt = ` — ${line.trim().slice(0, 160)}`;
                        }
                    }
                }
                catch {
                    // Excerpt is best-effort; the hit itself stands.
                }
            }
            hitLines.push(`- ${hit} (${kind})${excerpt}`);
        }
        const headerFor = (shown) => {
            const showingSuffix = shown > 0 ? `; showing ${offset + 1}–${offset + shown}` : '';
            const lines = [
                `Found ${hits.length} file(s) matching ${JSON.stringify(keyword)} under ${rel} (direct scan — search index is still building${showingSuffix}):`,
                '',
            ];
            if (rebuildSkipped || rebuildFailed) {
                lines.push(rebuildNote, '');
            }
            if (hits.length >= SEARCH_MAX_RESULTS) {
                lines.push(`Results capped at ${SEARCH_MAX_RESULTS}; narrow the keyword or path for more.`);
            }
            if (ignored.length > 0) {
                lines.push(`Note: in direct-scan mode ${ignored.join(', ')} were NOT applied — only the keyword, path, and file types were.`);
            }
            return lines;
        };
        const fitted = fitSearchOutput(headerFor, hitLines, (shown) => `More results available: pass offset ${offset + shown} (limit ${limit}) for the next page.`, hits.length, offset, cap);
        return okResult(fitted.text);
    }
    if (outcome.total === 0) {
        return okResult(withRebuildNote(`No files matching ${JSON.stringify(keyword)} under ${rel}.`));
    }
    const hitLines = outcome.hits.map((hit) => {
        const section = hit.section.length > 0 ? ` [${hit.section}]` : '';
        return `- ${hit.path}${section} (score ${hit.score.toFixed(2)}) — ${hit.snippet}`;
    });
    const fitted = fitSearchOutput((shown) => {
        const showingSuffix = shown > 0 ? ` (showing ${offset + 1}–${offset + shown})` : '';
        const header = [
            `Found ${outcome.total} matching file(s) for ${JSON.stringify(keyword)} under ${rel}${showingSuffix}:`,
            '',
        ];
        if (rebuildSkipped || rebuildFailed) {
            header.push(rebuildNote, '');
        }
        return header;
    }, hitLines, (shown) => `More results available: pass offset ${offset + shown} (limit ${limit}) for the next page.`, outcome.total, offset, cap);
    return okResult(fitted.text);
}
/**
 * Join search output within a byte budget, reserving room for the
 * trailing "More results" line so truncation never eats it — and
 * never eats results the next page would then skip. The header and
 * the "More" line are recomputed from the number of hits actually
 * shown, so the next page's offset advances by the displayed count,
 * not the computed one. The "More" line appears whenever results
 * remain beyond the displayed ones, including results the budget
 * cut off. Returns the fitted text and the shown count.
 */
function fitSearchOutput(headerFor, hitLines, moreFor, total, offset, cap) {
    if (hitLines.length === 0 && total > 0) {
        return {
            text: truncateUtf8([...headerFor(0), `No more results: offset ${offset} is beyond the ${total} matching file(s).`].join('\n'), cap),
            shown: 0,
        };
    }
    // Reserve for the longest plausible "More" line (largest offset);
    // the final line can only be shorter, so the total stays in budget.
    const reserve = hitLines.length > 0
        ? Buffer.byteLength(`\n\n${moreFor(hitLines.length)}`, 'utf8')
        : 0;
    let shown = hitLines.length;
    for (;;) {
        const header = headerFor(shown);
        let text = header.join('\n');
        let bytes = Buffer.byteLength(text, 'utf8');
        let actual = 0;
        for (let i = 0; i < shown; i++) {
            const addition = `\n${hitLines[i]}`;
            if (bytes + Buffer.byteLength(addition, 'utf8') + reserve > cap) {
                break;
            }
            text += addition;
            bytes += Buffer.byteLength(addition, 'utf8');
            actual += 1;
        }
        if (actual === shown) {
            const moreText = total > offset + actual ? `\n\n${moreFor(actual)}` : '';
            return { text: text + moreText, shown: actual };
        }
        shown = actual;
        if (shown === 0) {
            // Even the header alone is too long: truncate it.
            return { text: truncateUtf8(header.join('\n'), cap), shown: 0 };
        }
    }
}
const TAG_REMINDER_MARKER = 'tag-reminder-shown';
const TAG_REMINDER_TIP = 'Tip: you can tag notes with front matter `tags:` or body `#tag`s to find them later.';
// In-process guard for the one-time tag reminder: if the marker file
// cannot be written (unwritable cache dir), the reminder would
// otherwise repeat on every save. Track shown cache dirs so each
// library's tip appears at most once per process (the marker file
// itself is per-library, so the guard is keyed the same way).
const tagTipShownCacheDirs = new Set();
export function escapeImageAlt(alt) {
    return alt.replace(/[\\\]]/g, '\\$&');
}
async function handleSaveFile(ctx, inputPath, content, mode, imageSpecs) {
    // Writes get the cross-platform segment check (reserved names,
    // ADS, trailing dot/space); reads do not, so files synced in
    // under names like `meeting 10:30.md` still open.
    const absolute = await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, inputPath);
    const rel = relOf(ctx, absolute);
    if (rel === '.') {
        throw new MemDriveError('INVALID_PATH', 'save_file needs a file path, not the library root.');
    }
    const lowerRel = rel.toLowerCase();
    if (lowerRel === 'archive' || lowerRel.startsWith('archive/')) {
        throw new MemDriveError('INVALID_ARGUMENT', `Cannot write into archive/ (${rel}). Use restore_file to bring it back first.`);
    }
    if (mode === 'new' && (await ctx.backend.exists(rel))) {
        throw new MemDriveError('ALREADY_EXISTS', `File already exists: ${rel}. Use mode "overwrite" to replace it or "append" to add to it.`);
    }
    const docExt = path.extname(absolute).toLowerCase();
    const docStem = path.basename(absolute, path.extname(absolute));
    const docDirRel = path.dirname(rel) === '.' ? '' : path.dirname(rel).split(path.sep).join('/');
    // 1. Acquire images first (bytes in memory). Failures become notes;
    //    they never block the text save. At most SAVE_MAX_IMAGES specs
    //    are attempted, and everything kept together must fit the
    //    per-save stored-image budget while downloads together must
    //    fit the download-traffic budget. Hitting the count cap or
    //    exhausting the stored budget stops the loop with a note
    //    naming the cap; an exhausted download budget only refuses
    //    further URL fetches, local and clipboard images can still
    //    be acquired.
    const notes = [];
    const acquired = [];
    const budget = {
        storedRemainingBytes: SAVE_IMAGES_MAX_TOTAL_BYTES,
        downloadRemainingBytes: SAVE_IMAGES_MAX_DOWNLOAD_BYTES,
    };
    const specs = imageSpecs ?? [];
    for (let i = 0; i < specs.length; i++) {
        const spec = specs[i];
        if (i >= SAVE_MAX_IMAGES) {
            notes.push(`Image limit reached: only the first ${SAVE_MAX_IMAGES} images were processed; ${specs.length - SAVE_MAX_IMAGES} more image(s) were skipped.`);
            break;
        }
        const result = await acquireImage(spec, budget);
        if (result.ok) {
            acquired.push(result.image);
        }
        else {
            notes.push(`Image ${JSON.stringify(spec)} skipped: ${result.note}`);
        }
        // The stored budget is exhausted: stop the loop instead of
        // producing one refusal note per remaining spec.
        if (budget.storedRemainingBytes <= 0) {
            break;
        }
    }
    // 2. Persist acquired images into the sibling assets/ folder with
    //    unique docname+timestamp names. A failed image write is a note,
    //    not a failed save.
    const savedImages = [];
    if (acquired.length > 0) {
        const assetsRel = docDirRel === '' ? 'assets' : `${docDirRel}/assets`;
        // The doc path was sandbox-checked, but the assets folder was
        // not: a symlink inside the library could point it outside, and
        // the images would be written outside the root. Refuse the
        // images with a note; the text still saves.
        let assetsOk = true;
        try {
            await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, assetsRel);
        }
        catch {
            assetsOk = false;
            notes.push('Images were not stored: the assets folder links outside the library.');
        }
        if (assetsOk) {
            await ctx.backend.ensureDir(assetsRel);
            const stamp = timestampStem(new Date());
            const safeStem = truncateUtf8(docStem, 200);
            for (const image of acquired) {
                const ext = extensionForMime(image.mimeType);
                let candidate = `${safeStem}-${stamp}.${ext}`;
                let attempt = 1;
                while (await ctx.backend.exists(`${assetsRel}/${candidate}`)) {
                    attempt += 1;
                    candidate = `${safeStem}-${stamp}-${attempt}.${ext}`;
                }
                try {
                    await ctx.backend.writeFile(`${assetsRel}/${candidate}`, image.data, 'new');
                    savedImages.push({
                        fileName: candidate,
                        relPath: `${assetsRel}/${candidate}`,
                        alt: image.baseName,
                    });
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    notes.push(`Image ${image.baseName} could not be stored: ${message}`);
                }
            }
        }
    }
    // 3. Build the document body. Markdown references are appended only for
    //    Markdown documents; other formats keep their images in assets/ and the
    //    result text reports their paths.
    let body = content;
    if (savedImages.length > 0 && MARKDOWN_EXTENSIONS.has(docExt)) {
        const refs = savedImages
            .map((img) => `\n![${escapeImageAlt(img.alt)}](assets/${encodeImageSrc(img.fileName)})`)
            .join('');
        body += `${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}${refs}\n`;
    }
    // 4. Write the document. On failure, remove any images just stored so
    //    no dangling references are left behind.
    let created;
    try {
        ({ created } = await ctx.backend.writeFile(rel, Buffer.from(body, 'utf8'), mode));
    }
    catch (error) {
        for (const img of savedImages) {
            try {
                await fs.unlink(path.join(ctx.rootDir, img.relPath));
            }
            catch {
                // Best-effort cleanup only.
            }
        }
        throw error;
    }
    // Tell the index the file changed: the next search refreshes
    // before answering, so a just-saved note is searchable at once.
    ctx.searchIndex.markDirty(rel);
    const lines = [
        `Saved ${rel} (${formatBytes(Buffer.byteLength(body, 'utf8'))}, mode: ${mode}${created ? ', created' : ''}).`,
    ];
    if (savedImages.length > 0) {
        lines.push(`Images stored in assets/: ${savedImages.map((i) => i.fileName).join(', ')}.`);
        if (!MARKDOWN_EXTENSIONS.has(docExt)) {
            lines.push('No image references were appended because the file is not Markdown; the image paths above are the references to use.');
        }
    }
    for (const note of notes) {
        lines.push(`Note: ${note}`);
    }
    // One-time tag reminder per library cache dir (best-effort: a marker
    // check or write failure must never fail the save). Note: the server
    // can only append the tip and instruct the model in the tool description
    // to relay it; it cannot guarantee the model actually says it every time.
    try {
        const cacheDir = resolveIndexCacheDir(ctx.rootRealDir);
        const markerPath = path.join(cacheDir, TAG_REMINDER_MARKER);
        let markerExists = false;
        try {
            await fs.access(markerPath);
            markerExists = true;
        }
        catch {
            markerExists = false;
        }
        if (!markerExists && !tagTipShownCacheDirs.has(cacheDir)) {
            tagTipShownCacheDirs.add(cacheDir);
            lines.push(TAG_REMINDER_TIP);
            await fs.mkdir(cacheDir, { recursive: true });
            await fs.writeFile(markerPath, '', 'utf8');
        }
    }
    catch {
        // Best-effort only; never fail a save over the reminder marker.
    }
    return okResult(lines.join('\n'));
}
/** YAML front-matter block: `---` fence, body, `---` fence. */
const FRONT_MATTER_RE = /^---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/;
/** Unescape a double-quoted YAML scalar's content in a single left-to-right pass. */
function unescapeDoubleQuoted(inner) {
    let out = '';
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (ch === '\\' && i + 1 < inner.length) {
            const next = inner[i + 1];
            if (next === '\\' || next === '"') {
                out += next;
                i++;
                continue;
            }
        }
        out += ch;
    }
    return out;
}
/**
 * Read a tag the way `extractTags` does (trim, strip surrounding
 * quotes, strip a leading `#` marker, trim again) — without the
 * lowercase step, so the stored case is preserved.
 */
function readTag(raw) {
    const trimmed = raw.trim();
    // A matching pair of double quotes is a YAML double-quoted scalar:
    // unescape it in ONE left-to-right pass (`\\` -> `\`, `\"` -> `"`).
    // A single pass matters: two sequential passes would corrupt `\\"`
    // into `"`. Any other `\x` is left intact, so a literal backslash
    // in a hand-written `"a\b"` survives. A matching pair of single
    // quotes is a YAML single-quoted scalar, where `\` is literal:
    // strip the quotes without unescaping.
    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return unescapeDoubleQuoted(trimmed.slice(1, -1)).replace(/^#+/, '').trim();
    }
    if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
        return trimmed.slice(1, -1).replace(/^#+/, '').trim();
    }
    return trimmed.replace(/^['"]|['"]$/g, '').replace(/^#+/, '').trim();
}
/** A tag that can be stored in front matter without breaking the YAML or being dropped on read. */
function isFrontMatterStorable(tag) {
    return (tag.length > 0 &&
        !/[\[\]{}"]/.test(tag) &&
        !/^'|'$/.test(tag) &&
        !/^#/.test(tag) &&
        !/\s#/.test(tag) &&
        !tag.includes(': ') &&
        !tag.startsWith('-') &&
        !tag.endsWith('\\'));
}
function isQuotedStorable(tag) {
    if (tag.length === 0 || tag.includes('"')) {
        return false;
    }
    for (const ch of tag) {
        const code = ch.codePointAt(0);
        if (code < 0x20 && ch !== '\t') {
            return false;
        }
    }
    return true;
}
/** A tag that can appear as a body `#tag` (same shape `extractTags` accepts). */
function isBodyTag(tag) {
    return /^[\p{L}\p{N}_][\p{L}\p{N}_/-]*$/u.test(tag) && /\p{L}/u.test(tag);
}
/** Split the bracketed contents of a flow list, respecting quoted items (`"a,b"` is one item). */
function splitFlowItems(inner) {
    const items = [];
    let cur = '';
    let quote = null;
    for (let i = 0; i < inner.length; i++) {
        const ch = inner[i];
        if (quote === '"') {
            // Inside double quotes a backslash escapes the next character.
            cur += ch;
            if (ch === '\\' && i + 1 < inner.length) {
                cur += inner[i + 1];
                i++;
            }
            else if (ch === '"') {
                quote = null;
            }
        }
        else if (quote !== null) {
            cur += ch;
            if (ch === quote) {
                quote = null;
            }
        }
        else if (ch === '"' || ch === "'") {
            quote = ch;
            cur += ch;
        }
        else if (ch === ',') {
            items.push(cur);
            cur = '';
        }
        else {
            cur += ch;
        }
    }
    items.push(cur);
    return items;
}
/** Quote a flow-list item when a comma or single quote inside it would break parsing on read. */
function quoteFlowItem(item) {
    return item.includes(',') || item.includes("'")
        ? '"' + item.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
        : item;
}
function quoteBlockItem(tag) {
    return isFrontMatterStorable(tag)
        ? tag
        : '"' + tag.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}
/** The line ending of a line ('' when the line is the last one and has none). */
function lineEnding(line) {
    if (line.endsWith('\r\n')) {
        return '\r\n';
    }
    if (line.endsWith('\n')) {
        return '\n';
    }
    return '';
}
function parseFmTags(fmBody) {
    const lines = fmBody.split(/(?<=\n)/);
    const none = {
        form: 'none',
        tags: [],
        lineIndex: -1,
        suffix: '',
        blockItems: [],
    };
    let lineIndex = -1;
    let rest = '';
    for (let i = 0; i < lines.length; i++) {
        const m = /^tags:([ \t]*)(.*)$/.exec(lines[i].replace(/\r?\n$/, ''));
        if (m !== null) {
            lineIndex = i;
            const leadWs = m[1] ?? '';
            const afterWs = m[2] ?? '';
            rest = afterWs.startsWith('#') ? `${leadWs || ' '}${afterWs}` : afterWs;
            break;
        }
    }
    if (lineIndex === -1) {
        return none;
    }
    const value = rest.trim();
    if (value.startsWith('[')) {
        // Flow list. A `#` inside the brackets is a tag character, not
        // a comment — only a `#` after the closing `]` starts one (same
        // rule `extractTags` uses).
        const bracket = /^\[((?:[^\]"']|"(?:\\.|[^"\\])*"|'[^']*')*)\]/.exec(value);
        if (bracket === null) {
            throw new MemDriveError('INVALID_ARGUMENT', 'The tags line could not be parsed (unclosed "["); fix it manually and retry.');
        }
        const tags = splitFlowItems(bracket[1])
            .map((p) => readTag(p))
            .filter((t) => t.length > 0);
        if (tags.some((t) => !isFrontMatterStorable(t))) {
            throw new MemDriveError('INVALID_ARGUMENT', 'The tags line contains a value that cannot be edited safely; fix it manually and retry.');
        }
        return {
            form: 'flow',
            tags,
            lineIndex,
            suffix: value.slice(bracket[0].length),
            blockItems: [],
        };
    }
    // Block list: the `tags:` line has no value (or only a comment)
    // and `- item` lines follow it. Blank lines inside the block are
    // skipped; the first non-blank, non-item line ends it.
    if (value === '' || value.startsWith('#')) {
        const blockItems = [];
        for (let i = lineIndex + 1; i < lines.length; i++) {
            const rawLine = lines[i];
            const content = rawLine.replace(/\r?\n$/, '');
            if (content.trim() === '') {
                continue;
            }
            const m = /^([ \t]*)-(?:[ \t]+(.*))?$/.exec(content);
            if (m === null) {
                break;
            }
            const indent = m[1];
            const itemText = (m[2] ?? '');
            if (itemText === '') {
                blockItems.push({
                    lineIndex: i,
                    indent,
                    value: '',
                    valueStart: content.length,
                    valueEnd: content.length,
                });
                continue;
            }
            const leadSpaces = itemText.length - itemText.trimStart().length;
            const trimmedItem = itemText.slice(leadSpaces);
            const valueStart = content.indexOf(itemText, indent.length + 1) + leadSpaces;
            // A trailing YAML comment (`- alpha # c1`) is not part of the
            // tag; the `#` must start the value or follow whitespace outside quotes.
            let quote = null;
            let commentIdx = -1;
            for (let j = 0; j < trimmedItem.length; j++) {
                const ch = trimmedItem[j];
                if (quote !== null) {
                    // Inside double quotes a backslash escapes the next
                    // character, so `\"` does not close the quote.
                    if (quote === '"' && ch === '\\') {
                        j++;
                    }
                    else if (ch === quote) {
                        quote = null;
                    }
                }
                else if ((ch === '"' || ch === "'") && j === 0) {
                    // A quote only opens a quoted scalar at the start of the
                    // value (YAML rule): a quote mid-value (the `'` in
                    // `Bob's idea`) is an ordinary character, so a later `#`
                    // still starts a comment.
                    quote = ch;
                }
                else if (ch === '#' &&
                    (j === 0 || trimmedItem[j - 1] === ' ' || trimmedItem[j - 1] === '\t')) {
                    commentIdx = j;
                    break;
                }
            }
            const rawValue = (commentIdx === -1 ? trimmedItem : trimmedItem.slice(0, commentIdx)).trimEnd();
            blockItems.push({
                lineIndex: i,
                indent,
                value: readTag(rawValue),
                valueStart: rawValue.length === 0 ? content.length : valueStart,
                valueEnd: rawValue.length === 0 ? content.length : valueStart + rawValue.length,
            });
        }
        if (blockItems.length > 0) {
            const tags = blockItems.map((b) => b.value).filter((t) => t.length > 0);
            if (tags.some((t) => !isFrontMatterStorable(t) && !isQuotedStorable(t))) {
                throw new MemDriveError('INVALID_ARGUMENT', 'The tags line contains a value that cannot be edited safely; fix it manually and retry.');
            }
            return {
                form: 'block',
                tags,
                lineIndex,
                suffix: '',
                blockItems,
            };
        }
        // Empty `tags:` with no items: a plain empty value (a comment
        // after it is preserved as the suffix).
        return {
            form: 'plain',
            tags: [],
            lineIndex,
            suffix: value.startsWith('#') ? rest : '',
            blockItems: [],
        };
    }
    // Plain value: comma-separated, with an optional trailing comment.
    const commentMatch = /(^|\s)#/.exec(rest);
    const itemsPart = commentMatch === null
        ? rest
        : rest.slice(0, commentMatch.index);
    const suffix = commentMatch === null
        ? ''
        : (commentMatch[1] === '' ? ' ' : '') +
            rest.slice(commentMatch.index);
    const tags = itemsPart
        .split(',')
        .map((p) => readTag(p))
        .filter((t) => t.length > 0);
    if (tags.some((t) => !isFrontMatterStorable(t))) {
        throw new MemDriveError('INVALID_ARGUMENT', 'The tags line contains a value that cannot be edited safely; fix it manually and retry.');
    }
    return { form: 'plain', tags, lineIndex, suffix, blockItems: [] };
}
/** Format a plain `tags:` line, upgrading to flow syntax if any item contains a comma. */
function formatPlainTagsLine(items, suffix, eol) {
    if (items.length === 0) {
        return `tags:${suffix}${eol}`;
    }
    if (items.some((t) => t.includes(','))) {
        return `tags: [${items.map(quoteFlowItem).join(', ')}]${suffix}${eol}`;
    }
    return `tags: ${items.join(', ')}${suffix}${eol}`;
}
/**
 * Apply one tag operation to a front-matter body. Returns the new
 * body, or null when the operation is a no-op (the tag is already
 * there, the tag is not there, or the new name already exists).
 * Only the `tags:` entry changes; every other line is untouched.
 * Throws INVALID_ARGUMENT when the `tags:` line cannot be parsed
 * safely.
 */
function editFrontMatterTags(fmBody, operation, tag, newTag, eol) {
    const entry = parseFmTags(fmBody);
    const lower = tag.toLowerCase();
    const lines = fmBody.split(/(?<=\n)/);
    if (operation === 'add') {
        if (entry.tags.some((t) => t.toLowerCase() === lower)) {
            return null;
        }
        if (entry.form === 'none') {
            // No `tags:` line: insert one right after the opening fence.
            return `tags: [${quoteFlowItem(tag)}]${eol}${fmBody}`;
        }
        if (entry.form === 'flow') {
            const items = [...entry.tags, tag];
            lines[entry.lineIndex] =
                `tags: [${items.map(quoteFlowItem).join(', ')}]${entry.suffix}${lineEnding(lines[entry.lineIndex])}`;
            return lines.join('');
        }
        if (entry.form === 'block') {
            const last = entry.blockItems[entry.blockItems.length - 1];
            const lastHadEnding = lines[last.lineIndex].endsWith('\n');
            // The last item line may be the last line of the front matter
            // (no ending): give it one first, or the insert runs together.
            if (!(lines[last.lineIndex].endsWith('\n'))) {
                lines[last.lineIndex] = `${lines[last.lineIndex]}${eol}`;
            }
            lines.splice(last.lineIndex + 1, 0, lastHadEnding ? `${last.indent}- ${quoteBlockItem(tag)}${eol}` : `${last.indent}- ${quoteBlockItem(tag)}`);
            return lines.join('');
        }
        // Plain value (possibly empty): rebuild the line.
        const items = [...entry.tags, tag];
        lines[entry.lineIndex] = formatPlainTagsLine(items, entry.suffix, lineEnding(lines[entry.lineIndex]));
        return lines.join('');
    }
    if (operation === 'remove') {
        if (!entry.tags.some((t) => t.toLowerCase() === lower)) {
            return null;
        }
        if (entry.form === 'flow') {
            const items = entry.tags.filter((t) => t.toLowerCase() !== lower);
            lines[entry.lineIndex] =
                `tags: [${items.map(quoteFlowItem).join(', ')}]${entry.suffix}${lineEnding(lines[entry.lineIndex])}`;
            return lines.join('');
        }
        if (entry.form === 'block') {
            const matches = entry.blockItems.filter((b) => b.value.toLowerCase() === lower);
            if (matches.length === 0) {
                return null;
            }
            for (let i = matches.length - 1; i >= 0; i--) {
                const item = matches[i];
                const wasLastNoEnding = item.lineIndex === lines.length - 1 &&
                    !(lines[item.lineIndex].endsWith('\n'));
                lines.splice(item.lineIndex, 1);
                if (wasLastNoEnding && lines.length > 0) {
                    // Removing the last line must not leave a stray blank line
                    // before the closing fence: drop the new last line's ending.
                    const prev = lines[lines.length - 1];
                    lines[lines.length - 1] = prev.replace(/\r?\n$/, '');
                }
            }
            return lines.join('');
        }
        const items = entry.tags.filter((t) => t.toLowerCase() !== lower);
        lines[entry.lineIndex] = formatPlainTagsLine(items, entry.suffix, lineEnding(lines[entry.lineIndex]));
        return lines.join('');
    }
    // Rename.
    const newLower = newTag.toLowerCase();
    if (!entry.tags.some((t) => t.toLowerCase() === lower)) {
        return null;
    }
    if (entry.tags.some((t) => t.toLowerCase() === newLower)) {
        return null;
    }
    if (entry.form === 'flow') {
        const items = entry.tags.map((t) => t.toLowerCase() === lower ? newTag : t);
        lines[entry.lineIndex] =
            `tags: [${items.map(quoteFlowItem).join(', ')}]${entry.suffix}${lineEnding(lines[entry.lineIndex])}`;
        return lines.join('');
    }
    if (entry.form === 'block') {
        const matches = entry.blockItems.filter((b) => b.value.toLowerCase() === lower);
        if (matches.length === 0) {
            return null;
        }
        for (const item of matches) {
            const line = lines[item.lineIndex];
            lines[item.lineIndex] =
                line.slice(0, item.valueStart) + quoteBlockItem(newTag) + line.slice(item.valueEnd);
        }
        return lines.join('');
    }
    const items = entry.tags.map((t) => t.toLowerCase() === lower ? newTag : t);
    lines[entry.lineIndex] = formatPlainTagsLine(items, entry.suffix, lineEnding(lines[entry.lineIndex]));
    return lines.join('');
}
/**
 * Find `#tag` occurrences in body text, excluding fenced code blocks
 * and inline code — the same rules `extractTags` uses, with offsets
 * preserved so the matches can be edited in place.
 */
function scanBodyTags(body) {
    const out = [];
    const lines = body.split(/(?<=\n)/);
    let offset = 0;
    let fence = null;
    for (const line of lines) {
        const lineStart = offset;
        offset += line.length;
        const content = line.replace(/\r?\n$/, '');
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(content);
        if (fence === null) {
            // A backtick fence's info string may not contain a backtick.
            if (m !== null && !(m[1][0] === '`' && m[2].includes('`'))) {
                fence = { ch: m[1][0], len: m[1].length };
                continue;
            }
        }
        else if (m !== null &&
            m[1][0] === fence.ch &&
            m[1].length >= fence.len &&
            m[2].trim() === '') {
            fence = null;
            continue;
        }
        if (fence !== null) {
            continue;
        }
        // Mask inline code with equal-length spaces so offsets survive.
        const scanned = content.replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, (match) => ' '.repeat(match.length));
        for (const match of scanned.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) {
            const tag = match[1];
            if (!/\p{L}/u.test(tag)) {
                continue;
            }
            const hashInLine = match.index + match[0].indexOf('#');
            out.push({
                tag,
                hashIndex: lineStart + hashInLine,
                tagStart: lineStart + hashInLine + 1,
                tagEnd: lineStart + hashInLine + 1 + tag.length,
                lineStart,
                lineEnd: lineStart + line.length,
            });
        }
    }
    return out;
}
/**
 * Apply one tag operation to body text. Returns the new body, or
 * null when the operation is a no-op. Adding appends `#tag` on its
 * own line at the end of the file; removing drops a tag-only line
 * whole and otherwise removes the token plus one adjacent space, so
 * no double space is left behind; renaming replaces every
 * occurrence. Nothing else in the body changes.
 */
function editBodyTags(body, operation, tag, newTag, eol) {
    const lower = tag.toLowerCase();
    const found = scanBodyTags(body);
    if (operation === 'add') {
        if (found.some((f) => f.tag.toLowerCase() === lower)) {
            return null;
        }
        const sep = body.length === 0 ? '' : body.endsWith('\n') ? '' : eol;
        return `${body}${sep}#${tag}${eol}`;
    }
    const targets = found.filter((f) => f.tag.toLowerCase() === lower);
    if (targets.length === 0) {
        return null;
    }
    if (operation === 'rename') {
        const newLower = newTag.toLowerCase();
        if (found.some((f) => f.tag.toLowerCase() === newLower)) {
            return null;
        }
    }
    const lines = body.split(/(?<=\n)/);
    const lineStarts = [];
    let off = 0;
    for (const line of lines) {
        lineStarts.push(off);
        off += line.length;
    }
    const byLine = new Map();
    for (const t of targets) {
        const idx = lineStarts.indexOf(t.lineStart);
        if (!byLine.has(idx)) {
            byLine.set(idx, []);
        }
        byLine.get(idx).push(t);
    }
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const ts = byLine.get(i);
        if (ts === undefined) {
            out.push(line);
            continue;
        }
        const ls = lineStarts[i];
        if (operation === 'rename') {
            let newLine = line;
            const sorted = [...ts].sort((a, b) => b.tagStart - a.tagStart);
            for (const t of sorted) {
                const s = t.tagStart - ls;
                const e = t.tagEnd - ls;
                newLine = newLine.slice(0, s) + newTag + newLine.slice(e);
            }
            out.push(newLine);
            continue;
        }
        // Remove: right-to-left, token plus one adjacent space.
        let newLine = line;
        const sorted = [...ts].sort((a, b) => b.hashIndex - a.hashIndex);
        for (const t of sorted) {
            const hs = t.hashIndex - ls;
            const te = t.tagEnd - ls;
            const contentEnd = newLine.replace(/\r?\n$/, '').length;
            if (te < contentEnd &&
                (newLine[te] === ' ' || newLine[te] === '\t')) {
                newLine = newLine.slice(0, hs) + newLine.slice(te + 1);
            }
            else if (hs > 0 &&
                (newLine[hs - 1] === ' ' || newLine[hs - 1] === '\t')) {
                newLine = newLine.slice(0, hs - 1) + newLine.slice(te);
            }
            else {
                newLine = newLine.slice(0, hs) + newLine.slice(te);
            }
        }
        // A line left with nothing but whitespace was a tag-only line:
        // drop it whole instead of leaving a blank line behind.
        if (newLine.replace(/\r?\n$/, '').trim() === '') {
            if (i === lines.length - 1 && !line.endsWith('\n') && out.length > 0) {
                const prev = out[out.length - 1];
                out[out.length - 1] = prev.replace(/\r?\n$/, '');
            }
            continue;
        }
        out.push(newLine);
    }
    return out.join('');
}
/** The tags a file carries in one location (lowercased, deduplicated, in order). */
function locationTags(text, location) {
    const fm = FRONT_MATTER_RE.exec(text);
    if (location === 'front_matter') {
        if (fm === null || fm[1] === undefined) {
            return [];
        }
        return [
            ...new Set(parseFmTags(fm[1]).tags.map((t) => t.toLowerCase())),
        ];
    }
    const body = fm === null ? text : text.slice(fm.index + fm[0].length);
    return [...new Set(scanBodyTags(body).map((m) => m.tag.toLowerCase()))];
}
async function handleEditTags(ctx, inputPath, operation, tag, newTag, location) {
    // Writes get the cross-platform segment check, like save_file.
    const absolute = await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, inputPath);
    const rel = relOf(ctx, absolute);
    if (rel === '.') {
        throw new MemDriveError('INVALID_PATH', 'edit_tags needs a file path, not the library root.');
    }
    const lowerRel = rel.toLowerCase();
    if (lowerRel === 'archive' || lowerRel.startsWith('archive/')) {
        throw new MemDriveError('INVALID_ARGUMENT', `Cannot edit a file inside archive/ (${rel}). Use restore_file to bring it back first.`);
    }
    const stat = await ctx.backend.stat(rel);
    if (stat === null) {
        throw new NotFoundError(`File not found: ${rel}`);
    }
    if (stat.isDirectory) {
        throw new MemDriveError('NOT_A_FILE', `${rel} is a directory. Use list_directory to see its contents.`);
    }
    if (stat.size > MAX_READ_FILE_BYTES) {
        throw new MemDriveError('FILE_TOO_LARGE', `${rel} is too large to edit (${formatBytes(stat.size)}; limit is ${formatBytes(MAX_READ_FILE_BYTES)}).`);
    }
    const data = await ctx.backend.readFile(rel);
    if (looksBinary(data)) {
        throw new MemDriveError('BINARY_FILE', `${rel} looks like a binary file (not text, image, or SVG). MemDrive reads text and images only.`);
    }
    const hasBom = data.length >= 3 &&
        data[0] === 0xef &&
        data[1] === 0xbb &&
        data[2] === 0xbf;
    const text = decodeText(data, rel);
    const cleanTag = tag.trim().replace(/^#+/, '').trim();
    if (cleanTag.length === 0 || /[\r\n]/.test(cleanTag)) {
        throw new MemDriveError('INVALID_ARGUMENT', 'Provide a tag name (without the leading "#").');
    }
    let cleanNew;
    if (operation === 'rename') {
        if (newTag === undefined) {
            throw new MemDriveError('INVALID_ARGUMENT', 'Renaming a tag needs new_tag.');
        }
        cleanNew = newTag.trim().replace(/^#+/, '').trim();
        if (cleanNew.length === 0 || /[\r\n]/.test(cleanNew)) {
            throw new MemDriveError('INVALID_ARGUMENT', 'Provide a new tag name (without the leading "#").');
        }
    }
    // What gets written is validated strictly; what is looked up is
    // lenient (a tag that cannot be there is simply not there).
    if (location === 'front_matter') {
        if (operation === 'add' && !isFrontMatterStorable(cleanTag)) {
            throw new MemDriveError('INVALID_ARGUMENT', `Tag ${JSON.stringify(cleanTag)} cannot be stored in front matter (it contains [, ], {, }, ", leading/trailing ', leading #, or whitespace followed by #).`);
        }
        if (cleanNew !== undefined && !isFrontMatterStorable(cleanNew)) {
            throw new MemDriveError('INVALID_ARGUMENT', `Tag ${JSON.stringify(cleanNew)} cannot be stored in front matter (it contains [, ], {, }, ", leading/trailing ', leading #, or whitespace followed by #).`);
        }
    }
    else {
        if (operation === 'add' && !isBodyTag(cleanTag)) {
            throw new MemDriveError('INVALID_ARGUMENT', `Tag ${JSON.stringify(cleanTag)} is not a valid body #tag (letters, digits, _, / and - only, cannot start with -, and must contain a letter).`);
        }
        if (cleanNew !== undefined && !isBodyTag(cleanNew)) {
            throw new MemDriveError('INVALID_ARGUMENT', `Tag ${JSON.stringify(cleanNew)} is not a valid body #tag (letters, digits, _, / and - only, cannot start with -, and must contain a letter).`);
        }
    }
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const locLabel = location === 'front_matter' ? 'front matter' : 'body';
    const beforeTags = locationTags(text, location);
    const fm = FRONT_MATTER_RE.exec(text);
    let newText = null;
    if (location === 'front_matter') {
        if (fm === null) {
            // No front matter: only adding creates one (a minimal block).
            if (operation === 'add') {
                newText = `---${eol}tags: [${quoteFlowItem(cleanTag)}]${eol}---${eol}${text}`;
            }
        }
        else if (fm[1] === undefined) {
            // Empty `---\n---` front matter: insert the tags line between the fences.
            if (operation === 'add') {
                const bodyStart = text.indexOf('\n') + 1;
                newText = `${text.slice(0, bodyStart)}tags: [${quoteFlowItem(cleanTag)}]${eol}${text.slice(bodyStart)}`;
            }
        }
        else {
            const fmBody = fm[1];
            const bodyStart = text.indexOf('\n') + 1;
            const bodyEnd = bodyStart + fmBody.length;
            const edited = editFrontMatterTags(fmBody, operation, cleanTag, cleanNew, eol);
            if (edited !== null) {
                newText = text.slice(0, bodyStart) + edited + text.slice(bodyEnd);
            }
        }
    }
    else {
        const bodyStart = fm === null ? 0 : fm.index + fm[0].length;
        const body = text.slice(bodyStart);
        const edited = editBodyTags(body, operation, cleanTag, cleanNew, eol);
        if (edited !== null) {
            const prefix = text.slice(0, bodyStart);
            const sep = prefix.length > 0 && !prefix.endsWith('\n') ? eol : '';
            newText = prefix + sep + edited;
        }
    }
    const tagList = (tags) => tags.length > 0 ? tags.join(', ') : '(none)';
    if (newText === null) {
        let reason;
        if (operation === 'add') {
            reason = `"${cleanTag}" is already in the ${locLabel} tags of ${rel}`;
        }
        else if (operation === 'remove') {
            reason = `"${cleanTag}" is not in the ${locLabel} tags of ${rel}`;
        }
        else if (!beforeTags.includes(cleanTag.toLowerCase())) {
            reason = `"${cleanTag}" is not in the ${locLabel} tags of ${rel}`;
        }
        else {
            reason = `"${cleanNew}" is already in the ${locLabel} tags of ${rel}, so "${cleanTag}" was not renamed`;
        }
        return okResult(`No change: ${reason}. Tags now: ${tagList(beforeTags)}.`);
    }
    const outText = hasBom ? `\uFEFF${newText}` : newText;
    await ctx.backend.writeFile(rel, Buffer.from(outText, 'utf8'), 'overwrite');
    // Tell the index the file changed: the next search refreshes
    // before answering, so the new tags are searchable at once.
    ctx.searchIndex.markDirty(rel);
    const afterTags = locationTags(newText, location);
    const verb = operation === 'add'
        ? `added "${cleanTag}"`
        : operation === 'remove'
            ? `removed "${cleanTag}"`
            : `renamed "${cleanTag}" to "${cleanNew}"`;
    return okResult(`Updated tags in ${rel} (${locLabel}): ${verb}. Tags now: ${tagList(afterTags)}.`);
}
/**
 * Resolve an image reference to an absolute on-disk path. Obsidian
 * embeds (`![[pic.png]]`) resolve by filename across the whole
 * library via the index (vault-root first, then note-relative, then
 * suffix); the rest resolve relative to the note's directory, as
 * before. Returns the absolute path, or a human-readable reason
 * when the reference cannot be resolved.
 */
async function resolveImageAbs(ctx, noteRel, noteAbs, ref) {
    if (ref.kind === 'obsidian') {
        const resolved = await ctx.searchIndex
            .resolveNoteImageRef(noteRel, ref)
            .catch((error) => {
            // A backend stat failure (EACCES/EIO) must not fail the whole
            // note read: report the image as skipped with a reason, the
            // same way a broken ref is reported.
            const message = error instanceof Error ? error.message : String(error);
            return { reason: message };
        });
        if ('reason' in resolved) {
            return resolved;
        }
        if (resolved.status === 'ok') {
            return { abs: path.resolve(ctx.rootDir, ...resolved.path.split('/')) };
        }
        if (resolved.status === 'ambiguous') {
            return { reason: `matches several files: ${resolved.candidates.join(', ')}` };
        }
        return { reason: 'not found in the library' };
    }
    // Non-Obsidian refs resolve relative to the note's directory, or
    // from the library root when they start with `/`. Normalize
    // backslashes first (same as resolveImageRef): a note synced from
    // Windows carries `assets\pic.png`, and on macOS/Linux
    // `path.resolve` treats `\` as an ordinary filename character, so
    // the image would report ENOENT while diagnostics (which
    // normalizes) calls it valid.
    const src = ref.src.replace(/\\/g, '/');
    const decoded = decodeUserPath(src);
    const toAbs = (p) => p.startsWith('/')
        ? path.resolve(ctx.rootDir, ...p.replace(/^\/+/, '').split('/'))
        : path.resolve(path.dirname(noteAbs), p);
    // Prefer the literal path when it exists (a file can legitimately
    // contain `%` in its name); otherwise use the decoded form.
    if (decoded !== src) {
        const rawAbs = toAbs(src);
        try {
            const rawRel = relOf(ctx, rawAbs);
            if (isInside(ctx.rootDir, rawAbs) &&
                (await ctx.backend.exists(rawRel === '.' ? '' : rawRel))) {
                return { abs: rawAbs };
            }
        }
        catch {
            // Fall through to the decoded form.
        }
    }
    return { abs: toAbs(decoded) };
}
/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */
async function handleReadFile(ctx, inputPath, includeImages) {
    // One total budget governs the whole response: text bytes + base64
    // bytes of every image block, counted together. Text is guaranteed
    // first; images share only what the text leaves. An image that does
    // not fit is downscaled to the remaining budget or skipped with a
    // note — the read as a whole never fails because of an image, and
    // the file on disk is never modified.
    const budget = responseBudgetBytes();
    const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath);
    const rel = relOf(ctx, absolute);
    const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
    if (stat === null) {
        throw new NotFoundError(`File not found: ${rel}`);
    }
    if (stat.isDirectory) {
        throw new MemDriveError('NOT_A_FILE', `${rel} is a directory. Use list_directory to see its contents.`);
    }
    if (stat.size > MAX_READ_FILE_BYTES) {
        throw new MemDriveError('FILE_TOO_LARGE', `${rel} is too large to read (${formatBytes(stat.size)}; limit is ${formatBytes(MAX_READ_FILE_BYTES)}).`);
    }
    const data = await ctx.backend.readFile(rel === '.' ? '' : rel);
    const ext = path.extname(absolute).toLowerCase();
    // Direct image read: this one image gets the whole budget. It is
    // returned untouched when it fits, and downscaled in memory only
    // when the image itself exceeds the budget (or the per-image cap).
    const directImageMime = ext === SVG_EXTENSION
        ? null
        : (mimeFromExtension(absolute) ?? (ext === '' ? detectImageMime(data) : null));
    if (directImageMime !== null) {
        const mimeType = directImageMime;
        const effectiveCap = Math.min(IMAGE_PREVIEW_MAX_BYTES, maxBinaryForBase64Budget(Math.max(0, budget - DIRECT_IMAGE_HEADER_RESERVE_BYTES)));
        const notReturned = (reason) => okResult(truncateUtf8(`Image: ${rel} (${formatBytes(data.length)} on disk) was not returned as an image: ${reason} The original file was not modified.`, budget));
        let preview = await makePreview(data, mimeType, effectiveCap);
        if (preview === null) {
            return notReturned(`it could not be downscaled to fit the ${formatBytes(budget)} total response budget (format not supported by the built-in decoder, or still over budget at minimum size).`);
        }
        const buildHeader = (shown) => shown.data.length < data.length
            ? `Image: ${rel} (${formatBytes(data.length)} on disk; preview downscaled to ${formatBytes(shown.data.length)} to fit the ${formatBytes(budget)} total response budget, original untouched).`
            : `Image: ${rel} (${formatBytes(data.length)}).`;
        let header = buildHeader(preview);
        let total = utf8Bytes(header) + base64Length(preview.data.length);
        if (total > budget) {
            // The header reserve was too small for this (very long) path:
            // shrink once more by the exact excess, then re-check.
            const excess = total - budget;
            const tighterCap = Math.max(0, effectiveCap - Math.ceil((excess * 3) / 4) - 1024);
            const retry = await makePreview(data, mimeType, tighterCap);
            if (retry === null) {
                return notReturned(`it could not be downscaled to fit the ${formatBytes(budget)} total response budget.`);
            }
            preview = retry;
            header = buildHeader(preview);
            total = utf8Bytes(header) + base64Length(preview.data.length);
            if (total > budget) {
                return notReturned(`it could not be downscaled to fit the ${formatBytes(budget)} total response budget.`);
            }
        }
        const imageBlock = {
            type: 'image',
            data: preview.data.toString('base64'),
            mimeType: preview.mimeType,
        };
        return { content: [textBlock(header), imageBlock] };
    }
    // SVG is XML text: return it as text, never as an image block.
    if (ext === SVG_EXTENSION) {
        const svgText = decodeText(data, rel);
        const svgNotes = [];
        const effectiveTextCap = Math.min(TEXT_MAX_BYTES, budget);
        if (utf8Bytes(svgText) > effectiveTextCap) {
            svgNotes.push(`Text truncated to the ${formatBytes(effectiveTextCap)} read cap; the file on disk is untouched.`);
        }
        return okResult(assembleText(svgText, svgNotes, budget, 0));
    }
    // Everything else must decode as text.
    if (looksBinary(data)) {
        throw new MemDriveError('BINARY_FILE', `${rel} looks like a binary file (not text, image, or SVG). MemDrive reads text and images only.`);
    }
    const fullText = decodeText(data, rel);
    const effectiveTextCap = Math.min(TEXT_MAX_BYTES, budget);
    const notes = [];
    let body = fullText;
    if (utf8Bytes(body) > effectiveTextCap) {
        notes.push(`Text truncated to the ${formatBytes(effectiveTextCap)} read cap; the file on disk is untouched.`);
        body = truncateUtf8(body, effectiveTextCap);
    }
    if (MARKDOWN_EXTENSIONS.has(ext)) {
        // References are scanned from the full text, not the truncated
        // body, so a reference past the truncation point is still listed
        // or attempted (and skipped with a budget note when no room
        // remains) instead of silently disappearing.
        const refs = scanMarkdownImages(fullText);
        if (!includeImages) {
            // Step 1 of two-step reading: text only, plus the list of
            // referenced image paths (library-relative, ready for a direct
            // read_file call each). No image blocks are returned.
            if (refs.length === 0) {
                return okResult(assembleText(body, notes, budget, 0));
            }
            const listed = [];
            const seen = new Set();
            for (const ref of refs) {
                const resolved = await resolveImageAbs(ctx, rel, absolute, ref);
                let line;
                if ('reason' in resolved) {
                    line = `- ${ref.src} (${resolved.reason})`;
                }
                else {
                    const imageAbs = resolved.abs;
                    try {
                        if (!isInside(ctx.rootDir, imageAbs)) {
                            line = `- ${ref.src} (outside the library root — not readable via read_file)`;
                        }
                        else {
                            await assertInsideRealRoot(ctx.rootRealDir, imageAbs);
                            line = `- ${relOf(ctx, imageAbs)}`;
                        }
                    }
                    catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        line = `- ${ref.src} (${message})`;
                    }
                }
                if (!seen.has(line)) {
                    seen.add(line);
                    listed.push(line);
                }
            }
            const listingSection = `\n\n[MemDrive referenced images — read each one separately with read_file on its path for full quality]\n${listed.join('\n')}`;
            const notesSection = notes.length > 0
                ? `\n\n[MemDrive notes]\n${notes.map((n) => `- ${n}`).join('\n')}`
                : '';
            const suffix = notesSection + listingSection;
            if (utf8Bytes(suffix) >= budget) {
                return okResult(truncateUtf8(suffix, budget));
            }
            return okResult(truncateUtf8(body, budget - utf8Bytes(suffix)) + suffix);
        }
        // Markdown, bundled read: text plus every locally-referenced
        // image that fits the remaining budget, in reference order.
        const imageBlocks = [];
        const seenImageRels = new Set();
        let imageBase64Total = 0;
        let included = 0;
        const runningTextBytes = utf8Bytes(body);
        for (const ref of refs) {
            if (included >= READ_MAX_IMAGES) {
                notes.push(`Only the first ${READ_MAX_IMAGES} referenced images were included; the document references more.`);
                break;
            }
            const resolved = await resolveImageAbs(ctx, rel, absolute, ref);
            if ('reason' in resolved) {
                notes.push(`Skipped image ${ref.src}: ${resolved.reason}.`);
                continue;
            }
            const imageAbs = resolved.abs;
            try {
                if (!isInside(ctx.rootDir, imageAbs)) {
                    notes.push(`Skipped image outside the library root: ${ref.src}.`);
                    continue;
                }
                await assertInsideRealRoot(ctx.rootRealDir, imageAbs);
                const imageRel = relOf(ctx, imageAbs);
                if (seenImageRels.has(imageRel)) {
                    continue;
                }
                seenImageRels.add(imageRel);
                const imageStat = await ctx.backend.stat(imageRel === '.' ? '' : imageRel);
                if (imageStat === null) {
                    notes.push(`Skipped image ${ref.src}: it is no longer on disk.`);
                    continue;
                }
                if (imageStat.isDirectory) {
                    notes.push(`Skipped image ${ref.src}: it is a directory, not a file.`);
                    continue;
                }
                if (imageStat.size > MAX_READ_FILE_BYTES) {
                    notes.push(`Skipped image ${ref.src}: it is too large to read (${formatBytes(imageStat.size)}; limit is ${formatBytes(MAX_READ_FILE_BYTES)}).`);
                    continue;
                }
                const imageData = await ctx.backend.readFile(imageRel === '.' ? '' : imageRel);
                const imageExt = path.extname(imageAbs).toLowerCase();
                const mimeType = imageExt === SVG_EXTENSION
                    ? null
                    : (mimeFromExtension(imageAbs) ?? (imageExt === '' ? detectImageMime(imageData) : null));
                if (mimeType === null) {
                    notes.push(`Skipped referenced file with unsupported image type: ${ref.src}.`);
                    continue;
                }
                const currentNotesBytes = notes.length > 0
                    ? utf8Bytes(`\n\n[MemDrive notes]\n${notes.map((n) => `- ${n}`).join('\n')}`)
                    : 0;
                const remaining = budget - runningTextBytes - currentNotesBytes - 256 - imageBase64Total;
                if (remaining <= 0) {
                    notes.push(`Skipped image ${ref.src}: the ${formatBytes(budget)} total response budget is already used by the text. Read it directly with read_file on "${imageRel}" for full quality.`);
                    continue;
                }
                const cap = Math.min(IMAGE_PREVIEW_MAX_BYTES, maxBinaryForBase64Budget(remaining));
                if (cap <= 0) {
                    notes.push(`Skipped image ${ref.src}: no response budget remains after the text. Read it directly with read_file on "${imageRel}" for full quality.`);
                    continue;
                }
                const preview = await makePreview(imageData, mimeType, cap);
                if (preview === null) {
                    notes.push(`Skipped image ${ref.src} (${formatBytes(imageData.length)}): could not be downscaled to fit the remaining response budget; original untouched. Read it directly with read_file on "${imageRel}" — a direct read gives it the whole budget.`);
                    continue;
                }
                const encodedLength = base64Length(preview.data.length);
                if (encodedLength > remaining) {
                    notes.push(`Skipped image ${ref.src}: its downscaled preview still does not fit the remaining response budget; original untouched. Read it directly with read_file on "${imageRel}".`);
                    continue;
                }
                if (preview.data.length < imageData.length) {
                    notes.push(`Image ${ref.src} downscaled in memory to ${formatBytes(preview.data.length)} to fit the response budget; original untouched.`);
                }
                imageBlocks.push({
                    type: 'image',
                    data: preview.data.toString('base64'),
                    mimeType: preview.mimeType,
                });
                imageBase64Total += encodedLength;
                included += 1;
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                notes.push(`Skipped image ${ref.src}: ${message}`);
            }
        }
        return {
            content: [
                textBlock(assembleText(body, notes, budget, imageBase64Total)),
                ...imageBlocks,
            ],
        };
    }
    return okResult(assembleText(body, notes, budget, 0));
}
function decodeText(data, rel) {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(data);
    }
    catch {
        throw new MemDriveError('BINARY_FILE', `${rel} is not valid UTF-8 text. MemDrive reads text and images only.`);
    }
}
/** Truncate text to a byte budget without splitting a UTF-8 sequence. */
function truncateUtf8(text, maxBytes) {
    if (maxBytes <= 0) {
        return '';
    }
    const encoded = new TextEncoder().encode(text);
    if (encoded.length <= maxBytes) {
        return text;
    }
    let end = maxBytes;
    while (end > 0 && encoded[end] >= 0x80 && encoded[end] < 0xc0) {
        end -= 1;
    }
    return new TextDecoder('utf-8').decode(encoded.subarray(0, end));
}
/* ------------------------------------------------------------------ */
/* open_image                                                        */
/* ------------------------------------------------------------------ */
/**
 * Sniff the first bytes of a file for an image signature. Used only
 * when the file extension does not identify an image, so an
 * extensionless image file can still be opened; reading 32 bytes is
 * enough for every signature `detectImageMime` checks.
 */
async function sniffImageMime(absolutePath) {
    let handle = null;
    try {
        handle = await fs.open(absolutePath, 'r');
        const buffer = Buffer.alloc(32);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead === 0) {
            return null;
        }
        return detectImageMime(buffer.subarray(0, bytesRead));
    }
    catch {
        return null;
    }
    finally {
        await handle?.close().catch(() => undefined);
    }
}
async function handleOpenImage(ctx, inputPath) {
    const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath);
    const rel = relOf(ctx, absolute);
    const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
    if (stat === null) {
        throw new NotFoundError(`File not found: ${rel}`);
    }
    if (stat.isDirectory) {
        throw new MemDriveError('NOT_A_FILE', `${rel} is a directory. Use list_directory to see its contents.`);
    }
    // An image is identified by its extension, or — for extensionless
    // files — by its magic bytes. Anything else (text, SVG, binary) is
    // rejected with a short note, never opened: the viewer must only
    // ever receive a file that is actually an image.
    const isImage = mimeFromExtension(absolute) !== null ||
        (path.extname(absolute) === '' && (await sniffImageMime(absolute)) !== null);
    if (!isImage) {
        throw new MemDriveError('NOT_AN_IMAGE', `${rel} is not an image file. open_image opens image files only; use read_file to read it.`);
    }
    const result = await openInViewer(absolute);
    if (result.ok) {
        return okResult(`Opened ${rel} in the system image viewer.`);
    }
    return okResult(`Could not open ${rel} in the system image viewer: ${result.reason} The file was not modified. Open it manually from the library folder instead.`);
}
/* ------------------------------------------------------------------ */
/* open_containing_folder                                              */
/* ------------------------------------------------------------------ */
/**
 * Pure resolution for open_containing_folder: given a sandbox-checked
 * absolute path and whether it is a directory, return the folder to
 * open. A file resolves to its parent directory; a directory resolves
 * to itself; the library root resolves to itself. No filesystem
 * access happens here, so this is directly unit-testable without
 * opening a file manager (see the protocol tests). The caller must
 * already have run the path through `sandboxPath` and checked that
 * it exists.
 */
export function resolveContainingFolder(rootDir, absolutePath, isDirectory) {
    if (absolutePath === rootDir) {
        return rootDir;
    }
    if (isDirectory) {
        return absolutePath;
    }
    return path.dirname(absolutePath);
}
async function handleOpenContainingFolder(ctx, inputPath) {
    const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath ?? '');
    const rel = relOf(ctx, absolute);
    const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
    if (stat === null) {
        throw new NotFoundError(`Path not found: ${rel}`);
    }
    // No image checks, no preview, no highlight/selection: the folder
    // itself is what opens, via the folder launcher in src/viewer.ts
    // (cmd /c start "" explorer.exe /n,<path> on Windows, so it opens
    // a new window instead of a tab in an existing Explorer window).
    const folderAbsolute = resolveContainingFolder(ctx.rootDir, absolute, stat.isDirectory);
    const folderRel = relOf(ctx, folderAbsolute);
    const result = await openFolderInViewer(folderAbsolute);
    if (result.ok) {
        return okResult(`Opened ${folderRel} in the system file manager.`);
    }
    return okResult(`Could not open ${folderRel} in the system file manager: ${result.reason} Nothing was modified. Open the folder manually from the library folder instead.`);
}
/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */
const SAVE_GUIDANCE = [
    'Interaction rule — read before calling:',
    'Before calling this tool, show the user the EXACT destination path and',
    'filename you intend to write (for example: "notes/2026-10-28.md") and',
    'get their explicit confirmation in the chat. Never call save_file with',
    'a path or filename the user has not confirmed. If the user has not',
    'confirmed a location yet, ask them first instead of calling.',
    'There is no popup or confirmation dialog: confirmation happens here,',
    'in the conversation, through you.',
].join('\n');
async function handleArchiveFile(ctx, inputPath) {
    const absolute = await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, inputPath);
    const rel = relOf(ctx, absolute);
    if (rel === '.') {
        throw new MemDriveError('INVALID_ARGUMENT', 'archive_file needs a file path, not the library root.');
    }
    // [Issue 6] Case-insensitive check for top-level archive/
    const lowerRel = rel.toLowerCase();
    if (lowerRel === 'archive' || lowerRel.startsWith('archive/')) {
        throw new MemDriveError('INVALID_ARGUMENT', lowerRel === 'archive'
            ? 'Cannot archive the archive folder itself.'
            : `${rel} is already in archive/.`);
    }
    const stat = await ctx.backend.stat(rel);
    if (stat === null) {
        throw new NotFoundError(`File not found: ${rel}`);
    }
    if (stat.isDirectory) {
        throw new MemDriveError('INVALID_ARGUMENT', `${rel} is a directory. Only files can be archived.`);
    }
    const destRel = `archive/${rel}`;
    const destAbsolute = await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, destRel);
    const cleanDestRel = relOf(ctx, destAbsolute);
    if (await ctx.backend.exists(cleanDestRel)) {
        throw new MemDriveError('ALREADY_EXISTS', `Archive destination already exists: ${cleanDestRel}. Refusing to overwrite.`);
    }
    await ctx.backend.moveFile(rel, cleanDestRel);
    ctx.searchIndex.markDirty(rel);
    return okResult(`Archived ${rel} to ${cleanDestRel}.`);
}
async function handleRestoreFile(ctx, inputPath) {
    const absolute = await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, inputPath);
    const rel = relOf(ctx, absolute);
    // [Issue 6] Case-insensitive check for top-level archive/
    const lowerRel = rel.toLowerCase();
    if (!lowerRel.startsWith('archive/')) {
        throw new MemDriveError('INVALID_ARGUMENT', `restore_file requires a file inside archive/ (got ${rel}).`);
    }
    const destRel = rel.slice('archive/'.length);
    if (destRel.length === 0) {
        throw new MemDriveError('INVALID_ARGUMENT', 'restore_file needs a file path inside archive/, not archive/ itself.');
    }
    const stat = await ctx.backend.stat(rel);
    if (stat === null) {
        throw new NotFoundError(`File not found: ${rel}`);
    }
    if (stat.isDirectory) {
        throw new MemDriveError('INVALID_ARGUMENT', `${rel} is a directory. Only files can be restored.`);
    }
    const destAbsolute = await sandboxPathForWrite(ctx.rootDir, ctx.rootRealDir, destRel);
    const cleanDestRel = relOf(ctx, destAbsolute);
    const lowerDestRel = cleanDestRel.toLowerCase();
    if (lowerDestRel === 'archive' || lowerDestRel.startsWith('archive/')) {
        throw new MemDriveError('INVALID_ARGUMENT', `Cannot restore ${rel} into archive/ (${cleanDestRel}).`);
    }
    if (await ctx.backend.exists(cleanDestRel)) {
        throw new MemDriveError('ALREADY_EXISTS', `Destination already exists: ${cleanDestRel}. Refusing to overwrite.`);
    }
    await ctx.backend.moveFile(rel, cleanDestRel);
    ctx.searchIndex.markDirty(cleanDestRel);
    return okResult(`Restored ${rel} to ${cleanDestRel}.`);
}
export function registerTools(server, backend, rootDir, rootRealDir, searchIndex) {
    const ctx = {
        backend,
        rootDir,
        rootRealDir,
        searchIndex: searchIndex ?? new LocalSearchIndex(rootDir, rootRealDir, backend),
    };
    const wrap = (fn) => fn().catch((error) => {
        if (error instanceof MemDriveError) {
            return errorResult(error.message);
        }
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[memdrive] tool error: ${message}`);
        return errorResult(`Unexpected error: ${message}`);
    });
    server.registerTool('list_directory', {
        description: [
            'List the immediate children (subfolders and files) of a directory inside the MemDrive memory library.',
            'Returns one line per entry with type, size, and modification time. Directories sort first.',
            'Use this to explore what is already stored before reading or saving.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Omit path or pass "" for the root. Absolute paths are accepted only when they stay inside the root.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .optional()
                .describe('Directory to list, relative to the library root. Omit or pass "" for the root.'),
        },
    }, (args) => wrap(() => handleListDirectory(ctx, args.path)));
    server.registerTool('search_files', {
        description: [
            'Search the memory library by keyword, ranked by relevance (full-text index + BM25; Chinese queries are segmented, so 1–2 character terms match).',
            'Returns one hit per matching file (its best-matching chunk) with the file path, section heading, relevance score, and a snippet with the matched term highlighted as **term**. Filename matches are included too: a substring of a filename finds the file, including non-text files such as images. Results are paginated: limit defaults to 20, pass offset for the next page.',
            'Filters: file_types (e.g. [".md"]), tags (a file must carry at least one), date_from/date_to (file date: front matter > filename > modification time; a date-only upper bound covers the whole day), modified_after/modified_before (modification time). exact_phrase requires the phrase to appear verbatim.',
            'diagnostics_only returns a read-only library report (empty files, duplicate content, broken image references, unreferenced attachments older than 24h) and never modifies anything; keyword is not needed for it. rebuild_index forces a full index rebuild first (use after a bulk import or a cache clear).',
            'On the first search after startup the index may still be building in the background; the result then says so and falls back to a direct scan (keyword, path, and file types only — tags, dates, and exact_phrase are not applied there, and the result says so).',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Omit path or pass "" to search the whole library.',
            'Files under the top-level archive/ folder are excluded from search_files — whole-library search and an explicit path: "archive" search both return nothing for them — while list_directory still shows archive/ so archived files remain inspectable.',
        ].join('\n'),
        inputSchema: {
            keyword: z
                .string()
                .optional()
                .describe('Keyword to search for (case-insensitive; Chinese terms are segmented). Required unless diagnostics_only is true.'),
            path: z
                .string()
                .optional()
                .describe('Directory to search under, relative to the library root. Omit or pass "" for the whole library.'),
            file_types: z
                .array(z.string())
                .optional()
                .describe('File extensions to include, e.g. [".md", ".txt"]. Omit for all types.'),
            tags: z
                .array(z.string())
                .optional()
                .describe('A file must carry at least one of these tags (YAML front matter `tags:` or body `#tag`). Omit for all.'),
            date_from: z
                .string()
                .optional()
                .describe('Earliest file date (ISO date, e.g. "2026-01-01"). File date is front matter date, then filename date, then modification time. A date-only value means that calendar day in the server\'s local timezone.'),
            date_to: z
                .string()
                .optional()
                .describe('Latest file date (ISO date, e.g. "2026-12-31"). A date-only value covers that whole calendar day in the server\'s local timezone.'),
            modified_after: z
                .string()
                .optional()
                .describe('Earliest modification time (ISO date). A date-only value means the start of that calendar day in the server\'s local timezone.'),
            modified_before: z
                .string()
                .optional()
                .describe('Latest modification time (ISO date). A date-only value covers that whole calendar day in the server\'s local timezone.'),
            exact_phrase: z
                .string()
                .optional()
                .describe('Phrase that must appear verbatim in a matching chunk (in addition to the keyword).'),
            limit: z
                .number()
                .int()
                .min(1)
                .max(SEARCH_MAX_RESULTS)
                .optional()
                .describe('Maximum files to return (default 20, max 200).'),
            offset: z
                .number()
                .int()
                .min(0)
                .optional()
                .describe('Files to skip for pagination (default 0).'),
            rebuild_index: z
                .boolean()
                .optional()
                .describe('Force a full index rebuild before searching (default false).'),
            diagnostics_only: z
                .boolean()
                .optional()
                .describe('Return the read-only library diagnostics report instead of searching (default false).'),
        },
    }, (args) => wrap(() => handleSearchFiles(ctx, args.keyword ?? '', args.path, {
        fileTypes: args.file_types,
        tags: args.tags,
        dateFrom: args.date_from,
        dateTo: args.date_to,
        modifiedAfter: args.modified_after,
        modifiedBefore: args.modified_before,
        exactPhrase: args.exact_phrase,
        limit: args.limit,
        offset: args.offset,
        rebuildIndex: args.rebuild_index,
        diagnosticsOnly: args.diagnostics_only,
    })));
    server.registerTool('save_file', {
        description: [
            'CLIPBOARD FIRST — READ THIS BEFORE ANYTHING ELSE: When the user says to save a screenshot or an image from the clipboard — for example "把截图存下来", "把剪贴板里的图存下来", "save the screenshot", or any equivalent wording — pass images: ["clipboard"]. That is all it takes: the server reads the clipboard directly on the user\'s own machine. You do NOT need to see the clipboard or the image. NEVER ask the user to paste, upload, or send the image into the chat. NEVER say you cannot read the clipboard, that you cannot see images, or that this memory library can only store text. If the clipboard holds no image, the server reports that in the result and the text is still saved — tell the user to take the screenshot again and retry; do not invent a clipboard failure.',
            SAVE_GUIDANCE,
            'Save text (usually Markdown) into the MemDrive memory library.',
            'Modes: "new" (default) fails when the file already exists; "overwrite" replaces it; "append" adds to the end, creating the file when missing. Parent directories are created automatically.',
            'Tags: two syntaxes are supported — YAML front matter `tags:` (inline `[a, b]` or block `- a`) and body `#tag`. Proactively suggest adding tags ONLY in these three cases: (1) the user mentions a category or topic while saving (e.g. saving a work plan); (2) the note clearly belongs to a tag already used in the library; (3) the user saves several notes on the same topic in a row (ask once, e.g. whether to tag all of them X). NEVER ask about tags for quick screenshot/clipboard saves, when the user only said "save it" with no topic signal, or after you already asked once in this conversation and the user ignored it or said no. When the user explicitly asks to save with tags, just save with those tags — none of the rules above apply. If the tool result includes a `Tip:` line about tagging, you MUST say that tip to the user.',
            'Images: pass an "images" array with any mix of the literal string "clipboard" (capture the latest screenshot from the OS clipboard — see the clipboard rule above), local file paths, or http(s) image URLs. Images are copied/downloaded/captured into a sibling assets/ folder, renamed "<document-name>-<timestamp>.<ext>", and for Markdown files a standard image reference is appended to the document automatically. The on-disk original is always kept at full quality; only the preview handed to a model is ever downscaled.',
            'Clipboard behavior: when the clipboard is empty or holds text instead of an image, the text is still saved and the result explains what to do (re-screenshot). Clipboard capture never crashes the server; in headless environments it reports itself as unsupported and suggests a file path or URL instead.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root. The root is a hard sandbox: "../" escapes and symlinks pointing outside are rejected.',
            'Path cleaning: surrounding quotes are stripped, a leading ~ expands to the home directory, and separators are normalized.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .min(1)
                .describe('Destination file path, relative to the library root (for example "notes/2026-10-28.md"). Must be confirmed with the user before calling.'),
            content: z.string().describe('Text content to save (usually Markdown).'),
            mode: z
                .enum(['new', 'overwrite', 'append'])
                .optional()
                .describe('Write mode: "new" (default, fails if the file exists), "overwrite", or "append".'),
            images: z
                .array(z.string())
                .optional()
                .describe('Images to archive with the document — CLIPBOARD FIRST: the literal string "clipboard" captures the latest screenshot/image from the OS clipboard on the machine running the server. Use it whenever the user mentions a screenshot or the clipboard: never ask them to paste the image into the chat, and never claim the clipboard cannot be read. Local file paths and http(s) image URLs are also accepted.'),
        },
    }, (args) => wrap(() => handleSaveFile(ctx, args.path, args.content, args.mode ?? 'new', args.images)));
    server.registerTool('edit_tags', {
        description: [
            'Edit the tags on an existing note: add one tag, remove one tag, or rename one tag. One operation per call.',
            'Tags live in two places: YAML front matter `tags:` (inline `[a, b]` or block `- a`) and body `#tag`s. The location parameter picks which one to edit (default front_matter).',
            'Only the tag lines change: the rest of the file is left byte-for-byte identical (no reflow, no other front-matter field touched). Adding a tag to a note with no front matter creates a minimal `---\\ntags: [tag]\\n---` block at the top; adding a body tag appends `#tag` on its own line at the end of the file.',
            'No-ops are not errors: adding a tag that is already there, removing one that is not there, and renaming to a name that already exists all succeed with a "No change" result. Tag names are case-insensitive.',
            'The search index is updated at once, so the note is searchable by its new tags immediately.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root. The root is a hard sandbox: "../" escapes and symlinks pointing outside are rejected.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .min(1)
                .describe('Note to edit, relative to the library root (for example "notes/2026-10-28.md").'),
            operation: z
                .enum(['add', 'remove', 'rename'])
                .describe('One operation per call: "add" adds tag, "remove" removes tag, "rename" renames tag to new_tag.'),
            tag: z
                .string()
                .min(1)
                .describe('The tag to add, remove, or rename (without the leading "#").'),
            new_tag: z
                .string()
                .optional()
                .describe('Required for "rename": the new tag name. Ignored for "add" and "remove".'),
            location: z
                .enum(['front_matter', 'body'])
                .optional()
                .describe('Which tag syntax to edit: "front_matter" (default, YAML `tags:`) or "body" (`#tag`s in the text).'),
        },
    }, (args) => wrap(() => handleEditTags(ctx, args.path, args.operation, args.tag, args.new_tag, args.location ?? 'front_matter')));
    server.registerTool('archive_file', {
        description: [
            'Move a file into the top-level `archive/` folder, preserving its relative path (`notes/foo.md` becomes `archive/notes/foo.md`).',
            'Archiving is recoverable and is the default way to retire old or superseded files instead of deleting them. Use `restore_file` to move an archived file back.',
            'Files in `archive/` are excluded from `search_files`, while `list_directory` still shows `archive/` so archived files remain inspectable.',
            'Refuses to overwrite if the destination under `archive/` already exists, and rejects directories, missing files, `archive/` itself, or files already inside `archive/`.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root. The root is a hard sandbox: "../" escapes and symlinks pointing outside are rejected.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .min(1)
                .describe('File to archive, relative to the library root (for example "notes/2026-10-28.md").'),
        },
    }, (args) => wrap(() => handleArchiveFile(ctx, args.path)));
    server.registerTool('restore_file', {
        description: [
            'Restore an archived file from the top-level `archive/` folder back to its original path (for example `archive/notes/foo.md` becomes `notes/foo.md`).',
            'The search index is updated immediately so the restored file is searchable again.',
            'Refuses to overwrite if a file already exists at the original path, and rejects directories, missing files, or paths not inside `archive/`.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root. The root is a hard sandbox: "../" escapes and symlinks pointing outside are rejected.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .min(1)
                .describe('Archived file to restore, relative to the library root — must start with "archive/" (for example "archive/notes/2026-10-28.md").'),
        },
    }, (args) => wrap(() => handleRestoreFile(ctx, args.path)));
    server.registerTool('plan_cleanup', {
        description: [
            'Generate a read-only cleanup plan for the library (two-step confirmation). Scans the library and proposes file actions — archiving empty files, duplicate files and orphan attachments — but changes nothing.',
            'Returns a plan ID and a human-readable preview. The plan is also saved as JSON in the per-library cache dir (plan-<id>.json) for the `apply_plan` tool or the `memdrive-mcp apply <plan-id>` command.',
            'Empty files, duplicates and orphan attachments are all proposed for archiving (recoverable); nothing is ever permanently deleted. Broken image references are listed as notes, not actions. Similar content is never proposed — only exact SHA-256 duplicates.',
            'This tool never modifies any file.',
        ].join('\n'),
        inputSchema: {},
    }, (_args) => wrap(() => handlePlanCleanup(ctx)));
    server.registerTool('apply_plan', {
        description: [
            'Execute a cleanup plan created by plan_cleanup, by its plan ID. Archives each action in the plan (empty files, duplicate files, orphan attachments) after re-verifying it; nothing is ever permanently deleted.',
            'Before executing, each action is re-verified against the library: the path must still exist, the SHA-256 and modification time must match the plan, and the reason must still hold (empty file still empty, duplicate group still intact, orphan still unreferenced). Actions that no longer hold are skipped with the reason, and the rest still execute.',
            'Plans older than 7 days are rejected. A plan ID that does not exist or is malformed is reported, and nothing is changed. The search index is rebuilt after execution.',
            'Use this when the user asks to execute a plan in chat (for example "执行这个清理计划"). The command-line `memdrive-mcp apply <plan-id>` does the same thing from a terminal.',
            'Never call this tool automatically right after plan_cleanup. Always show the user the plan preview and plan ID first and wait for their explicit confirmation in the chat before calling.',
        ].join('\n'),
        inputSchema: {
            plan_id: z
                .string()
                .min(1)
                .describe('Plan ID returned by plan_cleanup (for example "20261114054412-c4ad79").'),
        },
    }, (args) => wrap(() => handleApplyPlan(ctx, args.plan_id)));
    server.registerTool('read_file', {
        description: [
            'Read a file from the MemDrive memory library.',
            'TOTAL RESPONSE BUDGET — THREE LIMITS ON THREE DIFFERENT LAYERS. (1) HOST: the MCP host rejects a whole tool result over about 1 MB ("Tool result is too large. Maximum size is 1MB"), a host limit outside this server and separate from the model context window. (2) SERVER: text bytes plus base64 image bytes in one response must fit a single total budget — default 950,000 bytes, overridable with MEMDRIVE_RESPONSE_BUDGET_BYTES (clamped to 100,000–50,000,000). Text is guaranteed first; images share what remains and are downscaled in memory (trying higher JPEG quality before shrinking dimensions) or skipped with a note so a read never fails over an image and the file on disk is never modified. read_file returns a preview that fits the budget; to view the original image on disk, use open_image (only when the user asks). (3) MODEL: the model converts image pixels into tokens under its own limits, unrelated to the byte limits above.',
            'TWO-STEP READING — USE THIS WHENEVER A DOCUMENT REFERENCES SEVERAL IMAGES, OR ONE LARGE IMAGE: Step 1, call read_file with include_images=false to read the text and get the list of referenced image paths. Step 2, call read_file once per referenced image, passing that image path itself as path, so the image alone gets the whole response budget and keeps the best quality the budget allows. Reading an image file directly is also limited by the same total budget: a single image is returned untouched when it fits, and downscaled in memory only when the image itself exceeds the budget.',
            'Text files: returned as text (truncated at the smaller of the 1 MB text cap and the total budget, with a note when truncated).',
            'Markdown files: with include_images=true (the default), the text is returned TOGETHER WITH every locally-referenced image that fits the remaining budget in the same response — each image becomes an image content block, so the model sees words and pictures together. Remote (http) and data: images are skipped with a note. Images over the 3.5 MB preview cap are downscaled in memory only; the file on disk is never modified.',
            'Image files: returned as a single image content block (downscaled in memory only when over the preview cap or the total budget). If an image cannot be fitted within the budget at all, the result is text explaining that, not an error — the original is untouched.',
            'SVG files are returned as text (they are XML), never as image blocks.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .min(1)
                .describe('File to read, relative to the library root (for example "notes/2026-10-28.md").'),
            include_images: z
                .boolean()
                .optional()
                .describe('For Markdown files: true (default) returns the text together with its referenced images, within the total response budget; false returns text only plus the list of referenced image paths (step 1 of two-step reading). Ignored for non-Markdown files.'),
        },
    }, (args) => wrap(() => handleReadFile(ctx, args.path, args.include_images ?? true)));
    server.registerTool('open_image', {
        description: [
            'Open an image file from the MemDrive memory library in the operating system\'s default image viewer (Photos on Windows/macOS, the default viewer on Linux), at full original quality.',
            'USE ONLY WHEN THE USER EXPLICITLY ASKS TO VIEW THE ORIGINAL IMAGE — for example "open this image", "show me the original", or "在系统里打开这张图". NEVER call open_image automatically after a read_file, a save_file, or any other tool call, and never open an image the user has not asked to view. Opening a viewer window is a visible side effect on the user\'s screen; the model must not cause it unprompted.',
            'The image itself is never returned to the model: the result is only a short text confirmation (or a note when no viewer is available, for example on a headless machine). To see the picture in the conversation, use read_file on the image path instead.',
            'Only image files inside the library root can be opened. Non-image files, directories, missing files, and paths escaping the root are rejected with a note. The file on disk is never modified.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .min(1)
                .describe('Image file to open, relative to the library root (for example "notes/assets/shot-20261028-120000-000.png"). Only call this when the user explicitly asked to view the original image.'),
        },
    }, (args) => wrap(() => handleOpenImage(ctx, args.path)));
    server.registerTool('open_containing_folder', {
        description: [
            'Open the folder containing a file or directory from the MemDrive memory library in the operating system\'s file manager (Explorer on Windows, Finder on macOS, the default file manager on Linux). A file opens its parent folder; a folder opens itself; an empty path opens the whole library root. The folder is opened without highlighting or selecting any file.',
            'USE ONLY WHEN THE USER EXPLICITLY ASKS TO OPEN THE FOLDER — for example "open the folder", "show me this note in the file manager", or "在系统里打开这个笔记所在的文件夹". NEVER call open_containing_folder automatically after a read_file, a save_file, or any other tool call, and never open a folder the user has not asked to open. Opening a file manager window is a visible side effect on the user\'s screen; the model must not cause it unprompted.',
            'The folder contents are never returned to the model: the result is only a short text confirmation naming the folder that was opened (or a note when no file manager is available, for example on a headless machine). To see what is in the folder, use list_directory instead.',
            'Only paths inside the library root can be opened. Missing paths and paths escaping the root are rejected with a note. Nothing is modified.',
            'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root.',
        ].join('\n'),
        inputSchema: {
            path: z
                .string()
                .optional()
                .describe('File or folder whose containing folder to open, relative to the library root (for example "notes/2026-10-28.md" opens "notes"). Omit or pass "" to open the library root. Only call this when the user explicitly asked to open the folder.'),
        },
    }, (args) => wrap(() => handleOpenContainingFolder(ctx, args.path)));
}
