/**
 * Search engine core (0.8.0): full-text index + BM25 + filters.
 *
 * The index is a CACHE, never the source of truth: the notes on disk
 * are the data, and a damaged or outdated index is rebuilt from them.
 * The index lives OUTSIDE the library (system cache dir, subdir hashed
 * by library path) so sync drives never corrupt it and list/search
 * never see it as a note.
 *
 * Design decisions (fixed by the 0.8.0 plan, 2026-11-07):
 * - Chinese tokenization: Node `Intl.Segmenter('zh')` + character
 *   bigram + single-char fallback (1–2 char queries must hit), NFKC
 *   normalization of queries and filenames (macOS filenames are NFD).
 * - Chunk-based index: heading/paragraph chunks, 600-char cap, 100-char
 *   overlap, exact [startOffset, endOffset] per chunk, so 0.10.0
 *   vector search needs no rework. Hybrid ranking via RRF.
 * - Single-writer lock (30 s expiry) + atomicWrite + format version
 *   (rebuild on mismatch): several MCP clients each spawn a MemDrive
 *   process and share one index.
 * - Background incremental indexing: searches fall back to a direct
 *   scan until the index is ready; CPU-heavy work yields the event
 *   loop. Incremental update compares mtime+size first, hashes only
 *   on mismatch; fs.watch is unreliable on sync drives, so a light
 *   stat scan runs on query. iCloud/OneDrive placeholder files are
 *   skipped, never downloaded.
 * - Storage: pure-JS inverted index persisted as files (good for
 *   thousands of notes, zero native deps). A `SearchIndex` interface
 *   is extracted so the backend can be swapped without touching
 *   callers.
 * - Safety: postings/files maps are null-prototype objects, so an
 *   indexed term such as `__proto__` or `constructor` can never
 *   pollute `Object.prototype`. Files over the content cap
 *   (`MEMDRIVE_INDEX_MAX_BYTES`, default 1 MB) and `.log`/`.csv`/
 *   `.json` files are indexed by filename only, never read in full.
 *   Placeholder detection covers iCloud `.icloud` files; on macOS a
 *   dataless file (`stat.blocks === 0 && size > 0`) is also skipped.
 *   OneDrive placeholders on Windows carry no detectable marker, so
 *   indexing there can still trigger a download — documented, not
 *   claimed otherwise.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './atomic.js';
import { BM25_B, BM25_K1, INDEX_FORMAT_VERSION, INDEX_LOCK_TIMEOUT_MS, INDEX_REFRESH_MIN_INTERVAL_MS, ORPHAN_MIN_RETENTION_MS, RRF_K, SEARCH_CHUNK_MAX_CHARS, SEARCH_CHUNK_OVERLAP_CHARS, resolveIndexCacheDir, resolveIndexMaxFileBytes, } from './config.js';
import { MemDriveError } from './errors.js';
import { scanMarkdownImages } from './images.js';
import { isInside } from './sandbox.js';
/** Normalize text for indexing and querying: NFKC + lowercase. */
export function normalizeText(text) {
    return text.normalize('NFKC').toLowerCase();
}
/** True when the string contains CJK characters. */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
/** Split a string into its maximal CJK runs. */
const CJK_RUN_SPLIT_RE = /[^\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+/u;
function hasCjk(s) {
    return CJK_RE.test(s);
}
/**
 * Segment text into tokens. Uses `Intl.Segmenter('zh')` when available
 * and falls back to a regex splitter (CJK chars + word runs) when it is
 * not. For CJK word segments, emits the segment itself plus every
 * character bigram and every single character, so 1–2 char queries and
 * mixed Chinese/English queries hit. Non-CJK words are emitted as-is.
 * Returns tokens with duplicates (term frequency matters for BM25).
 */
export function tokenize(text) {
    const normalized = normalizeText(text);
    const tokens = [];
    const pushCjk = (word) => {
        tokens.push(word);
        const chars = [...word];
        // Bigrams, but only when they differ from the word itself: a
        // 2-char word's only bigram IS the word, and emitting it would
        // double-count that term's frequency.
        if (chars.length > 2) {
            for (let i = 0; i + 1 < chars.length; i += 1) {
                tokens.push(chars[i] + chars[i + 1]);
            }
        }
        // Single chars, but only when they differ from the word: a 1-char
        // word's only char IS the word.
        if (chars.length > 1) {
            for (const ch of chars) {
                tokens.push(ch);
            }
        }
    };
    const segmenter = createSegmenter();
    if (segmenter !== null) {
        for (const seg of segmenter.segment(normalized)) {
            if (!seg.isWordLike) {
                continue;
            }
            const word = seg.segment;
            if (hasCjk(word)) {
                pushCjk(word);
            }
            else {
                tokens.push(word);
            }
        }
        return tokens;
    }
    // Fallback: split on anything that is not a letter/number/CJK char,
    // then treat each CJK run like a word segment above.
    for (const word of normalized.split(/[^\p{L}\p{N}]+/u)) {
        if (word.length === 0) {
            continue;
        }
        if (hasCjk(word)) {
            pushCjk(word);
        }
        else {
            tokens.push(word);
        }
    }
    return tokens;
}
let cachedSegmenter;
function createSegmenter() {
    if (cachedSegmenter !== undefined) {
        return cachedSegmenter;
    }
    try {
        cachedSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
    }
    catch {
        cachedSegmenter = null;
    }
    return cachedSegmenter;
}
/** Unique query terms (deduped) for one query string. */
export function tokenizeQuery(query) {
    return [...new Set(tokenize(query))];
}
/**
 * Local-midnight date from components. `new Date(y, m, d)` maps
 * years 0–99 to 1900–1999 (a JS quirk), so `setFullYear` is used:
 * a note dated in year 50 would otherwise fail its component
 * check and fall back to mtime.
 */
function localDate(y, m, d) {
    const dt = new Date(0);
    dt.setFullYear(y, m - 1, d);
    dt.setHours(0, 0, 0, 0);
    return dt;
}
/**
 * Parse a date filter bound. A date-only value (`YYYY-MM-DD`) on an
 * upper bound means the end of that day (23:59:59.999), so a note
 * dated that afternoon is still included. An unparseable value is
 * the caller's error, not something to silently ignore.
 */
export function parseDateBound(raw, endOfDay) {
    if (raw === undefined || raw === '') {
        return null;
    }
    const trimmed = raw.trim();
    // A bare date ("2026-10-28") means that calendar day in the
    // server's local timezone — NOT UTC midnight. `new Date` parses
    // an ISO date-only string as UTC, which in UTC+8 shifts the bound
    // 8 hours into the day: `modified_after: "2026-10-28"` would then
    // miss files modified that morning. Parse it as local time.
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly !== null) {
        const y = Number(dateOnly[1]);
        const m = Number(dateOnly[2]);
        const d = Number(dateOnly[3]);
        // A date that does not exist must not roll over (Feb 31 -> Mar 3).
        const local = localDate(y, m, d);
        if (local.getFullYear() !== y ||
            local.getMonth() !== m - 1 ||
            local.getDate() !== d) {
            throw new MemDriveError('INVALID_DATE', `Invalid date: ${JSON.stringify(raw)}`);
        }
        if (endOfDay) {
            const end = localDate(y, m, d);
            end.setHours(23, 59, 59, 999);
            return end.getTime();
        }
        return local.getTime();
    }
    const ms = new Date(trimmed).getTime();
    if (Number.isNaN(ms)) {
        throw new MemDriveError('INVALID_DATE', `Invalid date: ${JSON.stringify(raw)}`);
    }
    return ms;
}
const EMPTY_INDEX = {
    version: INDEX_FORMAT_VERSION,
    files: {},
    chunks: [],
    postings: {},
    totalChunks: 0,
    avgChunkLen: 0,
    updatedAt: new Date(0).toISOString(),
    fileNames: [],
};
/**
 * A record with no prototype: assigning a key such as `__proto__`
 * or `constructor` creates an ordinary own property instead of
 * touching `Object.prototype`. All postings/files maps (and the
 * per-chunk maps inside them) are built this way, in memory and
 * after loading from disk. The persisted JSON is safe as-is:
 * `JSON.parse` creates own properties even for `__proto__` keys.
 */
function nullRecord() {
    return Object.create(null);
}
/** True when a parsed index file has the full v2 shape; anything else is treated as damaged and rebuilt. */
function isValidIndex(parsed) {
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return false;
    }
    const p = parsed;
    if (p['version'] !== INDEX_FORMAT_VERSION) {
        return false;
    }
    if (!Array.isArray(p['chunks']) || typeof p['totalChunks'] !== 'number' || typeof p['avgChunkLen'] !== 'number') {
        return false;
    }
    if (typeof p['updatedAt'] !== 'string' || !Array.isArray(p['fileNames'])) {
        return false;
    }
    // Every file name must be a string: search calls path.basename
    // on each one, which throws on a non-string.
    if (!p['fileNames'].every((n) => typeof n === 'string')) {
        return false;
    }
    if (!isRecord(p['files']) || !isRecord(p['postings'])) {
        return false;
    }
    // Cross-checks (0.8.1): the writer guarantees all of these, so a
    // file that fails one is damaged. Without them a corrupt index
    // loads fine and search silently skips the broken parts — a
    // missed hit with no error, and refresh never repairs it (it only
    // updates changed files). Rejecting the file just triggers a
    // rebuild, which is always safe.
    const fileKeys = new Set(Object.keys(p['files']));
    const chunkIds = new Set();
    for (const chunk of p['chunks']) {
        if (typeof chunk !== 'object' ||
            chunk === null ||
            typeof chunk['id'] !== 'number' ||
            typeof chunk['file'] !== 'string' ||
            typeof chunk['startOffset'] !== 'number' ||
            typeof chunk['endOffset'] !== 'number' ||
            typeof chunk['section'] !== 'string' ||
            typeof chunk['tokenCount'] !== 'number') {
            return false;
        }
        // Two chunks must not share an id (hits would be attributed to
        // the wrong file), and every chunk must belong to a file entry.
        if (chunkIds.has(chunk['id'])) {
            return false;
        }
        chunkIds.add(chunk['id']);
        if (!fileKeys.has(chunk['file'])) {
            return false;
        }
    }
    for (const entry of Object.values(p['files'])) {
        if (typeof entry !== 'object' || entry === null) {
            return false;
        }
        const e = entry;
        if (typeof e['mtimeMs'] !== 'number' ||
            typeof e['size'] !== 'number' ||
            typeof e['hash'] !== 'string' ||
            !Array.isArray(e['tags']) ||
            !(typeof e['date'] === 'string' || e['date'] === null) ||
            !Array.isArray(e['chunkIds']) ||
            !e['chunkIds'].every((id) => typeof id === 'number') ||
            !Array.isArray(e['terms']) ||
            !e['terms'].every((t) => typeof t === 'string') ||
            typeof e['nameOnly'] !== 'boolean') {
            return false;
        }
        // Every chunk a file claims must exist, or its content is
        // silently unsearchable.
        for (const id of e['chunkIds']) {
            if (!chunkIds.has(id)) {
                return false;
            }
        }
    }
    for (const perChunk of Object.values(p['postings'])) {
        if (!isRecord(perChunk)) {
            return false;
        }
        for (const tf of Object.values(perChunk)) {
            if (typeof tf !== 'number') {
                return false;
            }
        }
        // Every posting must point at a real chunk (search skips a
        // dangling one with no error).
        for (const idStr of Object.keys(perChunk)) {
            if (!chunkIds.has(Number(idStr))) {
                return false;
            }
        }
    }
    return true;
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Chunk a text into heading/paragraph chunks with overlap. Offsets are exact slices of the original text. */
export function chunkText(text) {
    const units = splitUnits(text);
    const chunks = [];
    let current = [];
    let currentLen = 0;
    // Start offset of the current chunk. It may sit BEFORE the first
    // unit's start: when a chunk is cut, the next one re-opens with a
    // 100-char overlap tail from the previous chunk, so a phrase
    // straddling the cut is still found inside one chunk.
    let currentStart = 0;
    let currentSection = '';
    const flush = (end) => {
        if (current.length === 0) {
            return;
        }
        chunks.push({ startOffset: currentStart, endOffset: end, section: currentSection });
    };
    for (const unit of units) {
        const unitLen = unit.end - unit.start;
        if (unitLen > SEARCH_CHUNK_MAX_CHARS) {
            if (current.length > 0) {
                const last = current[current.length - 1];
                if (last !== undefined) {
                    flush(last.end);
                }
                current = [];
                currentLen = 0;
            }
            flushHardSplit(unit, chunks);
            continue;
        }
        if (current.length === 0) {
            currentStart = unit.start;
            currentSection = unit.section;
            current = [unit];
            currentLen = unitLen;
            continue;
        }
        // Length of the slice if this unit joins the chunk: the slice is
        // contiguous from currentStart to the unit's end, so blank lines
        // between units count too. (Summing unit lengths alone ignored
        // the gaps, and emitted slices could exceed the cap.)
        if (unit.end - currentStart > SEARCH_CHUNK_MAX_CHARS) {
            const last = current[current.length - 1];
            if (last === undefined) {
                current = [unit];
                currentLen = unitLen;
                continue;
            }
            flush(last.end);
            // Next chunk re-opens with an overlap tail (up to 100 chars),
            // shrunk when the new unit is long — or the gap to it is wide.
            // When the gap forces zero overlap, the next chunk starts at
            // the unit's start instead: the blank gap carries no searchable
            // text, so skipping it loses nothing — and the emitted slice
            // never exceeds the chunk cap.
            const gap = unit.start - last.end;
            const maxOverlap = Math.max(0, SEARCH_CHUNK_MAX_CHARS - unitLen - gap);
            const overlap = Math.min(SEARCH_CHUNK_OVERLAP_CHARS, maxOverlap);
            const nextStart = overlap === 0 ? unit.start : Math.max(currentStart, last.end - overlap);
            currentStart = nextStart;
            currentSection = unit.section;
            current = [unit];
            // Exact length of the new chunk's slice so far.
            currentLen = unit.end - nextStart;
            continue;
        }
        current.push(unit);
        currentLen = unit.end - currentStart;
    }
    if (current.length > 0) {
        const last = current[current.length - 1];
        if (last !== undefined) {
            flush(last.end);
        }
    }
    return chunks;
}
/** Split one over-long unit into cap-sized pieces with overlap. */
function flushHardSplit(unit, chunks) {
    let start = unit.start;
    while (start < unit.end) {
        const end = Math.min(unit.end, start + SEARCH_CHUNK_MAX_CHARS);
        chunks.push({ startOffset: start, endOffset: end, section: unit.section });
        if (end >= unit.end) {
            break;
        }
        start = Math.max(start + 1, end - SEARCH_CHUNK_OVERLAP_CHARS);
    }
}
/** Split text into heading/paragraph units with exact offsets and section titles. */
function splitUnits(text) {
    const units = [];
    const lines = text.split('\n');
    let offset = 0;
    let section = '';
    let paraStart = null;
    let paraEnd = 0;
    const flushPara = (end) => {
        if (paraStart !== null && end > paraStart) {
            units.push({ start: paraStart, end, section });
        }
        paraStart = null;
    };
    for (const line of lines) {
        const lineStart = offset;
        const lineEnd = offset + line.length;
        offset = lineEnd + 1; // +1 for the '\n'
        const heading = /^(#{1,6})\s+(.*\S)\s*$/.exec(line);
        if (heading !== null) {
            flushPara(lineStart);
            section = heading[2].trim();
            // The heading line itself is a unit (it carries the section title).
            units.push({ start: lineStart, end: lineEnd, section });
            continue;
        }
        if (line.trim().length === 0) {
            flushPara(lineStart);
            continue;
        }
        if (paraStart === null) {
            paraStart = lineStart;
        }
        paraEnd = lineEnd;
    }
    flushPara(paraEnd);
    return units;
}
/** Strip CommonMark fenced code blocks (3+ backticks or tildes, <=3 spaces indent, CRLF-safe). */
function stripFencedCode(text) {
    const out = [];
    let fence = null;
    for (const line of text.split(/\r?\n/)) {
        const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence === null) {
            // A backtick fence's info string may not contain a backtick.
            if (m !== null && !(m[1][0] === '`' && m[2].includes('`'))) {
                fence = { ch: m[1][0], len: m[1].length };
                continue;
            }
        }
        else if (m !== null && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') {
            fence = null;
            continue;
        }
        if (fence === null) {
            out.push(line);
        }
    }
    return out.join('\n');
}
/** Extract tags: YAML front matter `tags:` + body `#tag`. Read-only. */
export function extractTags(text) {
    const tags = new Set();
    // Tags are case-insensitive and never keep a leading '#': a query
    // for `project` must match `#Project` and front matter `#project`.
    const addTag = (raw) => {
        const tag = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^#+/, '').trim().toLowerCase();
        // Reject only real dirty characters (brackets, braces,
        // quotes): a strict allowlist dropped legitimate front-matter
        // tags with spaces or dots (`machine learning`, `node.js`,
        // `c++`) — a 0.8.3 regression caught by Sonnet's review.
        // Body `#tag`s are already restricted by their own regex, so
        // this gate only affects front-matter tags. Trim again after
        // stripping quotes/`#`: a quoted whitespace-only value
        // (`tags: ["   "]`) would otherwise be stored as a blank tag
        // (Carbon r2 review).
        if (tag.length > 0 && !/[\[\]{}"]/.test(tag)) {
            tags.add(tag);
        }
    };
    // In YAML, `#` starts a comment when it is at the start of a
    // value or follows whitespace: `tags: # comment` is an empty
    // value, not a tag called "comment"; `- alpha # c1` is "alpha".
    const stripYamlComment = (value) => value.replace(/(^|\s)#.*$/, '$1').trim();
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (fm !== null) {
        const body = fm[1];
        // Inline form only: `[ \t]*` (not `\s*`) so the match cannot
        // cross the line break and swallow the first `- item` of a
        // block list as a bogus `- alpha` tag.
        const tagsLine = /^tags:[ \t]*(.*)$/m.exec(body);
        if (tagsLine !== null) {
            const value = tagsLine[1].trim();
            // Flow list `[a, #b]`: a `#` inside the brackets is a tag
            // character, not a comment — only a `#` after the closing
            // `]` starts a comment. Extract the bracketed list first
            // and ignore the rest; a plain value still goes through
            // stripYamlComment. (Stripping the comment from the whole
            // line first ate ` #b]` and lost the tag — a 0.8.2
            // regression.)
            const bracket = /^\[((?:[^\]"']|"[^"]*"|'[^']*')*)\]/.exec(value);
            if (bracket !== null) {
                for (const part of bracket[1].split(',')) {
                    addTag(part);
                }
            }
            else if (!value.startsWith('[')) {
                const raw = stripYamlComment(value);
                for (const part of raw.split(',')) {
                    addTag(part);
                }
            }
        }
        // Block-style list under `tags:`. A trailing YAML comment
        // after `tags:` is allowed (`tags: # my tags` then `- a`).
        const block = /^tags:[ \t]*(?:#.*)?\s*\n((?:\s*-\s*.+\n?)+)/m.exec(body);
        if (block !== null) {
            for (const line of block[1].split('\n')) {
                const item = /^-\s*(.+?)\s*$/.exec(line.trim());
                if (item !== null) {
                    addTag(stripYamlComment(item[1]));
                }
            }
        }
    }
    // Body `#tag`: skip fenced code blocks (a `#include` in code is
    // not a tag) and the front-matter block (its `#` comments are
    // YAML, not tags). A tag must contain at least one letter, so a
    // pure number (`#123`) is not a tag. Inline code is stripped
    // first: a `#` inside `` `git commit #amend` `` is preceded by a
    // space, so without this it would be extracted as a tag.
    let bodyText = text;
    if (fm !== null) {
        bodyText = bodyText.slice(fm[0].length);
    }
    bodyText = stripFencedCode(bodyText);
    bodyText = bodyText.replace(/(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, ' ');
    // Nested tags use '/': `#a/b` is one tag, not `a`.
    for (const match of bodyText.matchAll(/(?:^|\s)#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gu)) {
        const tag = match[1];
        if (tag !== undefined && /\p{L}/u.test(tag)) {
            addTag(tag);
        }
    }
    return [...tags];
}
/** Extract the best date for a file: front matter `date:` > filename (YYYY-MM-DD / YYYYMMDD) > mtime. */
export function extractDate(text, fileName, mtimeMs) {
    const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (fm !== null) {
        const dateLine = /^date:\s*(.+?)\s*$/m.exec(fm[1]);
        if (dateLine !== null) {
            // Strip a trailing YAML comment (`date: 2026-10-28 #
            // meeting`), otherwise the value parses as Invalid Date
            // and the date is silently lost. Then strip surrounding
            // quotes (`date: "2026-10-28"` is common YAML): without
            // this the bare-date check below is bypassed and
            // `new Date('"2026-02-31"')` silently rolls over to 2026-03-03.
            // Any leading/trailing quote chars are stripped, paired or
            // not: a quote is never part of a date value, and leaving
            // one in lets V8 parse leniently and roll an invalid date
            // over (verified: even `"2026-02-31'` rolls to 2026-03-03).
            // Stripping is safe because the bare check below validates
            // the components — an invalid date still falls back.
            const raw = dateLine[1]
                .replace(/(^|\s)#.*$/, '$1')
                .trim()
                .replace(/^['"]+|['"]+$/g, '');
            // A bare date is a local calendar day, the same basis as
            // the filename date and the date_from/date_to filters
            // (0.8.3 #5): storing it as UTC midnight would put it on
            // the previous local day in negative-offset timezones.
            // It must also not roll over (`2026-02-31` -> 2026-03-03),
            // so the parsed components must match the source.
            const bare = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
            if (bare !== null) {
                const y = Number(bare[1]);
                const m = Number(bare[2]);
                const d = Number(bare[3]);
                const parsed = localDate(y, m, d);
                if (parsed.getFullYear() === y &&
                    parsed.getMonth() + 1 === m &&
                    parsed.getDate() === d) {
                    return parsed.toISOString();
                }
                // Invalid bare date: fall through to filename / mtime.
            }
            else {
                const parsed = new Date(raw);
                if (!Number.isNaN(parsed.getTime())) {
                    return parsed.toISOString();
                }
            }
        }
    }
    const nameMatch = /(?<!\d)(?:(\d{4})-(\d{2})-(\d{2})|(\d{4})(\d{2})(\d{2}))(?!\d)/.exec(fileName);
    if (nameMatch !== null) {
        const y = nameMatch[1] ?? nameMatch[4];
        const m = nameMatch[2] ?? nameMatch[5];
        const d = nameMatch[3] ?? nameMatch[6];
        if (y !== undefined && m !== undefined && d !== undefined) {
            // A date that does not exist must not silently roll over:
            // `new Date(2026, 1, 31)` becomes 2026-03-03 instead of
            // failing, so the parsed components must match the source.
            // Local calendar day (same basis as the filters): a file
            // named 2026-10-28 belongs to the local 2026-10-28.
            const parsed = localDate(Number(y), Number(m), Number(d));
            if (!Number.isNaN(parsed.getTime()) &&
                parsed.getFullYear() === Number(y) &&
                parsed.getMonth() + 1 === Number(m) &&
                parsed.getDate() === Number(d)) {
                return parsed.toISOString();
            }
        }
    }
    return new Date(mtimeMs).toISOString();
}
/** File extensions whose content is indexed as text (plus extensionless text files, checked by content). */
export const TEXT_EXTENSIONS = new Set([
    '.md',
    '.markdown',
    '.txt',
    '.text',
    '.mdx',
]);
/**
 * Extensions indexed by filename only, never read in full: logs and
 * data dumps are usually huge and rarely searched by content, and
 * reading them would block the server (a 60 MB .log took ~12 s to
 * index and produced a ~31 MB index file).
 */
export const NAME_ONLY_EXTENSIONS = new Set(['.json', '.csv', '.log']);
/** Markdown extensions whose image references diagnostics scans. */
export const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdx']);
/** Image extensions considered for orphan detection. */
const IMAGE_EXTENSIONS = new Set([
    '.png',
    '.jpg',
    '.jpeg',
    '.webp',
    '.gif',
    '.bmp',
    '.tiff',
    '.tif',
]);
/**
 * Placeholder suffixes for cloud-only files: never read, never
 * hashed. Only iCloud actually marks placeholders this way
 * (`.icloud`); OneDrive placeholders keep their real names, so
 * `.cloud` / `.onedrive` matched nothing real and are not listed.
 * On macOS a dataless file is also skipped via `stat.blocks`.
 */
const PLACEHOLDER_SUFFIXES = ['.icloud'];
/** True when the file is a cloud placeholder (skip it: reading would trigger a download). */
export function isPlaceholderFile(relPath) {
    const lower = relPath.toLowerCase();
    return PLACEHOLDER_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}
/** Heuristic: no NUL byte in the first 8 KB means probably text. */
function looksLikeText(data) {
    return !data.subarray(0, 8192).includes(0);
}
/** SHA-256 hex of a buffer. */
function sha256Hex(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}
/** Reciprocal rank fusion over ranked id lists: score = sum(1 / (k + rank)). */
export function reciprocalRankFusion(rankedLists, k = RRF_K) {
    const scores = new Map();
    for (const list of rankedLists) {
        for (let rank = 0; rank < list.length; rank += 1) {
            const id = list[rank];
            scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1));
        }
    }
    return scores;
}
/** Okapi BM25 (k1 = 1.2, b = 0.75). */
export function bm25(tf, df, totalDocs, docLen, avgLen) {
    if (tf <= 0 || totalDocs <= 0) {
        return 0;
    }
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    const norm = tf * (BM25_K1 + 1) / (tf + BM25_K1 * (1 - BM25_B + (BM25_B * docLen) / Math.max(1, avgLen)));
    return idf * norm;
}
/**
 * Pure-JS inverted index over the library, persisted as one JSON file
 * outside the library. One instance per server process; several
 * processes share the file via the single-writer lock.
 */
export class LocalSearchIndex {
    rootDir;
    rootRealDir;
    backend;
    cacheDir;
    indexPath;
    lockPath;
    data = {
        ...EMPTY_INDEX,
        files: nullRecord(),
        chunks: [],
        postings: nullRecord(),
        fileNames: [],
    };
    status = 'unbuilt';
    buildPromise = null;
    refreshPromise = null;
    /** A refresh was requested while one was running: run a follow-up pass after it. */
    refreshQueued = false;
    lastRefreshMs = 0;
    /** True after a save until the next refresh has run: the next search waits for it. */
    needsRefresh = false;
    /**
     * True when a search threw on the in-memory index: the on-disk
     * copy it was loaded from is the same damaged data, so
     * `ensureReady()` must NOT load it again (it would only re-arm
     * the same failure) — it rebuilds straight away. Cleared when a
     * rebuild succeeds. Without this, the 0.8.1 load-first
     * `ensureReady()` broke the auto-heal: a corrupt-but-validating
     * index was reloaded on every search and never rebuilt.
     */
    distrustDisk = false;
    /** Next chunk id to hand out; only grows, never reused after a removal. */
    nextChunkIdValue = 0;
    /**
     * Random token written into the lock file when this process takes
     * it (see acquireLock). releaseLock only deletes the lock when
     * the file still carries our token — an old process that wakes up
     * after its lock was stolen must not delete the new owner's lock.
     */
    lockToken = null;
    /** Interval that renews the lock timestamp while we hold it (heartbeat). */
    lockHeartbeat = null;
    /**
     * When resolveNoteImageRef last waited for another process's
     * build to finish (see the cold-start wait there). A note with
     * many Obsidian images calls it once per image; without this,
     * each image would wait the full ~2 s again when the other
     * process's build runs long, so one read_file could block 20 s
     * instead of ~2 s.
     */
    lastColdWaitMs = 0;
    /**
     * Chunk-entry count per term, so dropping a file can tell whether
     * a term's postings map is empty in O(1). (Counting keys with
     * Object.keys / for...in on a hot term's map enumerates thousands
     * of chunk ids per call — that was ~70 ms per removed file.)
     */
    postingsCount = new Map();
    /** Recompute postingsCount from the current data (after load / full rebuild). */
    rebuildPostingsCount() {
        this.postingsCount.clear();
        for (const [term, perChunk] of Object.entries(this.data.postings)) {
            this.postingsCount.set(term, Object.keys(perChunk).length);
        }
    }
    constructor(rootDir, rootRealDir, backend) {
        this.rootDir = rootDir;
        this.rootRealDir = rootRealDir;
        this.backend = backend;
        this.cacheDir = resolveIndexCacheDir(rootRealDir);
        this.indexPath = path.join(this.cacheDir, 'index.json');
        this.lockPath = path.join(this.cacheDir, 'index.lock');
    }
    /** Cache directory (outside the library). Exposed for tests. */
    getCacheDir() {
        return this.cacheDir;
    }
    getStatus() {
        return this.status;
    }
    /**
     * Load a persisted index if it parses, the version matches, and
     * the structure is sound; otherwise start unbuilt (a rebuild
     * follows). A file that parses but has the wrong shape — e.g.
     * `{"version":2,"chunks":[]}` with no `files`/`postings` — used
     * to load as `ready` and then throw on every search, forever.
     *
     * `load()` never downgrades the status (F2): on any failure it
     * leaves the status exactly as it was. Callers only invoke it
     * while `unbuilt`, so in practice a failure leaves it `unbuilt`;
     * but a concurrent build in this same process must keep its
     * `building` status, and a `ready` index must keep its data.
     */
    async load() {
        // Another process is mid-build (holds a fresh lock): do not load
        // the index it is about to replace — a later persist could write
        // our stale copy over the builder's fresh one. Stay unbuilt;
        // ensureReady() retries the load once the lock clears.
        if (await this.isLockHeldByLiveProcess()) {
            return;
        }
        try {
            const raw = await fs.readFile(this.indexPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (!isValidIndex(parsed)) {
                return;
            }
            // Null-prototype top-level maps, so keys like `__proto__` stay
            // ordinary own properties (see nullRecord). `JSON.parse` already
            // made them own properties; the swap only guards later
            // assignments such as `files[relPath] = entry`.
            // The per-chunk maps stay as parsed: their keys are chunk-id
            // numbers only, so they can never be `__proto__` — and copying
            // each one into a fresh null-prototype object cost ~500 ms on
            // a 10k-note library (0.8.1 E, measured). One Object.assign
            // per top-level map does the same job in ~17 ms.
            const files = Object.assign(nullRecord(), parsed.files);
            const postings = Object.assign(nullRecord(), parsed.postings);
            this.data = { ...parsed, files, postings };
            let maxId = -1;
            for (const chunk of this.data.chunks) {
                if (chunk.id > maxId) {
                    maxId = chunk.id;
                }
            }
            this.nextChunkIdValue = maxId + 1;
            this.rebuildPostingsCount();
            this.status = 'ready';
        }
        catch {
            // Leave the status untouched (F2, see the doc comment above).
        }
    }
    /** Start (or join) a background full build; searches fall back to a direct scan until it finishes. */
    ensureReady() {
        if (this.status === 'ready') {
            return Promise.resolve();
        }
        if (this.buildPromise !== null) {
            return this.buildPromise;
        }
        this.buildPromise = (async () => {
            // A previous attempt — or another process — may have left a
            // fresh index on disk: load it instead of rebuilding from
            // scratch. But not when the on-disk index is distrusted: a
            // search just threw on it, so loading it again would only
            // re-arm the same failure and the auto-heal would never run.
            if (!this.distrustDisk) {
                await this.load();
            }
            if (this.status === 'ready') {
                return;
            }
            const result = await this.buildAll();
            if (result !== 'built' && this.getStatus() !== 'ready') {
                // The lock was held by another process: it may have finished
                // since our build attempt — pick up its index instead of
                // staying on the direct-scan fallback. (Skipped when the
                // disk index is distrusted, for the same reason as above.)
                if (!this.distrustDisk) {
                    await this.load();
                }
            }
        })().finally(() => {
            this.buildPromise = null;
        });
        return this.buildPromise;
    }
    /** Yield the event loop so a long build never blocks the server. */
    static async yieldLoop() {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
    }
    /**
     * macOS only: a cloud file with no local content (evicted by
     * iCloud Drive / OneDrive) reports zero allocated blocks.
     * Protected so tests can simulate a dataless file on Linux,
     * where the platform gate never triggers.
     */
    async isDatalessFile(relPath, size) {
        if (process.platform !== 'darwin' || size === 0) {
            return false;
        }
        const st = await this.backend.stat(relPath);
        return st !== null && st.blocks === 0;
    }
    /**
     * Walk the library: `files` are the indexable entries (text files
     * plus filename-only ones), `allNames` is every file of any type
     * (for filename-substring search). Placeholders and temp files
     * are skipped; symlinks escaping the root are skipped too.
     */
    async walkTextFiles() {
        const files = [];
        const allNames = [];
        const maxBytes = resolveIndexMaxFileBytes(process.env['MEMDRIVE_INDEX_MAX_BYTES']);
        let rootRealDir = this.rootRealDir;
        try {
            rootRealDir = await fs.realpath(this.rootDir);
        }
        catch {
            // Keep the configured root.
        }
        const visited = new Set([rootRealDir]);
        const queue = [''];
        while (queue.length > 0) {
            const current = queue.shift();
            let entries;
            try {
                entries = await this.backend.listDirectory(current);
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.name.startsWith('.mdtmp-') || isPlaceholderFile(entry.relPath)) {
                    continue;
                }
                // listDirectory already statted the entry (following
                // symlinks), so size/mtime come from it — no extra stat per
                // file. Only a symlink needs the realpath + inside-root
                // test: a symlink that escapes the library is skipped, so
                // the walk can never read outside the root.
                let real = null;
                if (entry.isSymlink) {
                    try {
                        real = await fs.realpath(path.join(this.rootDir, entry.relPath));
                        if (!isInside(rootRealDir, real)) {
                            continue;
                        }
                    }
                    catch {
                        continue;
                    }
                }
                if (entry.type === 'directory') {
                    // Directories are few: realpath for the loop guard.
                    if (real === null) {
                        try {
                            real = await fs.realpath(path.join(this.rootDir, entry.relPath));
                        }
                        catch {
                            continue;
                        }
                    }
                    if (!visited.has(real)) {
                        visited.add(real);
                        queue.push(entry.relPath);
                    }
                    continue;
                }
                allNames.push(entry.relPath);
                const ext = path.extname(entry.name).toLowerCase();
                const mtimeMs = new Date(entry.modifiedAt).getTime();
                // Dataless cloud files on macOS (evicted by iCloud Drive /
                // OneDrive) report zero allocated blocks: index the name
                // only, never read them, so no download is triggered. The
                // blocks check needs one extra stat, macOS only.
                const dataless = await this.isDatalessFile(entry.relPath, entry.size);
                if (dataless) {
                    files.push({
                        relPath: entry.relPath,
                        size: entry.size,
                        mtimeMs,
                        nameOnly: true,
                        dataless: true,
                    });
                    continue;
                }
                // Content-indexed text, or filename-only: oversized files
                // and .log/.csv/.json are never read in full (a 60 MB .log
                // once blocked the server for ~12 s and wrote a 31 MB index).
                const nameOnly = entry.size > maxBytes || NAME_ONLY_EXTENSIONS.has(ext);
                if (ext === '' || TEXT_EXTENSIONS.has(ext) || nameOnly) {
                    files.push({
                        relPath: entry.relPath,
                        size: entry.size,
                        mtimeMs,
                        nameOnly,
                        dataless: false,
                    });
                }
            }
            // Yield between directories so a huge library never blocks the loop.
            await LocalSearchIndex.yieldLoop();
        }
        return { files, allNames };
    }
    /**
     * Index one file's content. Returns the chunks and the postings
     * (term frequencies per chunk, by chunk position). The filename's
     * tokens are added to the first chunk, so a file is findable by
     * name even when its content never mentions the keyword (the 0.7.0
     * search matched by name OR content; the index must keep both).
     * An empty file gets one synthetic chunk carrying only its filename
     * tokens, so it stays findable by name.
     */
    indexFileContent(relPath, text, mtimeMs, size) {
        const rawChunks = chunkText(text);
        const chunks = [];
        const postings = [];
        const tags = extractTags(text);
        const date = extractDate(text, path.basename(relPath), mtimeMs);
        const fileNameTokens = tokenize(path.basename(relPath, path.extname(relPath)));
        const effectiveChunks = rawChunks.length > 0
            ? rawChunks
            : [{ startOffset: 0, endOffset: 0, section: '' }];
        const terms = new Set();
        for (let pos = 0; pos < effectiveChunks.length; pos += 1) {
            const raw = effectiveChunks[pos];
            const slice = text.slice(raw.startOffset, raw.endOffset);
            const tokens = tokenize(slice);
            if (pos === 0) {
                tokens.push(...fileNameTokens);
            }
            const tf = new Map();
            for (const tok of tokens) {
                tf.set(tok, (tf.get(tok) ?? 0) + 1);
            }
            chunks.push({
                id: -1, // assigned by the caller
                file: relPath,
                startOffset: raw.startOffset,
                endOffset: raw.endOffset,
                section: raw.section,
                tokenCount: tokens.length,
            });
            for (const [term, count] of tf) {
                terms.add(term);
                postings.push({ chunkPos: pos, term, count });
            }
        }
        return {
            entry: {
                mtimeMs,
                size,
                hash: '',
                tags,
                date,
                chunkIds: [],
                terms: [...terms],
                nameOnly: false,
            },
            chunks,
            postings,
        };
    }
    /**
     * Index one walked file into `target`. Filename-only entries
     * (oversized / .log / .csv / .json / dataless) never read the file.
     * Returns the entry, or null when the file was skipped (unreadable
     * or binary). Chunk ids come from `nextId`.
     */
    async addFileToIndex(target, file, nextId) {
        if (file.nameOnly) {
            const { entry, chunks, postings } = this.indexFileContent(file.relPath, '', file.mtimeMs, file.size);
            entry.nameOnly = true;
            this.attachChunks(target, entry, chunks, postings, nextId);
            return entry;
        }
        let data;
        try {
            data = await this.backend.readFile(file.relPath);
        }
        catch {
            return null;
        }
        if (!looksLikeText(data)) {
            return null;
        }
        const text = data.toString('utf8');
        const { entry, chunks, postings } = this.indexFileContent(file.relPath, text, file.mtimeMs, file.size);
        entry.hash = sha256Hex(data);
        this.attachChunks(target, entry, chunks, postings, nextId);
        return entry;
    }
    /** Assign chunk ids and wire chunks + postings into `target`. */
    attachChunks(target, entry, chunks, postings, nextId) {
        entry.chunkIds = [];
        const idByPos = [];
        for (const chunk of chunks) {
            const id = nextId();
            chunk.id = id;
            idByPos.push(id);
            entry.chunkIds.push(id);
            target.chunks.push(chunk);
        }
        for (const p of postings) {
            const id = idByPos[p.chunkPos];
            if (id === undefined) {
                continue;
            }
            const perChunk = target.postings[p.term] ?? nullRecord();
            // Fresh chunk ids are unique, so this insert always adds one
            // entry. (During a full rebuild the target is a scratch index
            // and the count is rebuilt from it afterwards.)
            if (target === this.data) {
                this.postingsCount.set(p.term, (this.postingsCount.get(p.term) ?? 0) + 1);
            }
            perChunk[String(id)] = p.count;
            target.postings[p.term] = perChunk;
        }
    }
    /**
     * Rebuild the whole index from disk (background; yields the event
     * loop between files). Holds the single-writer lock for the whole
     * build, so a concurrent rebuild in another process cannot
     * interleave and silently overwrite it. Returns `'locked'` when
     * the lock could not be taken (the old index stays in place) and
     * `'failed'` when the rebuild itself threw; a failure is logged —
     * a silent `'failed'` would leave the user with no way to tell
     * it apart from a lock.
     */
    async buildAll() {
        const locked = await this.acquireLock();
        if (!locked) {
            return 'locked';
        }
        this.status = 'building';
        // True once the new index has been swapped in: a later failure
        // is a write failure, and the swapped-in index is complete and
        // usable even for an empty library (totalChunks 0).
        let swappedIn = false;
        try {
            const { files, allNames } = await this.walkTextFiles();
            const next = {
                version: INDEX_FORMAT_VERSION,
                files: nullRecord(),
                chunks: [],
                postings: nullRecord(),
                totalChunks: 0,
                avgChunkLen: 0,
                updatedAt: new Date().toISOString(),
                fileNames: allNames,
            };
            let nextChunkId = 0;
            for (const file of files) {
                const entry = await this.addFileToIndex(next, file, () => {
                    const id = nextChunkId;
                    nextChunkId += 1;
                    return id;
                });
                if (entry !== null) {
                    next.files[file.relPath] = entry;
                }
                await LocalSearchIndex.yieldLoop();
            }
            next.totalChunks = next.chunks.length;
            let totalTokens = 0;
            for (const chunk of next.chunks) {
                totalTokens += chunk.tokenCount;
            }
            next.avgChunkLen = next.totalChunks > 0 ? totalTokens / next.totalChunks : 0;
            this.data = next;
            swappedIn = true;
            this.rebuildPostingsCount();
            this.nextChunkIdValue = nextChunkId;
            this.status = 'ready';
            await this.writeIndexFile();
            // A fresh index is on disk now: the distrusted copy is gone.
            this.distrustDisk = false;
            return 'built';
        }
        catch (error) {
            // A failed build leaves the previous index (if any) in place;
            // searches keep falling back to a direct scan. If the new
            // index was already swapped in, it is complete and usable —
            // only the write failed — so the status stays 'ready' even
            // for an empty library (totalChunks 0).
            this.status =
                swappedIn || this.data.totalChunks > 0 ? 'ready' : 'unbuilt';
            console.error(`[memdrive] search index rebuild failed: ${error instanceof Error ? error.message : String(error)}`);
            return 'failed';
        }
        finally {
            await this.releaseLock();
        }
    }
    /**
     * Light incremental refresh: stat scan; re-index only files whose
     * mtime/size changed (hash on mismatch). Throttled to once per
     * 5 s, except after a save (markDirty), which always refreshes.
     * Overlapping refreshes join the one already running — and a
     * joiner queues a follow-up pass, because the running pass
     * started before the joiner's changes and may miss them (without
     * this, a refresh requested during a background pass could
     * return having seen none of the new files). When too many files
     * changed, a full rebuild is cheaper than updating file by file,
     * so it rebuilds instead.
     */
    refreshIfNeeded(nowMs = Date.now(), opts) {
        if (this.status !== 'ready') {
            return Promise.resolve();
        }
        if (this.refreshPromise !== null) {
            // Join the running chain. An awaited caller also queues a
            // follow-up pass, because the running pass started before
            // this call and may miss its changes. A background caller
            // (a routine query refresh nobody waits on) only joins: the
            // next query refreshes again anyway, so queueing a pass per
            // query would keep the library re-walking forever.
            if (opts?.background !== true) {
                this.refreshQueued = true;
            }
            return this.refreshPromise;
        }
        const forced = this.needsRefresh;
        if (!forced && nowMs - this.lastRefreshMs < INDEX_REFRESH_MIN_INTERVAL_MS) {
            return Promise.resolve();
        }
        this.lastRefreshMs = nowMs;
        this.needsRefresh = false;
        // One chain: keep passing until nothing was queued (or dirtied)
        // while a pass ran. Joiners wait on this same promise.
        const run = async () => {
            for (;;) {
                this.refreshQueued = false;
                this.lastRefreshMs = Date.now();
                await this.doRefresh();
                if (!this.refreshQueued && !this.needsRefresh) {
                    break;
                }
                this.needsRefresh = false;
            }
        };
        this.refreshPromise = run().finally(() => {
            this.refreshPromise = null;
        });
        return this.refreshPromise;
    }
    /** A save just changed this file: drop its stale entry and make the next search refresh. */
    markDirty(relPath) {
        this.removeFileFromIndex(relPath);
        this.needsRefresh = true;
        this.lastRefreshMs = 0;
    }
    async doRefresh() {
        const { files, allNames } = await this.walkTextFiles();
        // Pass 1 (stat only): classify without reading anything.
        const changed = [];
        const seen = new Set();
        for (const file of files) {
            seen.add(file.relPath);
            const existing = this.data.files[file.relPath];
            if (existing !== undefined &&
                existing.mtimeMs === file.mtimeMs &&
                existing.size === file.size &&
                existing.nameOnly === file.nameOnly) {
                continue;
            }
            changed.push(file);
        }
        const deleted = [];
        for (const relPath of Object.keys(this.data.files)) {
            if (!seen.has(relPath)) {
                deleted.push(relPath);
            }
        }
        // Too many changes: a full rebuild is cheaper than updating
        // file by file (each removal used to scan the whole index).
        const totalFiles = Object.keys(this.data.files).length;
        if (changed.length + deleted.length > Math.max(200, Math.floor(totalFiles * 0.05))) {
            if ((await this.buildAll()) === 'built') {
                return;
            }
            // The lock was busy or the rebuild failed: fall through to
            // incremental updates.
        }
        const anyChange = changed.length > 0 || deleted.length > 0;
        // Pass 2: apply the changes, yielding between files. All
        // removals share one doomed set; the chunks array is filtered
        // once at the end, not once per file.
        const doomedAll = new Set();
        for (const file of changed) {
            const existing = this.data.files[file.relPath];
            if (file.nameOnly) {
                // Never read: rebuild the filename-only entry.
                this.removeFileFromIndex(file.relPath, doomedAll);
                const entry = await this.addFileToIndex(this.data, file, () => this.nextChunkId());
                if (entry !== null) {
                    this.data.files[file.relPath] = entry;
                }
                await LocalSearchIndex.yieldLoop();
                continue;
            }
            let data;
            try {
                data = await this.backend.readFile(file.relPath);
            }
            catch {
                continue;
            }
            if (!looksLikeText(data)) {
                this.removeFileFromIndex(file.relPath, doomedAll);
                await LocalSearchIndex.yieldLoop();
                continue;
            }
            const hash = sha256Hex(data);
            if (existing !== undefined && existing.hash === hash) {
                // mtime moved (sync tool) but content is identical: refresh
                // the recorded mtime/size without re-indexing.
                existing.mtimeMs = file.mtimeMs;
                existing.size = file.size;
                existing.nameOnly = false;
                await LocalSearchIndex.yieldLoop();
                continue;
            }
            this.removeFileFromIndex(file.relPath, doomedAll);
            const text = data.toString('utf8');
            const { entry, chunks, postings } = this.indexFileContent(file.relPath, text, file.mtimeMs, file.size);
            entry.hash = hash;
            this.attachChunks(this.data, entry, chunks, postings, () => this.nextChunkId());
            this.data.files[file.relPath] = entry;
            await LocalSearchIndex.yieldLoop();
        }
        for (const relPath of deleted) {
            this.removeFileFromIndex(relPath, doomedAll);
        }
        if (doomedAll.size > 0) {
            this.data.chunks = this.data.chunks.filter((c) => !doomedAll.has(c.id));
        }
        this.data.fileNames = allNames;
        if (anyChange) {
            this.recomputeTotals();
            // The disk write runs in the background: the in-memory index
            // is already fresh, and a search that triggered this refresh
            // should not wait ~1.5 s for JSON.stringify + the write. The
            // index is a rebuildable cache, so a write lost to a crash or
            // to a lock held by another process self-heals on the next
            // refresh (the changed file's mtime still differs).
            void this.persist().catch(() => undefined);
        }
    }
    nextChunkId() {
        const id = this.nextChunkIdValue;
        this.nextChunkIdValue += 1;
        return id;
    }
    /**
     * Remove a file's chunks and postings. When `doomedOut` is given,
     * the file's chunk ids are added to it and the chunks array is
     * NOT filtered here — the caller filters once after removing many
     * files (filtering the whole array per file made bulk updates
     * O(files × chunks)).
     */
    removeFileFromIndex(relPath, doomedOut) {
        const entry = this.data.files[relPath];
        if (entry === undefined) {
            return;
        }
        const doomed = new Set(entry.chunkIds);
        if (doomedOut !== undefined) {
            for (const id of doomed) {
                doomedOut.add(id);
            }
        }
        else {
            this.data.chunks = this.data.chunks.filter((c) => !doomed.has(c.id));
        }
        // Only this file's own terms (recorded at index time), never a
        // scan of the whole postings map: that scan made bulk updates
        // slower than a full rebuild.
        const terms = entry.terms ?? [];
        if (terms.length === 0 && doomed.size > 0) {
            // No term list (an index written before terms were recorded):
            // fall back to the full scan once.
            for (const term of Object.keys(this.data.postings)) {
                this.dropChunksFromTerm(term, doomed);
            }
        }
        else {
            for (const term of terms) {
                this.dropChunksFromTerm(term, doomed);
            }
        }
        delete this.data.files[relPath];
    }
    dropChunksFromTerm(term, doomed) {
        const perChunk = this.data.postings[term];
        if (perChunk === undefined) {
            return;
        }
        let removed = 0;
        for (const id of doomed) {
            if (id in perChunk) {
                delete perChunk[String(id)];
                removed += 1;
            }
        }
        if (removed === 0) {
            return;
        }
        const left = (this.postingsCount.get(term) ?? 0) - removed;
        if (left <= 0) {
            delete this.data.postings[term];
            this.postingsCount.delete(term);
        }
        else {
            this.postingsCount.set(term, left);
        }
    }
    recomputeTotals() {
        this.data.totalChunks = this.data.chunks.length;
        let totalTokens = 0;
        for (const chunk of this.data.chunks) {
            totalTokens += chunk.tokenCount;
        }
        this.data.avgChunkLen =
            this.data.totalChunks > 0 ? totalTokens / this.data.totalChunks : 0;
        this.data.updatedAt = new Date().toISOString();
    }
    /** Persist the index (single-writer lock, atomic write). Skips the write when another process holds the lock. */
    async persist() {
        const acquired = await this.acquireLock();
        if (!acquired) {
            return;
        }
        try {
            await this.writeIndexFile();
        }
        finally {
            await this.releaseLock();
        }
    }
    /** Write the current index file; the caller must hold the lock (buildAll holds it for the whole build). */
    async writeIndexFile() {
        await fs.mkdir(this.cacheDir, { recursive: true });
        await atomicWrite(this.indexPath, JSON.stringify(this.data), {});
    }
    /**
     * True when another process is currently building (holds a fresh
     * lock). A stale lock — older than the timeout, e.g. left by a
     * crashed process — does not count: the builder is gone, so the
     * on-disk index is safe to load and the lock is stealable.
     */
    async isLockHeldByLiveProcess() {
        let raw;
        try {
            raw = await fs.readFile(this.lockPath, 'utf8');
        }
        catch {
            return false; // No lock file.
        }
        try {
            const prev = JSON.parse(raw);
            return (typeof prev.time === 'number' &&
                Date.now() - prev.time <= INDEX_LOCK_TIMEOUT_MS);
        }
        catch {
            // Unreadable (empty or half-written): the owner just created
            // the lock and is still writing the stamp. It counts as held
            // when the file itself is fresh — same mtime rule as
            // isLockStealable, or a just-started build is not deferred to.
            try {
                const st = await fs.stat(this.lockPath);
                return Date.now() - st.mtimeMs <= INDEX_LOCK_TIMEOUT_MS;
            }
            catch {
                return false;
            }
        }
    }
    /**
     * True when the lock file is present and provably stale (its
     * owner is gone), so it may be stolen. A fresh lock is not
     * stealable. An unreadable lock is not stealable either, unless
     * the file itself is old: a lock whose owner just created it is
     * an empty file until the stamp lands, and treating that empty
     * file as "corrupt, delete it" lets two processes hold the lock
     * at once (the 0.8.3 acquire-side race).
     */
    async isLockStealable() {
        let raw;
        try {
            raw = await fs.readFile(this.lockPath, 'utf8');
        }
        catch {
            return false; // No lock file: nothing to steal.
        }
        try {
            const prev = JSON.parse(raw);
            if (typeof prev.time === 'number') {
                return Date.now() - prev.time > INDEX_LOCK_TIMEOUT_MS;
            }
            // No usable timestamp: fall back to the file's mtime.
        }
        catch {
            // Unparseable (empty or half-written): fall back to mtime.
        }
        try {
            const st = await fs.stat(this.lockPath);
            return Date.now() - st.mtimeMs > INDEX_LOCK_TIMEOUT_MS;
        }
        catch {
            return false;
        }
    }
    /** Try to take the lock file ('wx'); steal it when older than the timeout. */
    async acquireLock() {
        // The cache directory must exist before the lock file can be
        // created in it; on a first build it does not exist yet.
        try {
            await fs.mkdir(this.cacheDir, { recursive: true });
        }
        catch {
            return false;
        }
        // A random token identifies OUR lock: an old process that wakes
        // up after its lock was stolen must not delete the new owner's
        // lock in releaseLock. The token is written into the lock file
        // and kept on the instance for the ownership check.
        const token = crypto.randomBytes(16).toString('hex');
        const stamp = JSON.stringify({ pid: process.pid, time: Date.now(), token });
        for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
                const handle = await fs.open(this.lockPath, 'wx');
                try {
                    await handle.writeFile(stamp);
                }
                finally {
                    await handle.close();
                }
                this.lockToken = token;
                this.startLockHeartbeat();
                return true;
            }
            catch (error) {
                if (error.code !== 'EEXIST') {
                    return false;
                }
                // Another process holds the lock, or is in the middle of
                // creating it. Steal it only when it is provably stale.
                if (await this.isLockStealable()) {
                    // Re-check immediately before unlinking: another
                    // process may have taken the lock over since the first
                    // read, and unlinking then would delete the new
                    // owner's lock (the steal-side TOCTOU).
                    if (await this.isLockStealable()) {
                        try {
                            await fs.unlink(this.lockPath);
                        }
                        catch {
                            // Someone else removed it first: retry the create.
                        }
                    }
                    continue;
                }
                // Held by a live process: wait briefly, then give up.
                await new Promise((resolve) => {
                    setTimeout(resolve, 100);
                });
            }
        }
        return false;
    }
    /**
     * Release the lock — but only when it is still ours. An old
     * process that wakes up after its lock was stolen (30 s timeout,
     * another process took over) must not delete the new owner's
     * lock: the unconditional unlink here was the 0.8.2 lock race.
     */
    async releaseLock() {
        this.stopLockHeartbeat();
        if (this.lockToken === null) {
            return;
        }
        const token = this.lockToken;
        this.lockToken = null;
        try {
            const raw = await fs.readFile(this.lockPath, 'utf8');
            const prev = JSON.parse(raw);
            if (prev.token !== token) {
                // Stolen (or already replaced): it is someone else's lock now.
                return;
            }
            await fs.unlink(this.lockPath);
        }
        catch {
            // Lock already gone (stolen as stale, then released): nothing to do.
        }
    }
    /**
     * Renew the lock timestamp while we hold it, so a build running
     * longer than the 30 s staleness timeout cannot have its lock
     * stolen by another process. Fires every 10 s (a third of the
     * timeout); each tick rewrites the lock file with a fresh time
     * only when it still carries our token, and stops itself when
     * the lock is no longer ours.
     */
    startLockHeartbeat() {
        this.stopLockHeartbeat();
        this.lockHeartbeat = setInterval(() => {
            void (async () => {
                if (this.lockToken === null) {
                    this.stopLockHeartbeat();
                    return;
                }
                const token = this.lockToken;
                try {
                    const raw = await fs.readFile(this.lockPath, 'utf8');
                    const prev = JSON.parse(raw);
                    if (prev.token !== token) {
                        // Stolen: stop renewing a lock that is no longer ours.
                        this.stopLockHeartbeat();
                        return;
                    }
                    const stamp = JSON.stringify({
                        pid: prev.pid ?? process.pid,
                        time: Date.now(),
                        token,
                    });
                    // Atomic (temp file + rename): a plain writeFile
                    // truncates first, and a reader in that window sees an
                    // empty / half-written lock and may delete it as "stale".
                    await atomicWrite(this.lockPath, stamp, {});
                }
                catch {
                    // Lock gone or unreadable: stop renewing.
                    this.stopLockHeartbeat();
                }
            })();
        }, 10_000);
        // A heartbeat must never keep the process alive on its own.
        this.lockHeartbeat.unref();
    }
    stopLockHeartbeat() {
        if (this.lockHeartbeat !== null) {
            clearInterval(this.lockHeartbeat);
            this.lockHeartbeat = null;
        }
    }
    /** Ranked search over the index. Returns ready:false when the index is not built yet. */
    async search(query) {
        // Input validation first: a bad date is the caller's error, not
        // a damaged index — it must surface instead of triggering a
        // rebuild (the catch below is only for index corruption).
        const dateFrom = parseDateBound(query.dateFrom, false);
        const dateTo = parseDateBound(query.dateTo, true);
        const modAfter = parseDateBound(query.modifiedAfter, false);
        const modBefore = parseDateBound(query.modifiedBefore, true);
        try {
            return await this.searchInner(query, dateFrom, dateTo, modAfter, modBefore);
        }
        catch {
            // A damaged in-memory index must never fail every search
            // forever: mark the on-disk copy distrusted (it is the same
            // damaged data — loading it again would only re-arm the same
            // failure), drop back to unbuilt so callers fall back to a
            // direct scan, and rebuild in the background.
            this.distrustDisk = true;
            this.status = 'unbuilt';
            void this.ensureReady().catch(() => undefined);
            return { ready: false, hits: [], total: 0 };
        }
    }
    async searchInner(query, dateFrom, dateTo, modAfter, modBefore) {
        // A save just happened: wait for the refresh, so the new file
        // is searchable at once. Routine time-based refreshes run in
        // the background instead: a query must not wait for a full
        // stat scan of the library.
        if (this.needsRefresh) {
            await this.refreshIfNeeded().catch(() => undefined);
        }
        else {
            void this.refreshIfNeeded(Date.now(), { background: true }).catch(() => undefined);
        }
        if (this.status !== 'ready') {
            return { ready: false, hits: [], total: 0 };
        }
        // Single-character terms are noise in a multi-character query:
        // they only mean something when the query itself is one char.
        let terms = tokenizeQuery(query.keyword);
        if (terms.some((t) => [...t].length > 1)) {
            terms = terms.filter((t) => [...t].length > 1 || !hasCjk(t));
        }
        const phrase = query.exactPhrase
            ? normalizeText(query.exactPhrase)
            : null;
        // Single-character CJK noise, second half: the filter above
        // only triggers when some term is multi-character. When the
        // segmenter splits a multi-character CJK query into single
        // characters only (说了 -> 说 / 了), every term is a particle
        // and OR-matching floods the results. In that case — and only
        // that case — require the query's CJK run to appear verbatim
        // in the chunk, like an implicit exact phrase. Queries that
        // segment into a multi-character term are unaffected.
        let substringReq = null;
        const cjkRuns = normalizeText(query.keyword)
            .split(CJK_RUN_SPLIT_RE)
            .filter((r) => r.length > 0);
        if (cjkRuns.length === 1 &&
            [...cjkRuns[0]].length > 1 &&
            terms.length > 0 &&
            terms.every((t) => [...t].length === 1 && hasCjk(t))) {
            substringReq = cjkRuns[0];
        }
        const fileTypes = (query.fileTypes ?? []).map((e) => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`);
        // Tags are case-insensitive and never keep a leading '#'.
        const tags = (query.tags ?? []).map((t) => t.replace(/^#+/, '').toLowerCase());
        const scopePath = query.path ?? '';
        const filePasses = (relPath, entry) => {
            if (scopePath !== '' && relPath !== scopePath && !relPath.startsWith(`${scopePath}/`)) {
                return false;
            }
            if (fileTypes.length > 0) {
                const ext = path.extname(relPath).toLowerCase();
                if (!fileTypes.includes(ext)) {
                    return false;
                }
            }
            if (tags.length > 0 && !tags.some((t) => entry.tags.includes(t))) {
                return false;
            }
            if (dateFrom !== null || dateTo !== null) {
                const d = entry.date === null ? null : new Date(entry.date).getTime();
                if (d === null) {
                    return false;
                }
                if (dateFrom !== null && d < dateFrom) {
                    return false;
                }
                if (dateTo !== null && d > dateTo) {
                    return false;
                }
            }
            if (modAfter !== null && entry.mtimeMs < modAfter) {
                return false;
            }
            if (modBefore !== null && entry.mtimeMs > modBefore) {
                return false;
            }
            return true;
        };
        const chunkById = new Map();
        for (const chunk of this.data.chunks) {
            chunkById.set(chunk.id, chunk);
        }
        // One read per file per search: the phrase check and the snippet
        // builder used to re-read the same file for every chunk.
        const fileTextCache = new Map();
        const readFileText = async (relPath) => {
            const cached = fileTextCache.get(relPath);
            if (cached !== undefined) {
                return cached;
            }
            let text = '';
            try {
                text = (await this.backend.readFile(relPath)).toString('utf8');
            }
            catch {
                text = '';
            }
            fileTextCache.set(relPath, text);
            return text;
        };
        const totalDocs = this.data.totalChunks;
        const scores = new Map();
        for (const term of terms) {
            const perChunk = this.data.postings[term];
            if (perChunk === undefined) {
                continue;
            }
            const df = Object.keys(perChunk).length;
            for (const [idStr, tf] of Object.entries(perChunk)) {
                const id = Number(idStr);
                const chunk = chunkById.get(id);
                if (chunk === undefined) {
                    continue;
                }
                const entry = this.data.files[chunk.file];
                if (entry === undefined || !filePasses(chunk.file, entry)) {
                    continue;
                }
                const s = bm25(tf, df, totalDocs, chunk.tokenCount, this.data.avgChunkLen);
                scores.set(id, (scores.get(id) ?? 0) + s);
            }
        }
        // Filename-substring matches (0.7.0 behavior): the raw keyword
        // as a substring of the filename, over EVERY file in the
        // library — not just tokenized text. `memdr` must still find
        // `memdrive-notes.md`, and `shot` must find `shot.png`.
        const rawNorm = normalizeText(query.keyword);
        let nameSubIds = [];
        let syntheticHits = [];
        if (rawNorm.length > 0) {
            const firstChunkByFile = new Map();
            for (const chunk of this.data.chunks) {
                if (!firstChunkByFile.has(chunk.file)) {
                    firstChunkByFile.set(chunk.file, chunk.id);
                }
            }
            const namePasses = (relPath) => {
                const entry = this.data.files[relPath];
                if (entry !== undefined) {
                    return filePasses(relPath, entry);
                }
                if (scopePath !== '' && relPath !== scopePath && !relPath.startsWith(`${scopePath}/`)) {
                    return false;
                }
                if (fileTypes.length > 0) {
                    const ext = path.extname(relPath).toLowerCase();
                    if (!fileTypes.includes(ext)) {
                        return false;
                    }
                }
                // No tags or dates are known for a file outside the index:
                // with those filters set, it cannot be shown to match.
                if (tags.length > 0 || dateFrom !== null || dateTo !== null || modAfter !== null || modBefore !== null) {
                    return false;
                }
                return true;
            };
            for (const relPath of this.data.fileNames) {
                const base = normalizeText(path.basename(relPath));
                if (!base.includes(rawNorm)) {
                    continue;
                }
                if (!namePasses(relPath)) {
                    continue;
                }
                const firstChunk = firstChunkByFile.get(relPath);
                if (firstChunk !== undefined) {
                    nameSubIds.push(firstChunk);
                }
                else {
                    // Not indexed as text (an image, say): a synthetic hit
                    // carrying the filename. Listed first, like 0.7.0.
                    syntheticHits.push({
                        path: relPath,
                        score: 0,
                        snippet: path.basename(relPath),
                        startOffset: 0,
                        endOffset: 0,
                        section: '',
                    });
                }
            }
        }
        // Exact phrase: only chunks whose normalized text contains it.
        // Filename matches must pass it too; synthetic hits cannot be
        // verified (their content is not indexed) and are dropped.
        if (phrase !== null) {
            const phraseOk = new Set();
            const candidates = new Set([...scores.keys(), ...nameSubIds]);
            for (const id of candidates) {
                const chunk = chunkById.get(id);
                if (chunk === undefined) {
                    continue;
                }
                const text = normalizeText((await readFileText(chunk.file)).slice(chunk.startOffset, chunk.endOffset));
                if (text.includes(phrase)) {
                    phraseOk.add(id);
                }
            }
            for (const id of [...scores.keys()]) {
                if (!phraseOk.has(id)) {
                    scores.delete(id);
                }
            }
            nameSubIds = nameSubIds.filter((id) => phraseOk.has(id));
            syntheticHits = [];
        }
        // Implicit substring requirement (see above): only content
        // hits are filtered — filename hits already match the raw
        // keyword, so they are left alone.
        if (substringReq !== null) {
            const subOk = new Set();
            for (const id of scores.keys()) {
                const chunk = chunkById.get(id);
                if (chunk === undefined) {
                    continue;
                }
                const text = normalizeText((await readFileText(chunk.file)).slice(chunk.startOffset, chunk.endOffset));
                if (text.includes(substringReq)) {
                    subOk.add(id);
                }
            }
            for (const id of [...scores.keys()]) {
                if (!subOk.has(id)) {
                    scores.delete(id);
                }
            }
        }
        // Filename ranking for RRF fusion: files whose name contains a query term rank first.
        const bm25Ranked = [...scores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => id);
        const nameScores = new Map();
        for (const id of bm25Ranked) {
            const chunk = chunkById.get(id);
            if (chunk === undefined) {
                continue;
            }
            const base = path.basename(chunk.file).normalize('NFKC').toLowerCase();
            let hits = 0;
            for (const term of terms) {
                if (term.length > 0 && base.includes(term)) {
                    hits += 1;
                }
            }
            if (hits > 0) {
                nameScores.set(id, hits);
            }
        }
        const nameRanked = [...nameScores.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([id]) => id);
        const rankLists = [bm25Ranked];
        if (nameSubIds.length > 0) {
            rankLists.push(nameSubIds);
        }
        if (nameRanked.length > 0) {
            rankLists.push(nameRanked);
        }
        const fused = reciprocalRankFusion(rankLists);
        const ranked = [...fused.entries()]
            .sort((a, b) => b[1] - a[1] || (scores.get(b[0]) ?? 0) - (scores.get(a[0]) ?? 0))
            .map(([id]) => id);
        // One hit per file (the best chunk): a long note used to flood
        // the page with its own chunks, and `total` counted chunks.
        const seenFiles = new Set();
        const deduped = [];
        for (const id of ranked) {
            const chunk = chunkById.get(id);
            if (chunk === undefined || seenFiles.has(chunk.file)) {
                continue;
            }
            seenFiles.add(chunk.file);
            deduped.push(id);
        }
        const ordered = [
            ...syntheticHits.map((hit) => ({ kind: 'synthetic', hit })),
            ...deduped.map((id) => ({ kind: 'chunk', id })),
        ];
        const total = ordered.length;
        const limit = query.limit ?? 20;
        const offset = query.offset ?? 0;
        const page = ordered.slice(offset, offset + limit);
        const hits = [];
        for (const item of page) {
            if (item.kind === 'synthetic') {
                hits.push(item.hit);
                continue;
            }
            const chunk = chunkById.get(item.id);
            if (chunk === undefined) {
                continue;
            }
            const slice = (await readFileText(chunk.file)).slice(chunk.startOffset, chunk.endOffset);
            hits.push({
                path: chunk.file,
                score: scores.get(item.id) ?? 0,
                snippet: highlightSnippet(slice, terms, query.keyword),
                startOffset: chunk.startOffset,
                endOffset: chunk.endOffset,
                section: chunk.section,
            });
        }
        return { ready: true, hits, total };
    }
    /**
     * Read-only diagnostics: empty files, duplicates (SHA-256), broken
     * image refs, orphan attachment candidates. When `scope` is set,
     * only files under that directory are reported. Hashes come from
     * the index when the recorded mtime/size still match, so a scan
     * does not re-read (and re-hash) the whole library — or trigger a
     * cloud download for files the index already knows.
     */
    async scanDiagnostics(scope) {
        const emptyFiles = [];
        const byHash = new Map();
        const brokenImageRefs = [];
        const referenced = new Set();
        const maxBytes = resolveIndexMaxFileBytes(process.env['MEMDRIVE_INDEX_MAX_BYTES']);
        const indexReady = this.status === 'ready';
        const { files } = await this.walkTextFiles();
        // Basename lookup for Obsidian embeds: `![[pic.png]]` resolves
        // by filename across the whole library, not relative to the
        // note's directory.
        const imageByName = new Map();
        const allFiles = await this.walkAllFiles();
        for (const file of allFiles) {
            const ext = path.extname(file.relPath).toLowerCase();
            if (!IMAGE_EXTENSIONS.has(ext)) {
                continue;
            }
            const list = imageByName.get(path.basename(file.relPath)) ?? [];
            list.push(file.relPath);
            imageByName.set(path.basename(file.relPath), list);
        }
        for (const file of files) {
            if (file.size === 0) {
                emptyFiles.push(file.relPath);
                continue;
            }
            // Dataless cloud files (macOS): never read — a read would
            // trigger a cloud download. They carry no hash (the index
            // never read them either), so there is nothing to check.
            if (file.dataless) {
                continue;
            }
            // Files over the content cap are never read here either.
            if (file.size > maxBytes) {
                continue;
            }
            const ext = path.extname(file.relPath).toLowerCase();
            const isMarkdown = MARKDOWN_EXTENSIONS.has(ext);
            const indexEntry = indexReady ? this.data.files[file.relPath] : undefined;
            let data = null;
            let hash = null;
            if (indexEntry !== undefined &&
                indexEntry.mtimeMs === file.mtimeMs &&
                indexEntry.size === file.size &&
                indexEntry.hash !== '') {
                hash = indexEntry.hash;
            }
            if (isMarkdown) {
                // Markdown must be read anyway for its image references;
                // hashing the bytes already in hand costs nothing extra.
                try {
                    data = await this.backend.readFile(file.relPath);
                }
                catch {
                    continue;
                }
                hash = sha256Hex(data);
            }
            else if (hash === null && !file.nameOnly) {
                // Filename-only files (.json/.csv/.log) are data, not notes:
                // reading them just to hash for duplicates wastes I/O and
                // reports noise, so they are skipped here (0.8.2 #11).
                try {
                    data = await this.backend.readFile(file.relPath);
                }
                catch {
                    continue;
                }
                hash = sha256Hex(data);
            }
            if (hash !== null && !file.nameOnly) {
                const group = byHash.get(hash) ?? [];
                group.push(file.relPath);
                byHash.set(hash, group);
            }
            if (isMarkdown && data !== null) {
                const text = data.toString('utf8');
                for (const ref of scanMarkdownImages(text)) {
                    const resolved = await this.resolveImageRef(file.relPath, ref, imageByName);
                    if (resolved.status === 'ok') {
                        referenced.add(resolved.path);
                    }
                    else if (resolved.status === 'ambiguous') {
                        // Several files share the name: not broken, and none of
                        // them is an orphan.
                        for (const candidate of resolved.candidates) {
                            referenced.add(candidate);
                        }
                    }
                    else {
                        brokenImageRefs.push({ file: file.relPath, src: ref.src });
                    }
                }
            }
            await LocalSearchIndex.yieldLoop();
        }
        const duplicateGroups = [...byHash.values()].filter((g) => g.length > 1);
        // Orphan candidates: image files that no note references, older
        // than the minimum retention. Candidates only.
        const orphanCandidates = [];
        const now = Date.now();
        for (const file of allFiles) {
            const ext = path.extname(file.relPath).toLowerCase();
            if (!IMAGE_EXTENSIONS.has(ext)) {
                continue;
            }
            if (referenced.has(file.relPath)) {
                continue;
            }
            if (now - file.mtimeMs < ORPHAN_MIN_RETENTION_MS) {
                continue;
            }
            orphanCandidates.push(file.relPath);
        }
        if (scope !== undefined && scope !== '') {
            const under = (p) => p === scope || p.startsWith(`${scope}/`);
            return {
                emptyFiles: emptyFiles.filter(under),
                duplicateGroups: duplicateGroups
                    .map((g) => g.filter(under))
                    .filter((g) => g.length > 1),
                brokenImageRefs: brokenImageRefs.filter((r) => under(r.file)),
                orphanCandidates: orphanCandidates.filter(under),
            };
        }
        return { emptyFiles, duplicateGroups, brokenImageRefs, orphanCandidates };
    }
    /**
     * Resolve one image reference from a note. Inline, `<img>`, and
     * reference-style refs are relative to the note's directory.
     * Obsidian embeds without a `/` resolve by filename across the
     * whole library (that is how Obsidian finds them); with several
     * same-named files the reference is ambiguous, not broken.
     * Obsidian embeds WITH a `/` are vault paths: try the vault root
     * first (Obsidian's default), then the note's directory, then a
     * path-suffix match — a note in notes/deep writing
     * `![[attachments/pic.png]]` means the vault-root file, not
     * notes/deep/attachments/pic.png.
     */
    async resolveImageRef(noteRelPath, ref, imageByName) {
        // Normalize backslashes too, not just `path.sep`: a note
        // synced from Windows carries `folder\pic.png`, and on
        // macOS/Linux `path.sep` is `/`, so `split(path.sep)` would
        // leave the `\` intact and `path.posix.normalize` would not
        // recognize `..\` — the escape check below would be bypassed
        // and a legitimate Windows ref would fail to resolve.
        const src = ref.src.replace(/\\/g, '/');
        if (ref.kind === 'obsidian' && !src.includes('/')) {
            const candidates = imageByName.get(src) ?? [];
            if (candidates.length === 1) {
                return { status: 'ok', path: candidates[0] };
            }
            if (candidates.length > 1) {
                return { status: 'ambiguous', candidates };
            }
            return { status: 'broken' };
        }
        if (ref.kind === 'obsidian') {
            // Vault-root-relative first (a leading `/` is Obsidian's
            // absolute-in-vault form, so it is stripped, not kept).
            const vaultPath = path.posix.normalize(src.replace(/^\/+/, ''));
            // A ref that escapes the library (`![[../../outside.png]]`)
            // must not be probed: it would leak whether a file exists
            // outside the root (the content is blocked downstream, but
            // the existence signal alone is a side channel).
            if (vaultPath === '..' || vaultPath.startsWith('../')) {
                return { status: 'broken' };
            }
            if (await this.backend.exists(vaultPath)) {
                return { status: 'ok', path: vaultPath };
            }
            // Then note-relative.
            const noteRelative = path.posix.normalize(path.posix.join(path.posix.dirname(noteRelPath), vaultPath));
            if (noteRelative === '..' || noteRelative.startsWith('../')) {
                return { status: 'broken' };
            }
            if (await this.backend.exists(noteRelative)) {
                return { status: 'ok', path: noteRelative };
            }
            // Then path-suffix: the vault path ending in the given path.
            const suffixMatches = [];
            for (const candidates of imageByName.values()) {
                for (const candidate of candidates) {
                    if (candidate.endsWith(`/${vaultPath}`)) {
                        suffixMatches.push(candidate);
                    }
                }
            }
            if (suffixMatches.length === 1) {
                return { status: 'ok', path: suffixMatches[0] };
            }
            if (suffixMatches.length > 1) {
                return { status: 'ambiguous', candidates: suffixMatches };
            }
            return { status: 'broken' };
        }
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(noteRelPath), src));
        // Same escape guard as the Obsidian branch above: a ref that
        // resolves outside the library is broken, not probed.
        if (resolved === '..' || resolved.startsWith('../')) {
            return { status: 'broken' };
        }
        const exists = await this.backend.exists(resolved);
        return exists ? { status: 'ok', path: resolved } : { status: 'broken' };
    }
    /**
     * Resolve one image reference from a note, the same way
     * diagnostics does: Obsidian embeds resolve by filename across
     * the whole library (vault-root first, then note-relative, then
     * suffix), the rest relative to the note's directory. The
     * basename map is built from the index's file list (no disk
     * walk), so it only sees files the index knows. Used by read_file
     * so `![[pic.png]]` works there too (0.8.2 #2).
     */
    async resolveNoteImageRef(noteRelPath, ref) {
        // The basename map comes from the index's file list. When the
        // index is ready, make sure it is fresh (a just-saved image
        // is unresolvable until the next refresh) and use the full
        // map. When it is NOT ready, do NOT await the whole build:
        // ensureReady() blocks for the full index build (seconds on
        // a large library, over a minute on a very large one) and a
        // read_file would time out. Kick the build off in the
        // background instead and resolve with what needs no index
        // (vault-root and note-relative paths); only a basename-only
        // ref (`![[pic.png]]`) reports 'broken' this once, and a
        // retry after the build finds it.
        if (this.status !== 'ready') {
            // If ANOTHER process is still building (it holds the lock
            // and the on-disk index is not out yet), the list is still
            // empty. Wait briefly for that build to finish and retry
            // once (bounded: ~2 s, then the refs fail as before — a
            // retry will see them). Without this, a read_file in the
            // multi-process cold-start window reports every Obsidian
            // embed as missing. The wait runs at most once per 5 s: a
            // note with many images calls this once per image, and each
            // would otherwise wait the full ~2 s again. Only a FOREIGN
            // lock waits: when WE hold the lock (this.lockToken !==
            // null, our own background build) there is nothing to wait
            // for — waiting for our own build is the cold-start block
            // this fix removes.
            try {
                if (this.lockToken === null &&
                    Date.now() - this.lastColdWaitMs >= 5_000 &&
                    (await this.isLockHeldByLiveProcess())) {
                    this.lastColdWaitMs = Date.now();
                    for (let i = 0; i < 10; i += 1) {
                        await new Promise((resolve) => {
                            setTimeout(resolve, 200);
                        });
                        if (!(await this.isLockHeldByLiveProcess())) {
                            break;
                        }
                    }
                    await this.load().catch(() => undefined);
                    void this.refreshIfNeeded(Date.now(), { background: true }).catch(() => undefined);
                }
            }
            catch {
                // Best effort only; fall through with the stale/empty list.
            }
            // Fast disk load first: if a valid index already exists on
            // disk, loading it is quick (tens of ms for a small library)
            // and this call can use the full map. Without this, the
            // fire-and-forget ensureReady() below leaves status
            // 'unbuilt' at the map check (its internal load() is async
            // file I/O), so even a perfectly good on-disk index is
            // ignored on the first read after startup — the first
            // basename ref in the note reports 'broken' while later
            // ones (after the background load lands) succeed. Only
            // attempt the load when no build is already in flight and
            // the disk copy is trusted; otherwise fall through to the
            // background build + empty map below.
            if (!this.distrustDisk &&
                this.status === 'unbuilt' &&
                this.buildPromise === null) {
                await this.load().catch(() => undefined);
            }
        }
        // Use the index if it is ready now (either it was already, or
        // the fast disk load / foreign build above made it so);
        // otherwise kick the build off in the background and resolve
        // without the index.
        if (this.status === 'ready') {
            if (this.needsRefresh) {
                await this.refreshIfNeeded().catch(() => undefined);
            }
            else {
                void this.refreshIfNeeded(Date.now(), { background: true }).catch(() => undefined);
            }
        }
        else {
            void this.ensureReady().catch(() => undefined);
        }
        // Only build the basename map when the index is ready. On a
        // cold start it stays empty: resolveImageRef still resolves
        // vault-root and note-relative paths, and only basename-only
        // refs report 'broken' until the background build finishes.
        const imageByName = new Map();
        if (this.status === 'ready') {
            for (const relPath of this.data.fileNames) {
                const ext = path.extname(relPath).toLowerCase();
                if (!IMAGE_EXTENSIONS.has(ext)) {
                    continue;
                }
                const base = path.basename(relPath);
                const list = imageByName.get(base) ?? [];
                list.push(relPath);
                imageByName.set(base, list);
            }
        }
        return this.resolveImageRef(noteRelPath, ref, imageByName);
    }
    /** Walk every file (any type) for orphan detection. Same symlink guards as the text walk: no escapes, no loops. */
    async walkAllFiles() {
        const out = [];
        let rootRealDir = this.rootRealDir;
        try {
            rootRealDir = await fs.realpath(this.rootDir);
        }
        catch {
            // Keep the configured root.
        }
        const visited = new Set([rootRealDir]);
        const queue = [''];
        while (queue.length > 0) {
            const current = queue.shift();
            let entries;
            try {
                entries = await this.backend.listDirectory(current);
            }
            catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.name.startsWith('.mdtmp-') || isPlaceholderFile(entry.relPath)) {
                    continue;
                }
                // Symlink guard: only a symlink needs the realpath +
                // inside-root test — see walkTextFiles. Size/mtime come
                // from listDirectory; no extra stat per file.
                let real = null;
                if (entry.isSymlink) {
                    try {
                        real = await fs.realpath(path.join(this.rootDir, entry.relPath));
                        if (!isInside(rootRealDir, real)) {
                            continue;
                        }
                    }
                    catch {
                        continue;
                    }
                }
                if (entry.type === 'directory') {
                    // Directories are few: realpath for the loop guard.
                    if (real === null) {
                        try {
                            real = await fs.realpath(path.join(this.rootDir, entry.relPath));
                        }
                        catch {
                            continue;
                        }
                    }
                    if (!visited.has(real)) {
                        visited.add(real);
                        queue.push(entry.relPath);
                    }
                    continue;
                }
                out.push({
                    relPath: entry.relPath,
                    mtimeMs: new Date(entry.modifiedAt).getTime(),
                });
            }
            await LocalSearchIndex.yieldLoop();
        }
        return out;
    }
}
/** Highlight query terms in a snippet with **term** (first occurrence window, ~160 chars). */
export function highlightSnippet(slice, terms, rawQuery) {
    // Offsets are measured on the original slice (lowercased only):
    // measuring them on the NFKC-normalized string and slicing the
    // original with them shifted every match after a compatibility
    // character (`……` folds 2 chars into 6), sometimes leaving only
    // `…` as the whole snippet.
    const lower = slice.toLowerCase();
    // Window: first occurrence of the raw query when present, else the earliest term.
    let bestAt = -1;
    let bestLen = 0;
    const rawLower = rawQuery !== undefined ? rawQuery.toLowerCase() : '';
    if (rawLower.length > 0) {
        const at = lower.indexOf(rawLower);
        if (at !== -1) {
            bestAt = at;
            bestLen = rawLower.length;
        }
    }
    if (bestAt === -1) {
        for (const term of terms) {
            if (term.length === 0) {
                continue;
            }
            const at = lower.indexOf(term);
            if (at !== -1 && (bestAt === -1 || at < bestAt)) {
                bestAt = at;
                bestLen = term.length;
            }
        }
    }
    let windowText = slice;
    if (bestAt !== -1) {
        const start = Math.max(0, bestAt - 60);
        const end = Math.min(slice.length, bestAt + bestLen + 100);
        windowText = (start > 0 ? '…' : '') + slice.slice(start, end) + (end < slice.length ? '…' : '');
    }
    else {
        windowText = slice.slice(0, 160);
    }
    // One combined pass, longest candidate first: a multi-char term is
    // wrapped once instead of being re-wrapped char by char (which
    // would nest the asterisks). The raw query is a candidate too, so
    // the user's exact phrase highlights as one span.
    const candidates = [...new Set([rawQuery ?? '', ...terms])]
        .filter((t) => t.length > 0)
        .sort((a, b) => b.length - a.length);
    if (candidates.length === 0) {
        return windowText.replace(/\n+/g, ' ').trim().slice(0, 400);
    }
    const pattern = new RegExp(`(${candidates.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    const out = windowText.replace(pattern, '**$1**');
    return out.replace(/\n+/g, ' ').trim().slice(0, 400);
}
