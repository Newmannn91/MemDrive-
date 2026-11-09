# Changelog

All notable changes to MemDrive (`memdrive-mcp`) are documented here,
newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project
is pre-1.0 and was published to npm as of 0.5.2 (2026-10-30);
earlier versions were delivered as zips and verified by the
protocol suite (see TEST-REPORT.md). Each section below maps
to a GitHub Release.

## [0.8.1] - 2026-11-09

Follow-up to the 0.8.0 search engine: three deferred review items (E, F, G). No new features; the search contract is unchanged.

### Fixed

- **E — slow index load (measured, not guessed).** `load()` on a 10k-note library took ~3.3 s (46 MB index, same corpus and method as the 0.8.0 benchmark); the breakdown was read ~0.1 s, `JSON.parse` ~0.25 s, deep validation ~0.05 s, and the null-prototype map rebuild ~0.5 s — the rebuild, not the validation, was the cost. `load()` now converts only the two top-level maps with one `Object.assign` each (~17 ms) and leaves each per-chunk map as parsed: its keys are chunk-id numbers only, so they can never be `__proto__` (the `__proto__`-term test still passes). Fresh load is now ~1.7 s on the same 46 MB corpus (~0.6 s on a 28 MB corpus), roughly half. The validation cross-checks added later in 0.8.1 cost ~0.2 s on a 10k-note library (reviewer's measurement: 1.17 s → 1.42 s; the ranges overlap, so part of it may be noise). Deliberately NOT done: splitting the index into multiple files — measured, it does not speed up loading (search needs all postings parsed anyway) and adds a cross-file atomicity problem; a compact postings format is a possible later optimization.
- **F — multi-process lock behavior.** A second process starting while the first is building no longer loads the index the builder is about to replace (`load()` skips when a fresh lock is held); `ensureReady()` picks up the finished index afterwards instead of staying on the direct-scan fallback. `rebuild_index` while another process holds the lock now says so in the result instead of silently searching the old index. Stale locks (older than the 30 s timeout, e.g. a crashed process) are still stolen. Covered by real two-process tests (the 0.8.0 test only ran two instances in one process). Sonnet round 1 added F1/F2 on top (see below).
- **G — chunk overshoot.** A near-cap paragraph after a wide blank gap used to emit a chunk over the 600-char cap (639 chars for a 50-line gap, 1,589 for a 1,000-line gap: the gap counted toward the slice because the next chunk re-opened at the previous paragraph's end). When the gap forces zero overlap, the next chunk now starts at the paragraph's start — the blank gap carries no searchable text, so skipping it loses nothing. All chunks are within the cap; the review round's 310-note comparison found ~2% of chunk boundaries move, every chunk remaining an exact slice.
- **F1 — rebuild result is specific (Sonnet round 1).** `buildAll()` used to return a boolean, so `rebuild_index` could not tell "the lock is held" from "the rebuild itself failed" — both showed "another MemDrive process is building the index", including the common case where the lock is held by this process's own background build after a restart. It now returns `'built' | 'locked' | 'failed'`; the result text says "being built (by another MemDrive process or a background build)" for `'locked'` and "rebuild failed" for `'failed'` (a failed rebuild is also logged to the server log). A failed write still leaves a usable in-memory index (`ready`) — only persistence failed.
- **F2 — `load()` never downgrades the status (Sonnet round 1).** The skip and failure paths used to set the status to `unbuilt` unconditionally, which would have clobbered a `building` status if `load()` were ever called mid-build. It now leaves the status exactly as it was; callers only invoke it while `unbuilt`, so in practice a failure still leaves it `unbuilt`.
- **Auto-heal regression (Sonnet round 2 — 0.8.1's `ensureReady` broke it).** A corrupt index that still validates (e.g. a torn write leaving non-string `fileNames`) used to self-heal in 0.8.0: `search()` threw, dropped to `unbuilt`, and `ensureReady()` rebuilt. The 0.8.1 load-first `ensureReady()` instead reloaded the same damaged index on every search, so searches fell back to direct scan forever (and re-read the ~37 MB index each time). Fix: the index remembers that its disk copy is distrusted — `search()`'s catch sets `distrustDisk`, `ensureReady()` skips both `load()` calls while it is set and rebuilds straight away, and a successful `buildAll()` clears it. Covered by a test that corrupts `fileNames` to `[123]` and requires search to recover to the index within 3 attempts.
- **Index validation cross-checks (pulled forward from 0.8.2).** `isValidIndex` used to check shapes only, so a structurally valid but referentially broken index loaded fine and search silently skipped the broken parts — a missed hit with no error, and refresh never repaired it (it only updates changed files). It now also requires: every `fileNames` element is a string (search calls `path.basename` on each), every chunk's `file` exists in `files`, every file's `chunkIds` all exist, every posting key points at a real chunk, and chunk ids are unique. All of these are invariants the writer already guarantees, so a file failing one is damaged and gets rejected → rebuilt. The check is O(n) over the parsed index and adds negligible time to `load()`.
- **Empty-library write failure (Sonnet round 2, low).** The failed-build status used to key on `totalChunks > 0`, so an empty library plus a write failure reported `unbuilt` even though the swapped-in (empty) index was complete. `buildAll()` now tracks whether `this.data = next` already ran and reports `ready` in that case.
- **Failed-rebuild copy (Sonnet round 2, low).** The note said "the index could not be rebuilt"; on a write failure the index *was* rebuilt in memory, it just could not be saved — the note now says "could not be saved to disk".
- **Known limit (Sonnet round 2):** the build lock has no heartbeat — a build running longer than the 30 s staleness timeout can have its lock stolen by another process. A 10k-note build takes 5–9 s; this only matters at ~100k-note scale, where the lock needs a heartbeat (periodic timestamp refresh).

### Notes

- H (the 5 s stale-snippet window) is unchanged: a disclosed design trade-off, not a bug.

## [0.8.0] - 2026-11-08

Search engine: a full-text index with BM25 ranking replaces the
single-keyword substring scan. Chinese queries are segmented, results
are ranked chunks with snippets, and the library gains filters,
pagination, and a read-only diagnostics report.

### Added

- Full-text search index (`src/search-index.ts`, `SearchIndex`
  interface + `LocalSearchIndex`): pure-JS inverted index, zero
  native deps; persisted as one JSON file OUTSIDE the library
  (system cache dir, subdir named by the first 16 hex chars of the
  SHA-256 of the library's real path — `MEMDRIVE_CACHE_DIR`
  overrides the base), so sync drives never corrupt it and
  list/search never see it as a note. Format version 2; a mismatch
  or a damaged structure triggers a rebuild.
- Chinese tokenization: Node `Intl.Segmenter('zh')` (word
  granularity) + character bigram + single-char fallback, so 1–2
  character queries hit; NFKC normalization of queries and
  filenames (macOS filenames are NFD). A regex fallback covers
  runtimes without `Intl.Segmenter`.
- Chunk-based index: heading/paragraph chunks, 600-char cap,
  100-char overlap, exact `[startOffset, endOffset]` per chunk and
  a section heading, so a future vector search needs no rework.
- Ranking: Okapi BM25 (k1 = 1.2, b = 0.75) fused with a
  filename-match ranking via reciprocal rank fusion (RRF, k = 60).
  The filename's tokens are indexed on the file's first chunk, so a
  file is findable by name even when its content never mentions the
  keyword (the 0.7.0 search matched by name OR content; the index
  keeps both). Empty files get one synthetic chunk carrying only
  their filename tokens.
- `search_files` gains `file_types`, `tags` (YAML front matter
  `tags:` or body `#tag`, case-insensitive, `#a/b` kept whole),
  `date_from`/`date_to` (file date: front matter > filename >
  modification time; a date-only upper bound covers the whole day),
  `modified_after`/`modified_before`, `exact_phrase`, `limit`/
  `offset` pagination, `rebuild_index`, and `diagnostics_only`.
  Results are one hit per matching file (its best chunk) with the
  file path, section, relevance score, and a snippet with the
  matched term highlighted as `**term**`; a substring of a filename
  still finds the file, including non-text files such as images
  (the 0.7.0 name search). `keyword` is now optional when
  `diagnostics_only` is set. Output is capped by
  `MEMDRIVE_SEARCH_MAX_BYTES` (default 80,000 bytes, clamped to
  1,000–50,000,000); the output is fitted to the cap hit by hit, so
  the "More results" line and the next page's offset are never cut
  off or skipped by truncation. `keyword` + `path` keep the 0.7.0
  calling format, but results are ranked files, not the 0.7.0
  name/content list — see Changed below.
- Background incremental indexing: the index builds in the
  background on first use (yielding the event loop); searches fall
  back to a direct scan (0.7.0 behavior) until it is ready. A light
  stat scan refreshes the index incrementally — mtime+size first,
  SHA-256 hash only on mismatch — throttled to at most once per
  5 seconds, and it runs in the background so a query does not wait
  for it; a save (`save_file`) marks its file dirty, so the next
  search refreshes before answering and the new note is searchable
  at once. When more than 5% of files (or 200) changed, a full
  rebuild replaces the incremental update — it is faster. Files
  over the content cap (`MEMDRIVE_INDEX_MAX_BYTES`, default 1 MB,
  clamped to 1 KB–50 MB) and `.log`/`.csv`/`.json` files are indexed
  by filename only and never read in full. iCloud placeholder files
  (`.icloud`) are skipped, never read; on macOS a dataless file
  (`stat.blocks === 0 && size > 0`) is skipped the same way.
  OneDrive placeholders on Windows carry no detectable marker, so
  indexing there can still trigger a download — documented, not
  claimed otherwise.
- Single-writer lock: the index file is written under a lock file
  (`index.lock`, 30 s staleness timeout, stale locks are stolen);
  a full rebuild holds the lock for the whole build, and when
  another process holds the lock the write is skipped and the
  in-memory index keeps serving, so several MCP clients sharing one
  library never corrupt the index.
- Read-only diagnostics (`diagnostics_only`, also the
  `scanDiagnostics` core): empty files, duplicate groups (SHA-256),
  broken Markdown image references, and unreferenced attachment
  candidates older than 24 h. Candidates only; nothing is modified.
  Hashes come from the index when the recorded mtime/size still
  match, so a scan does not re-read (and re-hash) the whole
  library. Obsidian embeds resolve by filename across the whole
  library, as Obsidian does; the orphan walk cannot escape the
  library through a symlink.
- Markdown image references (`src/images.ts`): Obsidian embeds
  (`![[img.png]]`, `![[folder/img.png|alt]]`) and reference-style
  (`![alt][id]` + `[id]: src`, including collapsed `![id][]` and
  definitions with a title) are now found, alongside the 0.7.0
  inline and `<img>` forms. Obsidian embeds of notes and PDFs
  (`![[Meeting Notes]]`, `![[spec.pdf]]`) are not image references,
  and a `#fragment` in an embed is not part of the on-disk path.
- Cross-platform path validation (`src/sandbox.ts`):
  `validateCrossPlatformSegments` rejects Windows reserved device
  names (`CON`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, ignoring the
  extension), NTFS alternate-data-stream segments (`a.md:$DATA`),
  segments ending in a dot or space, and UNC paths; a leading
  Windows drive letter is allowed. The check runs on WRITES only
  (`save_file`): reads keep 0.7.0 behavior, so a file synced in as
  `meeting 10:30.md` or `aux.notes.md` still opens. `isInside` now
  compares NFKC-normalized, lowercased paths on macOS/Windows
  (case-insensitive filesystems), exact on Linux.

### Fixed

Review round on the 0.8.0 package (2026-11-08, Sonnet; every
finding verified against the code and by live reproduction before
fixing):

- `__proto__` as an indexed term polluted `Object.prototype`
  (postings/files maps are now null-prototype objects; a damaged
  index file no longer loads as `ready` and then fails every
  search — it rebuilds, and a failed search falls back to a direct
  scan and triggers a rebuild).
- Bulk updates were slower than a full rebuild (removal scanned the
  whole postings map and chunk ids were found by a full scan each
  time): each file now records its own terms, chunk ids come from a
  counter, and the refresh yields between files; a 500-file change
  in 5,000 notes now rebuilds in ~4 s instead of stalling for
  ~15 s, and a 100-file change refreshes incrementally in ~1 s.
- A 60 MB `.log` blocked the server for ~12 s and wrote a 31 MB
  index (now 31 ms, 714 bytes: filename only).
- `save_file` did not tell the index (a new note was unsearchable
  for up to 5 s); query-time refresh no longer blocks on the stat
  scan, and the direct-scan fallback now applies the file-type
  filter and pagination and says which filters it did not apply.
- Long-note results flooded the page and `total` counted chunks;
  search results are now one hit per file and `total` counts files.
- Snippet highlighting measured offsets on the NFKC-normalized
  string and sliced the original with them, sometimes leaving only
  `…` as the snippet; offsets are now measured on the original.
- Date filters: a date-only upper bound now covers the whole day,
  and an unparseable date is an error instead of a silently ignored
  filter. Tags: block lists no longer yield a bogus `- alpha` tag,
  matching is case-insensitive, `#a/b` stays whole.
- Search no longer loses the 0.7.0 filename-substring behavior
  (`memdr` finds `memdrive-notes.md`, `shot` finds `shot.png`), and
  single-character terms only count when the query itself is one
  character.
- The chunk cap is now enforced for the common cases (blank lines
  between short paragraphs no longer push slices over 600 chars);
  one narrow case remains — a near-cap paragraph after a wide gap
  can exceed the cap by the length of the whitespace between the
  two paragraphs (usually a few chars; a 50-line gap produced a
  639-char slice, a 1,000-line gap a 1,589-char slice — see Notes).
- `diagnostics_only` no longer requires a `keyword` and now honors
  `path` as its scope.

Second review round on the fixed package (2026-11-08, Sonnet;
every finding verified against the code and by live reproduction
before fixing):

- Chinese queries the segmenter splits into single characters only
  (说了 -> 说 / 了) no longer match every note containing the
  particles: the query's CJK run must now appear verbatim in the
  chunk (an implicit exact phrase); queries that segment into a
  multi-character term are unchanged.
- Obsidian embeds with a path (`![[attachments/pic.png]]`) now
  resolve vault-root first, then note-relative, then by path
  suffix — a nested note no longer reports a vault-root file as
  a broken reference or an orphan.
- `#` / `?` are stripped only for Obsidian embeds (where `#` is an
  anchor); inline, `<img>`, and reference-style refs keep the
  literal path, as in 0.7.0 (`notes/C#/pic.png` no longer parses
  as `notes/C`).
- Diagnostics never reads a dataless cloud file (macOS): the walk
  marks such files and the scan skips them, so no iCloud/OneDrive
  download is triggered.

### Changed

- `search_files` results are ranked chunks, not the 0.7.0
  name/content file list. The direct-scan fallback (used while the
  index builds) still returns the 0.7.0 format.
- `User-Agent` for image downloads is now `memdrive-mcp/0.8.0`.

### Notes

- DNS rebinding guard (from 0.7.0, `src/net-guard.ts`):
  unchanged in 0.8.0. The download path already uses
  `node:http`/`node:https` with `agent: false` and a custom
  `lookup` (single resolution, every address validated, checked
  address = connected address); the 0.7.0 local-server test for it
  still passes. No `fetch` remains in `src/`.
- Performance (10,000 synthetic notes, this VM, three runs;
  benchmark vocabulary widened from 36 to ~300 words for the
  review round, so these numbers are not comparable with the
  pre-review ones): cold index ~13.2–14.6 s; hot query p50
  23–24 ms, p95 56–77 ms, p99 67–679 ms, max 70–874 ms (the tail
  varies run to run; a query landing while a background refresh
  walks the library can spike); incremental update of 10 changed
  files ~0.67–0.75 s (a 10-file refresh took ~5 s before the
  walk/remove/persist optimizations in the review round); heap
  ~295–450 MB, RSS ~750–800 MB after build. A fresh load() of the
  persisted index takes ~3.3 s at 10,000 notes (the review round
  added a full structural validation on load); the index file is
  ~46 MB (was ~29 MB before the review round, mostly the
  per-file term lists). Both grow with library size. See
  TEST-REPORT.md and `test/bench-search.mjs` (deterministic,
  seeded).
- Known limitations (deferred to 0.8.1): chunk slices can exceed
  the 600-char cap by the length of the whitespace between the
  two paragraphs when a near-cap paragraph follows a wide gap
  (overlap shrinks to 0 and the gap counts toward the slice;
  usually a few chars, but a 50-line gap produced a 639-char
  slice and a 1,000-line gap a 1,589-char slice); `rebuild_index`
  while another process holds
  the index lock silently does nothing; a second process that
  starts while the first is building keeps using the direct-scan
  fallback instead of loading the finished index.

## [0.7.0] - Unreleased

Foundation release, no new features. Security fixes, a Node floor
raise, CI, the permanent removal of WebDAV, image caps, and atomic
writes — plus fixes from a second Claude Desktop review of the full
source (2026-11-06). Not yet published.

### Added

- GitHub Actions CI (`.github/workflows/ci.yml`): 3 OS
  (windows-latest, ubuntu-latest, macos-latest) × Node 24 and 26;
  on push and pull_request runs `npm ci`, `npm run typecheck`,
  `npm run build`, `npm test`.
- `npm prepack` (`npm run build`), so published packages are always
  built from current source.

### Changed

- Node floor raised to 24: `engines >=24` in `package.json`;
  `setup.bat`, `setup.sh`, and `setup.command` all require Node 24
  or newer. Node 22 support ends 2027-04-30.
- The per-save image budget is now two counters
  (`src/images.ts`, `src/tools.ts`): a download-traffic counter
  (500 MB) and a stored-image budget (500 MB). A download stops at
  the lowest of the per-download ceiling (500 MB, unchanged), the
  remaining download traffic, and the remaining stored budget, so
  an image too large to store is aborted immediately instead of
  downloaded in full first; the stored budget is deducted only
  after a download completes and is confirmed to be an image, so a
  failed or non-image download no longer blocks later legitimate
  images. Either counter exhausted refuses further fetches without
  fetching; only the stored budget stops the image loop. Notes name
  which cap was hit, and the doubled `skipped:` prefix is gone.
- `save_file` image caps: at most 10 images per save; all images
  acquired in one save together at most 500 MB stored. The
  per-download ceiling (500 MB) is unchanged — no new per-image
  cap.
- Config and note writes share one atomic-write helper
  (`src/atomic.ts`): resolves symlinks, preserves permissions,
  refuses read-only targets, fsyncs, and retries Windows file
  locks (EPERM/EBUSY/EACCES, 5 attempts, 50–200 ms backoff).
  `writeFile` 'overwrite' now reports `created:false` for an
  existing file (previously always `created:true`).

### Fixed

- `search_files` symlink hole: the walk used to follow a symlink
  inside the root to a small outside text file and return its
  matching line as an excerpt. It now skips any entry whose real
  location escapes the root.
- Image URL download: explicit redirect limit of 5 (manual
  redirect handling); every fetch target must resolve to a public
  address. Loopback, private (RFC 1918 / ULA), link-local
  (including 169.254.169.254), and other non-routable ranges are
  refused before fetching. IPv6 now also blocks NAT64
  (64:ff9b::/96), 6to4 (2002::/16), site-local (fec0::/10), and
  Teredo (2001::/32); a literal IPv6 address is checked directly
  instead of going through DNS (Node's `URL.hostname` keeps the
  brackets, which `dns.lookup` cannot resolve).
- `save_file` no longer stores images through a symlinked
  `assets/` folder pointing outside the library: the assets folder
  is sandbox-checked first; on failure the images are refused with
  a note and the text still saves.
- Local image copy refuses non-regular files (`/dev/zero`, FIFOs,
  device nodes) instead of reading them until the process dies;
  a stat failure is reported directly instead of falling through
  to a misleading read error.
- Windows command injection in the viewer: `openInViewer` /
  `openFolderInViewer` refuse paths containing `& | < > ^ %` on
  win32 (cmd.exe re-parses the line), instead of launching.
  The launch mechanism itself is unchanged.
- Image refs with spaces or parentheses in the doc name:
  the ref is percent-encoded on write (`(`, `)` → `%28`, `%29`)
  and decoded on scan, so `read_file` finds the image again.
  Pre-existing notes with unencoded refs are unchanged.
- Overwrite no longer fails on long filenames: the shared
  atomic-write helper uses a short fixed temp name instead of
  appending ~30 characters to the target name.
- Orphaned atomic-write temp files (`.mdtmp-<hex>`, random 12-char hex suffix) are
  skipped by `listDirectory`, so they never appear as notes in
  listings or search.
- The setup wizard now prints the manual config snippet (plus a
  plain error) when updating a host config throws, instead of
  only `Setup stopped: ...`.
- DNS rebinding protection (`src/net-guard.ts`): image URL downloads
  now use `node:http`/`node:https` with `agent: false` and a custom
  `lookup` callback that resolves the hostname once, validates every
  resolved IP against the public-address policy, and connects only to
  that validated batch (supporting both `all: true` and single-address
  callback forms). Literal IPv4 and bracketed IPv6 hosts are validated
  before connecting.
- Magic-byte fallback in `read_file`, bundled Markdown reads,
  `open_image`, and `copyLocalImage`
  is restricted to extensionless files (`ext === ''`), and BMP/GIF
  magic-byte checks are tightened so text notes starting with `"BM"`
  or `"GIF8"` are never misidentified as images.
- `encodeImageSrc` preserves non-whitespace CJK characters for readable
  Markdown links while percent-encoding ASCII and non-ASCII whitespace
  (such as `\u3000`), BOM, control characters, and `#`, `?`, `%`,
  parentheses, `<`, `>`, `[`, `]`, quotes, backtick, and backslash.
- `save_file` in `new` mode checks whether the destination file already
  exists before acquiring or writing images, and URL download streaming
  caps `ceiling` at `min(URL_DOWNLOAD_MAX_BYTES, downloadRemainingBytes,
  storedRemainingBytes)`.

### Removed

- WebDAV, permanently, local-only: mentions deleted from
  `README.md`, `package.json` (description and keywords), and the
  header comments of `src/storage.ts` and `src/index.ts`.
  `CHANGELOG.md` and TEST-REPORT.md keep their historical mentions.

## [0.6.0] - 2026-10-31

### Added — UNVERIFIED on a real machine

- Claude Code adapter for the setup wizard (fourth host: menu
  item 4, `setup claude-code`). The wizard writes the
  user-scope entry — top-level `mcpServers` in the one
  `~/.claude.json` file (`%USERPROFILE%\.claude.json` on
  Windows, or inside `CLAUDE_CONFIG_DIR` when that variable
  is set) — with no `type` field (an entry without a `type`
  is read as a stdio server) and a 10,000,000-byte response
  budget in `env`. Local scope and project scope (`.mcp.json`)
  are deliberately not written. A missing `~/.claude.json`
  is never created: the wizard prints a ready-to-paste
  snippet instead, because the file is Claude Code's own
  main state file and creating a bare copy was never
  verified (B方案, user decision 2026-10-31).
- The adapter, the path rule, and the entry shape are taken
  from Anthropic's official docs only (checked 2026-10-31);
  no real-machine test was run, by the user's explicit
  decision. The 10,000,000 budget is an ESTIMATE, not a
  measurement (paid-product reasoning: a limit as stingy as
  Claude Desktop's would make no sense for paying users).
  If bundled reads fail or truncate in Claude Code, user
  reports are the feedback path for correcting the default.
  Claude Code's own output limits (default 25,000 tokens
  per tool result) apply on top of this server-side budget;
  see the README budget table.

### Changed

- Version 0.5.2 → 0.6.0 in `package.json` and `src/index.ts`
  `VERSION` only. No changes to the tools, sandbox, default
  budget (950,000), preview ladder, other adapters,
  dependencies, or tool descriptions.

## [0.5.2] - 2026-10-30

### Fixed

- `open_containing_folder` on Windows: the 0.5.1 launch
  (`explorer.exe` spawned directly, with `/n,` and the path as
  two separate arguments) is withdrawn — on the real machine
  it failed outright: `explorer.exe` exited with code 1 and
  opened no window, for both the library root and `notes/`,
  in Cursor and in Claude Desktop, confirmed by the user's
  own eyes (no popup in either host). The folder launch now
  goes through the shell again, as the image launch does:
  `cmd /c start "" explorer.exe /n,<path>`, with the switch
  and the path in ONE comma-joined argument. The direct
  explorer spawn and the two-argument form were both
  untested on Windows and both are gone; the VM suite only
  ever checked the command shape. `open_image` is unchanged.
  Whether this launch opens every folder (including
  `notes/assets`) as a visible new window is verified only
  by the user's real-machine test; the VM suite proves the
  command shape, not the window.

### Changed

- Version 0.5.1 → 0.5.2 in `package.json` and `src/index.ts`
  `VERSION` only; `package.json` description/keywords keep
  their WebDAV wording until publish time, per the spec.

## [0.5.1] - 2026-10-30

### Fixed

- `open_containing_folder` on Windows now opens the folder with
  `explorer.exe /n, <path>` (a new Explorer window every time)
  instead of `cmd /c start <path>`. Real-machine evidence for
  0.5.0: the library root and `notes/` opened visibly in all
  three hosts (Claude Desktop, Cursor, VS Code), while
  `notes/assets` opened visibly in none of them, although the
  tool result text said it had opened. The working hypothesis
  is Windows 11 tab reuse: with the default "open each folder
  in the same window" setting, a `start` launch can open the
  folder as a tab in an already-open Explorer window behind
  the foreground app. The `/n` switch is documented to always
  open a new window even when the folder is already open.
  Whether it fixes the behaviour on current Windows 11 builds
  is verified only by the user's real-machine test; the VM
  suite checks the command shape, not the window. `open_image`
  is unchanged (it still uses `cmd /c start`, because Explorer
  given a file path would open its folder, not the viewer).
  The folder launch shares the same argument-array / detached
  / stdio-ignored / unref / 10 s timeout shape as before, via
  a new `openFolderInViewer` / `folderCommandFor` pair in
  `src/viewer.ts`; macOS/Linux folder launches are unchanged.
  One new protocol check; full suite 75/75 on the Linux VM
  (see TEST-REPORT.md §15).

### Changed

- Version 0.5.0 → 0.5.1 in `package.json` and `src/index.ts`
  `VERSION` only; `package.json` description/keywords keep
  their WebDAV wording until publish time, per the spec.

## [0.5.0] - 2026-10-30

### Added

- Cursor response budget raised to 10,000,000 (was 5,000,000),
  written by the setup wizard into Cursor's config entry as
  `MEMDRIVE_RESPONSE_BUDGET_BYTES`. Evidence (see README.md
  Limits): verified 2026-10-30 — a single bundled `read_file`
  of `notes/测试A.md` (four image references, test budget
  50,000,000) passed in 26 seconds with no host size error;
  each preview downscaled in memory to 2.24 MB, original
  untouched; ~8.96 MB binary / ~11.95 MB base64, ~2 MB
  headroom; exact ceiling unmeasured, ladder closed. The test
  line was then restored to 10,000,000 and a normal read
  re-verified. The server default (950,000) and the VS Code
  budget (10,000,000) are unchanged; no `clientInfo`
  identification was added.
- `open_containing_folder` tool (6th tool): opens the folder
  containing a file (or the folder itself; an empty path opens
  the library root) in the operating system's file manager,
  without highlighting or selecting any file. Sandboxed with
  the same `sandboxPath` gate as `open_image`; missing paths
  are rejected, nothing is modified, and the result is text
  only. It reuses the `openInViewer` / `viewerCommandFor`
  launcher from `src/viewer.ts` — no new launcher, no image
  checks, no preview, no selection logic. The tool description
  restricts it to explicit user requests, the same way as
  `open_image`. Its `path` is optional, following the
  `list_directory` / `search_files` convention, so omitting it
  opens the library root.
- Protocol/unit tests: 5 new checks (pure folder resolution:
  file → parent, folder → itself, root → root; the new tool's
  description; sandbox escape, outside-path, and missing-path
  rejections). No VM test actually opens a file manager: the
  resolution checks use the exported pure function and the
  protocol checks fail at the sandbox/existence gate. Full
  suite 74/74 on the Linux VM (69 existing checks plus 5 new
  ones, with the Cursor entry check updated to 10,000,000 and
  the tools/list check updated to 6 tools); see TEST-REPORT.md
  §14.

### Changed

- Version 0.4.0 → 0.5.0 in `package.json` and `src/index.ts`
  `VERSION` only; `package.json` description/keywords keep
  their WebDAV wording until publish time, per the spec.
- WebDAV wording in the README and the `src/index.ts` header
  comment aligned to the approved form: interface reserved
  behind `StorageBackend`; whether to implement later depends
  on user feedback; consider it only if the user base is large
  with clear demand. No WebDAV code was added or removed.
- `src/viewer.ts` wording only: the launcher error now says
  "did not open the requested path" instead of "did not open
  the image", so folder-open failures read correctly. Launch
  shape (argument array, no shell, detached, 10 s timeout) is
  unchanged; `open_image` behaviour is unchanged apart from
  that wording.
- No changes to the other five tools' logic, the sandbox, the
  preview ladder, or the 3.5 MB per-image ceiling. No new
  dependencies.

## [0.4.0] - 2026-10-30

### Added

- VS Code host adapter for the setup wizard: the wizard now asks
  which host to configure first (1 Claude Desktop, 2 Cursor,
  3 VS Code, Enter = 1), then the library folder, in one run. An
  optional argument skips the host question (`node dist/index.js
  setup vscode` — only that one word, no `vs-code` / `code`
  alias); an unrecognised argument falls back to the prompt
  instead of guessing. Prompt-first stays the default foolproof
  path for `npx memdrive-mcp setup` and the launchers.
- VS Code Copilot Global config writing
  (`%USERPROFILE%\.copilot\mcp-config.json` on Windows,
  `~/.copilot/mcp-config.json` on macOS/Linux, returned only when
  the `.copilot` directory exists; `COPILOT_HOME` is not read).
  Entries carry `type: "stdio"` as Cursor's do; a missing config
  file is created (no backup — nothing to back up); a missing
  Claude config file is still never created. Corrupt files abort
  untouched for every host. When merging into an existing entry,
  VS Code's host-generated `"tools": ["*"]` field is preserved
  (generic merge rule: any existing entry's `tools` field the new
  entry does not define is carried over); a freshly created entry
  gets no `tools` field.
- Per-host response budgets, written by the wizard into each
  host's config entry as `MEMDRIVE_RESPONSE_BUDGET_BYTES` (the
  server cannot identify the host, so the env value is the only
  way to pass the budget through): Claude Desktop writes no
  budget env and keeps the 950,000-byte default; Cursor writes
  5,000,000; VS Code writes 10,000,000. See README.md Limits for
  the evidence behind each value — Claude Desktop verified,
  Cursor and VS Code partly verified, neither exact ceiling
  measured, no further probing planned.
- Protocol/unit tests: 6 new checks (VS Code discovery with
  injected fake environments, VS Code entry/snippet shape with
  the 10,000,000 budget, `tools` preservation in merges, VS Code
  host-argument parsing, VS Code create-if-missing, corrupt VS
  Code config untouched). Full suite 69/69 on the Linux VM (63
  existing checks plus 6 new ones); see TEST-REPORT.md §13.

### Changed

- The Cursor entry now carries the 5,000,000-byte budget env from
  the wizard; its shape is otherwise unchanged. Claude Desktop
  entries are byte-identical to 0.3.0 (no `type`, no budget env).
- WebDAV wording throughout the README (and the `src/index.ts`
  header comment): WebDAV is designed in behind the
  `StorageBackend` interface but not implemented; whether it is
  implemented later depends on user demand. No WebDAV code was
  added or removed. `package.json` description/keywords are
  unchanged in this version (revisited at publish time).
- No changes to tool logic, the sandbox, the preview ladder, or
  the 3.5 MB per-image ceiling. No new dependencies.

## [0.3.0] - 2026-10-29

### Added

- Cursor host adapter for the setup wizard: the wizard now asks
  which host to configure first (1 Claude Desktop, 2 Cursor,
  Enter = 1), then the library folder, in one run. An optional
  argument skips the host question (`node dist/index.js setup
  cursor`, `setup claude` / `setup claude-desktop`); an
  unrecognised argument falls back to the prompt instead of
  guessing. Prompt-first is the default foolproof path for
  `npx memdrive-mcp setup` and the launchers; the argument is an
  optional shortcut only.
- Cursor global config writing (`%USERPROFILE%\.cursor\mcp.json`
  on Windows, `~/.cursor/mcp.json` on macOS/Linux, returned only
  when the `.cursor` directory exists; stale legacy paths are not
  checked). Entries carry `type: "stdio"` as Cursor requires;
  Claude Desktop entries are unchanged (no `type` field). A
  missing Cursor config file is created (no backup — nothing to
  back up); a missing Claude config file is still never created.
  Corrupt files abort untouched for every host. Project-level
  `.cursor/mcp.json` is not written (global config only).
- Protocol/unit tests: 7 new checks (host-argument parsing,
  Cursor entry/snippet shape, Cursor discovery with injected
  fake environments, create-if-missing with and without an
  existing file, corrupt Cursor config untouched). Full suite
  63/63 on the Linux VM; see TEST-REPORT.md §12.

### Changed

- Wizard output now uses the chosen host's name for the
  config-updated, backup, snippet, and restart lines, and the
  corrupt-config message is host-generic. No changes to the
  response budget, preview ladder, sandbox rules, or tool logic.
  Cursor's tool-result size limit is unmeasured; the conservative
  950,000-byte default stays in force for Cursor until it is
  measured.

## [0.2.0] - 2026-10-29

### Added

- `open_image` tool (5th tool): opens an image file from the library
  in the OS default viewer (Windows `cmd /c start`, macOS `open`,
  Linux `xdg-open`) at full original quality, via an argument array
  with no shell string and no viewer-command override. The tool
  description requires an explicit user request and forbids
  auto-opening after reads or saves; the result is text only, never
  image bytes. Sandbox-checked like the other tools; non-image
  files, directories, and missing files are rejected, and a viewer
  failure on a headless machine returns a graceful note, never a
  crash.
- Setup wizard (`node dist/index.js setup`, or `npx memdrive-mcp
  setup` after npm publish): zero new dependencies, plain Node
  `readline`. Probes for OneDrive / Google Drive / iCloud sync
  folders (Google Drive on Windows: DriveFS presence, then a
  PowerShell volume-label probe, then existence-checked common
  paths — no drive letter hardcoded) plus the `~/memdrive`
  default, offers a numbered menu or a custom absolute path,
  creates the chosen root, finds the Claude Desktop config
  (including the Windows `%LOCALAPPDATA%` glob locations), backs
  it up (`.bak`, or `.bak-<timestamp>` when one exists), merges
  the `mcpServers.memdrive` entry preserving all other keys and
  servers, and aborts untouched on corrupt JSON. No config file
  found → nothing written, ready-to-paste snippet printed. No
  budget environment variable is written. Config writing is
  isolated behind a per-host adapter; Claude Desktop is the only
  v1 host.
- Launcher scripts (thin shells, all logic in Node):
  `setup.bat` (Windows), `setup.sh` (macOS/Linux), `setup.command`
  (macOS double-click). Each checks Node.js 18+, offers to open
  https://nodejs.org when Node is missing, then runs `npm
  install` + `npm run build` (failures stop the script) and the
  wizard.
- Protocol/unit tests: 21 new checks (8 `open_image` protocol
  checks, 13 wizard/viewer/host-config unit checks with injected
  fake environments). Full suite 56/56 on the Linux VM; see
  TEST-REPORT.md §9.

### Fixed

- `setup.bat` line endings and parsing (same 0.2.0 version, fixed
  zip): the first 0.2.0 zip shipped `setup.bat` with LF-only line
  endings, which cmd.exe fails to parse ("install was unexpected
  at this time") before running anything. The fixed zip uses CRLF
  for `setup.bat`, rewrites it in goto-label style with no
  parenthesized blocks, replaces the inline `node -e` version
  check with a `for /f` parse of `node -v`, and calls `npm.cmd`
  explicitly. See TEST-REPORT.md §11. `setup.sh` / `setup.command`
  correctly stay LF.

### Changed

- Tool count 4 → 5 (`open_image`); README status, Quick start,
  Tools table, and a new Setup section document the wizard,
  launchers, SmartScreen steps, and the one-verified-row host
  limit note. No changes to the response budget, preview ladder,
  or sandbox rules.

## [0.1.3] - 2026-10-28

### Added

- `CHANGELOG.md`: version history from 0.1.0, kept in the repo.
- Three-layer limit explanation in the `read_file` tool description:
  the host's ~1 MB whole-result cap, this server's 950,000-byte total
  budget and 3.5 MB per-image ceiling, and the model's own pixel/token
  scaling — plus the history that versions before 0.1.1 had no total
  budget. The model can now answer limit questions from the
  description instead of guessing.

### Changed

- Image previews: at full resolution the ladder now tries JPEG
  qualities 95, 90, then 80 (first fit wins) before shrinking;
  smaller scales stay at quality 80, so shrinking still prefers
  resolution over quality. Minimum-dimension retries (60/40/20)
  unchanged.
- README: Limits section states the quality ladder, the host-limit
  experiment, and the three layers; status updated to 0.1.3.

## [0.1.2] - 2026-10-28

### Fixed

- Preview ladder: tries a full-resolution JPEG re-encode first, then
  shrinks in 0.9 steps (was: first step 0.7), returning the first
  attempt that fits. A direct read no longer returns the same small
  preview as a bundled read when the whole budget is available.
  Measured on the deterministic 512×512 fixture: 131,455 B at
  358×358 → 366,469 B at 512×512.

## [0.1.1] - 2026-10-28

### Added

- One total response budget for `read_file` (default 950,000 bytes,
  `MEMDRIVE_RESPONSE_BUDGET_BYTES`, clamped 100,000–50,000,000):
  text UTF-8 bytes + image base64 bytes counted together, text
  guaranteed first, images downscaled or skipped with a note — a
  read never fails as a whole because of an image.
- `include_images` option on `read_file` (default true): `false`
  returns text only plus the list of referenced image paths (step 1
  of two-step reading).
- Clipboard rule first in the `save_file` tool description: pass
  `images: ["clipboard"]`, never ask the user to paste the image,
  never claim the clipboard cannot be read or the library is
  text-only.

### Changed

- Direct image reads that cannot fit the budget return explanatory
  text instead of the `IMAGE_TOO_LARGE` error. Text truncation is
  `min(1,000,000, budget)`; SVG text is truncated the same way.

## [0.1.0] - 2026-10-28

### Added

- Initial MVP: TypeScript MCP server (SDK 1.32.2, zero native
  dependencies) with four tools — `list_directory`, `search_files`,
  `save_file`, `read_file` — over a local sync-folder backend;
  Markdown + sibling `assets/` image workflow, clipboard capture,
  path sandbox around `MEMDRIVE_ROOT`, WebDAV deferred behind the
  storage interface.

Note on 0.1.0 limits, for the record: per-part caps only — 1 MB
text, 3.5 MB per-image preview, no combined check — which is why a
bundled read of an 813.5 KB screenshot (~1.11 MB as base64) was
rejected wholesale by Claude Desktop's ~1 MB result ceiling. Fixed
in 0.1.1.
