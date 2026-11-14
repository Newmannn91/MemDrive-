/**
 * Image acquisition and preview handling.
 *
 * Acquisition sources (all funneled through `acquireImage`):
 *   - the literal string "clipboard" → OS clipboard (see clipboard.ts)
 *   - an http(s) URL → streamed download, zero token cost
 *   - a local filesystem path → copied verbatim (source paths are OS
 *     paths, NOT sandbox-root paths: a picture in ~/Pictures is meant to
 *     be archivable; only the DESTINATION inside the root is sandboxed)
 *
 * Previews (`makePreview`): the on-disk original is never touched. Only
 * the in-memory copy handed to the model is downscaled, and only when it
 * exceeds IMAGE_PREVIEW_MAX_BYTES. Formats the pure-JS decoder (jimp)
 * cannot read (WebP, SVG) are passed through untouched when under the cap
 * and reported with a note when over it — never crashed on.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Jimp } from 'jimp';
import { readClipboardImage } from './clipboard.js';
import { IMAGE_MIME_BY_EXTENSION, IMAGE_PREVIEW_MAX_BYTES, IMAGE_PREVIEW_MIME, IMAGE_PREVIEW_MIN_DIMENSION, IMAGE_PREVIEW_QUALITIES, IMAGE_PREVIEW_QUALITY, IMAGE_PREVIEW_SCALE_STEP, SAVE_IMAGES_MAX_DOWNLOAD_BYTES, SAVE_IMAGES_MAX_TOTAL_BYTES, URL_DOWNLOAD_MAX_BYTES, URL_DOWNLOAD_TIMEOUT_MS, } from './config.js';
import { BlockedUrlError, blockedUrlReason, isPublicIp, precheckUrlReason, safeRequest, } from './net-guard.js';
import { cleanPath } from './sandbox.js';
export { blockedUrlReason, isPublicIp, safeRequest };
/** Reason text when the per-save stored-image budget is hit. */
function storedBudgetNote() {
    return `stored image budget for this save (${SAVE_IMAGES_MAX_TOTAL_BYTES / 1_000_000} MB) was reached`;
}
/** Reason text when the per-save download-traffic budget is hit. */
function downloadBudgetNote() {
    return `download limit for this save (${SAVE_IMAGES_MAX_DOWNLOAD_BYTES / 1_000_000} MB) was reached`;
}
const EXTENSION_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
};
export function mimeFromExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return Object.hasOwn(IMAGE_MIME_BY_EXTENSION, ext) ? (IMAGE_MIME_BY_EXTENSION[ext] ?? null) : null;
}
export function extensionForMime(mimeType) {
    return Object.hasOwn(EXTENSION_BY_MIME, mimeType) ? (EXTENSION_BY_MIME[mimeType] ?? 'png') : 'png';
}
const BMP_HEADER_SIZES = new Set([12, 40, 52, 56, 64, 108, 124]);
/** Detect an image MIME type from magic bytes; null when not an image. */
export function detectImageMime(data) {
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg';
    }
    if (data.length >= 6) {
        const gifHead = data.subarray(0, 6).toString('ascii');
        if (gifHead === 'GIF87a' || gifHead === 'GIF89a') {
            return 'image/gif';
        }
    }
    if (data.length >= 18 &&
        data[0] === 0x42 &&
        data[1] === 0x4d &&
        data.readUInt32LE(6) === 0 &&
        BMP_HEADER_SIZES.has(data.readUInt32LE(14))) {
        return 'image/bmp';
    }
    if (data.length >= 12 &&
        data.subarray(0, 4).toString('ascii') === 'RIFF' &&
        data.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }
    if (data.length >= 4 &&
        ((data[0] === 0x49 && data[1] === 0x49 && data[2] === 0x2a && data[3] === 0x00) ||
            (data[0] === 0x4d && data[1] === 0x4d && data[2] === 0x00 && data[3] === 0x2a))) {
        return 'image/tiff';
    }
    return null;
}
function baseNameOf(filePath) {
    const base = path.basename(filePath, path.extname(filePath));
    const cleaned = base.replace(/[^\p{L}\p{N}_\- ]+/gu, '').trim().replace(/\s+/g, '-');
    return cleaned.length > 0 ? cleaned : 'image';
}
/** Redirect statuses HTTP(S) downloads follow; anything else is a final answer. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
/** Maximum redirects followed for one image URL. */
const MAX_REDIRECTS = 5;
/** Download an image URL, streaming to memory with a safety ceiling. */
async function downloadImage(url, budget, netOpts) {
    // Either per-save counter exhausted refuses the fetch outright:
    // no download traffic is spent and no stored budget is needed.
    if (budget !== undefined && budget.downloadRemainingBytes <= 0) {
        return { ok: false, note: `${downloadBudgetNote()}.` };
    }
    if (budget !== undefined && budget.storedRemainingBytes <= 0) {
        return { ok: false, note: `${storedBudgetNote()}.` };
    }
    // One deadline for the whole redirect chain and body stream.
    const timeout = AbortSignal.timeout(URL_DOWNLOAD_TIMEOUT_MS);
    let current = url;
    let response = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        // Layer 1 (pre-check): URL syntax, scheme, localhost, and IP literals.
        // Layer 2 (authoritative connection-time check in safeRequest):
        // single DNS resolution in custom `lookup` with `agent: false`.
        const blocked = precheckUrlReason(current, netOpts?.isAllowedAddress ?? isPublicIp);
        if (blocked !== null) {
            return { ok: false, note: `Refusing image URL ${url}: ${blocked}.` };
        }
        try {
            response = await safeRequest(current, {
                ...netOpts,
                signal: timeout,
            });
        }
        catch (error) {
            if (error instanceof BlockedUrlError) {
                return { ok: false, note: `Refusing image URL ${url}: ${error.reason}.` };
            }
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, note: `Could not download image URL ${url}: ${message}` };
        }
        const status = response.statusCode ?? 0;
        if (REDIRECT_STATUSES.has(status)) {
            const locationHeader = response.headers.location;
            const location = Array.isArray(locationHeader)
                ? locationHeader[0]
                : locationHeader;
            response.destroy();
            response = null;
            if (location === undefined || location === '') {
                return {
                    ok: false,
                    note: `Could not download image URL ${url}: redirect without a location.`,
                };
            }
            if (hop === MAX_REDIRECTS) {
                return {
                    ok: false,
                    note: `Image URL ${url} exceeds the ${MAX_REDIRECTS} redirect limit.`,
                };
            }
            try {
                current = new URL(location, current).toString();
            }
            catch {
                return {
                    ok: false,
                    note: `Could not download image URL ${url}: redirect to an invalid URL.`,
                };
            }
            continue;
        }
        break;
    }
    if (response === null) {
        return { ok: false, note: `Could not download image URL ${url}.` };
    }
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) {
        response.destroy();
        return {
            ok: false,
            note: `Could not download image URL ${url}: HTTP ${status}`,
        };
    }
    const chunks = [];
    let total = 0;
    // The stream stops at whichever ceiling is lowest: the per-download
    // ceiling, the remaining download-traffic budget, or the remaining
    // stored-image budget (so an image too large to store is aborted
    // immediately instead of downloaded in full first).
    const downloadCap = budget?.downloadRemainingBytes ?? URL_DOWNLOAD_MAX_BYTES;
    const storedCap = budget?.storedRemainingBytes ?? URL_DOWNLOAD_MAX_BYTES;
    const ceiling = Math.min(URL_DOWNLOAD_MAX_BYTES, downloadCap, storedCap);
    try {
        for await (const chunk of response) {
            const buf = chunk;
            total += buf.byteLength;
            if (budget !== undefined) {
                budget.downloadRemainingBytes = Math.max(0, budget.downloadRemainingBytes - buf.byteLength);
            }
            if (total > ceiling) {
                response.destroy();
                if (budget !== undefined && ceiling < URL_DOWNLOAD_MAX_BYTES) {
                    return {
                        ok: false,
                        note: downloadCap <= storedCap
                            ? `${downloadBudgetNote()}.`
                            : `${storedBudgetNote()}.`,
                    };
                }
                return {
                    ok: false,
                    note: `Image URL ${url} exceeds the ${URL_DOWNLOAD_MAX_BYTES} byte download safety ceiling.`,
                };
            }
            chunks.push(buf);
        }
    }
    catch (error) {
        response.destroy();
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, note: `Download of image URL ${url} failed: ${message}` };
    }
    const data = Buffer.concat(chunks);
    const rawContentType = response.headers['content-type'];
    const contentTypeStr = Array.isArray(rawContentType)
        ? rawContentType[0]
        : rawContentType;
    const headerType = contentTypeStr?.split(';')[0]?.trim().toLowerCase();
    // Magic bytes are authoritative: a `200 OK` HTML error page or a
    // 0-byte body served as `image/png` is not an image. detectImageMime
    // recognizes all six raster formats this code supports, so dropping
    // the Content-Type fallback excludes nothing legitimate.
    const mimeType = detectImageMime(data);
    if (mimeType === null) {
        return {
            ok: false,
            note: `URL ${url} did not return image data (content-type: ${headerType ?? 'unknown'}).`,
        };
    }
    // Only now, with a confirmed image, does the stored budget move:
    // a failed or non-image download has already spent traffic, but
    // must not block later legitimate images.
    if (budget !== undefined && data.length > budget.storedRemainingBytes) {
        return { ok: false, note: `${storedBudgetNote()}.` };
    }
    if (budget !== undefined) {
        budget.storedRemainingBytes = Math.max(0, budget.storedRemainingBytes - data.length);
    }
    let stem = 'image';
    try {
        stem = baseNameOf(new URL(current).pathname);
    }
    catch {
        // Keep the default stem.
    }
    return { ok: true, image: { data, mimeType, baseName: stem } };
}
/** Copy an image from a local OS path (outside the sandbox root is fine). */
async function copyLocalImage(spec, budget) {
    const cleaned = cleanPath(spec);
    const absolute = path.isAbsolute(cleaned)
        ? path.resolve(cleaned)
        : path.resolve(process.cwd(), cleaned);
    // Refuse non-regular files outright: /dev/zero, FIFOs, and device
    // nodes report size 0, so a size check alone cannot stop an
    // unbounded read — and readFile on them never returns. A stat
    // failure is reported directly instead of falling through to a
    // read that would report a different, misleading error.
    let st;
    try {
        st = await fs.stat(absolute);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, note: `Could not read local image ${spec}: ${message}` };
    }
    if (!st.isFile()) {
        return { ok: false, note: `Not a regular file: ${spec}` };
    }
    // A local file that alone would exhaust the save's stored budget is
    // refused without reading it.
    if (budget !== undefined && st.size > budget.storedRemainingBytes) {
        return { ok: false, note: `${storedBudgetNote()}.` };
    }
    let data;
    try {
        data = await fs.readFile(absolute);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, note: `Could not read local image ${spec}: ${message}` };
    }
    // The file may have grown between stat and read; re-check after read.
    if (budget !== undefined && data.length > budget.storedRemainingBytes) {
        return { ok: false, note: `${storedBudgetNote()}.` };
    }
    // Magic bytes are authoritative here too: a file whose extension
    // claims an image but whose bytes are not one (or are empty) is not
    // an image. This also covers the extensionless case, which already
    // used detectImageMime alone.
    const mimeType = detectImageMime(data);
    if (mimeType === null) {
        return {
            ok: false,
            note: `File ${spec} does not look like an image (unrecognized format).`,
        };
    }
    if (budget !== undefined) {
        budget.storedRemainingBytes = Math.max(0, budget.storedRemainingBytes - data.length);
    }
    return { ok: true, image: { data, mimeType, baseName: baseNameOf(absolute) } };
}
/**
 * Acquire one image from a save_file `images` entry: "clipboard", an
 * http(s) URL, or a local file path. Never throws for expected failures;
 * returns a note instead so the caller can save the text and report.
 */
export async function acquireImage(spec, budget, netOpts) {
    const trimmed = spec.trim();
    if (trimmed === 'clipboard') {
        const result = await readClipboardImage();
        if (result.kind === 'image') {
            if (budget !== undefined && result.data.length > budget.storedRemainingBytes) {
                return { ok: false, note: `${storedBudgetNote()}.` };
            }
            if (budget !== undefined) {
                budget.storedRemainingBytes = Math.max(0, budget.storedRemainingBytes - result.data.length);
            }
            return {
                ok: true,
                image: { data: result.data, mimeType: result.mimeType, baseName: 'clipboard' },
            };
        }
        if (result.kind === 'text') {
            return {
                ok: false,
                note: 'Clipboard holds text, not an image. The text was saved; re-copy a screenshot to attach an image.',
            };
        }
        if (result.kind === 'empty') {
            return {
                ok: false,
                note: 'Clipboard is empty. The text was saved; take a screenshot and retry to attach an image.',
            };
        }
        return { ok: false, note: result.reason };
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return downloadImage(trimmed, budget, netOpts);
    }
    return copyLocalImage(trimmed, budget);
}
/** Base64 length (bytes) of `byteLength` binary bytes: ceil(n/3)*4. */
export function base64Length(byteLength) {
    return Math.ceil(byteLength / 3) * 4;
}
/**
 * Largest binary size whose base64 encoding fits in `base64Budget`
 * bytes: floor(budget/4)*3.
 */
export function maxBinaryForBase64Budget(base64Budget) {
    if (base64Budget <= 0) {
        return 0;
    }
    return Math.floor(base64Budget / 4) * 3;
}
/**
 * Build a model-facing preview for an image buffer.
 *
 * Returns the original bytes untouched when under `maxBytes`. When over,
 * decodes with jimp and tries, in order from mildest to most aggressive:
 * a JPEG re-encode at full resolution (scale 1.0 — for PNG screenshots
 * this alone usually drops below the cap with no detail lost to
 * resizing), trying JPEG qualities 95, 90, then 80 before any
 * shrinking, then progressively smaller resizes in 0.9 steps at
 * quality 80. The FIRST attempt that fits `maxBytes` wins,
 * so the preview stays close to the largest size the budget allows
 * instead of stopping far below it. At the minimum dimension, lower
 * JPEG qualities are tried before giving up. Returns null when no
 * preview can be produced (format the decoder cannot read, or the
 * image stays over the cap even at minimum size/quality) — callers
 * then report a note instead. The on-disk original is never modified
 * by this function.
 *
 * `maxBytes` defaults to IMAGE_PREVIEW_MAX_BYTES (the per-image
 * ceiling). Callers pass a smaller value when the total response
 * budget leaves less room; the preview then fits the remaining budget
 * instead of the per-image ceiling.
 */
export async function makePreview(data, mimeType, maxBytes = IMAGE_PREVIEW_MAX_BYTES) {
    if (maxBytes <= 0) {
        return null;
    }
    if (data.length <= maxBytes) {
        return { data, mimeType };
    }
    try {
        const image = await Jimp.read(data);
        let scale = 1;
        for (;;) {
            const width = Math.max(IMAGE_PREVIEW_MIN_DIMENSION, Math.round(image.width * scale));
            const height = Math.max(IMAGE_PREVIEW_MIN_DIMENSION, Math.round(image.height * scale));
            // At scale 1.0 there is nothing to resize: re-encode only.
            // (Resize mutates in place, so branch on a single clone to keep
            // one static type for `working`.)
            const working = image.clone();
            if (scale < 1) {
                working.resize({ w: width, h: height });
            }
            // At full resolution, spend the budget on quality first: try
            // 95, then 90, then 80. Once shrinking starts, resolution
            // matters more than quality, so smaller scales stay at 80.
            const qualities = scale === 1 ? IMAGE_PREVIEW_QUALITIES : [IMAGE_PREVIEW_QUALITY];
            for (const quality of qualities) {
                const preview = await working.getBuffer(IMAGE_PREVIEW_MIME, {
                    quality,
                });
                if (preview.length <= maxBytes) {
                    return { data: preview, mimeType: IMAGE_PREVIEW_MIME };
                }
            }
            if (width <= IMAGE_PREVIEW_MIN_DIMENSION && height <= IMAGE_PREVIEW_MIN_DIMENSION) {
                // Last resort: same minimum size, lower JPEG quality.
                for (const quality of [60, 40, 20]) {
                    const smaller = await working.getBuffer(IMAGE_PREVIEW_MIME, {
                        quality,
                    });
                    if (smaller.length <= maxBytes) {
                        return { data: smaller, mimeType: IMAGE_PREVIEW_MIME };
                    }
                }
                return null;
            }
            scale *= IMAGE_PREVIEW_SCALE_STEP;
        }
    }
    catch {
        return null;
    }
}
/**
 * Scan markdown for locally-referenced images: inline `![alt](src)`,
 * `<img src="...">`, Obsidian embeds `![[src]]` / `![[src|alt]]`, and
 * reference-style `![alt][id]` with `[id]: src` definitions. Remote
 * URLs (http/https), data: URIs, and fragments are skipped — only
 * files that could live next to the document.
 */
/**
 * Percent-encode characters in a Markdown image src that would break
 * the inline scan regex below (ASCII and non-ASCII whitespace, BOM,
 * parentheses), be parsed by Markdown renderers as a URL fragment or
 * query string ('#', '?'), or collide with percent-decoding ('%'),
 * while keeping non-whitespace CJK characters directly readable in
 * the note. Only newly saved notes carry encoded refs; pre-existing
 * notes with unencoded refs are unchanged.
 */
export function encodeImageSrc(src) {
    return src.replace(/[\s\uFEFF\x00-\x1f\x7f%()#?<>\[\]"'`\\]/g, (ch) => {
        const code = ch.codePointAt(0);
        return code < 0x80
            ? `%${code.toString(16).toUpperCase().padStart(2, '0')}`
            : encodeURIComponent(ch);
    });
}
export function scanMarkdownImages(markdown) {
    const refs = [];
    const seen = new Set();
    const push = (src, kind) => {
        let trimmed = src.trim();
        // A raw `#fragment` or `?query` is not part of the on-disk path
        // — but ONLY for Obsidian embeds (`![[pic.png#center]]` refers
        // to `pic.png`; `#` there is an anchor, not a filename). Inline,
        // `<img>`, and reference-style refs keep 0.7.0 behavior: the path
        // is literal, so `notes/C#/pic.png` stays `notes/C#/pic.png`.
        // Strip BEFORE decoding: a `#` that belongs to the filename
        // arrives percent-encoded (`%23`) and must survive the strip.
        if (kind === 'obsidian') {
            const hashAt = trimmed.indexOf('#');
            if (hashAt !== -1) {
                trimmed = trimmed.slice(0, hashAt).trim();
            }
            const queryAt = trimmed.indexOf('?');
            if (queryAt !== -1) {
                trimmed = trimmed.slice(0, queryAt).trim();
            }
        }
        // A raw `#fragment` is a same-document anchor, not a file — check
        // BEFORE decoding, so a percent-encoded `#` in a filename (`%23`)
        // survives (it decodes to `#` only after this check).
        if (trimmed.startsWith('#')) {
            return;
        }
        // Newly saved notes carry percent-encoded refs; decode them back
        // to the on-disk path. A bad escape falls back to the raw src.
        try {
            trimmed = decodeURIComponent(trimmed);
        }
        catch {
            // Keep the raw src.
        }
        // Obsidian embeds can point at notes and PDFs too (`![[Meeting
        // Notes]]`, `![[spec.pdf]]`): only image extensions are image
        // references, the rest must not reach read_file's image path.
        if (kind === 'obsidian' && mimeFromExtension(trimmed) === null) {
            return;
        }
        if (trimmed.length === 0 ||
            seen.has(`${kind}:${trimmed}`) ||
            /^https?:\/\//i.test(trimmed) ||
            /^data:/i.test(trimmed)) {
            return;
        }
        seen.add(`${kind}:${trimmed}`);
        refs.push({ src: trimmed, kind });
    };
    const inlinePattern = /!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>]*)>|([^\s)]+))(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    for (const match of markdown.matchAll(inlinePattern)) {
        const src = match[1] ?? match[2];
        if (src !== undefined) {
            push(src, 'inline');
        }
    }
    const imgPattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    for (const match of markdown.matchAll(imgPattern)) {
        const src = match[1] ?? match[2] ?? match[3];
        if (src !== undefined) {
            push(src, 'img');
        }
    }
    // Obsidian embeds: `![[path.png]]` and `![[folder/img.png|alt]]`.
    const obsidianPattern = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
    for (const match of markdown.matchAll(obsidianPattern)) {
        const src = match[1];
        if (src !== undefined) {
            push(src, 'obsidian');
        }
    }
    // Reference-style: collect `[id]: src` definitions first, then
    // resolve `![alt][id]` (and collapsed `![id][]`, where id = alt).
    // A definition may carry an optional title: `[id]: src "title"`.
    const refDefs = new Map();
    for (const match of markdown.matchAll(/^\s*\[([^\]]+)\]:\s*(\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/gm)) {
        const id = match[1];
        const src = match[2];
        if (id !== undefined && src !== undefined) {
            refDefs.set(id.toLowerCase(), src);
        }
    }
    const refPattern = /!\[(?:\\.|[^\]\\])*\]\[([^\]]*)\]/g;
    for (const match of markdown.matchAll(refPattern)) {
        const idRaw = match[1];
        const altMatch = /^!\[((?:\\.|[^\]\\])*)\]/.exec(match[0]);
        const id = idRaw.length > 0 ? idRaw : (altMatch?.[1] ?? '');
        const src = refDefs.get(id.toLowerCase());
        if (src !== undefined) {
            push(src, 'reference');
        }
    }
    return refs;
}
