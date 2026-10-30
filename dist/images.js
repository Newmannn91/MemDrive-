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
import { IMAGE_PREVIEW_MAX_BYTES, IMAGE_PREVIEW_MIME, IMAGE_PREVIEW_MIN_DIMENSION, IMAGE_PREVIEW_QUALITIES, IMAGE_PREVIEW_QUALITY, IMAGE_PREVIEW_SCALE_STEP, URL_DOWNLOAD_MAX_BYTES, URL_DOWNLOAD_TIMEOUT_MS, } from './config.js';
import { cleanPath } from './sandbox.js';
const MIME_BY_EXTENSION = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
};
const EXTENSION_BY_MIME = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
};
export function mimeFromExtension(filePath) {
    return MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}
export function extensionForMime(mimeType) {
    return EXTENSION_BY_MIME[mimeType] ?? 'png';
}
/** Detect an image MIME type from magic bytes; null when not an image. */
export function detectImageMime(data) {
    if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
        return 'image/png';
    }
    if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
        return 'image/jpeg';
    }
    if (data.length >= 6 && data.subarray(0, 6).toString('ascii').startsWith('GIF8')) {
        return 'image/gif';
    }
    if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
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
    const cleaned = base.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-');
    return cleaned.length > 0 ? cleaned : 'image';
}
/** Download an image URL, streaming to memory with a safety ceiling. */
async function downloadImage(url) {
    let response;
    try {
        response = await fetch(url, {
            signal: AbortSignal.timeout(URL_DOWNLOAD_TIMEOUT_MS),
            redirect: 'follow',
        });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, note: `Could not download image URL ${url}: ${message}` };
    }
    if (!response.ok || response.body === null) {
        return {
            ok: false,
            note: `Could not download image URL ${url}: HTTP ${response.status}`,
        };
    }
    const chunks = [];
    let total = 0;
    try {
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            total += value.byteLength;
            if (total > URL_DOWNLOAD_MAX_BYTES) {
                await reader.cancel().catch(() => undefined);
                return {
                    ok: false,
                    note: `Image URL ${url} exceeds the ${URL_DOWNLOAD_MAX_BYTES} byte download safety ceiling.`,
                };
            }
            chunks.push(Buffer.from(value));
        }
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, note: `Download of image URL ${url} failed: ${message}` };
    }
    const data = Buffer.concat(chunks);
    const headerType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const mimeType = detectImageMime(data) ?? (headerType?.startsWith('image/') ? headerType : null);
    if (mimeType === null) {
        return {
            ok: false,
            note: `URL ${url} did not return image data (content-type: ${headerType ?? 'unknown'}).`,
        };
    }
    let stem = 'image';
    try {
        stem = baseNameOf(new URL(url).pathname);
    }
    catch {
        // Keep the default stem.
    }
    return { ok: true, image: { data, mimeType, baseName: stem } };
}
/** Copy an image from a local OS path (outside the sandbox root is fine). */
async function copyLocalImage(spec) {
    const cleaned = cleanPath(spec);
    const absolute = path.isAbsolute(cleaned)
        ? path.resolve(cleaned)
        : path.resolve(process.cwd(), cleaned);
    let data;
    try {
        data = await fs.readFile(absolute);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, note: `Could not read local image ${spec}: ${message}` };
    }
    const mimeType = detectImageMime(data) ?? mimeFromExtension(absolute);
    if (mimeType === null) {
        return {
            ok: false,
            note: `File ${spec} does not look like an image (unrecognized format).`,
        };
    }
    return { ok: true, image: { data, mimeType, baseName: baseNameOf(absolute) } };
}
/**
 * Acquire one image from a save_file `images` entry: "clipboard", an
 * http(s) URL, or a local file path. Never throws for expected failures;
 * returns a note instead so the caller can save the text and report.
 */
export async function acquireImage(spec) {
    const trimmed = spec.trim();
    if (trimmed === 'clipboard') {
        const result = await readClipboardImage();
        if (result.kind === 'image') {
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
        return downloadImage(trimmed);
    }
    return copyLocalImage(trimmed);
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
            if (width <= IMAGE_PREVIEW_MIN_DIMENSION || height <= IMAGE_PREVIEW_MIN_DIMENSION) {
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
 * Scan markdown for locally-referenced images: inline `![alt](src)` and
 * `<img src="...">`. Remote URLs (http/https), data: URIs, and fragments
 * are skipped — only files that could live next to the document.
 */
export function scanMarkdownImages(markdown) {
    const refs = [];
    const seen = new Set();
    const push = (src) => {
        const trimmed = src.trim();
        if (trimmed.length === 0 ||
            seen.has(trimmed) ||
            /^https?:\/\//i.test(trimmed) ||
            trimmed.startsWith('data:') ||
            trimmed.startsWith('#')) {
            return;
        }
        seen.add(trimmed);
        refs.push({ src: trimmed });
    };
    const inlinePattern = /!\[[^\]]*\]\(\s*([^\s)]+)(?:\s+"[^"]*")?\s*\)/g;
    for (const match of markdown.matchAll(inlinePattern)) {
        const src = match[1];
        if (src !== undefined) {
            push(src);
        }
    }
    const imgPattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
    for (const match of markdown.matchAll(imgPattern)) {
        const src = match[1] ?? match[2] ?? match[3];
        if (src !== undefined) {
            push(src);
        }
    }
    return refs;
}
