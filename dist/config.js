/**
 * MemDrive configuration: every size threshold lives here, in exactly one
 * place, as a named constant. Nothing else in the codebase hard-codes a
 * byte limit.
 *
 * Units are decimal bytes throughout (1 MB = 1,000,000 bytes), matching how
 * the vendor docs state their caps.
 */
import { homedir } from 'node:os';
import path from 'node:path';
/** Maximum text payload returned by read_file. Larger files are truncated. */
export const TEXT_MAX_BYTES = 1_000_000;
/**
 * Default total response budget for one read_file call (text bytes +
 * base64 bytes of every image block in the response, counted together).
 *
 * Why 950,000: Claude Desktop rejects a whole tool result over
 * 1,048,576 bytes ("result exceeds maximum length of 1048576"). A
 * single 813.5 KB screenshot is ~1.11 MB once base64-encoded, so the
 * old per-part caps (1 MB text, 3.5 MB per image, no combined check)
 * let a bundled text+image read blow straight past that wall. 950,000
 * leaves ~98 KB of headroom for JSON framing and notes. Clients with
 * a larger transport limit raise it with
 * MEMDRIVE_RESPONSE_BUDGET_BYTES; the 3.5 MB per-image ceiling still
 * caps any single preview (see IMAGE_PREVIEW_MAX_BYTES).
 *
 * Per-host overrides: the server cannot identify the host, so the
 * setup wizard writes the measured budget into each host's own
 * config entry (see `responseBudgetBytes` in `host-config.ts`):
 * Claude Desktop writes no budget env and keeps this 950,000
 * default; Cursor writes 10,000,000; VS Code writes 10,000,000.
 * Cursor is verified (2026-10-30, see `host-config.ts` for the
 * evidence) and VS Code is partly verified; neither exact ceiling
 * was measured. Unknown hosts keep this default.
 */
export const RESPONSE_BUDGET_DEFAULT_BYTES = 950_000;
/** Smallest total response budget the environment variable may set. */
export const RESPONSE_BUDGET_MIN_BYTES = 100_000;
/** Largest total response budget the environment variable may set. */
export const RESPONSE_BUDGET_MAX_BYTES = 50_000_000;
/**
 * Resolve the total response budget from a raw environment-variable
 * value. Unset, empty, or non-numeric values fall back to the default;
 * out-of-range values are clamped to [MIN, MAX]. Pure function of its
 * argument so the clamping rules are directly unit-testable.
 */
export function resolveResponseBudgetBytes(rawValue) {
    const trimmed = rawValue?.trim() ?? '';
    if (trimmed.length === 0) {
        return RESPONSE_BUDGET_DEFAULT_BYTES;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return RESPONSE_BUDGET_DEFAULT_BYTES;
    }
    const floored = Math.floor(parsed);
    if (floored < RESPONSE_BUDGET_MIN_BYTES) {
        return RESPONSE_BUDGET_MIN_BYTES;
    }
    if (floored > RESPONSE_BUDGET_MAX_BYTES) {
        return RESPONSE_BUDGET_MAX_BYTES;
    }
    return floored;
}
/**
 * Image preview cap (raw binary bytes). Images larger than this are
 * downscaled IN MEMORY to a preview below this size before being returned;
 * the on-disk original is never modified.
 *
 * Why 3.5 MB: base64 inflates binary by 4/3, so 3.5 MB binary becomes
 * ~4.67 MB of base64 text, which fits under every vendor image cap found
 * in the official docs (5 MB Bedrock/Vertex, 7 MB Gemini, 10 MB Claude API,
 * 20 MB OpenAI). Do not raise this without re-checking those docs.
 */
export const IMAGE_PREVIEW_MAX_BYTES = 3_500_000;
/** MIME type used for downscaled image previews (universally accepted). */
export const IMAGE_PREVIEW_MIME = 'image/jpeg';
/** JPEG quality used when generating an in-memory preview. */
export const IMAGE_PREVIEW_QUALITY = 80;
/**
 * JPEG qualities tried, in order, at full resolution before any
 * shrinking starts. A screenshot whose quality-80 encode fits easily
 * still has headroom for sharper text at 90/95, so the ladder spends
 * the budget on quality first; once shrinking starts, resolution
 * matters more than quality and smaller scales stay at
 * IMAGE_PREVIEW_QUALITY.
 */
export const IMAGE_PREVIEW_QUALITIES = [95, 90, 80];
/** Stop shrinking a preview once either dimension reaches this size. */
export const IMAGE_PREVIEW_MIN_DIMENSION = 64;
/**
 * Step factor applied to each downscale iteration. 0.9 (fine steps)
 * matters: makePreview returns the FIRST attempt that fits the
 * budget, so coarse steps (e.g. 0.7) would stop far below the budget
 * and waste most of it. Fine steps keep the returned preview close
 * to the largest size the budget allows.
 */
export const IMAGE_PREVIEW_SCALE_STEP = 0.9;
/** File extensions treated as images (lowercase, with leading dot). */
export const IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.bmp',
    '.tiff',
]);
/** `.svg` files are XML text: read_file returns them as text, never as image content. */
export const SVG_EXTENSION = '.svg';
/** Upper bound on search results returned by search_files. */
export const SEARCH_MAX_RESULTS = 200;
/** Maximum referenced images bundled into one read_file response. */
export const READ_MAX_IMAGES = 20;
/** Files larger than this are name-matched only (content search skipped). */
export const SEARCH_CONTENT_MAX_BYTES = 256_000;
/** Network timeout for downloading an image URL in save_file. */
export const URL_DOWNLOAD_TIMEOUT_MS = 30_000;
/**
 * Safety ceiling for a single URL download. The design says stored
 * originals have no size limit; this guard exists only to stop a hostile
 * or mistaken URL from exhausting disk/memory mid-stream. Documented
 * deviation, not a product limit: ordinary photos and screenshots are
 * orders of magnitude below it.
 */
export const URL_DOWNLOAD_MAX_BYTES = 500_000_000;
/** Timeout for a single native clipboard command. */
export const CLIPBOARD_COMMAND_TIMEOUT_MS = 10_000;
/** Max bytes captured from a clipboard command's stdout. */
export const CLIPBOARD_MAX_BYTES = 50_000_000;
/**
 * Resolve the memory-library root directory.
 *
 * `MEMDRIVE_ROOT` wins when set; otherwise `~/memdrive`. A leading `~` is
 * expanded to the user's home directory. The result is always absolute.
 */
export function resolveRootDir() {
    const raw = process.env['MEMDRIVE_ROOT']?.trim();
    const configured = raw && raw.length > 0 ? raw : '~/memdrive';
    const expanded = configured === '~'
        ? homedir()
        : configured.startsWith('~/')
            ? path.join(homedir(), configured.slice(2))
            : configured;
    return path.resolve(expanded);
}
