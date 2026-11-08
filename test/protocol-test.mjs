#!/usr/bin/env node
/**
 * MemDrive protocol tests — drive the built server over stdio with the
 * SDK's own Client, exactly like a real MCP client would.
 *
 * Run:  npm test        (builds nothing; run `npm run build` first)
 * Env:  MEMDRIVE_TEST_KEEP=1 keeps the scratch dir for inspection.
 *
 * Exit code 0 = every check passed.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Jimp } from 'jimp';

import { resolveResponseBudgetBytes, resolveSearchMaxBytes, resolveIndexCacheDir, resolveIndexMaxFileBytes } from '../dist/config.js';
import {
  backupPathFor,
  claudeCodeAdapter,
  claudeDesktopAdapter,
  cursorAdapter,
  HOST_ADAPTERS,
  hostAdapterForId,
  mergeConfigJson,
  parseHostArgument,
  vscodeAdapter,
  writeHostConfig,
} from '../dist/host-config.js';
import { atomicWrite } from '../dist/atomic.js';
import { acquireImage, detectImageMime, encodeImageSrc, extensionForMime, mimeFromExtension, scanMarkdownImages } from '../dist/images.js';
import { BlockedUrlError, safeRequest } from '../dist/net-guard.js';
import { LocalStorageBackend } from '../dist/storage.js';
import { validateCrossPlatformSegments } from '../dist/sandbox.js';
import {
  LocalSearchIndex,
  bm25,
  chunkText,
  extractDate,
  extractTags,
  highlightSnippet,
  isPlaceholderFile,
  normalizeText,
  reciprocalRankFusion,
  tokenize,
  tokenizeQuery,
} from '../dist/search-index.js';
import { folderCommandFor, openFolderInViewer, openInViewer, viewerCommandFor } from '../dist/viewer.js';
import { handleSearchFiles, resolveContainingFolder } from '../dist/tools.js';
import {
  buildServerEntry,
  configSnippet,
  expandCustomPath,
  probeCandidateRoots,
  serverScriptPath,
} from '../dist/wizard.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(ROOT, '..');
const SERVER = path.join(PROJECT, 'dist', 'index.js');

const results = [];
let failures = 0;

async function check(name, fn) {
  try {
    await fn();
    results.push(`PASS  ${name}`);
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    const message = error instanceof Error ? error.message : String(error);
    results.push(`FAIL  ${name} — ${message}`);
    console.log(`FAIL  ${name} — ${message}`);
  }
}

function textOf(result) {
  return result.content
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
}

function imagesOf(result) {
  return result.content.filter((c) => c.type === 'image');
}

/** Total response size as the transport sees it: text bytes + base64 bytes. */
function resultSizeBytes(result) {
  let total = 0;
  for (const block of result.content) {
    if (block.type === 'text') {
      total += Buffer.byteLength(block.text, 'utf8');
    } else if (block.type === 'image') {
      total += block.data.length;
    }
  }
  return total;
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic noisy PNG of roughly `bytes` scale; returns the buffer. */
async function makeNoisePng(width, height, seed) {
  const img = new Jimp({ width, height });
  const rand = mulberry32(seed);
  const data = img.bitmap.data;
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.floor(rand() * 256);
  }
  return img.getBuffer('image/png');
}

/**
 * Deterministic noisy BMP. BMP is uncompressed, so 512x512 is
 * 786,488 bytes — the same shape as the real Claude Desktop failure
 * (an 813.5 KB screenshot whose base64 is ~1.11 MB, over the
 * 1,048,576 transport ceiling and over the 950,000 budget).
 */
async function makeNoiseBmp(width, height, seed) {
  const img = new Jimp({ width, height });
  const rand = mulberry32(seed);
  const data = img.bitmap.data;
  for (let i = 0; i < data.length; i += 1) {
    data[i] = Math.floor(rand() * 256);
  }
  return img.getBuffer('image/bmp');
}

/**
 * Deterministic screenshot-like PNG: a blocky photo-texture top
 * region over flat comment rows (white background, dark text bars,
 * avatar squares). Its full-resolution JPEG at quality 80 fits the
 * budget easily, so a quality-80-only ladder would stop there; the
 * quality ladder must return a strictly larger preview (quality 90
 * or 95) at the same full resolution. Seeded, so the bytes are
 * identical on every machine.
 */
async function makeScreenshotPng() {
  const width = 1080;
  const height = 2400;
  const img = new Jimp({ width, height, color: 0xffffffff });
  const rand = mulberry32(20261028);
  const data = img.bitmap.data;
  const setPx = (x, y, r, g, b) => {
    const i = (y * width + x) * 4;
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  };
  const fillRect = (x0, y0, w, h, r, g, b) => {
    for (let y = y0; y < y0 + h && y < height; y++) {
      for (let x = x0; x < x0 + w && x < width; x++) setPx(x, y, r, g, b);
    }
  };
  const BLOCK = 12;
  for (let by = 0; by < 960; by += BLOCK) {
    for (let bx = 0; bx < width; bx += BLOCK) {
      const br = 70 + Math.floor(rand() * 130);
      const bg = 60 + Math.floor(rand() * 120);
      const bb = 60 + Math.floor(rand() * 110);
      for (let y = by; y < by + BLOCK && y < 960; y++) {
        for (let x = bx; x < bx + BLOCK && x < width; x++) {
          const j = Math.floor(rand() * 25) - 12;
          setPx(x, y, br + j, bg + j, bb + j);
        }
      }
    }
  }
  let y = 1000;
  let row = 0;
  while (y < height - 60) {
    fillRect(28, y, 46, 46, 120 + ((row * 37) % 100), 140, 190);
    fillRect(92, y + 2, 180 + ((row * 53) % 220), 16, 40, 40, 40);
    fillRect(92, y + 28, 420 + ((row * 91) % 380), 15, 60, 60, 60);
    fillRect(92, y + 50, 260 + ((row * 67) % 300), 14, 110, 110, 110);
    for (let x = 24; x < width - 24; x++) setPx(x, y + 78, 225, 225, 225);
    y += 96;
    row++;
  }
  return img.getBuffer('image/png');
}

async function main() {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memdrive-test-'));
  const root = path.join(scratch, 'library');
  await fs.mkdir(root, { recursive: true });
  const outside = path.join(scratch, 'outside');
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, 'secret.txt'), 'ZQXJ TOP-SECRET-OUTSIDE-ROOT\n');

  let serverStderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: {
      ...process.env,
      MEMDRIVE_ROOT: root,
      // Keep the test server's search index in the scratch dir, never
      // in the real user cache.
      MEMDRIVE_CACHE_DIR: path.join(scratch, 'index-cache'),
    },
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    serverStderr += chunk.toString('utf8');
  });

  const client = new Client(
    { name: 'memdrive-protocol-test', version: '0.1.0' },
    { capabilities: {} },
  );

  // Fixture images (small + large), built with jimp.
  const smallPng = await new Jimp({ width: 32, height: 24, color: 0x3366ccff }).getBuffer('image/png');
  const smallPngPath = path.join(scratch, 'shot.png');
  await fs.writeFile(smallPngPath, smallPng);

  // Tiny local HTTP server serving the small PNG (URL-download path).
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/shot.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(smallPng);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const urlPort = httpServer.address().port;

  const call = async (name, args) => client.callTool({ name, arguments: args });

  try {
    await client.connect(transport);

    await check('initialize + tools/list exposes exactly the 6 tools', async () => {
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['list_directory', 'open_containing_folder', 'open_image', 'read_file', 'save_file', 'search_files']);
    });

    await check('list_directory on empty root', async () => {
      const res = await call('list_directory', {});
      assert.equal(res.isError, undefined);
      assert.match(textOf(res), /empty/i);
    });

    // Large-image fixture: created AFTER the empty-root check so the
    // root is genuinely empty above.
    const bigPng = await makeNoisePng(2000, 2000, 42);
    assert.ok(bigPng.length > 3_500_000, `big fixture must exceed cap, got ${bigPng.length}`);
    const bigPngDisk = path.join(root, 'photos', 'big.png');
    await fs.mkdir(path.dirname(bigPngDisk), { recursive: true });
    await fs.writeFile(bigPngDisk, bigPng);
    const bigShaBefore = sha256(bigPng);

    // 813 KB-class BMP fixture (see makeNoiseBmp): its base64 alone
    // exceeds the 950,000-byte total budget, so a bundled read must
    // downscale it instead of returning it whole.
    const bmp1 = await makeNoiseBmp(512, 512, 7);
    assert.ok(
      bmp1.length > 712_500 && bmp1.length < 950_000,
      `BMP fixture must be 712,501–949,999 bytes, got ${bmp1.length}`,
    );
    assert.ok(
      Math.ceil(bmp1.length / 3) * 4 > 950_000,
      'BMP fixture base64 must exceed the 950,000 budget',
    );
    const bmp1Disk = path.join(root, 'photos', 'bmp1.bmp');
    await fs.writeFile(bmp1Disk, bmp1);
    const bmp1Sha = sha256(bmp1);

    // Screenshot-like fixture for the quality ladder (check 35):
    // its PNG is far over the cap, but its full-res JPEG at
    // quality 80 fits easily — the ladder must spend the headroom
    // on quality, not stop at 80.
    const screenPng = await makeScreenshotPng();
    assert.ok(screenPng.length > 712_116, `screenshot fixture PNG must exceed cap, got ${screenPng.length}`);
    const screenDisk = path.join(root, 'photos', 'screen.png');
    await fs.writeFile(screenDisk, screenPng);

    await check('save_file text (new) writes file + auto-creates deep dirs', async () => {
      const res = await call('save_file', {
        path: 'notes/2026/deep/note.md',
        content: '# Hello\nBody text here.',
        mode: 'new',
      });
      assert.equal(res.isError, undefined);
      const onDisk = await fs.readFile(path.join(root, 'notes/2026/deep/note.md'), 'utf8');
      assert.equal(onDisk, '# Hello\nBody text here.');
    });

    await check('save_file mode new refuses to overwrite', async () => {
      const res = await call('save_file', {
        path: 'notes/2026/deep/note.md',
        content: 'other',
        mode: 'new',
      });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /already exists/i);
      const onDisk = await fs.readFile(path.join(root, 'notes/2026/deep/note.md'), 'utf8');
      assert.match(onDisk, /Hello/);
    });

    await check('save_file overwrite replaces content', async () => {
      const res = await call('save_file', {
        path: 'notes/2026/deep/note.md',
        content: 'replaced',
        mode: 'overwrite',
      });
      assert.equal(res.isError, undefined);
      assert.equal(await fs.readFile(path.join(root, 'notes/2026/deep/note.md'), 'utf8'), 'replaced');
    });

    await check('save_file append adds to the end', async () => {
      await call('save_file', {
        path: 'notes/2026/deep/note.md',
        content: '+more',
        mode: 'append',
      });
      assert.equal(await fs.readFile(path.join(root, 'notes/2026/deep/note.md'), 'utf8'), 'replaced+more');
    });

    await check('save_file with local image archives to assets/ + appends ref', async () => {
      const res = await call('save_file', {
        path: 'notes/with-photo.md',
        content: '# Trip',
        images: [smallPngPath],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/with-photo.md'), 'utf8');
      assert.match(doc, /!\[shot\]\(assets\/with-photo-\d{8}-\d{6}-\d{3}\.png\)/);
      const assets = await fs.readdir(path.join(root, 'notes/assets'));
      assert.equal(assets.length, 1);
      const stored = await fs.readFile(path.join(root, 'notes/assets', assets[0]));
      assert.ok(stored.equals(smallPng), 'stored image must be byte-identical to the source');
    });

    await check('save_file refuses a localhost image URL, text still saved', async () => {
      // 0.7.0: image URLs must resolve to a public address. A localhost
      // URL is refused before fetching (SSRF guard), so the old
      // "downloads + archives" expectation no longer applies. The
      // success path has no public endpoint in this self-contained
      // suite and is not covered here.
      const res = await call('save_file', {
        path: 'notes/from-url.md',
        content: '# From URL',
        images: [`http://127.0.0.1:${urlPort}/shot.png`],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/from-url.md'), 'utf8');
      assert.equal(doc, '# From URL');
      assert.match(textOf(res), /skipped/i);
      assert.match(textOf(res), /not a public address/i);
      const assets = await fs.readdir(path.join(root, 'notes/assets'));
      assert.ok(!assets.some((n) => n.startsWith('from-url-')), 'no image from a refused URL must be archived');
    });

    await check('save_file with more than 10 images processes only 10, text still saved', async () => {
      // 0.7.0: at most 10 images per save; the rest are skipped with
      // a note naming the cap, and the text is still saved.
      const specs = Array.from({ length: 12 }, () => smallPngPath);
      const res = await call('save_file', {
        path: 'notes/many.md',
        content: '# Many',
        images: specs,
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/many.md'), 'utf8');
      assert.match(doc, /# Many/);
      assert.match(textOf(res), /only the first 10 images were processed/);
      assert.match(textOf(res), /2 more image\(s\) were skipped/);
      const assets = await fs.readdir(path.join(root, 'notes/assets'));
      const many = assets.filter((n) => n.startsWith('many-'));
      assert.equal(many.length, 10, `expected 10 stored images, got ${many.length}: ${many.join(', ')}`);
    });

    await check('save_file refuses to store images when assets/ links outside the library', async () => {
      // 0.7.0 follow-up (#1): the doc path is sandbox-checked, but
      // the assets folder was not — a symlink inside the library
      // pointing outside let images be written outside the root.
      const escDir = path.join(root, 'esc');
      const outsideAssets = path.join(outside, 'assets-out');
      await fs.mkdir(escDir, { recursive: true });
      await fs.mkdir(outsideAssets, { recursive: true });
      await fs.symlink(outsideAssets, path.join(escDir, 'assets'), 'junction');
      const res = await call('save_file', {
        path: 'esc/doc.md',
        content: '# Esc',
        images: [smallPngPath],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'esc/doc.md'), 'utf8');
      assert.equal(doc, '# Esc');
      assert.match(textOf(res), /links outside the library/i);
      const leaked = await fs.readdir(outsideAssets);
      assert.equal(leaked.length, 0, 'no image must be written outside the library');
    });

    await check('save_file refuses non-regular local images, server survives', async () => {
      // 0.7.0 follow-up (#3): /dev/zero, FIFOs, and device nodes
      // report size 0, so a size check alone cannot stop an
      // unbounded read. A directory is a cross-platform fixture
      // for "not a regular file".
      const dirPath = path.join(scratch, 'somedir');
      await fs.mkdir(dirPath, { recursive: true });
      const res = await call('save_file', {
        path: 'notes/not-a-file.md',
        content: '# Dir',
        images: [dirPath],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/not-a-file.md'), 'utf8');
      assert.equal(doc, '# Dir');
      assert.match(textOf(res), /Not a regular file/i);
      if (process.platform !== 'win32') {
        // /dev/null is a character device: stat succeeds, isFile()
        // is false, and the old code would have read it forever
        // (on /dev/zero) or until OOM. Refusal must be immediate.
        const resNull = await call('save_file', {
          path: 'notes/dev-null.md',
          content: '# Null',
          images: ['/dev/null'],
        });
        assert.equal(resNull.isError, undefined, textOf(resNull));
        assert.match(textOf(resNull), /Not a regular file/i);
      }
    });

    if (process.platform !== 'win32') {
      await check('save_file overwrite of a 243-byte name does not fail with ENAMETOOLONG', async () => {
        // 0.7.0 follow-up (#7): the old temp name appended ~30
        // characters to the target name, so a 243-byte filename
        // overflowed the 255-byte limit on overwrite. The shared
        // helper uses a short fixed temp name instead. Windows is
        // skipped: MAX_PATH makes even the plain create fail there.
        const longName = `${'n'.repeat(240)}.md`;
        assert.equal(Buffer.byteLength(longName), 243);
        const longRel = `notes/${longName}`;
        const created = await call('save_file', { path: longRel, content: '# Long', mode: 'new' });
        assert.equal(created.isError, undefined, textOf(created));
        const over = await call('save_file', { path: longRel, content: '# Longer', mode: 'overwrite' });
        assert.equal(over.isError, undefined, textOf(over));
        assert.equal(await fs.readFile(path.join(root, longRel), 'utf8'), '# Longer');
      });
    }

    await check('save_file overwrite reports created:false for existing, created:true for missing', async () => {
      // 0.7.0 follow-up (#8): the overwrite branch returned
      // created:true unconditionally (pre-existing since 0.6.0).
      await call('save_file', { path: 'notes/flag.md', content: '# v1', mode: 'new' });
      const over = await call('save_file', { path: 'notes/flag.md', content: '# v2', mode: 'overwrite' });
      assert.equal(over.isError, undefined, textOf(over));
      assert.doesNotMatch(textOf(over), /, created/);
      const fresh = await call('save_file', { path: 'notes/fresh-flag.md', content: '# new', mode: 'overwrite' });
      assert.equal(fresh.isError, undefined, textOf(fresh));
      assert.match(textOf(fresh), /, created/);
      assert.equal(await fs.readFile(path.join(root, 'notes/fresh-flag.md'), 'utf8'), '# new');
    });

    await check('save_file refuses image URLs in NAT64/6to4 IPv6 ranges, text still saved', async () => {
      // 0.7.0 follow-up (#11): literal IPs need no DNS, so the
      // SSRF range check is testable without a public endpoint.
      const res = await call('save_file', {
        path: 'notes/from-ipv6.md',
        content: '# From IPv6',
        images: ['http://[64:ff9b::c000:201]/x.png', 'http://[2002:c000:201::]/x.png'],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/from-ipv6.md'), 'utf8');
      assert.equal(doc, '# From IPv6');
      assert.match(textOf(res), /not a public address/i);
      const assets = await fs.readdir(path.join(root, 'notes/assets'));
      assert.ok(!assets.some((n) => n.startsWith('from-ipv6-')), 'no image from a refused URL must be archived');
    });

    await check('save_file with spaces/parens in the doc name writes an encoded ref that reads back', async () => {
      // 0.7.0 follow-up (#2): the ref is percent-encoded on write
      // and decoded on scan, so spaces and parentheses survive the
      // scan regex instead of truncating the path.
      const res = await call('save_file', {
        path: 'notes/my notes (v1).md',
        content: '# Spaced',
        images: [smallPngPath],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/my notes (v1).md'), 'utf8');
      assert.match(doc, /!\[shot\]\(assets\/my%20notes%20%28v1%29-\d{8}-\d{6}-\d{3}\.png\)/);
      const read = await call('read_file', { path: 'notes/my notes (v1).md' });
      assert.equal(read.isError, undefined, textOf(read));
      assert.doesNotMatch(textOf(read), /Skipped image/);
      assert.equal(imagesOf(read).length, 1, 'the referenced image must be returned by read_file');
    });

    await check('text notes starting with BM or GIF8 are read as text, rejected by open_image and save_file images', async () => {
      const bmText = 'BM25 is a ranking function used by search engines to estimate relevance.';
      const gifText = 'GIF89a is a classic graphics interchange format specification.';
      await call('save_file', { path: 'notes/bm25.md', content: bmText, mode: 'new' });
      await call('save_file', { path: 'notes/bm25.txt', content: bmText, mode: 'new' });
      await call('save_file', { path: 'notes/gif.md', content: gifText, mode: 'new' });
      await call('save_file', { path: 'notes/ref-bm25.md', content: '# Ref\n![bm](bm25.md)\n', mode: 'new' });

      for (const rel of ['notes/bm25.md', 'notes/bm25.txt', 'notes/gif.md']) {
        const readRes = await call('read_file', { path: rel });
        assert.equal(readRes.isError, undefined, textOf(readRes));
        assert.equal(imagesOf(readRes).length, 0, `${rel} must not return an image block`);
        assert.match(textOf(readRes), /BM25|GIF89a/);
      }

      const bundledRef = await call('read_file', { path: 'notes/ref-bm25.md' });
      assert.equal(bundledRef.isError, undefined, textOf(bundledRef));
      assert.equal(imagesOf(bundledRef).length, 0, 'referencing bm25.md must not produce an image block');
      assert.match(textOf(bundledRef), /unsupported image type/);

      const openBm = await call('open_image', { path: 'notes/bm25.md' });
      assert.equal(openBm.isError, true);
      assert.match(textOf(openBm), /not an image/i);

      const bm25LocalPath = path.join(scratch, 'BM25.txt');
      await fs.writeFile(bm25LocalPath, bmText);
      const saveWithBmTxt = await call('save_file', {
        path: 'notes/with-bm-txt.md',
        content: '# Try BM25.txt',
        images: [bm25LocalPath],
      });
      assert.equal(saveWithBmTxt.isError, undefined, textOf(saveWithBmTxt));
      assert.match(textOf(saveWithBmTxt), /does not look like an image/i);
    });

    await check('save_file with CJK, #, ?, spaces, and parens keeps CJK readable and reads image back', async () => {
      const res = await call('save_file', {
        path: 'notes/架构笔记 #1 (v2).md',
        content: '# 架构',
        images: [smallPngPath],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/架构笔记 #1 (v2).md'), 'utf8');
      assert.match(doc, /!\[shot\]\(assets\/架构笔记%20%231%20%28v2%29-\d{8}-\d{6}-\d{3}\.png\)/);
      const read = await call('read_file', { path: 'notes/架构笔记 #1 (v2).md' });
      assert.equal(read.isError, undefined, textOf(read));
      assert.equal(imagesOf(read).length, 1);
      assert.equal(encodeImageSrc('定稿?v=1#top (a).png'), '定稿%3Fv=1%23top%20%28a%29.png');
    });

    await check('save_file with full-width space (U+3000) in filename encodes ref and read_file returns 1 image', async () => {
      assert.equal(encodeImageSrc('a\u3000b.png'), 'a%E3%80%80b.png');
      const res = await call('save_file', {
        path: 'notes/全角\u3000空格.md',
        content: '# 全角空格',
        images: [smallPngPath],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/全角\u3000空格.md'), 'utf8');
      assert.match(doc, /!\[shot\]\(assets\/全角%E3%80%80空格-\d{8}-\d{6}-\d{3}\.png\)/);
      const read = await call('read_file', { path: 'notes/全角\u3000空格.md' });
      assert.equal(read.isError, undefined, textOf(read));
      assert.equal(imagesOf(read).length, 1);
    });

    await check('DNS rebinding guard (net-guard): single resolve, loopback rejected with 0 connections, allowed policy downloads', async () => {
      let serverHits = 0;
      let lastHeaders = {};
      const guardServer = http.createServer((req, res) => {
        serverHits += 1;
        lastHeaders = req.headers;
        if (req.url === '/shot.png') {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end(smallPng);
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise((resolve) => guardServer.listen(0, '127.0.0.1', resolve));
      const guardPort = guardServer.address().port;
      try {
        // 1. Default public-IP policy: resolver returning 127.0.0.1 is called
        //    exactly ONCE, request is rejected, and server receives 0 connections.
        let resolveCalls = 0;
        await assert.rejects(
          () =>
            safeRequest(`http://rebind.example:${guardPort}/shot.png`, {
              resolve: async () => {
                resolveCalls += 1;
                return [{ address: '127.0.0.1', family: 4 }];
              },
            }),
          (err) => err instanceof BlockedUrlError && /127\.0\.0\.1 is not a public address/.test(err.reason),
        );
        assert.equal(resolveCalls, 1, 'resolver must be called exactly 1 time (no second DNS lookup)');
        assert.equal(serverHits, 0, 'local server must receive 0 connections when blocked');

        // 2. IPv6 literal http://[::1]/ is rejected at connection time with 0 connections.
        await assert.rejects(
          () => safeRequest(`http://[::1]:${guardPort}/shot.png`),
          (err) => err instanceof BlockedUrlError && /::1 is not a public address/.test(err.reason),
        );
        assert.equal(serverHits, 0, 'local server must receive 0 connections on [::1]');

        // 3. Injected allow policy: resolver called once, download succeeds,
        //    Host and User-Agent/Accept headers set properly.
        let allowResolveCalls = 0;
        const acq = await acquireImage(
          `http://rebind.example:${guardPort}/shot.png`,
          undefined,
          {
            resolve: async () => {
              allowResolveCalls += 1;
              return [{ address: '127.0.0.1', family: 4 }];
            },
            isAllowedAddress: () => true,
          },
        );
        assert.equal(acq.ok, true, acq.ok ? '' : acq.note);
        assert.equal(allowResolveCalls, 1, 'resolver must be called exactly 1 time on allowed download');
        assert.equal(serverHits, 1, 'local server must receive the 1 allowed request');
        assert.ok(acq.image.data.equals(smallPng));
        assert.equal(lastHeaders['host'], `rebind.example:${guardPort}`);
        assert.match(String(lastHeaders['user-agent'] ?? ''), /memdrive-mcp/);
        assert.equal(lastHeaders['accept'], 'image/*');
        assert.equal(lastHeaders['accept-encoding'], undefined);

        // 4. Download stream stops early when storedRemainingBytes is smaller than the image.
        const smallStoredBudget = {
          storedRemainingBytes: 10,
          downloadRemainingBytes: 500_000_000,
        };
        const overStored = await acquireImage(
          `http://rebind.example:${guardPort}/shot.png`,
          smallStoredBudget,
          {
            resolve: async () => [{ address: '127.0.0.1', family: 4 }],
            isAllowedAddress: () => true,
          },
        );
        assert.equal(overStored.ok, false);
        assert.match(overStored.note, /stored image budget/i);
      } finally {
        guardServer.close();
      }
    });

    await check('save_file mode new pre-check rejects existing target before acquiring or writing images', async () => {
      await call('save_file', { path: 'precheck/existing.md', content: '# V1', mode: 'new' });
      const dup = await call('save_file', {
        path: 'precheck/existing.md',
        content: '# V2',
        mode: 'new',
        images: [smallPngPath],
      });
      assert.equal(dup.isError, true);
      assert.match(textOf(dup), /already exists/i);
      await assert.rejects(
        fs.stat(path.join(root, 'precheck', 'assets')),
        'assets/ must not be created when mode:new target already exists',
      );
    });

    await check('atomicWrite & overwrite guarantees: mode preserved, symlink followed, read-only refused, retry, .mdtmp skipped', async () => {
      // 1. Orphaned .mdtmp-* files are skipped by list_directory and search_files.
      const orphanTmp = path.join(root, 'notes', '.mdtmp-orphan-999');
      await fs.writeFile(orphanTmp, 'ORPHAN-TEMP-SECRET-KEYWORD');
      const listRes = await call('list_directory', { path: 'notes' });
      assert.doesNotMatch(textOf(listRes), /\.mdtmp-/);
      const searchRes = await call('search_files', { keyword: 'ORPHAN-TEMP-SECRET-KEYWORD' });
      assert.doesNotMatch(textOf(searchRes), /\.mdtmp-/);
      await fs.unlink(orphanTmp);

      // 2. Intra-root symlink is followed on overwrite (link stays a link, target updated).
      const realNote = path.join(root, 'notes', 'real-target.md');
      const linkNote = path.join(root, 'notes', 'sym-target.md');
      await fs.writeFile(realNote, 'v1');
      let canSymlink = true;
      try {
        await fs.symlink(realNote, linkNote, 'file');
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') {
          canSymlink = false;
        } else {
          throw err;
        }
      }
      if (canSymlink) {
        const overSym = await call('save_file', {
          path: 'notes/sym-target.md',
          content: 'v2-through-link',
          mode: 'overwrite',
        });
        assert.equal(overSym.isError, undefined, textOf(overSym));
        assert.equal((await fs.lstat(linkNote)).isSymbolicLink(), true, 'symlink must not be replaced by a regular file');
        assert.equal(await fs.readFile(realNote, 'utf8'), 'v2-through-link');
      }

      // 3. Mode preservation (0o600) and read-only refusal (0o444) on POSIX.
      if (process.platform !== 'win32') {
        const modeFile = path.join(root, 'notes', 'secret-mode.md');
        await fs.writeFile(modeFile, 'initial', { mode: 0o600 });
        await fs.chmod(modeFile, 0o600);
        const overMode = await call('save_file', {
          path: 'notes/secret-mode.md',
          content: 'updated-600',
          mode: 'overwrite',
        });
        assert.equal(overMode.isError, undefined, textOf(overMode));
        assert.equal(((await fs.stat(modeFile)).mode & 0o777), 0o600, '0o600 mode must be preserved after overwrite');

        if (typeof process.getuid === 'function' && process.getuid() !== 0) {
          const roFile = path.join(root, 'notes', 'readonly.md');
          await fs.writeFile(roFile, 'locked');
          await fs.chmod(roFile, 0o444);
          try {
            const overRo = await call('save_file', {
              path: 'notes/readonly.md',
              content: 'try-write',
              mode: 'overwrite',
            });
            assert.equal(overRo.isError, true);
            assert.match(textOf(overRo), /File is read-only/i);
            assert.doesNotMatch(textOf(overRo), /Unexpected error/i);
            assert.equal(await fs.readFile(roFile, 'utf8'), 'locked');
            await assert.rejects(
              () => atomicWrite(roFile, 'try-direct'),
              (err) => err.name === 'MemDriveError' && err.code === 'READ_ONLY',
            );
          } finally {
            await fs.chmod(roFile, 0o644).catch(() => undefined);
          }
        }
      }

      // 4. Rename retry on transient EBUSY/EPERM.
      const retryTarget = path.join(root, 'notes', 'retry-test.md');
      let renameAttempts = 0;
      const retryRes = await atomicWrite(retryTarget, 'retried-ok', {
        fs: {
          rename: async (src, dest) => {
            renameAttempts += 1;
            if (renameAttempts < 3) {
              const err = new Error('busy');
              err.code = 'EBUSY';
              throw err;
            }
            return fs.rename(src, dest);
          },
        },
      });
      assert.equal(retryRes.existed, false);
      assert.equal(renameAttempts, 3);
      assert.equal(await fs.readFile(retryTarget, 'utf8'), 'retried-ok');
    });

    await check('extensionForMime and mimeFromExtension ignore Object.prototype properties', async () => {
      assert.equal(extensionForMime('constructor'), 'png');
      assert.equal(extensionForMime('__proto__'), 'png');
      assert.equal(extensionForMime('toString'), 'png');
      assert.equal(mimeFromExtension('file.constructor'), null);
      assert.equal(mimeFromExtension('file.__proto__'), null);
      assert.equal(detectImageMime(Buffer.from('BM25 is a ranking function')), null);
      assert.equal(detectImageMime(Buffer.from('GIF89a is text, Wait: GIF89a header is 6 bytes')), 'image/gif');
      assert.equal(detectImageMime(Buffer.from('GIF800 not a gif')), null);
    });

    await check('cumulative image budget ceiling aborts an endless stream promptly when the budget is reached', async () => {
      const chunk64k = Buffer.alloc(65_536, 0xaa);
      const streamServer = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        const pump = () => {
          while (!res.destroyed && !res.writableEnded) {
            if (!res.write(chunk64k)) {
              res.once('drain', pump);
              return;
            }
          }
        };
        pump();
      });
      await new Promise((resolve) => streamServer.listen(0, '127.0.0.1', resolve));
      const streamPort = streamServer.address().port;
      try {
        const budget = {
          storedRemainingBytes: 1_000_000,
          downloadRemainingBytes: 1_000_000,
        };
        const t0 = Date.now();
        const res = await acquireImage(
          `http://127.0.0.1:${streamPort}/endless.png`,
          budget,
          { isAllowedAddress: () => true },
        );
        const elapsedMs = Date.now() - t0;
        assert.equal(res.ok, false);
        assert.match(res.note, /download limit|stored image budget/i);
        assert.equal(budget.downloadRemainingBytes, 0, 'downloadRemainingBytes must be drained to 0');
        assert.ok(elapsedMs < 5_000, `abort must return promptly, took ${elapsedMs} ms`);
      } finally {
        streamServer.close();
      }
    });

    await check('acquireImage refuses without fetching when either budget is exhausted', async () => {
      // 0.7.0 follow-up (#4, partial): the pre-checks refuse before
      // any fetch, so they are testable offline. The full
      // "failed download does not consume stored budget" path has
      // no public endpoint in this suite and is not covered here.
      const noStored = await acquireImage('http://example.com/x.png', {
        storedRemainingBytes: 0,
        downloadRemainingBytes: 500_000_000,
      });
      assert.equal(noStored.ok, false);
      assert.match(noStored.note, /stored image budget/i);
      const noDownload = await acquireImage('http://example.com/x.png', {
        storedRemainingBytes: 500_000_000,
        downloadRemainingBytes: 0,
      });
      assert.equal(noDownload.ok, false);
      assert.match(noDownload.note, /download limit/i);
    });

    await check('save_file with quoted + backslash path is cleaned', async () => {
      const res = await call('save_file', {
        path: '"quoted\\win-style.md"',
        content: 'cleaned',
      });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(await fs.readFile(path.join(root, 'quoted/win-style.md'), 'utf8'), 'cleaned');
    });

    await check('save_file with image on non-Markdown file: image saved, no refs appended', async () => {
      const res = await call('save_file', {
        path: 'notes/plain.txt',
        content: 'plain text',
        images: [smallPngPath],
      });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(await fs.readFile(path.join(root, 'notes/plain.txt'), 'utf8'), 'plain text');
      assert.match(textOf(res), /not Markdown/);
      const assets = await fs.readdir(path.join(root, 'notes/assets'));
      assert.ok(assets.some((n) => n.startsWith('plain-')), `expected a plain- image in assets, got ${assets.join(',')}`);
    });

    await check('read_file returns text + image in ONE response', async () => {
      const res = await call('read_file', { path: 'notes/with-photo.md' });
      assert.equal(res.isError, undefined, textOf(res));
      assert.match(textOf(res), /Trip/);
      const images = imagesOf(res);
      assert.equal(images.length, 1);
      assert.equal(images[0].mimeType, 'image/png');
      const decoded = Buffer.from(images[0].data, 'base64');
      assert.ok(decoded.equals(smallPng), 'under-cap image must pass through byte-identical');
    });

    await check('read_file of a bare image path returns one image block', async () => {
      const res = await call('read_file', { path: 'notes/assets/' + (await fs.readdir(path.join(root, 'notes/assets')))[0] });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 1);
    });

    await check('read_file downscales >3.5MB image in memory, disk original untouched', async () => {
      const res = await call('read_file', { path: 'photos/big.png' });
      assert.equal(res.isError, undefined, textOf(res));
      const images = imagesOf(res);
      assert.equal(images.length, 1);
      const previewBytes = Buffer.from(images[0].data, 'base64');
      assert.ok(previewBytes.length <= 3_500_000, `preview ${previewBytes.length} must be under cap`);
      assert.equal(images[0].mimeType, 'image/jpeg');
      const bigShaAfter = sha256(await fs.readFile(bigPngDisk));
      assert.equal(bigShaAfter, bigShaBefore, 'on-disk original must be byte-identical after read');
    });

    await check('read_file truncates text over the 1MB cap with a note', async () => {
      const bigText = 'x'.repeat(1_200_000);
      await fs.writeFile(path.join(root, 'big.txt'), bigText);
      const res = await call('read_file', { path: 'big.txt' });
      assert.equal(res.isError, undefined);
      const text = textOf(res);
      assert.ok(Buffer.byteLength(text, 'utf8') <= 1_000_000 + 512, `truncated text too long: ${Buffer.byteLength(text, 'utf8')}`);
      assert.match(text, /truncated/i);
    });

    await check('read_file rejects binary files', async () => {
      await fs.writeFile(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 9]));
      const res = await call('read_file', { path: 'blob.bin' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /binary/i);
    });

    await check('read_file returns SVG as text, never as image', async () => {
      await call('save_file', {
        path: 'drawing.svg',
        content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>',
      });
      const res = await call('read_file', { path: 'drawing.svg' });
      assert.equal(res.isError, undefined);
      assert.equal(imagesOf(res).length, 0);
      assert.match(textOf(res), /<svg/);
    });

    await check('search_files matches by name and by content', async () => {
      // 0.8.0 returns ranked chunks (path + score + snippet); the 0.7.0
      // "(name)"/"(content)" kind labels are gone. Both paths (index
      // and direct-scan fallback) list the file, so assert on the path.
      const byName = await call('search_files', { keyword: 'with-photo' });
      assert.match(textOf(byName), /with-photo\.md/);
      const byContent = await call('search_files', { keyword: 'replaced+more' });
      assert.match(textOf(byContent), /note\.md/);
    });

    await check('sandbox rejects ../ escape', async () => {
      const res = await call('save_file', {
        path: '../escape.md',
        content: 'nope',
      });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /escapes/i);
      await assert.rejects(fs.stat(path.join(scratch, 'escape.md')));
    });

    await check('sandbox rejects absolute path outside root', async () => {
      const res = await call('read_file', { path: path.join(outside, 'secret.txt') });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /escapes/i);
    });

    await check('sandbox rejects symlink inside root pointing outside', async () => {
      // 'junction' works on Windows without admin rights; on POSIX the
      // type argument is ignored for directories.
      await fs.symlink(outside, path.join(root, 'link-out'), 'junction');
      const res = await call('read_file', { path: 'link-out/secret.txt' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /symlink/i);
    });

    await check('sandbox rejects symlink to an outside FILE', async () => {
      try {
        await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'link-file.txt'), 'file');
      } catch (error) {
        // Windows without symlink privilege (EPERM): creating a file
        // symlink is an environment limitation, not a server defect.
        // Skip this check rather than false-failing.
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          console.log('  (skipped: no privilege to create a file symlink on this machine)');
          return;
        }
        throw error;
      }
      const res = await call('read_file', { path: 'link-file.txt' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /symlink/i);
    });

    await check('search_files never leaks content through a symlink to an outside file', async () => {
      // Regression test for the 0.7.0 search_files symlink hole: the
      // search walk used to follow a symlink to a small outside text
      // file, read its content, and return its matching line as an
      // excerpt. The outside file holds 'ZQXJ', a nonsense term that
      // occurs nowhere inside the root. (0.8.0 tokenizes the keyword,
      // so a hyphenated identifier like 'TOP-SECRET-OUTSIDE-ROOT'
      // would also match inside files containing 'root' — the single
      // unique term keeps this test about the symlink, not ranking.)
      try {
        await fs.symlink(path.join(outside, 'secret.txt'), path.join(root, 'search-link.txt'), 'file');
      } catch (error) {
        // Windows without symlink privilege (EPERM): creating a file
        // symlink is an environment limitation, not a server defect.
        // Skip this check rather than false-failing.
        if (error.code === 'EPERM' || error.code === 'EACCES') {
          console.log('  (skipped: no privilege to create a file symlink on this machine)');
          return;
        }
        throw error;
      }
      const res = await call('search_files', { keyword: 'ZQXJ' });
      assert.equal(res.isError, undefined, textOf(res));
      const text = textOf(res);
      assert.match(text, /No files matching/);
      assert.doesNotMatch(text, /search-link\.txt/);
      assert.doesNotMatch(text, /link-file\.txt/);
    });

    await check('clipboard: graceful on every outcome, text saved, server alive', async () => {
      const res = await call('save_file', {
        path: 'notes/clip.md',
        content: '# Clipboard test',
        images: ['clipboard'],
      });
      assert.equal(res.isError, undefined, textOf(res));
      // Four graceful outcomes, depending on the machine/clipboard:
      // headless-unsupported, empty, text-only (note mentions the
      // clipboard), or a real image captured (stored in assets/).
      // Any of them is a pass; only a crash or a lost save is not.
      const clipText = textOf(res);
      assert.ok(
        /clipboard/i.test(clipText) ||
          /Images stored in assets/.test(clipText) ||
          /skipped/i.test(clipText),
        `unexpected clipboard result: ${clipText}`,
      );
      const saved = await fs.readFile(path.join(root, 'notes/clip.md'), 'utf8');
      assert.ok(saved.startsWith('# Clipboard test'), 'saved text must start with the submitted content');
      // Server must still answer after the clipboard attempt.
      const alive = await call('list_directory', { path: 'notes' });
      assert.equal(alive.isError, undefined);
    });

    await check('save_file with failing image still saves text (graceful degradation)', async () => {
      const res = await call('save_file', {
        path: 'notes/bad-image.md',
        content: 'text survives',
        images: ['/nonexistent/definitely-not-here.png'],
      });
      assert.equal(res.isError, undefined, textOf(res));
      assert.match(textOf(res), /skipped/i);
      assert.equal(await fs.readFile(path.join(root, 'notes/bad-image.md'), 'utf8'), 'text survives');
    });

    await check('list_directory shows nested content + errors on a file path', async () => {
      const res = await call('list_directory', { path: 'notes' });
      assert.equal(res.isError, undefined);
      assert.match(textOf(res), /with-photo\.md/);
      const bad = await call('list_directory', { path: 'notes/with-photo.md' });
      assert.equal(bad.isError, true);
      assert.match(textOf(bad), /not a directory/i);
    });

    // --- Total-budget + two-step reading + clipboard wording (0.1.1) ---

    await check('tools/list: read_file has include_images; save_file description leads with clipboard rule', async () => {
      const listed = await client.listTools();
      const readTool = listed.tools.find((t) => t.name === 'read_file');
      assert.equal(readTool.inputSchema.properties.include_images.type, 'boolean');
      assert.match(readTool.description, /950,000/);
      assert.match(readTool.description, /TWO-STEP READING/);
      assert.match(readTool.description, /include_images=false/);
      assert.match(readTool.description, /MEMDRIVE_RESPONSE_BUDGET_BYTES/);
      const saveTool = listed.tools.find((t) => t.name === 'save_file');
      assert.ok(
        saveTool.description.startsWith('CLIPBOARD FIRST'),
        `save_file description must start with the clipboard rule, got: ${saveTool.description.slice(0, 80)}`,
      );
      assert.match(saveTool.description, /NEVER ask the user to paste/);
      assert.match(saveTool.description, /cannot read the clipboard/);
      assert.match(saveTool.description, /only store text/);
      const imagesDesc = saveTool.inputSchema.properties.images.description;
      assert.ok(
        imagesDesc.startsWith('Images to archive with the document — CLIPBOARD FIRST'),
        `images description must put clipboard first, got: ${imagesDesc.slice(0, 80)}`,
      );
    });

    await check('read_file include_images=false returns text only + lists image paths', async () => {
      const res = await call('read_file', { path: 'notes/with-photo.md', include_images: false });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 0);
      assert.match(textOf(res), /Trip/);
      assert.match(textOf(res), /notes\/assets\/with-photo-.*\.png/);
      assert.match(textOf(res), /read each one separately/);
    });

    await check('total budget: 786KB BMP bundled stays under 950,000 bytes, downscaled, disk untouched', async () => {
      await fs.writeFile(
        path.join(root, 'notes/bundled.md'),
        '# Shot\n![shot](../photos/bmp1.bmp)\n',
      );
      const res = await call('read_file', { path: 'notes/bundled.md' });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 1);
      const total = resultSizeBytes(res);
      assert.ok(total <= 950_000, `bundled total ${total} must be <= 950,000`);
      const preview = Buffer.from(imagesOf(res)[0].data, 'base64');
      assert.ok(preview.length < bmp1.length, 'preview must be smaller than the 786KB original');
      assert.equal(imagesOf(res)[0].mimeType, 'image/jpeg');
      assert.match(textOf(res), /downscaled in memory/);
      assert.equal(sha256(await fs.readFile(bmp1Disk)), bmp1Sha, 'on-disk original must be byte-identical after a budget downscale');
    });

    await check('text-first: 1.2MB text + image stays under budget, image skipped with note, never errors', async () => {
      const heavy = `${'A'.repeat(1_200_000)}\n![shot](../photos/bmp1.bmp)\n`;
      await fs.writeFile(path.join(root, 'notes/heavy.md'), heavy);
      const res = await call('read_file', { path: 'notes/heavy.md' });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 0);
      const total = resultSizeBytes(res);
      assert.ok(total <= 950_000, `heavy total ${total} must be <= 950,000`);
      assert.match(textOf(res), /truncated/i);
      assert.match(textOf(res), /Skipped image/);
      assert.match(textOf(res), /total response budget/);
      assert.match(textOf(res), /^A+/);
    });

    await check('response budget resolver: default, clamp, invalid fallback', async () => {
      assert.equal(resolveResponseBudgetBytes(undefined), 950_000);
      assert.equal(resolveResponseBudgetBytes(''), 950_000);
      assert.equal(resolveResponseBudgetBytes('abc'), 950_000);
      assert.equal(resolveResponseBudgetBytes('1000'), 100_000);
      assert.equal(resolveResponseBudgetBytes('99999999'), 50_000_000);
      assert.equal(resolveResponseBudgetBytes('2000000'), 2_000_000);
      assert.equal(resolveResponseBudgetBytes(' 950000 '), 950_000);
    });

    await check('under-budget image passes through byte-identical on a direct read', async () => {
      const assets = await fs.readdir(path.join(root, 'notes/assets'));
      const withPhoto = assets.find((n) => n.startsWith('with-photo-'));
      assert.ok(withPhoto, `expected a with-photo asset, got ${assets.join(',')}`);
      const res = await call('read_file', { path: `notes/assets/${withPhoto}` });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 1);
      assert.equal(imagesOf(res)[0].mimeType, 'image/png');
      const decoded = Buffer.from(imagesOf(res)[0].data, 'base64');
      assert.ok(decoded.equals(smallPng), 'under-budget image must pass through byte-identical');
      assert.ok(resultSizeBytes(res) <= 950_000);
    });

    await check('preview uses the budget: over-budget image re-encoded at full resolution when that fits', async () => {
      const res = await call('read_file', { path: 'photos/bmp1.bmp' });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 1);
      assert.equal(imagesOf(res)[0].mimeType, 'image/jpeg');
      const previewBytes = Buffer.from(imagesOf(res)[0].data, 'base64');
      assert.ok(previewBytes.length < bmp1.length, 'preview must be smaller than the original');
      assert.ok(resultSizeBytes(res) <= 950_000, `direct total ${resultSizeBytes(res)} must be <= 950,000`);
      // The preview must NOT have been shrunk to the old 0.7 step:
      // decode it and check it kept the original 512x512 dimensions
      // (re-encode only), which the old ladder could never produce.
      const decoded = await Jimp.read(previewBytes);
      assert.equal(decoded.width, 512);
      assert.equal(decoded.height, 512);
    });

    await check('quality ladder: full-resolution preview tries higher JPEG quality before stopping at 80', async () => {
      const res = await call('read_file', { path: 'photos/screen.png' });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 1);
      assert.equal(imagesOf(res)[0].mimeType, 'image/jpeg');
      const previewBytes = Buffer.from(imagesOf(res)[0].data, 'base64');
      const decoded = await Jimp.read(previewBytes);
      assert.equal(decoded.width, 1080);
      assert.equal(decoded.height, 2400);
      assert.ok(resultSizeBytes(res) <= 950_000, `direct total ${resultSizeBytes(res)} must be <= 950,000`);
      // Quality-80-only encoding of the same pixels, computed here
      // with the same Jimp: the ladder must beat it (quality 90/95
      // at the same full resolution), not merely fit the budget.
      const q80 = await (await Jimp.read(screenPng)).getBuffer('image/jpeg', { quality: 80 });
      assert.ok(
        previewBytes.length > q80.length,
        `preview ${previewBytes.length} must exceed q80-only ${q80.length}`,
      );
    });

    // --- open_image + setup wizard (0.2.0) ---

    // Fixture for the open_image checks: a real PNG inside the root,
    // plus an extensionless copy of the same bytes (magic-byte sniff).
    const openMeDisk = path.join(root, 'open-me.png');
    await fs.writeFile(openMeDisk, smallPng);
    await fs.writeFile(path.join(root, 'noext'), smallPng);

    await check('open_image description: explicit request only, never auto-open, never returns bytes', async () => {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === 'open_image');
      assert.ok(tool, 'open_image must be listed');
      assert.match(tool.description, /ONLY WHEN THE USER EXPLICITLY ASKS/);
      assert.match(tool.description, /NEVER call open_image automatically/);
      assert.match(tool.description, /never returned to the model/);
      assert.equal(tool.inputSchema.properties.path.type, 'string');
    });

    await check('open_image rejects ../ escape', async () => {
      const res = await call('open_image', { path: '../escape.png' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /escapes/i);
      assert.equal(imagesOf(res).length, 0);
    });

    await check('open_image rejects absolute path outside root', async () => {
      const res = await call('open_image', { path: path.join(outside, 'secret.txt') });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /escapes/i);
    });

    await check('open_image rejects non-image file', async () => {
      const res = await call('open_image', { path: 'notes/plain.txt' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /not an image/i);
    });

    await check('open_image rejects missing file', async () => {
      const res = await call('open_image', { path: 'photos/nope.png' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /not found/i);
    });

    await check('open_image rejects a directory', async () => {
      const res = await call('open_image', { path: 'notes' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /not a file|directory/i);
    });

    await check('open_image on headless Linux: viewer failure is a graceful note, never a crash', async () => {
      const res = await call('open_image', { path: 'open-me.png' });
      assert.equal(res.isError, undefined, textOf(res));
      assert.equal(imagesOf(res).length, 0, 'open_image must never return image bytes');
      // Either wording is graceful: "Opened ..." where a viewer
      // exists, "Could not open ..." where xdg-open has no method
      // (this headless VM: exit code 3). Only a crash or an error
      // result would fail this check.
      assert.match(textOf(res), /image viewer/i);
      const alive = await call('list_directory', { path: '' });
      assert.equal(alive.isError, undefined);
    });

    await check('open_image opens an extensionless file identified by magic bytes', async () => {
      const res = await call('open_image', { path: 'noext' });
      // A NOT_AN_IMAGE error here would mean the magic-byte sniff
      // did not run; the viewer outcome itself is environment
      // dependent (see the headless check above).
      assert.equal(res.isError, undefined, textOf(res));
      assert.match(textOf(res), /image viewer/i);
    });

    // --- open_containing_folder (0.5.0; folder launcher split in 0.5.1,
    // corrected in 0.5.2) ---
    // No check below reaches the launcher: resolution is tested via
    // the exported pure function, and the protocol checks all fail
    // at the sandbox/existence gate, before any launch. The VM suite
    // only asserts the launcher's command SHAPE; it never opens a
    // file manager on Windows, so it cannot prove a Windows launch
    // works. (The 0.5.1 comment claiming the failure path was
    // covered by the open_image headless check was wrong for the
    // Windows folder branch, whose command differed.) Only the
    // user's real-machine test proves the window opens.

    await check('resolveContainingFolder: file -> parent, folder -> itself, root -> root', async () => {
      assert.equal(
        resolveContainingFolder(root, path.join(root, 'notes', 'note.md'), false),
        path.join(root, 'notes'),
      );
      assert.equal(
        resolveContainingFolder(root, path.join(root, 'notes'), true),
        path.join(root, 'notes'),
      );
      assert.equal(resolveContainingFolder(root, root, true), root);
      assert.equal(
        resolveContainingFolder(root, path.join(root, 'note.md'), false),
        root,
      );
      assert.equal(
        resolveContainingFolder(root, path.join(root, 'notes', 'sub'), true),
        path.join(root, 'notes', 'sub'),
      );
    });

    await check('open_containing_folder description: explicit request only, never auto-open, no highlight, path optional', async () => {
      const listed = await client.listTools();
      const tool = listed.tools.find((t) => t.name === 'open_containing_folder');
      assert.ok(tool, 'open_containing_folder must be listed');
      assert.match(tool.description, /USE ONLY WHEN THE USER EXPLICITLY ASKS/);
      assert.match(tool.description, /NEVER call open_containing_folder automatically/);
      assert.match(tool.description, /without highlighting or selecting/);
      assert.match(tool.description, /never returned to the model/);
      assert.equal(tool.inputSchema.properties.path.type, 'string');
      assert.ok(
        !((tool.inputSchema.required ?? []).includes('path')),
        'path must be optional so omitting it opens the library root',
      );
    });

    await check('open_containing_folder rejects ../ escape', async () => {
      const res = await call('open_containing_folder', { path: '../escape.md' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /escapes/i);
      assert.equal(imagesOf(res).length, 0);
    });

    await check('open_containing_folder rejects absolute path outside root', async () => {
      const res = await call('open_containing_folder', { path: path.join(outside, 'secret.txt') });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /escapes/i);
    });

    await check('open_containing_folder rejects missing path', async () => {
      const res = await call('open_containing_folder', { path: 'notes/missing.md' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /not found/i);
    });

    // A second server with a small budget proves the budget is read
    // from the environment and that two-step reading recovers what a
    // bundled read had to drop.
    let smallTransport = null;
    let smallClient = null;
    try {
      smallTransport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER],
        env: { ...process.env, MEMDRIVE_ROOT: root, MEMDRIVE_RESPONSE_BUDGET_BYTES: '200000' },
        stderr: 'pipe',
      });
      smallClient = new Client(
        { name: 'memdrive-protocol-test-small-budget', version: '0.1.0' },
        { capabilities: {} },
      );
      await smallClient.connect(smallTransport);
      const smallCall = async (name, args) => smallClient.callTool({ name, arguments: args });

      await check('small budget (200,000): bundled read never errors and stays in budget', async () => {
        const res = await smallCall('read_file', { path: 'notes/bundled.md' });
        assert.equal(res.isError, undefined, textOf(res));
        assert.ok(resultSizeBytes(res) <= 200_000, `small-budget total ${resultSizeBytes(res)} must be <= 200,000`);
      });

      await check('small budget: undecodable oversized image skipped with note, never errors', async () => {
        await fs.writeFile(path.join(root, 'photos/fake.png'), Buffer.alloc(800_000, 0x41));
        await fs.writeFile(path.join(root, 'notes/fake.md'), '# Fake\n![fake](../photos/fake.png)\n');
        const res = await smallCall('read_file', { path: 'notes/fake.md' });
        assert.equal(res.isError, undefined, textOf(res));
        assert.equal(imagesOf(res).length, 0);
        assert.match(textOf(res), /Skipped image/);
        assert.ok(resultSizeBytes(res) <= 200_000);
        const direct = await smallCall('read_file', { path: 'photos/fake.png' });
        assert.equal(direct.isError, undefined, textOf(direct));
        assert.equal(imagesOf(direct).length, 0);
        assert.match(textOf(direct), /was not returned as an image/);
      });

      await check('two-step: direct read gets the whole small budget for the image the bundled read dropped', async () => {
        const bundled = await smallCall('read_file', { path: 'notes/heavy.md' });
        assert.equal(bundled.isError, undefined, textOf(bundled));
        assert.equal(imagesOf(bundled).length, 0);
        assert.ok(resultSizeBytes(bundled) <= 200_000);
        const direct = await smallCall('read_file', { path: 'photos/bmp1.bmp' });
        assert.equal(direct.isError, undefined, textOf(direct));
        assert.equal(imagesOf(direct).length, 1);
        assert.equal(imagesOf(direct)[0].mimeType, 'image/jpeg');
        assert.ok(resultSizeBytes(direct) <= 200_000, `direct total ${resultSizeBytes(direct)} must be <= 200,000`);
        assert.equal(sha256(await fs.readFile(bmp1Disk)), bmp1Sha, 'on-disk original must be byte-identical after direct budget reads');
      });
    } finally {
      await smallClient?.close().catch(() => undefined);
      await smallTransport?.close().catch(() => undefined);
    }

    // --- Wizard / host-config / viewer unit checks (0.2.0, no MCP) ---

    await check('viewerCommandFor: exact commands per platform, path kept as one argument', async () => {
      assert.deepEqual(viewerCommandFor('win32', 'C:\\Users\\x\\shot.png'), {
        command: 'cmd.exe',
        args: ['/c', 'start', '', 'C:\\Users\\x\\shot.png'],
      });
      assert.deepEqual(viewerCommandFor('darwin', '/Users/you/shot.png'), {
        command: 'open',
        args: ['/Users/you/shot.png'],
      });
      assert.deepEqual(viewerCommandFor('linux', '/home/u/shot.png'), {
        command: 'xdg-open',
        args: ['/home/u/shot.png'],
      });
      // A hostile filename (spaces, semicolon, shell metacharacters)
      // stays ONE array element: it is never concatenated into a
      // command line by this code. That alone does NOT make it safe
      // on Windows — cmd.exe re-parses the line, so & | < > ^ %
      // would still split it (see the launchViewer refusal test
      // below); the array shape only rules out naive concatenation.
      const hostile = '/tmp/a b; rm -rf /x.png';
      const cmd = viewerCommandFor('linux', hostile);
      assert.equal(cmd.args.length, 1);
      assert.equal(cmd.args[0], hostile);
    });

    await check('folderCommandFor (0.5.2): Windows shell-mediated explorer /n,path in one element; macOS/Linux unchanged', async () => {
      // Windows folders must NOT use a direct explorer.exe spawn
      // (0.5.1: exited with code 1, no window) and must NOT split
      // the switch from the path: /n,path is ONE comma-joined
      // argument, launched through cmd /c start (shell-mediated,
      // as the image viewer is), so explorer opens a new window
      // even when the folder is already open.
      assert.deepEqual(folderCommandFor('win32', 'C:\\Users\\x\\notes\\assets'), {
        command: 'cmd.exe',
        args: ['/c', 'start', '', 'explorer.exe', '/n,C:\\Users\\x\\notes\\assets'],
      });
      assert.notDeepEqual(
        folderCommandFor('win32', 'C:\\Users\\x\\notes\\assets'),
        viewerCommandFor('win32', 'C:\\Users\\x\\notes\\assets'),
      );
      assert.deepEqual(folderCommandFor('darwin', '/Users/you/notes'), viewerCommandFor('darwin', '/Users/you/notes'));
      assert.deepEqual(folderCommandFor('linux', '/home/u/notes'), viewerCommandFor('linux', '/home/u/notes'));
      // A hostile folder name stays ONE array element, as with the
      // file launcher: never concatenated into a command line.
      // On Windows it stays inside the single /n,path element.
      const hostileFolder = '/tmp/a b; rm -rf /x';
      const folderCmd = folderCommandFor('linux', hostileFolder);
      assert.equal(folderCmd.args.length, 1);
      assert.equal(folderCmd.args[0], hostileFolder);
      const hostileWin = 'C:\\Users\\x\\a b; del *';
      const winCmd = folderCommandFor('win32', hostileWin);
      assert.equal(winCmd.args.length, 5);
      assert.equal(winCmd.args[4], '/n,' + hostileWin);
    });

    await check('openInViewer/openFolderInViewer refuse Windows shell metacharacters without spawning', async () => {
      // 0.7.0 follow-up (#9): on win32 the path is re-parsed by
      // cmd.exe, so & | < > ^ % would split the command line.
      // The refusal happens before any spawn, so this runs on any
      // platform by passing 'win32' explicitly.
      const file = await openInViewer('C:\\x&calc&.png', 'win32');
      assert.equal(file.ok, false);
      assert.match(file.reason, /metacharacters/i);
      const folder = await openFolderInViewer('C:\\x&calc&', 'win32');
      assert.equal(folder.ok, false);
      assert.match(folder.reason, /metacharacters/i);
      const pipe = await openInViewer('C:\\a|b.png', 'win32');
      assert.equal(pipe.ok, false);
    });

    await check('probeCandidateRoots (Linux fake): existing OneDrive + always-listed default', async () => {
      const found = await probeCandidateRoots({
        platform: 'linux',
        homeDir: '/home/testuser',
        exists: async (p) => p === '/home/testuser/OneDrive',
      });
      assert.deepEqual(found, [
        { path: '/home/testuser/OneDrive', label: 'OneDrive' },
        { path: '/home/testuser/memdrive', label: 'Default (~/memdrive)' },
      ]);
    });

    await check('probeCandidateRoots (Windows fake): DriveFS + label probe + fallback dedupe, no hardcoded G:', async () => {
      const win = path.win32;
      const home = 'C:\\Users\\x';
      const existing = new Set([
        win.join(home, 'OneDrive'),
        win.join('C:\\Users\\x\\AppData\\Local', 'Google', 'DriveFS'),
        'G:\\My Drive',
      ]);
      const found = await probeCandidateRoots({
        platform: 'win32',
        env: {
          OneDrive: win.join(home, 'OneDrive'),
          LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
          USERPROFILE: home,
        },
        homeDir: home,
        exists: async (p) => existing.has(p),
        driveLetterProbe: async () => 'G',
      });
      const paths = found.map((c) => c.path);
      assert.ok(paths.includes('G:\\My Drive'), `expected G:\\My Drive in ${paths.join(', ')}`);
      assert.equal(paths.filter((p) => p === 'G:\\My Drive').length, 1, 'probe + fallback must dedupe to one entry');
      assert.ok(!paths.some((p) => p.startsWith('H:')), 'H: must not appear when it does not exist');
      assert.equal(paths[paths.length - 1], win.join(home, 'memdrive'));
    });

    await check('probeCandidateRoots (Windows fake): no DriveFS means the label probe never runs', async () => {
      let probeCalls = 0;
      const found = await probeCandidateRoots({
        platform: 'win32',
        env: {
          LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local',
          USERPROFILE: 'C:\\Users\\x',
        },
        homeDir: 'C:\\Users\\x',
        exists: async () => false,
        driveLetterProbe: async () => {
          probeCalls += 1;
          return 'G';
        },
      });
      assert.equal(probeCalls, 0, 'PowerShell probe must not run without DriveFS');
      assert.deepEqual(found, [
        { path: 'C:\\Users\\x\\memdrive', label: 'Default (~/memdrive)' },
      ]);
    });

    await check('probeCandidateRoots (macOS fake): Google Drive volume + iCloud candidates', async () => {
      const existing = new Set([
        '/Volumes/GoogleDrive',
        '/Users/you/Library/Mobile Documents/com~apple~CloudDocs',
      ]);
      const found = await probeCandidateRoots({
        platform: 'darwin',
        homeDir: '/Users/you',
        exists: async (p) => existing.has(p),
      });
      const labels = found.map((c) => c.label);
      assert.ok(labels.includes('Google Drive'));
      assert.ok(labels.includes('iCloud Drive'));
      assert.equal(found[found.length - 1].path, '/Users/you/memdrive');
    });

    await check('expandCustomPath: ~ expansion, absolute-only, quote stripping', async () => {
      assert.equal(expandCustomPath('~/notes', '/home/u', 'linux'), '/home/u/notes');
      assert.equal(expandCustomPath('~', '/home/u', 'linux'), '/home/u');
      assert.equal(expandCustomPath('notes/x', '/home/u', 'linux'), null);
      assert.equal(expandCustomPath('', '/home/u', 'linux'), null);
      assert.equal(
        expandCustomPath('"C:\\Users\\x\\memory"', 'C:\\Users\\x', 'win32'),
        'C:\\Users\\x\\memory',
      );
      assert.equal(expandCustomPath('C:memory', 'C:\\Users\\x', 'win32'), null);
    });

    await check('buildServerEntry: node + dist/index.js + MEMDRIVE_ROOT only, no budget env', async () => {
      const entry = buildServerEntry('/tmp/fakehome/memdrive');
      assert.equal(entry.command, 'node');
      assert.equal(entry.args.length, 1);
      assert.equal(entry.args[0], serverScriptPath());
      assert.ok(serverScriptPath().endsWith(path.join('dist', 'index.js')));
      assert.deepEqual(Object.keys(entry.env), ['MEMDRIVE_ROOT']);
      assert.equal(entry.env.MEMDRIVE_ROOT, '/tmp/fakehome/memdrive');
      assert.equal(entry.type, undefined);
      await fs.stat(serverScriptPath());
    });

    await check('buildServerEntry (Cursor): includes type stdio and 10000000 budget env; configSnippet matches host', async () => {
      const entry = buildServerEntry('/tmp/fakehome/memdrive', cursorAdapter);
      assert.equal(entry.type, 'stdio');
      assert.equal(entry.command, 'node');
      assert.deepEqual(Object.keys(entry.env), ['MEMDRIVE_ROOT', 'MEMDRIVE_RESPONSE_BUDGET_BYTES']);
      assert.equal(entry.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      const cursorSnippet = JSON.parse(configSnippet('/tmp/fakehome/memdrive', cursorAdapter));
      assert.equal(cursorSnippet.mcpServers.memdrive.type, 'stdio');
      assert.equal(cursorSnippet.mcpServers.memdrive.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      const claudeSnippet = JSON.parse(configSnippet('/tmp/fakehome/memdrive', claudeDesktopAdapter));
      assert.equal(claudeSnippet.mcpServers.memdrive.type, undefined);
      assert.equal('type' in claudeSnippet.mcpServers.memdrive, false);
      assert.equal('MEMDRIVE_RESPONSE_BUDGET_BYTES' in claudeSnippet.mcpServers.memdrive.env, false);
    });

    await check('buildServerEntry (VS Code): includes type stdio and 10000000 budget env; configSnippet matches host', async () => {
      const entry = buildServerEntry('/tmp/fakehome/memdrive', vscodeAdapter);
      assert.equal(entry.type, 'stdio');
      assert.equal(entry.command, 'node');
      assert.deepEqual(Object.keys(entry.env), ['MEMDRIVE_ROOT', 'MEMDRIVE_RESPONSE_BUDGET_BYTES']);
      assert.equal(entry.env.MEMDRIVE_ROOT, '/tmp/fakehome/memdrive');
      assert.equal(entry.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      const snippet = JSON.parse(configSnippet('/tmp/fakehome/memdrive', vscodeAdapter));
      assert.equal(snippet.mcpServers.memdrive.type, 'stdio');
      assert.equal(snippet.mcpServers.memdrive.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      assert.equal('tools' in snippet.mcpServers.memdrive, false);
    });

    await check('parseHostArgument: claude/cursor aliases, empty/unknown fall back to prompt', async () => {
      assert.equal(parseHostArgument(undefined), null);
      assert.equal(parseHostArgument(''), null);
      assert.equal(parseHostArgument('  '), null);
      assert.equal(parseHostArgument('cursor'), 'cursor');
      assert.equal(parseHostArgument('Cursor'), 'cursor');
      assert.equal(parseHostArgument('CURSOR'), 'cursor');
      assert.equal(parseHostArgument('claude'), 'claude-desktop');
      assert.equal(parseHostArgument('claude-desktop'), 'claude-desktop');
      assert.equal(parseHostArgument('Claude-Desktop'), 'claude-desktop');
      assert.equal(parseHostArgument('vscode'), 'vscode');
      assert.equal(parseHostArgument('unknown-host'), null);
      assert.deepEqual(
        HOST_ADAPTERS.map((a) => a.id),
        ['claude-desktop', 'cursor', 'vscode', 'claude-code'],
      );
      assert.equal(hostAdapterForId('cursor'), cursorAdapter);
      assert.equal(hostAdapterForId('claude-desktop'), claudeDesktopAdapter);
      assert.equal(hostAdapterForId('vscode'), vscodeAdapter);
      assert.equal(hostAdapterForId('claude-code'), claudeCodeAdapter);
    });

    await check('parseHostArgument (VS Code): only the single word vscode selects it; vs-code/code fall back to prompt', async () => {
      assert.equal(parseHostArgument('vscode'), 'vscode');
      assert.equal(parseHostArgument('VSCode'), 'vscode');
      assert.equal(parseHostArgument('VSCODE'), 'vscode');
      assert.equal(parseHostArgument('  vscode  '), 'vscode');
      assert.equal(parseHostArgument('vs-code'), null);
      assert.equal(parseHostArgument('VS-Code'), null);
      assert.equal(parseHostArgument('code'), null);
      assert.equal(parseHostArgument('Code'), null);
    });

    await check('mergeConfigJson: preserves a Cursor entry type and other servers', async () => {
      const entry = buildServerEntry('/r', cursorAdapter);
      const merged = mergeConfigJson(
        JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
        cursorAdapter,
        entry,
      );
      assert.equal(merged.ok, true);
      const doc = JSON.parse(merged.text);
      assert.equal(doc.mcpServers.memdrive.type, 'stdio');
      assert.deepEqual(doc.mcpServers.other, { command: 'x', args: [] });
    });

    await check('mergeConfigJson: preserves an existing entry tools field; fresh entries gain no tools', async () => {
      const entry = buildServerEntry('/r', vscodeAdapter);
      const merged = mergeConfigJson(
        JSON.stringify({
          mcpServers: {
            other: { command: 'x', args: [] },
            memdrive: {
              type: 'stdio',
              command: 'node',
              args: ['/old/dist/index.js'],
              env: { MEMDRIVE_ROOT: '/old' },
              tools: ['*'],
            },
          },
          otherKey: 1,
        }),
        vscodeAdapter,
        entry,
      );
      assert.equal(merged.ok, true);
      const doc = JSON.parse(merged.text);
      assert.deepEqual(doc.mcpServers.memdrive.tools, ['*']);
      assert.equal(doc.mcpServers.memdrive.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      assert.equal(doc.otherKey, 1);
      assert.deepEqual(doc.mcpServers.other, { command: 'x', args: [] });
      // No existing memdrive entry: no tools field is invented.
      const fresh = mergeConfigJson(
        JSON.stringify({ mcpServers: { other: { command: 'x', args: [] } } }),
        vscodeAdapter,
        entry,
      );
      assert.equal(fresh.ok, true);
      assert.equal('tools' in JSON.parse(fresh.text).mcpServers.memdrive, false);
      // Existing entry without tools: none is added.
      const noTools = mergeConfigJson(
        JSON.stringify({
          mcpServers: { memdrive: { command: 'node', args: [], env: {} } },
        }),
        vscodeAdapter,
        entry,
      );
      assert.equal(noTools.ok, true);
      assert.equal('tools' in JSON.parse(noTools.text).mcpServers.memdrive, false);
    });

    await check('findConfigPaths (Cursor, Windows fake): .cursor dir present returns global path, absent returns none', async () => {
      const win = path.win32;
      const dir = win.join('C:\\Users\\x', '.cursor');
      const expected = win.join(dir, 'mcp.json');
      const found = await cursorAdapter.findConfigPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        exists: async (p) => p === dir,
      });
      assert.deepEqual(found, [expected]);
      const none = await cursorAdapter.findConfigPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        exists: async () => false,
      });
      assert.deepEqual(none, []);
    });

    await check('findConfigPaths (Cursor, macOS/Linux fake): home .cursor path; stale legacy paths never returned', async () => {
      const expected = '/Users/you/.cursor/mcp.json';
      const found = await cursorAdapter.findConfigPaths({
        platform: 'darwin',
        homeDir: '/Users/you',
        exists: async (p) => p === '/Users/you/.cursor',
      });
      assert.deepEqual(found, [expected]);
      const linuxFound = await cursorAdapter.findConfigPaths({
        platform: 'linux',
        homeDir: '/home/u',
        exists: async (p) => p === '/home/u/.cursor',
      });
      assert.deepEqual(linuxFound, ['/home/u/.cursor/mcp.json']);
      // A legacy path existing alone must not be reported: only the
      // .cursor directory gates discovery.
      const legacy = await cursorAdapter.findConfigPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        exists: async (p) => p.endsWith('globalStorage\\mcp.json'),
      });
      assert.deepEqual(legacy, []);
    });

    await check('findConfigPaths (VS Code, fakes): .copilot dir present returns Copilot Global path, absent returns none; COPILOT_HOME ignored', async () => {
      const win = path.win32;
      const dir = win.join('C:\\Users\\x', '.copilot');
      const expected = win.join(dir, 'mcp-config.json');
      const found = await vscodeAdapter.findConfigPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        env: { COPILOT_HOME: 'D:\\elsewhere' },
        exists: async (p) => p === dir,
      });
      assert.deepEqual(found, [expected]);
      const none = await vscodeAdapter.findConfigPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        exists: async () => false,
      });
      assert.deepEqual(none, []);
      const macFound = await vscodeAdapter.findConfigPaths({
        platform: 'darwin',
        homeDir: '/Users/you',
        exists: async (p) => p === '/Users/you/.copilot',
      });
      assert.deepEqual(macFound, ['/Users/you/.copilot/mcp-config.json']);
      const linuxFound = await vscodeAdapter.findConfigPaths({
        platform: 'linux',
        homeDir: '/home/u',
        exists: async (p) => p === '/home/u/.copilot',
      });
      assert.deepEqual(linuxFound, ['/home/u/.copilot/mcp-config.json']);
    });

    await check('writeHostConfig (Cursor): missing file is created, no backup; existing file merges with backup', async () => {
      const dir = path.join(scratch, 'cursorcfg');
      const cursorDir = path.join(dir, '.cursor');
      await fs.mkdir(cursorDir, { recursive: true });
      const configPath = path.join(cursorDir, 'mcp.json');
      const entry = buildServerEntry('/r', cursorAdapter);
      const created = await writeHostConfig(cursorAdapter, configPath, entry);
      assert.equal(created.status, 'created');
      const createdDoc = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.equal(createdDoc.mcpServers.memdrive.type, 'stdio');
      assert.equal(createdDoc.mcpServers.memdrive.env.MEMDRIVE_ROOT, '/r');
      await assert.rejects(fs.stat(`${configPath}.bak`));
      // Second write merges into the created file, with a backup.
      const beforeSecond = await fs.readFile(configPath, 'utf8');
      const second = await writeHostConfig(cursorAdapter, configPath, entry);
      assert.equal(second.status, 'written');
      assert.equal(await fs.readFile(second.backupPath, 'utf8'), beforeSecond);
    });

    await check('writeHostConfig (Cursor): corrupt config untouched, no backup, no creation', async () => {
      const dir = path.join(scratch, 'cursorcfg2');
      await fs.mkdir(dir, { recursive: true });
      const corruptPath = path.join(dir, 'mcp.json');
      await fs.writeFile(corruptPath, '{broken');
      const entry = buildServerEntry('/r', cursorAdapter);
      const corrupt = await writeHostConfig(cursorAdapter, corruptPath, entry);
      assert.equal(corrupt.status, 'corrupt');
      assert.equal(await fs.readFile(corruptPath, 'utf8'), '{broken');
      await assert.rejects(fs.stat(`${corruptPath}.bak`));
    });

    await check('writeHostConfig (VS Code): missing file is created, no backup; existing file merges with backup', async () => {
      const dir = path.join(scratch, 'vscodecfg');
      const copilotDir = path.join(dir, '.copilot');
      await fs.mkdir(copilotDir, { recursive: true });
      const configPath = path.join(copilotDir, 'mcp-config.json');
      const entry = buildServerEntry('/r', vscodeAdapter);
      const created = await writeHostConfig(vscodeAdapter, configPath, entry);
      assert.equal(created.status, 'created');
      const createdDoc = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.deepEqual(Object.keys(createdDoc.mcpServers), ['memdrive']);
      assert.equal(createdDoc.mcpServers.memdrive.type, 'stdio');
      assert.equal(createdDoc.mcpServers.memdrive.env.MEMDRIVE_ROOT, '/r');
      assert.equal(createdDoc.mcpServers.memdrive.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      assert.equal('tools' in createdDoc.mcpServers.memdrive, false);
      await assert.rejects(fs.stat(`${configPath}.bak`));
      const beforeSecond = await fs.readFile(configPath, 'utf8');
      const second = await writeHostConfig(vscodeAdapter, configPath, entry);
      assert.equal(second.status, 'written');
      assert.equal(await fs.readFile(second.backupPath, 'utf8'), beforeSecond);
    });

    await check('writeHostConfig (VS Code): corrupt config untouched, no backup, no creation', async () => {
      const dir = path.join(scratch, 'vscodecfg2');
      await fs.mkdir(dir, { recursive: true });
      const corruptPath = path.join(dir, 'mcp-config.json');
      await fs.writeFile(corruptPath, '{broken');
      const entry = buildServerEntry('/r', vscodeAdapter);
      const corrupt = await writeHostConfig(vscodeAdapter, corruptPath, entry);
      assert.equal(corrupt.status, 'corrupt');
      assert.equal(await fs.readFile(corruptPath, 'utf8'), '{broken');
      await assert.rejects(fs.stat(`${corruptPath}.bak`));
    });

    await check('mergeConfigJson: preserves other keys/servers, installs memdrive, rejects non-objects', async () => {
      const entry = { command: 'node', args: ['/x/dist/index.js'], env: { MEMDRIVE_ROOT: '/r' } };
      const merged = mergeConfigJson(
        JSON.stringify({ otherKey: 1, mcpServers: { other: { command: 'x', args: [] } } }),
        claudeDesktopAdapter,
        entry,
      );
      assert.equal(merged.ok, true);
      const doc = JSON.parse(merged.text);
      assert.equal(doc.otherKey, 1);
      assert.deepEqual(doc.mcpServers.other, { command: 'x', args: [] });
      assert.deepEqual(doc.mcpServers.memdrive, entry);
      assert.equal(mergeConfigJson('{not json', claudeDesktopAdapter, entry).ok, false);
      assert.equal(mergeConfigJson('[1,2]', claudeDesktopAdapter, entry).ok, false);
      assert.equal(
        mergeConfigJson('{"mcpServers": "nope"}', claudeDesktopAdapter, entry).ok,
        false,
      );
    });

    await check('backupPathFor: plain .bak first, timestamped when one exists', async () => {
      assert.equal(backupPathFor('/c.json', () => false), '/c.json.bak');
      assert.equal(
        backupPathFor('/c.json', () => true, new Date(2026, 9, 29, 10, 28, 0, 123)),
        '/c.json.bak-20261029-102800-123',
      );
    });

    await check('writeHostConfig: backup + merge preserving other servers (temp dir)', async () => {
      const dir = path.join(scratch, 'cfgtest');
      await fs.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, 'claude_desktop_config.json');
      const original = JSON.stringify(
        { mcpServers: { other: { command: 'other', args: ['a'] } }, theme: 'dark' },
        null,
        2,
      );
      await fs.writeFile(configPath, original);
      const entry = { command: 'node', args: ['/x/dist/index.js'], env: { MEMDRIVE_ROOT: '/r' } };
      const first = await writeHostConfig(claudeDesktopAdapter, configPath, entry);
      assert.equal(first.status, 'written');
      assert.equal(first.backupPath, `${configPath}.bak`);
      assert.equal(await fs.readFile(first.backupPath, 'utf8'), original);
      const doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.equal(doc.theme, 'dark');
      assert.deepEqual(doc.mcpServers.other, { command: 'other', args: ['a'] });
      assert.deepEqual(doc.mcpServers.memdrive, entry);
      // Second write: the first backup is never overwritten.
      const second = await writeHostConfig(claudeDesktopAdapter, configPath, entry);
      assert.equal(second.status, 'written');
      assert.match(second.backupPath, /\.bak-\d{8}-\d{6}-\d{3}$/);
      assert.equal(await fs.readFile(first.backupPath, 'utf8'), original);
    });

    await check('writeHostConfig: missing config is never created; corrupt config untouched, no backup', async () => {
      const dir = path.join(scratch, 'cfgtest2');
      await fs.mkdir(dir, { recursive: true });
      const entry = { command: 'node', args: ['/x/dist/index.js'], env: { MEMDRIVE_ROOT: '/r' } };
      const missingPath = path.join(dir, 'absent.json');
      const missing = await writeHostConfig(claudeDesktopAdapter, missingPath, entry);
      assert.equal(missing.status, 'missing');
      await assert.rejects(fs.stat(missingPath));
      const corruptPath = path.join(dir, 'corrupt.json');
      await fs.writeFile(corruptPath, '{broken');
      const corrupt = await writeHostConfig(claudeDesktopAdapter, corruptPath, entry);
      assert.equal(corrupt.status, 'corrupt');
      assert.equal(await fs.readFile(corruptPath, 'utf8'), '{broken');
      await assert.rejects(fs.stat(`${corruptPath}.bak`));
    });

    await check('findConfigPaths (Windows fake): APPDATA + Claude-Data glob, deduped, existing only', async () => {
      const win = path.win32;
      const appData = 'C:\\Users\\x\\AppData\\Roaming';
      const localAppData = 'C:\\Users\\x\\AppData\\Local';
      const appDataConfig = win.join(appData, 'Claude', 'claude_desktop_config.json');
      const globConfig = win.join(
        localAppData, 'Claude-Data', 'claude_pzs8sxrjxfjjc', 'claude_desktop_config.json',
      );
      const claudeDataDir = win.join(localAppData, 'Claude-Data');
      const found = await claudeDesktopAdapter.findConfigPaths({
        platform: 'win32',
        env: { APPDATA: appData, LOCALAPPDATA: localAppData },
        homeDir: 'C:\\Users\\x',
        exists: async (p) => p === appDataConfig || p === globConfig,
        readdir: async (dir) =>
          dir === claudeDataDir ? ['claude_pzs8sxrjxfjjc'] : [],
      });
      assert.deepEqual(found, [appDataConfig, globConfig]);
    });

    await check('parseHostArgument (Claude Code): only claude-code selects it; claude stays Desktop, code falls back to prompt', async () => {
      assert.equal(parseHostArgument('claude-code'), 'claude-code');
      assert.equal(parseHostArgument('Claude-Code'), 'claude-code');
      assert.equal(parseHostArgument('CLAUDE-CODE'), 'claude-code');
      assert.equal(parseHostArgument('  claude-code  '), 'claude-code');
      assert.equal(parseHostArgument('claudecode'), null);
      assert.equal(parseHostArgument('claude_code'), null);
      assert.equal(parseHostArgument('claude'), 'claude-desktop');
      assert.equal(parseHostArgument('code'), null);
      assert.equal(hostAdapterForId('claude-code'), claudeCodeAdapter);
    });

    await check('buildServerEntry (Claude Code): no type field, 10000000 budget env; configSnippet matches host', async () => {
      const entry = buildServerEntry('/tmp/fakehome/memdrive', claudeCodeAdapter);
      assert.equal('type' in entry, false);
      assert.equal(entry.command, 'node');
      assert.equal(entry.env.MEMDRIVE_ROOT, '/tmp/fakehome/memdrive');
      assert.equal(entry.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      const snippet = JSON.parse(configSnippet('/tmp/fakehome/memdrive', claudeCodeAdapter));
      assert.deepEqual(snippet.mcpServers.memdrive, entry);
      assert.equal(claudeCodeAdapter.createIfMissing, undefined);
    });

    await check('findConfigPaths (Claude Code, fakes): single .claude.json, existing only; CLAUDE_CONFIG_DIR override wins', async () => {
      // Default: file exists -> returned; file missing -> [] even when
      // the ~/.claude directory exists (B方案: never created).
      const found = await claudeCodeAdapter.findConfigPaths({
        platform: 'darwin',
        homeDir: '/Users/you',
        exists: async (p) => p === '/Users/you/.claude.json',
      });
      assert.deepEqual(found, ['/Users/you/.claude.json']);
      const missing = await claudeCodeAdapter.findConfigPaths({
        platform: 'darwin',
        homeDir: '/Users/you',
        exists: async (p) => p === '/Users/you/.claude',
      });
      assert.deepEqual(missing, []);
      const winFound = await claudeCodeAdapter.findConfigPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        exists: async (p) => p === 'C:\\Users\\x\\.claude.json',
      });
      assert.deepEqual(winFound, ['C:\\Users\\x\\.claude.json']);
      // CLAUDE_CONFIG_DIR override: file inside that directory only;
      // the default path is ignored when the override is set.
      const overridden = await claudeCodeAdapter.findConfigPaths({
        platform: 'linux',
        homeDir: '/home/u',
        env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
        exists: async (p) => p === '/custom/claude/.claude.json',
      });
      assert.deepEqual(overridden, ['/custom/claude/.claude.json']);
      const overriddenDefault = await claudeCodeAdapter.findConfigPaths({
        platform: 'linux',
        homeDir: '/home/u',
        env: { CLAUDE_CONFIG_DIR: '/custom/claude' },
        exists: async (p) => p === '/home/u/.claude.json',
      });
      assert.deepEqual(overriddenDefault, []);
      const winOverride = await claudeCodeAdapter.findConfigPaths({
        platform: 'win32',
        homeDir: 'C:\\Users\\x',
        env: { CLAUDE_CONFIG_DIR: 'D:\\custom\\claude' },
        exists: async (p) => p === 'D:\\custom\\claude\\.claude.json',
      });
      assert.deepEqual(winOverride, ['D:\\custom\\claude\\.claude.json']);
      // Empty override falls back to the default path; a relative
      // override resolves against the home directory.
      const emptyOverride = await claudeCodeAdapter.findConfigPaths({
        platform: 'linux',
        homeDir: '/home/u',
        env: { CLAUDE_CONFIG_DIR: '   ' },
        exists: async (p) => p === '/home/u/.claude.json',
      });
      assert.deepEqual(emptyOverride, ['/home/u/.claude.json']);
      const relativeOverride = await claudeCodeAdapter.findConfigPaths({
        platform: 'linux',
        homeDir: '/home/u',
        env: { CLAUDE_CONFIG_DIR: 'rel/claude' },
        exists: async (p) => p === '/home/u/rel/claude/.claude.json',
      });
      assert.deepEqual(relativeOverride, ['/home/u/rel/claude/.claude.json']);
    });

    await check('mergeConfigJson (Claude Code): preserves projects and other top-level keys, installs memdrive only', async () => {
      const entry = buildServerEntry('/r', claudeCodeAdapter);
      const fixture = {
        projects: {
          '/p': { mcpServers: { other: { command: 'x', args: [] } }, history: [] },
        },
        otherKey: 1,
        mcpServers: { other: { command: 'y', args: [] } },
      };
      const merged = mergeConfigJson(JSON.stringify(fixture), claudeCodeAdapter, entry);
      assert.equal(merged.ok, true);
      const doc = JSON.parse(merged.text);
      assert.deepEqual(doc.projects, fixture.projects);
      assert.equal(doc.otherKey, 1);
      assert.deepEqual(doc.mcpServers.other, { command: 'y', args: [] });
      assert.deepEqual(doc.mcpServers.memdrive, entry);
      assert.equal('type' in doc.mcpServers.memdrive, false);
    });

    await check('writeHostConfig (Claude Code): missing file is NEVER created; existing file merges with backup', async () => {
      const dir = path.join(scratch, 'codecCfg');
      await fs.mkdir(dir, { recursive: true });
      const configPath = path.join(dir, '.claude.json');
      const entry = buildServerEntry('/r', claudeCodeAdapter);
      const missing = await writeHostConfig(claudeCodeAdapter, configPath, entry);
      assert.equal(missing.status, 'missing');
      await assert.rejects(fs.stat(configPath));
      // Existing file: merge preserves other keys, backs up first.
      const original = JSON.stringify(
        { projects: { '/p': { history: [] } }, mcpServers: { other: { command: 'x', args: [] } } },
        null,
        2,
      );
      await fs.writeFile(configPath, original);
      const written = await writeHostConfig(claudeCodeAdapter, configPath, entry);
      assert.equal(written.status, 'written');
      assert.equal(await fs.readFile(written.backupPath, 'utf8'), original);
      const doc = JSON.parse(await fs.readFile(configPath, 'utf8'));
      assert.deepEqual(doc.projects, { '/p': { history: [] } });
      assert.deepEqual(doc.mcpServers.other, { command: 'x', args: [] });
      assert.equal(doc.mcpServers.memdrive.env.MEMDRIVE_RESPONSE_BUDGET_BYTES, '10000000');
      // Corrupt file: untouched, no backup.
      const corruptPath = path.join(dir, 'corrupt.json');
      await fs.writeFile(corruptPath, '{broken');
      const corrupt = await writeHostConfig(claudeCodeAdapter, corruptPath, entry);
      assert.equal(corrupt.status, 'corrupt');
      assert.equal(await fs.readFile(corruptPath, 'utf8'), '{broken');
      await assert.rejects(fs.stat(`${corruptPath}.bak`));
    });

    await check('findConfigPaths (macOS fake): single Application Support path', async () => {
      const expected = '/Users/you/Library/Application Support/Claude/claude_desktop_config.json';
      const found = await claudeDesktopAdapter.findConfigPaths({
        platform: 'darwin',
        homeDir: '/Users/you',
        exists: async (p) => p === expected,
      });
      assert.deepEqual(found, [expected]);
      const none = await claudeDesktopAdapter.findConfigPaths({
        platform: 'darwin',
        homeDir: '/Users/you',
        exists: async () => false,
      });
      assert.deepEqual(none, []);
    });

    /* ------------------------------------------------------------ */
    /* 0.8.0 search engine                                           */
    /* ------------------------------------------------------------ */

    await check('0.8.0 tokenizer: Chinese segmentation + bigram + single char, mixed, NFKC', async () => {
      const tokens = tokenize('我喜欢用MemDrive记笔记');
      assert.ok(tokens.includes('喜欢'), 'bigram 喜欢');
      assert.ok(tokens.includes('记'), 'single char 记');
      assert.ok(tokens.includes('memdrive'), 'latin word lowercased');
      assert.ok(tokens.includes('记笔记'), 'segmented word');
      // No double-count: a 1-char word and a 2-char word's bigram
      // equal the word itself, so they must appear exactly once.
      assert.equal(tokens.filter((t) => t === '我').length, 1);
      assert.equal(tokens.filter((t) => t === '喜欢').length, 1);
      assert.deepEqual(tokenizeQuery('全文检索'), [...new Set(tokenize('全文检索'))]);
      // NFKC: full-width chars and compatibility forms fold.
      assert.ok(tokenize('Ｆｕｌｌ').includes('full'));
      assert.equal(normalizeText('é'), 'é');
    });

    await check('0.8.0 chunker: exact offsets, 600 cap, 100 overlap, sections', async () => {
      const text = '# 标题一\n\n第一段内容。\n\n## 小节\n\n' + '啊'.repeat(700) + '\n\n# 标题二\n\n尾段。';
      const chunks = chunkText(text);
      assert.ok(chunks.length >= 3);
      for (const c of chunks) {
        assert.equal(text.slice(c.startOffset, c.endOffset).length, c.endOffset - c.startOffset);
        assert.ok(c.endOffset - c.startOffset <= 600, `chunk over cap: ${c.endOffset - c.startOffset}`);
      }
      assert.deepEqual(chunks.map((c) => c.section).slice(0, 2), ['标题一', '小节']);
      // Hard-split pair overlaps by exactly 100.
      const hard = chunks.filter((c) => c.section === '小节');
      assert.ok(hard.length >= 2);
      assert.equal(hard[0].endOffset - hard[1].startOffset, 100);
      // Blank lines between units count toward the slice length:
      // a note of short paragraphs separated by blank lines used
      // to emit slices over the 600 cap.
      let spaced = '';
      for (let i = 0; i < 40; i++) {
        spaced += `段落${i}内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容内容。\n\n`;
      }
      for (const c of chunkText(spaced)) {
        assert.ok(c.endOffset - c.startOffset <= 600, `chunk over cap: ${c.endOffset - c.startOffset}`);
      }
    });

    await check('0.8.0 tags/date extraction: front matter > filename > mtime', async () => {
      assert.deepEqual(
        extractTags('---\ntags: [工作, 读书]\n---\n正文 #生活 #工作\n').sort(),
        ['工作', '读书', '生活'].sort(),
      );
      // Block-style list: no bogus `- alpha` item (the inline
      // regex used to swallow the newline and eat the first item).
      assert.deepEqual(
        extractTags('---\ntags:\n  - alpha\n  - beta\n---\n正文 #project\n').sort(),
        ['alpha', 'beta', 'project'].sort(),
      );
      // Tags are case-insensitive and keep no leading '#'; nested
      // tags keep their `/`.
      assert.deepEqual(
        extractTags('正文 #Project #a/b #Work\n').sort(),
        ['project', 'a/b', 'work'].sort(),
      );
      assert.equal(extractDate('x', '2026-11-08-note.md', 0), '2026-11-08T00:00:00.000Z');
      assert.equal(extractDate('---\ndate: 2025-01-02\n---\n', 'note.md', 0), '2025-01-02T00:00:00.000Z');
      assert.equal(extractDate('x', 'note.md', 0), new Date(0).toISOString());
    });

    await check('0.8.0 BM25 + RRF: scores sane, phrase-free ranking fuses', async () => {
      assert.ok(bm25(2, 1, 100, 50, 50) > bm25(1, 1, 100, 50, 50));
      assert.equal(bm25(0, 1, 100, 50, 50), 0);
      assert.ok(bm25(1, 1, 100, 50, 50) > bm25(1, 50, 100, 50, 50), 'rare term scores higher');
      const fused = reciprocalRankFusion([[1, 2, 3], [2, 1]]);
      assert.ok((fused.get(1) ?? 0) > (fused.get(3) ?? 0));
      assert.equal(fused.get(3), 1 / (60 + 3));
    });

    await check('0.8.0 config: resolveSearchMaxBytes clamps; resolveIndexCacheDir lives outside the library', async () => {
      assert.equal(resolveSearchMaxBytes(undefined), 80_000);
      assert.equal(resolveSearchMaxBytes(''), 80_000);
      assert.equal(resolveSearchMaxBytes('abc'), 80_000);
      assert.equal(resolveSearchMaxBytes('500'), 1_000);
      assert.equal(resolveSearchMaxBytes('999999999'), 50_000_000);
      assert.equal(resolveSearchMaxBytes('12345'), 12345);
      // Per-file content cap: 1 MB default, clamped to [1 KB, 50 MB].
      assert.equal(resolveIndexMaxFileBytes(undefined), 1_000_000);
      assert.equal(resolveIndexMaxFileBytes(''), 1_000_000);
      assert.equal(resolveIndexMaxFileBytes('abc'), 1_000_000);
      assert.equal(resolveIndexMaxFileBytes('500'), 1_000);
      assert.equal(resolveIndexMaxFileBytes('999999999'), 50_000_000);
      assert.equal(resolveIndexMaxFileBytes('2000000'), 2000000);
      const dir = resolveIndexCacheDir(root);
      assert.ok(!dir.startsWith(root), 'index cache must be outside the library');
      assert.match(dir, /[0-9a-f]{16}$/);
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'cache-override');
      assert.equal(
        resolveIndexCacheDir(root),
        path.join(scratch, 'cache-override', dir.split(path.sep).pop()),
      );
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 placeholder detection: only the real iCloud suffix is skipped', async () => {
      assert.equal(isPlaceholderFile('notes/x.md.icloud'), true);
      // `.cloud` / `.onedrive` are not real placeholder markers —
      // OneDrive placeholders keep their real names — so files
      // carrying them are ordinary files, not skipped.
      assert.equal(isPlaceholderFile('notes/x.md.cloud'), false);
      assert.equal(isPlaceholderFile('notes/x.md.onedrive'), false);
      assert.equal(isPlaceholderFile('notes/x.md'), false);
    });

    await check('0.8.0 scanMarkdownImages: Obsidian embeds + reference-style', async () => {
      const md = [
        '![a](assets/a.png)',
        '![[assets/b.png]]',
        '![[folder/c.png|alt]]',
        '![d][ref1]',
        '![e][]',
        '',
        '[ref1]: assets/d.png',
        '[e]: assets/e.png',
        '![remote](https://example.com/x.png)',
      ].join('\n');
      const srcs = scanMarkdownImages(md).map((r) => r.src).sort();
      assert.deepEqual(srcs, [
        'assets/a.png',
        'assets/b.png',
        'assets/d.png',
        'assets/e.png',
        'folder/c.png',
      ].sort());
      // Obsidian embeds of notes/PDFs are not images, and a
      // `#fragment` is not part of the on-disk path.
      const obs = scanMarkdownImages(
        '![[Meeting Notes]] ![[spec.pdf]] ![[pic.png#center]] ![[pic.png|alt]]',
      );
      assert.deepEqual(obs.map((r) => r.src), ['pic.png']);
      assert.equal(obs[0].kind, 'obsidian');
      // `#` / `?` are stripped only for Obsidian embeds: an inline
      // ref to a literal `C#` directory keeps its path (0.7.0
      // behavior), while an Obsidian `#anchor` is still dropped.
      const hashPath = scanMarkdownImages(
        '![x](notes/C#/pic.png) ![y](assets/q.png?v=2) ![[pic.png#center]] ![[pic.png?x=1]]',
      );
      assert.deepEqual(hashPath.map((r) => r.src), [
        'notes/C#/pic.png',
        'assets/q.png?v=2',
        'pic.png',
      ]);
      // A reference definition may carry a title.
      const titled = scanMarkdownImages('![alt][r]\n\n[r]: assets/x.png "title"\n');
      assert.deepEqual(titled.map((r) => r.src), ['assets/x.png']);
      assert.equal(titled[0].kind, 'reference');
    });

    await check('0.8.0 sandbox: Windows reserved names, ADS, trailing dot/space rejected', async () => {
      assert.throws(() => validateCrossPlatformSegments('notes/NUL.md'), /reserved device/);
      assert.throws(() => validateCrossPlatformSegments('notes/CON'), /reserved device/);
      assert.throws(() => validateCrossPlatformSegments('notes/com1.txt'), /reserved device/);
      assert.throws(() => validateCrossPlatformSegments('notes/a.md:$DATA'), /alternate data stream/);
      assert.throws(() => validateCrossPlatformSegments('notes/bad.'), /dot or space/);
      assert.throws(() => validateCrossPlatformSegments('notes/bad '), /dot or space/);
      assert.throws(() => validateCrossPlatformSegments('//server/share/x.md'), /UNC/);
      validateCrossPlatformSegments('notes/normal-file.md');
      validateCrossPlatformSegments('C:/Users/x/memdrive/notes/a.md');
      const res = await call('save_file', { path: 'notes/NUL.md', content: 'x', mode: 'new' });
      assert.equal(res.isError, true);
      assert.match(textOf(res), /reserved device/i);
    });

    await check('0.8.0 index (class): build, Chinese search, BM25 rank, exact phrase, filters, pagination', async () => {
      const libDir = path.join(scratch, 'index-unit-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-unit-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(
        path.join(libDir, 'a.md'),
        '---\ntags: [工作]\ndate: 2026-01-05\n---\n# 全文检索\n\n全文检索 全文检索 全文检索。记忆库的检索。\n',
      );
      await fs.writeFile(
        path.join(libDir, 'b.md'),
        '# 随手记\n\n今天只提了一次全文检索。\n',
      );
      await fs.writeFile(path.join(libDir, 'c.txt'), '全文检索在纯文本里。\n');
      await idx.buildAll();
      assert.equal(idx.getStatus(), 'ready');
      // Chinese keyword: a.md (3 occurrences) ranks above b.md (1).
      const res = await idx.search({ keyword: '全文检索' });
      assert.equal(res.ready, true);
      assert.ok(res.total >= 2);
      assert.equal(res.hits[0].path, 'a.md');
      assert.match(res.hits[0].snippet, /\*\*全文检索\*\*/);
      // Exact phrase: only chunks containing the whole phrase.
      const phrase = await idx.search({ keyword: '检索', exactPhrase: '记忆库的检索' });
      assert.deepEqual(phrase.hits.map((h) => h.path), ['a.md']);
      // File-type filter.
      const mdOnly = await idx.search({ keyword: '全文检索', fileTypes: ['.md'] });
      assert.ok(mdOnly.hits.every((h) => h.path.endsWith('.md')));
      assert.ok(!mdOnly.hits.some((h) => h.path === 'c.txt'));
      // Tag filter.
      const tagged = await idx.search({ keyword: '全文检索', tags: ['工作'] });
      assert.deepEqual(tagged.hits.map((h) => h.path), ['a.md']);
      // Date filter (front matter date 2026-01-05).
      const dated = await idx.search({ keyword: '全文检索', dateFrom: '2026-01-01', dateTo: '2026-01-31' });
      assert.deepEqual(dated.hits.map((h) => h.path), ['a.md']);
      // A range after every file's date (b.md/c.txt fall back to
      // mtime = today) excludes everything.
      const datedOut = await idx.search({ keyword: '全文检索', dateFrom: '2027-01-01' });
      assert.equal(datedOut.total, 0);
      // Pagination.
      const page1 = await idx.search({ keyword: '全文检索', limit: 1, offset: 0 });
      const page2 = await idx.search({ keyword: '全文检索', limit: 1, offset: 1 });
      assert.equal(page1.hits.length, 1);
      assert.equal(page2.hits.length, 1);
      assert.notEqual(page1.hits[0].path + page1.hits[0].startOffset, page2.hits[0].path + page2.hits[0].startOffset);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): incremental refresh picks up add/change/delete; placeholder skipped', async () => {
      const libDir = path.join(scratch, 'index-incr-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-incr-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'one.md'), '# One\n\n苹果香蕉。\n');
      await idx.buildAll();
      assert.equal((await idx.search({ keyword: '苹果' })).total, 1);
      // Add a file: refresh (forced past the throttle) finds it.
      await fs.writeFile(path.join(libDir, 'two.md'), '# Two\n\n苹果橙子。\n');
      await idx.refreshIfNeeded(Date.now() + 60_000);
      assert.equal((await idx.search({ keyword: '苹果' })).total, 2);
      // Change a file: new content found, old content gone.
      await fs.writeFile(path.join(libDir, 'one.md'), '# One\n\n葡萄西瓜。\n');
      await idx.refreshIfNeeded(Date.now() + 120_000);
      assert.equal((await idx.search({ keyword: '苹果' })).total, 1);
      assert.equal((await idx.search({ keyword: '葡萄' })).total, 1);
      // Delete a file: gone from the index.
      await fs.unlink(path.join(libDir, 'two.md'));
      await idx.refreshIfNeeded(Date.now() + 180_000);
      assert.equal((await idx.search({ keyword: '苹果' })).total, 0);
      // Placeholder file is never indexed.
      await fs.writeFile(path.join(libDir, 'cloud.md.icloud'), '苹果占位符。\n');
      await idx.refreshIfNeeded(Date.now() + 240_000);
      assert.equal((await idx.search({ keyword: '占位符' })).total, 0);
      // Persist + reload keeps the index.
      await idx.persist();
      const idx2 = new LocalSearchIndex(libDir, libDir, backend);
      await idx2.load();
      assert.equal(idx2.getStatus(), 'ready');
      assert.equal((await idx2.search({ keyword: '葡萄' })).total, 1);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): diagnostics finds empty, duplicates, broken refs, orphans', async () => {
      const libDir = path.join(scratch, 'index-diag-lib');
      await fs.mkdir(path.join(libDir, 'assets'), { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-diag-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'empty.md'), '');
      await fs.writeFile(path.join(libDir, 'dup1.md'), '# Same\n\n重复内容。\n');
      await fs.writeFile(path.join(libDir, 'dup2.md'), '# Same\n\n重复内容。\n');
      await fs.writeFile(path.join(libDir, 'broken.md'), '# B\n\n![gone](assets/gone.png)\n![[assets/also-gone.png]]\n');
      await fs.writeFile(path.join(libDir, 'assets', 'orphan.png'), smallPng);
      // Orphan must be older than the 24h retention: backdate it.
      const old = new Date(Date.now() - 25 * 3600 * 1000);
      await fs.utimes(path.join(libDir, 'assets', 'orphan.png'), old, old);
      await fs.writeFile(path.join(libDir, 'assets', 'used.png'), smallPng);
      await fs.writeFile(path.join(libDir, 'uses.md'), '# U\n\n![used](assets/used.png)\n');
      const diag = await idx.scanDiagnostics();
      assert.deepEqual(diag.emptyFiles, ['empty.md']);
      assert.equal(diag.duplicateGroups.length, 1);
      assert.deepEqual(diag.duplicateGroups[0].sort(), ['dup1.md', 'dup2.md']);
      assert.deepEqual(
        diag.brokenImageRefs.map((r) => `${r.file}:${r.src}`).sort(),
        ['broken.md:assets/also-gone.png', 'broken.md:assets/gone.png'],
      );
      assert.deepEqual(diag.orphanCandidates, ['assets/orphan.png']);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): __proto__ term does not pollute Object.prototype', async () => {
      const libDir = path.join(scratch, 'index-proto-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-proto-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'proto.md'), '# Notes\n\n__proto__ constructor prototype pollution test.\n');
      await idx.buildAll();
      assert.equal(idx.getStatus(), 'ready');
      // The old code wrote the per-chunk map into Object.prototype
      // itself, so every fresh object gained a stray '0' key.
      assert.equal(Object.prototype.hasOwnProperty('0'), false);
      assert.equal(({})['0'], undefined);
      assert.equal((await idx.search({ keyword: '__proto__' })).total, 1);
      assert.equal((await idx.search({ keyword: 'constructor' })).total, 1);
      // And the term survives a persist + reload.
      await idx.persist();
      const idx2 = new LocalSearchIndex(libDir, libDir, backend);
      await idx2.load();
      assert.equal(idx2.getStatus(), 'ready');
      assert.equal((await idx2.search({ keyword: 'constructor' })).total, 1);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): filename substring search; single-char noise', async () => {
      const libDir = path.join(scratch, 'index-names-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-names-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'memdrive-notes.md'), '# Notes\n\nSome content here.\n');
      await fs.writeFile(path.join(libDir, 'shot.png'), smallPng);
      await fs.writeFile(path.join(libDir, 'a.md'), '用户开户流程。\n');
      await fs.writeFile(path.join(libDir, 'b.md'), '存款证明材料。\n');
      await fs.writeFile(path.join(libDir, 'c.md'), '户\n');
      await idx.buildAll();
      // Substring of a filename finds the file even when the
      // content does not contain it (0.7.0 behavior).
      const memdr = await idx.search({ keyword: 'memdr' });
      assert.ok(memdr.hits.some((h) => h.path === 'memdrive-notes.md'));
      const shot = await idx.search({ keyword: 'shot' });
      assert.ok(shot.hits.some((h) => h.path === 'shot.png'));
      // A multi-character Chinese query does not match a note that
      // only holds one of its characters.
      const noise = await idx.search({ keyword: '用户存款' });
      assert.ok(!noise.hits.some((h) => h.path === 'c.md'));
      assert.ok(noise.hits.some((h) => h.path === 'a.md'));
      assert.ok(noise.hits.some((h) => h.path === 'b.md'));
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): CJK query split into single chars finds the word, not the particles', async () => {
      const libDir = path.join(scratch, 'index-cjk-noise-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-cjk-noise-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'a.md'), '# A\n\n他说了很多话。\n');
      await fs.writeFile(path.join(libDir, 'b.md'), '# B\n\n今天了解了全文检索的用法。\n');
      await fs.writeFile(path.join(libDir, 'c.md'), '# C\n\n我们有了新的想法。\n');
      await idx.buildAll();
      // 说了 segments into 说 / 了 on this runtime: before the fix
      // the OR over particles hit all three notes.
      const said = await idx.search({ keyword: '说了' });
      assert.deepEqual(said.hits.map((h) => h.path), ['a.md']);
      const saw = await idx.search({ keyword: '看了' });
      assert.equal(saw.total, 0);
      // A one-character query still searches the character itself.
      const le = await idx.search({ keyword: '了' });
      assert.ok(le.total >= 2);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): one hit per file; highlight survives long slices', async () => {
      const libDir = path.join(scratch, 'index-dedup-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-dedup-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      let long = '# 长笔记\n\n';
      for (let i = 0; i < 30; i++) {
        long += `第${i}段检索内容，重复出现的检索词。\n\n`;
      }
      await fs.writeFile(path.join(libDir, 'long.md'), long);
      await fs.writeFile(path.join(libDir, 'short.md'), '检索一次。\n');
      await idx.buildAll();
      const res = await idx.search({ keyword: '检索' });
      assert.equal(res.total, 2, 'total counts files, not chunks');
      assert.equal(res.hits.filter((h) => h.path === 'long.md').length, 1);
      // Highlight: many `……` before the match used to collapse the
      // snippet to a bare `…`.
      const longSlice = '……'.repeat(100) + '这里是匹配词出现的位置，后面还有一些文字内容。';
      const snippet = highlightSnippet(longSlice, ['匹配词'], '匹配词');
      assert.ok(snippet.includes('**匹配词**'), snippet);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): date bounds cover the whole day; bad dates fail', async () => {
      const libDir = path.join(scratch, 'index-dates-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-dates-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'dated.md'), '---\ndate: 2026-11-08T15:30:00Z\n---\n\ndated content here.\n');
      await idx.buildAll();
      // dateTo on the same day includes a note dated that afternoon.
      const same = await idx.search({ keyword: 'dated', dateTo: '2026-11-08' });
      assert.equal(same.total, 1);
      const before = await idx.search({ keyword: 'dated', dateTo: '2026-11-07' });
      assert.equal(before.total, 0);
      // An unparseable date is an error, not a silently ignored filter.
      await assert.rejects(idx.search({ keyword: 'dated', dateFrom: 'garbage' }), /Invalid date/);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): damaged index file rebuilds instead of failing every search', async () => {
      const libDir = path.join(scratch, 'index-corrupt-lib');
      await fs.mkdir(libDir, { recursive: true });
      const cacheDir = path.join(scratch, 'index-corrupt-cache');
      process.env['MEMDRIVE_CACHE_DIR'] = cacheDir;
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'note.md'), 'hello corrupt world\n');
      await idx.buildAll();
      assert.equal(idx.getStatus(), 'ready');
      // Corrupt the persisted index: parses, but has no files/postings.
      const dir = resolveIndexCacheDir(libDir);
      await fs.writeFile(path.join(dir, 'index.json'), '{"version":2,"chunks":[]}');
      const idx2 = new LocalSearchIndex(libDir, libDir, backend);
      await idx2.load();
      assert.equal(idx2.getStatus(), 'unbuilt');
      const res = await idx2.search({ keyword: 'hello' });
      assert.equal(res.ready, false);
      // Rebuild (the handler triggers it on an unbuilt index).
      await idx2.ensureReady();
      assert.equal(idx2.getStatus(), 'ready');
      assert.equal((await idx2.search({ keyword: 'hello' })).total, 1);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): oversized .log is indexed by filename only', async () => {
      const libDir = path.join(scratch, 'index-biglog-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-biglog-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      const line = 'ERROR 2026-11-08 something happened in the system log line\n';
      await fs.writeFile(path.join(libDir, 'app.log'), line.repeat(40000));
      await fs.writeFile(path.join(libDir, 'note.md'), 'small note\n');
      const t0 = Date.now();
      await idx.buildAll();
      const took = Date.now() - t0;
      assert.ok(took < 10000, `build took ${took} ms`);
      // Content words from the log are NOT indexed; the filename is.
      assert.equal((await idx.search({ keyword: 'something' })).total, 0);
      const byName = await idx.search({ keyword: 'app' });
      assert.ok(byName.hits.some((h) => h.path === 'app.log'));
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): bulk refresh stays incremental and correct', async () => {
      const libDir = path.join(scratch, 'index-bulk-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-bulk-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      const vocab = [];
      for (let i = 0; i < 200; i++) vocab.push(`word${i}`);
      for (let n = 0; n < 200; n++) {
        const words = [];
        for (let w = 0; w < 20; w++) words.push(vocab[(n + w) % vocab.length]);
        const extra = n === 100 ? ' onlyinnote100' : '';
        await fs.writeFile(path.join(libDir, `note-${n}.md`), `# Note ${n}\n${words.join(' ')}${extra}\n`);
      }
      await idx.buildAll();
      for (let n = 0; n < 50; n++) {
        await fs.writeFile(path.join(libDir, `note-${n}.md`), `# Note ${n} updated\nchanged content uniqueword${n}\n`);
      }
      await fs.unlink(path.join(libDir, 'note-100.md'));
      const t0 = Date.now();
      await idx.refreshIfNeeded(Date.now() + 60_000);
      const took = Date.now() - t0;
      assert.ok(took < 10000, `refresh took ${took} ms`);
      assert.equal((await idx.search({ keyword: 'changed' })).total, 50);
      assert.equal((await idx.search({ keyword: 'uniqueword7' })).total, 1);
      assert.equal((await idx.search({ keyword: 'onlyinnote100' })).total, 0);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): mtime-only change does not re-index', async () => {
      const libDir = path.join(scratch, 'index-mtime-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-mtime-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'one.md'), '# One\n\n苹果香蕉。\n');
      await idx.buildAll();
      // Touch the mtime only (sync tools do this): content is
      // identical, so the file must stay searchable as before.
      const future = new Date(Date.now() + 3600 * 1000);
      await fs.utimes(path.join(libDir, 'one.md'), future, future);
      await idx.refreshIfNeeded(Date.now() + 60_000);
      assert.equal((await idx.search({ keyword: '苹果' })).total, 1);
      assert.equal((await idx.search({ keyword: '香蕉' })).total, 1);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): diagnostics resolves Obsidian embeds vault-wide, ignores outside symlinks', async () => {
      const libDir = path.join(scratch, 'index-diag2-lib');
      await fs.mkdir(path.join(libDir, 'attachments'), { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-diag2-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'pic-note.md'), '# P\n\nsee ![[pic.png]]\n');
      await fs.writeFile(path.join(libDir, 'attachments', 'pic.png'), smallPng);
      const old = new Date(Date.now() - 25 * 3600 * 1000);
      await fs.utimes(path.join(libDir, 'attachments', 'pic.png'), old, old);
      await fs.writeFile(path.join(libDir, 'dup1.md'), '# Same\n\n重复内容。\n');
      await fs.writeFile(path.join(libDir, 'dup2.md'), '# Same\n\n重复内容。\n');
      // Symlink to a directory outside the library, holding an old image.
      const outsideDir = path.join(scratch, 'index-diag2-outside');
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, 'private-photo.png'), smallPng);
      await fs.utimes(path.join(outsideDir, 'private-photo.png'), old, old);
      await fs.symlink(outsideDir, path.join(libDir, 'link'));
      await idx.buildAll();
      const diag = await idx.scanDiagnostics();
      // The Obsidian embed resolves vault-wide: not broken, not orphan.
      assert.deepEqual(diag.brokenImageRefs, []);
      assert.deepEqual(diag.orphanCandidates, []);
      // Duplicates are still found when the index is ready (hashes reused).
      assert.equal(diag.duplicateGroups.length, 1);
      assert.deepEqual(diag.duplicateGroups[0].sort(), ['dup1.md', 'dup2.md']);
      // The outside file never leaks into the report.
      assert.ok(!JSON.stringify(diag).includes('private-photo'));
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): diagnostics resolves path-style Obsidian embeds from the vault root; inline # paths stay literal', async () => {
      const libDir = path.join(scratch, 'index-diag3-lib');
      await fs.mkdir(path.join(libDir, 'notes/deep'), { recursive: true });
      await fs.mkdir(path.join(libDir, 'attachments'), { recursive: true });
      await fs.mkdir(path.join(libDir, 'notes/C#'), { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-diag3-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      // B: nested note, vault-root embed.
      await fs.writeFile(path.join(libDir, 'notes/deep/a.md'), '# A\n\n![[attachments/pic.png]]\n');
      await fs.writeFile(path.join(libDir, 'attachments/pic.png'), smallPng);
      // B (suffix): the embed names a path tail, not the full vault path.
      await fs.writeFile(path.join(libDir, 'notes/deep/b.md'), '# B\n\n![[deep/pic2.png]]\n');
      await fs.mkdir(path.join(libDir, 'assets/deep'), { recursive: true });
      await fs.writeFile(path.join(libDir, 'assets/deep/pic2.png'), smallPng);
      // C: inline ref to a literal `#` directory.
      await fs.writeFile(path.join(libDir, 'c.md'), '# C\n\n![x](notes/C#/pic.png)\n');
      await fs.writeFile(path.join(libDir, 'notes/C#/pic.png'), smallPng);
      const old = new Date(Date.now() - 25 * 3600 * 1000);
      for (const p of ['attachments/pic.png', 'assets/deep/pic2.png', 'notes/C#/pic.png']) {
        await fs.utimes(path.join(libDir, p), old, old);
      }
      await idx.buildAll();
      const diag = await idx.scanDiagnostics();
      assert.deepEqual(diag.brokenImageRefs, []);
      assert.deepEqual(diag.orphanCandidates, []);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): diagnostics never reads a dataless cloud file', async () => {
      const libDir = path.join(scratch, 'index-dataless-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-dataless-cache');
      // Simulate macOS: cloud.md and cloud-dup.md report as dataless
      // (on Linux the platform gate never triggers, so the check is
      // overridden here to exercise the skip itself).
      class DatalessIndex extends LocalSearchIndex {
        async isDatalessFile(relPath) {
          return relPath === 'cloud.md' || relPath === 'cloud-dup.md';
        }
      }
      const backend = new LocalStorageBackend(libDir);
      const idx = new DatalessIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'cloud.md'), '# Cloud\n\n![[missing.png]]\n\n重复内容。\n');
      await fs.writeFile(path.join(libDir, 'plain.md'), '# Plain\n\n重复内容。\n');
      await fs.writeFile(path.join(libDir, 'cloud-dup.md'), '# Plain\n\n重复内容。\n');
      await idx.buildAll();
      // Name-only indexing still works: the file is findable.
      const found = await idx.search({ keyword: 'cloud' });
      assert.ok(found.hits.some((h) => h.path === 'cloud.md'));
      const diag = await idx.scanDiagnostics();
      // Had diagnostics read cloud.md, its broken ref would show;
      // had it hashed cloud-dup.md, it would duplicate plain.md.
      assert.deepEqual(diag.brokenImageRefs, []);
      assert.deepEqual(diag.duplicateGroups, []);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 index (class): two instances building at once do not corrupt the shared index', async () => {
      const libDir = path.join(scratch, 'index-concurrent-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-concurrent-cache');
      await fs.writeFile(path.join(libDir, 'a.md'), '# A\n\n全文检索测试。\n');
      await fs.writeFile(path.join(libDir, 'b.md'), '# B\n\n另一篇笔记。\n');
      const idx1 = new LocalSearchIndex(libDir, libDir, new LocalStorageBackend(libDir));
      const idx2 = new LocalSearchIndex(libDir, libDir, new LocalStorageBackend(libDir));
      const [r1, r2] = await Promise.all([idx1.buildAll(), idx2.buildAll()]);
      assert.ok(r1 || r2, 'at least one build wins the lock');
      // The persisted index loads cleanly afterwards.
      const idx3 = new LocalSearchIndex(libDir, libDir, new LocalStorageBackend(libDir));
      await idx3.load();
      assert.equal(idx3.getStatus(), 'ready');
      assert.ok((await idx3.search({ keyword: '全文检索' })).hits.some((h) => h.path === 'a.md'));
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 search_files (handler): fallback applies file types and says what it ignores; diagnostics needs no keyword', async () => {
      const libDir = path.join(scratch, 'index-fallback-lib');
      await fs.mkdir(libDir, { recursive: true });
      process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'index-fallback-cache');
      const backend = new LocalStorageBackend(libDir);
      const idx = new LocalSearchIndex(libDir, libDir, backend);
      await fs.writeFile(path.join(libDir, 'a.md'), '全文检索 in markdown.\n');
      await fs.writeFile(path.join(libDir, 'b.txt'), '全文检索 in text.\n');
      // The real server resolves the root with fs.realpath at startup
      // (src/index.ts); the test must do the same. On macOS os.tmpdir()
      // is /var/folders/... while /var is a symlink to /private/var, so
      // the unresolved libDir fails the sandbox's realpath check with
      // "Path escapes the MemDrive root through a symlink" (CI: macOS
      // only, 124/125). This mirrors the server, it does not weaken it.
      const ctx = { backend, rootDir: libDir, rootRealDir: await fs.realpath(libDir), searchIndex: idx };
      // Index never built: every search falls back to a direct scan.
      const res = await handleSearchFiles(ctx, '全文检索', '', {
        fileTypes: ['.md'],
        tags: ['工作'],
        exactPhrase: '全文检索',
        limit: 20,
        offset: 0,
      });
      const text = textOf(res);
      assert.match(text, /direct scan/);
      assert.match(text, /a\.md/);
      assert.doesNotMatch(text, /b\.txt/);
      assert.match(text, /NOT applied/);
      // diagnostics_only works without a keyword.
      const diag = await handleSearchFiles(ctx, '', '', { diagnosticsOnly: true });
      assert.match(textOf(diag), /Library diagnostics/);
      delete process.env['MEMDRIVE_CACHE_DIR'];
    });

    await check('0.8.0 search_files (MCP): Chinese keyword, filters, pagination, diagnostics_only', async () => {
      await call('save_file', {
        path: 'search8/a.md',
        content: '---\ntags: [工作]\ndate: 2026-03-10\n---\n# 全文检索实测\n\n全文检索 全文检索。记忆库的检索速度很快。\n',
        mode: 'new',
      });
      await call('save_file', {
        path: 'search8/b.md',
        content: '# 随手记\n\n今天只提了一次全文检索。\n',
        mode: 'new',
      });
      await call('save_file', {
        path: 'search8/c.txt',
        content: '全文检索在纯文本里。\n',
        mode: 'new',
      });
      const res = await call('search_files', { keyword: '全文检索', rebuild_index: true });
      assert.equal(res.isError, undefined, textOf(res));
      assert.match(textOf(res), /search8\/a\.md/);
      assert.match(textOf(res), /\*\*全文检索\*\*/);
      const tagged = await call('search_files', { keyword: '全文检索', tags: ['工作'] });
      assert.match(textOf(tagged), /search8\/a\.md/);
      assert.doesNotMatch(textOf(tagged), /search8\/b\.md/);
      const mdOnly = await call('search_files', { keyword: '全文检索', file_types: ['.md'] });
      assert.doesNotMatch(textOf(mdOnly), /search8\/c\.txt/);
      const phrase = await call('search_files', { keyword: '检索', exact_phrase: '检索速度很快' });
      assert.match(textOf(phrase), /search8\/a\.md/);
      assert.doesNotMatch(textOf(phrase), /search8\/b\.md/);
      const page = await call('search_files', { keyword: '全文检索', limit: 1, offset: 0 });
      assert.match(textOf(page), /showing 1–1/);
      assert.match(textOf(page), /More results available/);
      const diag = await call('search_files', { keyword: 'x', diagnostics_only: true });
      assert.equal(diag.isError, undefined, textOf(diag));
      assert.match(textOf(diag), /Library diagnostics \(read-only/);
      assert.match(textOf(diag), /Empty files/);
    });

    await check('0.8.0 search_files (MCP): save then search without rebuild; synced-in names still read', async () => {
      await call('save_file', {
        path: 'search8/d.md',
        content: '# 新笔记\n\n现搜现得的内容。\n',
        mode: 'new',
      });
      // No rebuild_index: the save must make the note searchable at once.
      const res = await call('search_files', { keyword: '现搜现得' });
      assert.match(textOf(res), /search8\/d\.md/);
      // Files synced in under cross-platform-unfriendly names still read.
      await fs.writeFile(path.join(root, 'meeting 10:30.md'), '# Meeting\n\ncolon name.\n');
      await fs.writeFile(path.join(root, 'aux.notes.md'), '# Aux\n\nreserved name.\n');
      const colon = await call('read_file', { path: 'meeting 10:30.md' });
      assert.equal(colon.isError, undefined, textOf(colon));
      assert.match(textOf(colon), /colon name/);
      const aux = await call('read_file', { path: 'aux.notes.md' });
      assert.equal(aux.isError, undefined, textOf(aux));
      // ... and saving under such a name is still refused (write check stays).
      const bad = await call('save_file', { path: 'meeting 10:31.md', content: 'x', mode: 'new' });
      assert.equal(bad.isError, true);
      // diagnostics_only works without a keyword.
      const diagNoKw = await call('search_files', { diagnostics_only: true });
      assert.equal(diagNoKw.isError, undefined, textOf(diagNoKw));
      assert.match(textOf(diagNoKw), /Library diagnostics \(read-only/);
    });

  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    httpServer.close();
    if (process.env['MEMDRIVE_TEST_KEEP'] !== '1') {
      await fs.rm(scratch, { recursive: true, force: true });
    } else {
      console.log(`Scratch kept at: ${scratch}`);
    }
  }

  console.log(`\n${results.length - failures}/${results.length} checks passed.`);
  if (serverStderr.trim().length > 0) {
    console.log('--- server stderr ---');
    console.log(serverStderr);
  }
  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Test harness crashed:', error);
  process.exit(2);
});
