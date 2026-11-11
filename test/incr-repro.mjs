// Instrumented reproduction for the 0.8.3 incremental-refresh flake
// (CI #10: `incremental refresh picks up add/change/delete` failed
// 1/100 with `0 !== 1`). Runs the same scenario in a loop and, on a
// miss, dumps what the refresh saw (mtime/size/hash before and after
// the change) so the trigger can be identified.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const { LocalSearchIndex } = await import('../dist/search-index.js');
const { LocalStorageBackend } = await import('../dist/storage.js');

const ITERATIONS = Number(process.argv[2] ?? 200);
let failures = 0;

for (let i = 0; i < ITERATIONS; i += 1) {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'memdrive-incr-repro-'));
  const libDir = path.join(scratch, 'lib');
  await fs.mkdir(libDir, { recursive: true });
  process.env['MEMDRIVE_CACHE_DIR'] = path.join(scratch, 'cache');
  const backend = new LocalStorageBackend(libDir);
  const idx = new LocalSearchIndex(libDir, libDir, backend);
  try {
    await fs.writeFile(path.join(libDir, 'one.md'), '# One\n\n苹果香蕉。\n');
    await idx.buildAll();
    const before = await fs.stat(path.join(libDir, 'one.md'));
    await fs.writeFile(path.join(libDir, 'two.md'), '# Two\n\n苹果橙子。\n');
    await idx.refreshIfNeeded(Date.now() + 60_000);
    const t2a = (await idx.search({ keyword: '苹果' })).total;
    await fs.writeFile(path.join(libDir, 'one.md'), '# One\n\n葡萄西瓜。\n');
    const after = await fs.stat(path.join(libDir, 'one.md'));
    await idx.refreshIfNeeded(Date.now() + 120_000);
    const tApple = (await idx.search({ keyword: '苹果' })).total;
    const tGrape = (await idx.search({ keyword: '葡萄' })).total;
    if (t2a !== 2 || tApple !== 1 || tGrape !== 1) {
      failures += 1;
      const entry = idx.data?.files?.['one.md'];
      console.log(`ITER ${i} MISS: after-add 苹果=${t2a} (want 2), after-change 苹果=${tApple} (want 1), 葡萄=${tGrape} (want 1)`);
      console.log(`  one.md before-change: mtimeMs=${before.mtimeMs} size=${before.size}`);
      console.log(`  one.md after-change:  mtimeMs=${after.mtimeMs} size=${after.size} (int ms equal: ${Math.floor(before.mtimeMs) === Math.floor(after.mtimeMs)})`);
      console.log(`  index entry for one.md: mtimeMs=${entry?.mtimeMs} size=${entry?.size} hash=${entry?.hash} date=${entry?.date}`);
      console.log(`  on-disk content now: ${JSON.stringify(await fs.readFile(path.join(libDir, 'one.md'), 'utf8'))}`);
      console.log(`  on-disk hash now: ${crypto.createHash('sha256').update(await fs.readFile(path.join(libDir, 'one.md'))).digest('hex')}`);
    }
  } finally {
    delete process.env['MEMDRIVE_CACHE_DIR'];
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
console.log(`done: ${ITERATIONS} iterations, ${failures} failures`);
