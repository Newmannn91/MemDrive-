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

import { resolveResponseBudgetBytes } from '../dist/config.js';
import {
  backupPathFor,
  claudeDesktopAdapter,
  cursorAdapter,
  HOST_ADAPTERS,
  hostAdapterForId,
  mergeConfigJson,
  parseHostArgument,
  vscodeAdapter,
  writeHostConfig,
} from '../dist/host-config.js';
import { folderCommandFor, viewerCommandFor } from '../dist/viewer.js';
import { resolveContainingFolder } from '../dist/tools.js';
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
  await fs.writeFile(path.join(outside, 'secret.txt'), 'TOP-SECRET-OUTSIDE-ROOT\n');

  let serverStderr = '';
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, MEMDRIVE_ROOT: root },
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

    await check('save_file with URL image downloads + archives', async () => {
      const res = await call('save_file', {
        path: 'notes/from-url.md',
        content: '# From URL',
        images: [`http://127.0.0.1:${urlPort}/shot.png`],
      });
      assert.equal(res.isError, undefined, textOf(res));
      const doc = await fs.readFile(path.join(root, 'notes/from-url.md'), 'utf8');
      assert.match(doc, /!\[shot\]\(assets\/from-url-.*\.png\)/);
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
      const byName = await call('search_files', { keyword: 'with-photo' });
      assert.match(textOf(byName), /with-photo\.md \(name\)/);
      const byContent = await call('search_files', { keyword: 'replaced+more' });
      assert.match(textOf(byContent), /note\.md \(content\)/);
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
      // command line, so it cannot inject a second command.
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
        ['claude-desktop', 'cursor', 'vscode'],
      );
      assert.equal(hostAdapterForId('cursor'), cursorAdapter);
      assert.equal(hostAdapterForId('claude-desktop'), claudeDesktopAdapter);
      assert.equal(hostAdapterForId('vscode'), vscodeAdapter);
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
