/**
 * The six MemDrive tools.
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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  CallToolResult,
  ImageContent,
  TextContent,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import {
  IMAGE_EXTENSIONS,
  IMAGE_PREVIEW_MAX_BYTES,
  READ_MAX_IMAGES,
  SEARCH_MAX_RESULTS,
  SVG_EXTENSION,
  TEXT_MAX_BYTES,
  resolveResponseBudgetBytes,
} from './config.js';
import { MemDriveError, NotFoundError } from './errors.js';
import {
  acquireImage,
  base64Length,
  detectImageMime,
  extensionForMime,
  makePreview,
  maxBinaryForBase64Budget,
  mimeFromExtension,
  scanMarkdownImages,
} from './images.js';
import {
  assertInsideRealRoot,
  isInside,
  sandboxPath,
  toDisplayPath,
} from './sandbox.js';
import type { StorageBackend, WriteMode } from './storage.js';
import { openFolderInViewer, openInViewer } from './viewer.js';

interface ToolContext {
  backend: StorageBackend;
  rootDir: string;
  rootRealDir: string;
}

function textBlock(text: string): TextContent {
  return { type: 'text', text };
}

function okResult(text: string): CallToolResult {
  return { content: [textBlock(text)] };
}

function errorResult(message: string): CallToolResult {
  return { content: [textBlock(`Error: ${message}`)], isError: true };
}

function relOf(ctx: ToolContext, absolutePath: string): string {
  return toDisplayPath(ctx.rootDir, absolutePath);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1_000_000) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

function looksBinary(data: Buffer): boolean {
  return data.subarray(0, 8192).includes(0);
}

/** UTF-8 byte length of a string (what the transport actually sends). */
function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * Total response budget for one read_file call, resolved fresh on
 * every call from MEMDRIVE_RESPONSE_BUDGET_BYTES (default 950,000;
 * clamped to 100,000–50,000,000 by resolveResponseBudgetBytes).
 */
function responseBudgetBytes(): number {
  return resolveResponseBudgetBytes(
    process.env['MEMDRIVE_RESPONSE_BUDGET_BYTES'],
  );
}

/**
 * Bytes reserved for the one-line header of a direct image read when
 * sizing its preview. The header is far shorter than this; the reserve
 * only guarantees the header + base64 together stay inside the budget,
 * and the final total is re-checked before returning.
 */
const DIRECT_IMAGE_HEADER_RESERVE_BYTES = 512;

/**
 * Assemble the text block of a read_file result so that
 * text bytes + `imageBase64Total` never exceed `budget`. The body is
 * truncated (UTF-8-safe) to make room for the notes section; when the
 * notes alone fill the allowance, the body is dropped and the notes
 * are truncated instead, so image paths and skip reasons survive.
 */
function assembleText(
  body: string,
  notes: string[],
  budget: number,
  imageBase64Total: number,
): string {
  const allowedTextBytes = budget - imageBase64Total;
  if (allowedTextBytes <= 0) {
    return '';
  }
  if (notes.length === 0) {
    return truncateUtf8(body, allowedTextBytes);
  }
  const notesSection = `\n\n[MemDrive notes]\n${notes.map((n) => `- ${n}`).join('\n')}`;
  if (utf8Bytes(notesSection) >= allowedTextBytes) {
    return truncateUtf8(notesSection, allowedTextBytes);
  }
  return (
    truncateUtf8(body, allowedTextBytes - utf8Bytes(notesSection)) +
    notesSection
  );
}

function timestampStem(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

/* ------------------------------------------------------------------ */
/* list_directory                                                      */
/* ------------------------------------------------------------------ */

async function handleListDirectory(
  ctx: ToolContext,
  inputPath: string | undefined,
): Promise<CallToolResult> {
  const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath ?? '');
  const rel = relOf(ctx, absolute);
  const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
  if (stat === null) {
    throw new NotFoundError(`Directory not found: ${rel}`);
  }
  if (!stat.isDirectory) {
    throw new MemDriveError(
      'NOT_A_DIRECTORY',
      `${rel} is a file, not a directory. Use read_file to read it.`,
    );
  }
  const entries = await ctx.backend.listDirectory(rel === '.' ? '' : rel);
  if (entries.length === 0) {
    return okResult(`Directory ${rel} is empty.`);
  }
  const lines = [`Directory: ${rel} (${entries.length} entries)`, ''];
  for (const entry of entries) {
    const meta =
      entry.type === 'directory'
        ? '[dir] '
        : `[file] ${formatBytes(entry.size)} · modified ${entry.modifiedAt} · `;
    lines.push(`${meta}${entry.name}`);
  }
  return okResult(lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* search_files                                                        */
/* ------------------------------------------------------------------ */

async function handleSearchFiles(
  ctx: ToolContext,
  keyword: string,
  inputPath: string | undefined,
): Promise<CallToolResult> {
  const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath ?? '');
  const rel = relOf(ctx, absolute);
  const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
  if (stat === null) {
    throw new NotFoundError(`Directory not found: ${rel}`);
  }
  if (!stat.isDirectory) {
    throw new MemDriveError(
      'NOT_A_DIRECTORY',
      `${rel} is a file, not a directory. Search a directory path instead.`,
    );
  }
  const hits = await ctx.backend.search(
    keyword,
    rel === '.' ? '' : rel,
    SEARCH_MAX_RESULTS,
  );
  if (hits.length === 0) {
    return okResult(`No files matching ${JSON.stringify(keyword)} under ${rel}.`);
  }
  const needle = keyword.toLowerCase();
  const lines = [
    `Found ${hits.length} file(s) matching ${JSON.stringify(keyword)} under ${rel}:`,
    '',
  ];
  for (const hit of hits) {
    const name = hit.split('/').pop() ?? hit;
    let kind = 'content';
    let excerpt = '';
    if (name.toLowerCase().includes(needle)) {
      kind = 'name';
    } else {
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
      } catch {
        // Excerpt is best-effort; the hit itself stands.
      }
    }
    lines.push(`- ${hit} (${kind})${excerpt}`);
  }
  if (hits.length >= SEARCH_MAX_RESULTS) {
    lines.push('', `Results capped at ${SEARCH_MAX_RESULTS}; narrow the keyword or path for more.`);
  }
  return okResult(lines.join('\n'));
}

/* ------------------------------------------------------------------ */
/* save_file                                                           */
/* ------------------------------------------------------------------ */

interface SavedImageInfo {
  fileName: string;
  relPath: string;
  alt: string;
}

async function handleSaveFile(
  ctx: ToolContext,
  inputPath: string,
  content: string,
  mode: WriteMode,
  imageSpecs: string[] | undefined,
): Promise<CallToolResult> {
  const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath);
  const rel = relOf(ctx, absolute);
  if (rel === '.') {
    throw new MemDriveError('INVALID_PATH', 'save_file needs a file path, not the library root.');
  }
  const docExt = path.extname(absolute).toLowerCase();
  const docStem = path.basename(absolute, path.extname(absolute));
  const docDirRel = path.dirname(rel) === '.' ? '' : path.dirname(rel).split(path.sep).join('/');

  // 1. Acquire images first (bytes in memory). Failures become notes;
  //    they never block the text save.
  const notes: string[] = [];
  const acquired: Array<{ data: Buffer; mimeType: string; baseName: string }> = [];
  for (const spec of imageSpecs ?? []) {
    const result = await acquireImage(spec);
    if (result.ok) {
      acquired.push(result.image);
    } else {
      notes.push(`Image ${JSON.stringify(spec)} skipped: ${result.note}`);
    }
  }

  // 2. Persist acquired images into the sibling assets/ folder with
  //    unique docname+timestamp names. A failed image write is a note,
  //    not a failed save.
  const savedImages: SavedImageInfo[] = [];
  if (acquired.length > 0) {
    const assetsRel = docDirRel === '' ? 'assets' : `${docDirRel}/assets`;
    await ctx.backend.ensureDir(assetsRel);
    const stamp = timestampStem(new Date());
    for (const image of acquired) {
      const ext = extensionForMime(image.mimeType);
      let candidate = `${docStem}-${stamp}.${ext}`;
      let attempt = 1;
      while (await ctx.backend.exists(`${assetsRel}/${candidate}`)) {
        attempt += 1;
        candidate = `${docStem}-${stamp}-${attempt}.${ext}`;
      }
      try {
        await ctx.backend.writeFile(`${assetsRel}/${candidate}`, image.data, 'new');
        savedImages.push({
          fileName: candidate,
          relPath: `${assetsRel}/${candidate}`,
          alt: image.baseName,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`Image ${image.baseName} could not be stored: ${message}`);
      }
    }
  }

  // 3. Build the document body. Markdown references are appended only for
  //    .md documents; other formats keep their images in assets/ and the
  //    result text reports their paths.
  let body = content;
  if (savedImages.length > 0 && docExt === '.md') {
    const refs = savedImages
      .map((img) => `\n![${img.alt}](assets/${img.fileName})`)
      .join('');
    body += `${body.length > 0 && !body.endsWith('\n') ? '\n' : ''}${refs}\n`;
  }

  // 4. Write the document. On failure, remove any images just stored so
  //    no dangling references are left behind.
  try {
    const { created } = await ctx.backend.writeFile(
      rel,
      Buffer.from(body, 'utf8'),
      mode,
    );
    const lines = [
      `Saved ${rel} (${formatBytes(Buffer.byteLength(body, 'utf8'))}, mode: ${mode}${created ? ', created' : ''}).`,
    ];
    if (savedImages.length > 0) {
      lines.push(`Images stored in assets/: ${savedImages.map((i) => i.fileName).join(', ')}.`);
      if (docExt !== '.md') {
        lines.push(
          'No image references were appended because the file is not Markdown; the image paths above are the references to use.',
        );
      }
    }
    for (const note of notes) {
      lines.push(`Note: ${note}`);
    }
    return okResult(lines.join('\n'));
  } catch (error) {
    for (const img of savedImages) {
      try {
        await fs.unlink(path.join(ctx.rootDir, img.relPath));
      } catch {
        // Best-effort cleanup only.
      }
    }
    throw error;
  }
}

/* ------------------------------------------------------------------ */
/* read_file                                                           */
/* ------------------------------------------------------------------ */

async function handleReadFile(
  ctx: ToolContext,
  inputPath: string,
  includeImages: boolean,
): Promise<CallToolResult> {
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
    throw new MemDriveError(
      'NOT_A_FILE',
      `${rel} is a directory. Use list_directory to see its contents.`,
    );
  }
  const data = await ctx.backend.readFile(rel === '.' ? '' : rel);
  const ext = path.extname(absolute).toLowerCase();

  // Direct image read: this one image gets the whole budget. It is
  // returned untouched when it fits, and downscaled in memory only
  // when the image itself exceeds the budget (or the per-image cap).
  if (IMAGE_EXTENSIONS.has(ext)) {
    const mimeType = ext === '.jpg' ? 'image/jpeg' : `image/${ext.slice(1)}`;
    const effectiveCap = Math.min(
      IMAGE_PREVIEW_MAX_BYTES,
      maxBinaryForBase64Budget(
        Math.max(0, budget - DIRECT_IMAGE_HEADER_RESERVE_BYTES),
      ),
    );
    const notReturned = (reason: string): CallToolResult =>
      okResult(
        truncateUtf8(
          `Image: ${rel} (${formatBytes(data.length)} on disk) was not returned as an image: ${reason} The original file was not modified.`,
          budget,
        ),
      );
    let preview = await makePreview(data, mimeType, effectiveCap);
    if (preview === null) {
      return notReturned(
        `it could not be downscaled to fit the ${formatBytes(budget)} total response budget (format not supported by the built-in decoder, or still over budget at minimum size).`,
      );
    }
    const buildHeader = (shown: { data: Buffer; mimeType: string }): string =>
      shown.data.length < data.length
        ? `Image: ${rel} (${formatBytes(data.length)} on disk; preview downscaled to ${formatBytes(shown.data.length)} to fit the ${formatBytes(budget)} total response budget, original untouched).`
        : `Image: ${rel} (${formatBytes(data.length)}).`;
    let header = buildHeader(preview);
    let total = utf8Bytes(header) + base64Length(preview.data.length);
    if (total > budget) {
      // The header reserve was too small for this (very long) path:
      // shrink once more by the exact excess, then re-check.
      const excess = total - budget;
      const tighterCap = Math.max(
        0,
        effectiveCap - Math.ceil((excess * 3) / 4) - 1024,
      );
      const retry = await makePreview(data, mimeType, tighterCap);
      if (retry === null) {
        return notReturned(
          `it could not be downscaled to fit the ${formatBytes(budget)} total response budget.`,
        );
      }
      preview = retry;
      header = buildHeader(preview);
      total = utf8Bytes(header) + base64Length(preview.data.length);
      if (total > budget) {
        return notReturned(
          `it could not be downscaled to fit the ${formatBytes(budget)} total response budget.`,
        );
      }
    }
    const imageBlock: ImageContent = {
      type: 'image',
      data: preview.data.toString('base64'),
      mimeType: preview.mimeType,
    };
    return { content: [textBlock(header), imageBlock] };
  }

  // SVG is XML text: return it as text, never as an image block.
  if (ext === SVG_EXTENSION) {
    const svgText = decodeText(data, rel);
    const svgNotes: string[] = [];
    const effectiveTextCap = Math.min(TEXT_MAX_BYTES, budget);
    if (utf8Bytes(svgText) > effectiveTextCap) {
      svgNotes.push(
        `Text truncated to the ${formatBytes(effectiveTextCap)} read cap; the file on disk is untouched.`,
      );
    }
    return okResult(assembleText(svgText, svgNotes, budget, 0));
  }

  // Everything else must decode as text.
  if (looksBinary(data)) {
    throw new MemDriveError(
      'BINARY_FILE',
      `${rel} looks like a binary file (not text, image, or SVG). MemDrive reads text and images only.`,
    );
  }
  const fullText = decodeText(data, rel);
  const effectiveTextCap = Math.min(TEXT_MAX_BYTES, budget);
  const notes: string[] = [];
  let body = fullText;
  if (utf8Bytes(body) > effectiveTextCap) {
    notes.push(
      `Text truncated to the ${formatBytes(effectiveTextCap)} read cap; the file on disk is untouched.`,
    );
    body = truncateUtf8(body, effectiveTextCap);
  }

  if (ext === '.md') {
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
      const listed: string[] = [];
      const seen = new Set<string>();
      for (const ref of refs) {
        const imageAbs = path.isAbsolute(ref.src)
          ? path.resolve(ref.src)
          : path.resolve(path.dirname(absolute), ref.src);
        let line: string;
        try {
          if (!isInside(ctx.rootDir, imageAbs)) {
            line = `- ${ref.src} (outside the library root — not readable via read_file)`;
          } else {
            await assertInsideRealRoot(ctx.rootRealDir, imageAbs);
            line = `- ${relOf(ctx, imageAbs)}`;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          line = `- ${ref.src} (${message})`;
        }
        if (!seen.has(line)) {
          seen.add(line);
          listed.push(line);
        }
      }
      const listingSection = `\n\n[MemDrive referenced images — read each one separately with read_file on its path for full quality]\n${listed.join('\n')}`;
      const notesSection =
        notes.length > 0
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
    const imageBlocks: ImageContent[] = [];
    let imageBase64Total = 0;
    let included = 0;
    const runningTextBytes = utf8Bytes(body);
    for (const ref of refs) {
      if (included >= READ_MAX_IMAGES) {
        notes.push(
          `Only the first ${READ_MAX_IMAGES} referenced images were included; the document references more.`,
        );
        break;
      }
      const imageAbs = path.isAbsolute(ref.src)
        ? path.resolve(ref.src)
        : path.resolve(path.dirname(absolute), ref.src);
      try {
        if (!isInside(ctx.rootDir, imageAbs)) {
          notes.push(`Skipped image outside the library root: ${ref.src}.`);
          continue;
        }
        await assertInsideRealRoot(ctx.rootRealDir, imageAbs);
        const imageRel = relOf(ctx, imageAbs);
        const imageData = await ctx.backend.readFile(imageRel === '.' ? '' : imageRel);
        const imageExt = path.extname(imageAbs).toLowerCase();
        const mimeType =
          imageExt === '.jpg'
            ? 'image/jpeg'
            : IMAGE_EXTENSIONS.has(imageExt)
              ? `image/${imageExt.slice(1)}`
              : null;
        if (mimeType === null) {
          notes.push(`Skipped referenced file with unsupported image type: ${ref.src}.`);
          continue;
        }
        const remaining = budget - runningTextBytes - imageBase64Total;
        if (remaining <= 0) {
          notes.push(
            `Skipped image ${ref.src}: the ${formatBytes(budget)} total response budget is already used by the text. Read it directly with read_file on "${imageRel}" for full quality.`,
          );
          continue;
        }
        const cap = Math.min(
          IMAGE_PREVIEW_MAX_BYTES,
          maxBinaryForBase64Budget(remaining),
        );
        if (cap <= 0) {
          notes.push(
            `Skipped image ${ref.src}: no response budget remains after the text. Read it directly with read_file on "${imageRel}" for full quality.`,
          );
          continue;
        }
        const preview = await makePreview(imageData, mimeType, cap);
        if (preview === null) {
          notes.push(
            `Skipped image ${ref.src} (${formatBytes(imageData.length)}): could not be downscaled to fit the remaining response budget; original untouched. Read it directly with read_file on "${imageRel}" — a direct read gives it the whole budget.`,
          );
          continue;
        }
        const encodedLength = base64Length(preview.data.length);
        if (encodedLength > remaining) {
          notes.push(
            `Skipped image ${ref.src}: its downscaled preview still does not fit the remaining response budget; original untouched. Read it directly with read_file on "${imageRel}".`,
          );
          continue;
        }
        if (preview.data.length < imageData.length) {
          notes.push(
            `Image ${ref.src} downscaled in memory to ${formatBytes(preview.data.length)} to fit the response budget; original untouched.`,
          );
        }
        imageBlocks.push({
          type: 'image',
          data: preview.data.toString('base64'),
          mimeType: preview.mimeType,
        });
        imageBase64Total += encodedLength;
        included += 1;
      } catch (error) {
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

function decodeText(data: Buffer, rel: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    throw new MemDriveError(
      'BINARY_FILE',
      `${rel} is not valid UTF-8 text. MemDrive reads text and images only.`,
    );
  }
}

/** Truncate text to a byte budget without splitting a UTF-8 sequence. */
function truncateUtf8(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) {
    return text;
  }
  let end = maxBytes;
  while (end > 0 && (encoded[end] as number) >= 0x80 && (encoded[end] as number) < 0xc0) {
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
 * extensionless image file can still be opened; reading 16 bytes is
 * enough for every signature `detectImageMime` checks.
 */
async function sniffImageMime(absolutePath: string): Promise<string | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(absolutePath, 'r');
    const buffer = Buffer.alloc(16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead === 0) {
      return null;
    }
    return detectImageMime(buffer.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function handleOpenImage(
  ctx: ToolContext,
  inputPath: string,
): Promise<CallToolResult> {
  const absolute = await sandboxPath(ctx.rootDir, ctx.rootRealDir, inputPath);
  const rel = relOf(ctx, absolute);
  const stat = await ctx.backend.stat(rel === '.' ? '' : rel);
  if (stat === null) {
    throw new NotFoundError(`File not found: ${rel}`);
  }
  if (stat.isDirectory) {
    throw new MemDriveError(
      'NOT_A_FILE',
      `${rel} is a directory. Use list_directory to see its contents.`,
    );
  }
  // An image is identified by its extension, or — for extensionless
  // files — by its magic bytes. Anything else (text, SVG, binary) is
  // rejected with a short note, never opened: the viewer must only
  // ever receive a file that is actually an image.
  const isImage =
    mimeFromExtension(absolute) !== null ||
    (await sniffImageMime(absolute)) !== null;
  if (!isImage) {
    throw new MemDriveError(
      'NOT_AN_IMAGE',
      `${rel} is not an image file. open_image opens image files only; use read_file to read it.`,
    );
  }
  const result = await openInViewer(absolute);
  if (result.ok) {
    return okResult(`Opened ${rel} in the system image viewer.`);
  }
  return okResult(
    `Could not open ${rel} in the system image viewer: ${result.reason} The file was not modified. Open it manually from the library folder instead.`,
  );
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
export function resolveContainingFolder(
  rootDir: string,
  absolutePath: string,
  isDirectory: boolean,
): string {
  if (absolutePath === rootDir) {
    return rootDir;
  }
  if (isDirectory) {
    return absolutePath;
  }
  return path.dirname(absolutePath);
}

async function handleOpenContainingFolder(
  ctx: ToolContext,
  inputPath: string | undefined,
): Promise<CallToolResult> {
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
  const folderAbsolute = resolveContainingFolder(
    ctx.rootDir,
    absolute,
    stat.isDirectory,
  );
  const folderRel = relOf(ctx, folderAbsolute);
  const result = await openFolderInViewer(folderAbsolute);
  if (result.ok) {
    return okResult(`Opened ${folderRel} in the system file manager.`);
  }
  return okResult(
    `Could not open ${folderRel} in the system file manager: ${result.reason} Nothing was modified. Open the folder manually from the library folder instead.`,
  );
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

export function registerTools(
  server: McpServer,
  backend: StorageBackend,
  rootDir: string,
  rootRealDir: string,
): void {
  const ctx: ToolContext = { backend, rootDir, rootRealDir };

  const wrap = (
    fn: () => Promise<CallToolResult>,
  ): Promise<CallToolResult> =>
    fn().catch((error: unknown) => {
      if (error instanceof MemDriveError) {
        return errorResult(error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[memdrive] tool error: ${message}`);
      return errorResult(`Unexpected error: ${message}`);
    });

  server.registerTool(
    'list_directory',
    {
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
          .describe(
            'Directory to list, relative to the library root. Omit or pass "" for the root.',
          ),
      },
    },
    (args) => wrap(() => handleListDirectory(ctx, args.path)),
  );

  server.registerTool(
    'search_files',
    {
      description: [
        'Search the memory library for files by keyword: matches file names (case-insensitive substring) and, for small text files, file contents.',
        'Searches recursively under the given directory. Returns root-relative paths with a match kind (name/content) and, for content matches, the first matching line.',
        'Paths are relative to the library root (MEMDRIVE_ROOT). Omit path or pass "" to search the whole library.',
      ].join('\n'),
      inputSchema: {
        keyword: z
          .string()
          .min(1)
          .describe('Keyword to search for (case-insensitive substring).'),
        path: z
          .string()
          .optional()
          .describe(
            'Directory to search under, relative to the library root. Omit or pass "" for the whole library.',
          ),
      },
    },
    (args) => wrap(() => handleSearchFiles(ctx, args.keyword, args.path)),
  );

  server.registerTool(
    'save_file',
    {
      description: [
        'CLIPBOARD FIRST — READ THIS BEFORE ANYTHING ELSE: When the user says to save a screenshot or an image from the clipboard — for example "把截图存下来", "把剪贴板里的图存下来", "save the screenshot", or any equivalent wording — pass images: ["clipboard"]. That is all it takes: the server reads the clipboard directly on the user\'s own machine. You do NOT need to see the clipboard or the image. NEVER ask the user to paste, upload, or send the image into the chat. NEVER say you cannot read the clipboard, that you cannot see images, or that this memory library can only store text. If the clipboard holds no image, the server reports that in the result and the text is still saved — tell the user to take the screenshot again and retry; do not invent a clipboard failure.',
        SAVE_GUIDANCE,
        'Save text (usually Markdown) into the MemDrive memory library.',
        'Modes: "new" (default) fails when the file already exists; "overwrite" replaces it; "append" adds to the end, creating the file when missing. Parent directories are created automatically.',
        'Images: pass an "images" array with any mix of the literal string "clipboard" (capture the latest screenshot from the OS clipboard — see the clipboard rule above), local file paths, or http(s) image URLs. Images are copied/downloaded/captured into a sibling assets/ folder, renamed "<document-name>-<timestamp>.<ext>", and for Markdown files a standard image reference is appended to the document automatically. The on-disk original is always kept at full quality; only the preview handed to a model is ever downscaled.',
        'Clipboard behavior: when the clipboard is empty or holds text instead of an image, the text is still saved and the result explains what to do (re-screenshot). Clipboard capture never crashes the server; in headless environments it reports itself as unsupported and suggests a file path or URL instead.',
        'Paths are relative to the library root (MEMDRIVE_ROOT). Absolute paths are accepted only when they stay inside the root. The root is a hard sandbox: "../" escapes and symlinks pointing outside are rejected.',
        'Path cleaning: surrounding quotes are stripped, a leading ~ expands to the home directory, and separators are normalized.',
      ].join('\n'),
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe(
            'Destination file path, relative to the library root (for example "notes/2026-10-28.md"). Must be confirmed with the user before calling.',
          ),
        content: z.string().describe('Text content to save (usually Markdown).'),
        mode: z
          .enum(['new', 'overwrite', 'append'])
          .optional()
          .describe(
            'Write mode: "new" (default, fails if the file exists), "overwrite", or "append".',
          ),
        images: z
          .array(z.string())
          .optional()
          .describe(
            'Images to archive with the document — CLIPBOARD FIRST: the literal string "clipboard" captures the latest screenshot/image from the OS clipboard on the machine running the server. Use it whenever the user mentions a screenshot or the clipboard: never ask them to paste the image into the chat, and never claim the clipboard cannot be read. Local file paths and http(s) image URLs are also accepted.',
          ),
      },
    },
    (args) =>
      wrap(() =>
        handleSaveFile(ctx, args.path, args.content, args.mode ?? 'new', args.images),
      ),
  );

  server.registerTool(
    'read_file',
    {
      description: [
        'Read a file from the MemDrive memory library.',
        'TOTAL RESPONSE BUDGET — THREE LIMITS ON THREE DIFFERENT LAYERS. (1) HOST: the MCP host (Claude Desktop, the only host verified so far) rejects a whole tool result over about 1 MB ("Tool result is too large. Maximum size is 1MB"). That limit lives in the host, outside this server, and is NOT a model or context-window limit; other hosts (ChatGPT, Grok) are untested, so this server assumes the same ~1 MB ceiling for all of them. (2) SERVER: text bytes plus the base64 bytes of every image block in one response must together fit inside a single total budget — default 950,000 bytes, overridable with MEMDRIVE_RESPONSE_BUDGET_BYTES (clamped to 100,000–50,000,000) — a safety margin under the host limit. Text comes first and is guaranteed; images share only the budget the text leaves. An image that does not fit is downscaled in memory to fit it, or skipped with a note — a read never fails as a whole because of an image. The file on disk is never modified. Previews are built at full resolution first, trying higher JPEG quality before shrinking, so a preview uses the budget for sharpness instead of stopping far below it. At the default budget the effective per-image cap is about 712,000 binary bytes (after base64 inflation), so the separate 3.5 MB per-image preview ceiling only binds when the budget is raised for a host with a larger limit. HISTORY: before v0.1.1 this server had NO total budget, so a bundled read whose base64 exceeded the host limit was rejected wholesale by the host — that is what happened to the first read of an 813.5 KB image (~1.11 MB as base64). (3) MODEL: once the model receives an image it scales it by pixels into tokens under its own limits — a separate layer from the byte limits above, not something this server controls.',
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
          .describe(
            'For Markdown files: true (default) returns the text together with its referenced images, within the total response budget; false returns text only plus the list of referenced image paths (step 1 of two-step reading). Ignored for non-Markdown files.',
          ),
      },
    },
    (args) =>
      wrap(() => handleReadFile(ctx, args.path, args.include_images ?? true)),
  );

  server.registerTool(
    'open_image',
    {
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
          .describe(
            'Image file to open, relative to the library root (for example "notes/assets/shot-20261028-120000-000.png"). Only call this when the user explicitly asked to view the original image.',
          ),
      },
    },
    (args) => wrap(() => handleOpenImage(ctx, args.path)),
  );

  server.registerTool(
    'open_containing_folder',
    {
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
          .describe(
            'File or folder whose containing folder to open, relative to the library root (for example "notes/2026-10-28.md" opens "notes"). Omit or pass "" to open the library root. Only call this when the user explicitly asked to open the folder.',
          ),
      },
    },
    (args) => wrap(() => handleOpenContainingFolder(ctx, args.path)),
  );
}
