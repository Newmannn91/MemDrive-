# MemDrive MVP — Test Report

Date: 2026-10-28. Environment: Linux VM (headless), Node v24.22.1,
npm 10.9.4. SDK `@modelcontextprotocol/sdk` **1.32.2** (v1.x line, pinned),
zod 4.6.7, jimp 1.6.1. All tests run from `~/workspace/memdrive-mcp/`.

## 1. Build checks

| Check | Result |
| --- | --- |
| `npm run typecheck` (`tsc --noEmit`, strict incl. `noUncheckedIndexedAccess`) | PASS, zero errors |
| `npm run build` (`tsc -p tsconfig.json`) | PASS; `dist/` contains 8 modules; `dist/index.js` has the `#!/usr/bin/env node` shebang |
| `npm install` (clean, from committed `package-lock.json`) | PASS; exact pinned versions installed |

## 2. Protocol tests (`npm test` → `test/protocol-test.mjs`)

The suite drives the built server over stdio with the SDK's own `Client`
(`@modelcontextprotocol/sdk/client`), exactly like a real MCP host.
Fixtures are generated with jimp; the URL-download path is exercised
against a loopback HTTP server (no external network dependency). Scratch
dirs are created under the OS temp dir and removed after the run.

**35/35 checks passed** on the final run (24 original checks from
0.1.0, plus 9 new checks 25–33 added in 0.1.1, check 34 added in
0.1.2, and check 35 added in 0.1.3 — see §6–§8):

| # | Check | Result |
| --- | --- | --- |
| 1 | initialize + `tools/list` exposes exactly the 4 tools | PASS |
| 2 | `list_directory` on empty root | PASS |
| 3 | `save_file` text (`new`) writes file + auto-creates deep parent dirs | PASS |
| 4 | `save_file` mode `new` refuses to overwrite (file unchanged) | PASS |
| 5 | `save_file` `overwrite` replaces content | PASS |
| 6 | `save_file` `append` adds to the end | PASS |
| 7 | `save_file` with a local image: archived to sibling `assets/`, renamed `docname-<timestamp>.png`, markdown ref appended, stored bytes identical to source | PASS |
| 8 | `save_file` with a URL image: downloaded + archived + ref appended | PASS |
| 9 | Path cleaning: surrounding quotes stripped, backslashes normalized (`"quoted\win-style.md"` → `quoted/win-style.md`) | PASS |
| 10 | `read_file` returns text + image in ONE response; under-cap image passes through byte-identical | PASS |
| 11 | `read_file` of a bare image path returns a single image block | PASS |
| 12 | `read_file` of a >3.5 MB PNG: preview ≤3.5 MB binary, JPEG, on-disk file hash unchanged after read | PASS |
| 13 | `read_file` truncates text over the 1 MB cap with a note | PASS |
| 14 | `read_file` rejects binary (NUL-containing) files with a clear error | PASS |
| 15 | `read_file` returns SVG as text, never as an image block | PASS |
| 16 | `search_files` matches by file name and by file content | PASS |
| 17 | Sandbox rejects `../` escape (nothing written outside root) | PASS |
| 18 | Sandbox rejects absolute path outside root | PASS |
| 19 | Sandbox rejects symlink *directory* inside root pointing outside | PASS |
| 20 | Sandbox rejects symlink *file* inside root pointing outside | PASS |
| 21 | Clipboard in headless VM: graceful message, text saved, server stays alive and answers the next call | PASS |
| 22 | `save_file` with a failing image source still saves the text (graceful degradation, note in result) | PASS |
| 23 | `list_directory` shows nested content; errors cleanly on a file path | PASS |
| 24 | `save_file` with image on a non-Markdown file: image saved, no refs appended, result notes it | PASS |

One test-harness bug was found and fixed during the run (the empty-root
check initially ran after a fixture directory was created; the server
behaved correctly — the check ordering was wrong, not the server).

## 3. MCP Inspector CLI

Run headless via `npx -y @modelcontextprotocol/inspector --cli`:

| Check | Result |
| --- | --- |
| `--method tools/list` | PASS — 4 tools listed with correct schemas |
| `--method tools/call --tool-name read_file --tool-arg path=probe.md` | PASS — file content returned |
| `tools/call` error path (missing file) | PASS — `isError: true` with a clean message, surfaced by the Inspector as `tool_is_error` |

Caveat: the Inspector CLI spawns the server with its own environment, so
a `MEMDRIVE_ROOT` exported in the shell did not reach the server (it used
the default `~/memdrive`). That is Inspector CLI behavior, not a server
defect — the SDK-Client suite above proves `MEMDRIVE_ROOT` works. In the
interactive Inspector UI, set the variable explicitly.

## 4. What was NOT tested here (remains for the user)

1. **Step 2 — real conversation test (the user's job).** Configure
   Claude Desktop (see README) and try a real dialogue: ask the model to
   save a note with a screenshot from the clipboard, then read it back
   and confirm the picture comes back with the text. This is the only
   end-to-end check that exercises the real host + the real desktop.
2. **macOS clipboard branch** (`osascript`) — implemented from the
   documented macOS pattern; no macOS machine was available.
3. **Windows clipboard branch** (PowerShell STA + exit codes 0/2/3) —
   implemented from the documented pattern; no Windows machine was
   available.
4. **WebP over the 3.5 MB cap** — jimp has no WebP decoder, so the code
   reports instead of downscaling. Verified by code reading only (a large
   WebP fixture was not generated on this VM).
5. **External-network URL downloads** — exercised against a loopback
   server only; a real `https://` image URL was not fetched from this VM.
6. **npm packaging** — not published; `npx memdrive-mcp` has not been
   run from the registry. Local `node dist/index.js` and the Claude
   Desktop `npx` path are documented but the published-package path is
   unverified until first publish.

## 5. Spec deviations / judgment calls

- **SDK v1.x, not v2.** The installed SDK is 1.32.2 (2025-11-25 spec).
  v2 ships as separate packages with a different API surface; v1.x is
  still maintained (≥6 months of security/fix support from its 2026-07
  release) and its API is stable and fully documented. All code was
  written against the installed SDK's own README/`.d.ts`, not from
  memory. Pin is exact in `package.json` + committed lockfile.
- **WebP/SVG handling** follows jimp's real capabilities: WebP passes
  through under cap / reported over cap; SVG is text; GIF reads the
  first frame. (Spec said "images" generally; these are decoder limits,
  documented in README.)
- **URL download safety ceiling of 500 MB** added (spec: "no size limit
  on originals"). It only guards against a malicious/mistaken URL
  exhausting disk/memory; normal photos/screenshots are far below it.
- **`READ_MAX_IMAGES = 20`** per `read_file` response (spec set no cap;
  prevents a Markdown file referencing hundreds of images from blowing
  up a response; overflow is reported as a note, not an error).
- **Text cap is 1,000,000 decimal bytes** (spec: "1MB"), truncation is
  UTF-8-safe (never splits a multi-byte sequence).
- **Cleanup on failed document write:** if the document write fails
  after images were archived, the just-archived images are deleted so no
  dangling files are left behind. (If cleanup itself fails, the error
  notes it.)
- **Clipboard sources are read on the machine running the server**
  (the user's own computer when run via Claude Desktop), never on a
  remote host.

## 6. Update 0.1.1 (2026-10-28): total response budget + clipboard wording

Motivation: the 2026-10-28 Claude Desktop test saved a note plus an
813.5 KB screenshot correctly, but reading them back failed — the
text + base64 image together exceeded Claude Desktop's 1,048,576-byte
tool-result ceiling, because the code had only per-part caps (1 MB
text, 3.5 MB per image) and no combined check. This update adds the
combined check and makes the clipboard rule unmissable for the model.

What changed (code):

- `src/config.ts`: `RESPONSE_BUDGET_DEFAULT_BYTES = 950,000`,
  `MIN = 100,000`, `MAX = 50,000,000`, and the pure resolver
  `resolveResponseBudgetBytes(rawValue)` (unset/empty/non-numeric →
  default; out-of-range → clamped).
- `src/tools.ts`: `handleReadFile` now resolves the budget fresh on
  every call from `MEMDRIVE_RESPONSE_BUDGET_BYTES` and counts text
  UTF-8 bytes + image base64 bytes together. Text is truncated at
  `min(TEXT_MAX_BYTES, budget)` and guaranteed first; bundled images
  are downscaled via `makePreview(data, mime, cap)` with
  `cap = min(3.5 MB, remaining-budget binary equivalent)` and skipped
  with a note when they cannot fit — the read never fails as a whole
  because of an image. `read_file` gains `include_images` (default
  `true`); `false` returns text only plus the library-relative list of
  referenced image paths (step 1 of two-step reading). The
  `read_file` description states the total budget and the two-step
  procedure. The `save_file` description now *starts* with the
  clipboard rule in plain language (pass `images: ["clipboard"]`,
  never ask the user to paste the image into the chat, never claim the
  clipboard cannot be read or the library is text-only), and the
  `images` parameter description puts the clipboard case first.
- `src/images.ts`: `makePreview` takes an optional `maxBytes`
  (default: the 3.5 MB per-image ceiling) and, at the minimum
  dimension, retries at JPEG qualities 60/40/20 before giving up.
  Added `base64Length` / `maxBinaryForBase64Budget` helpers so budget
  accounting is exact (base64 is `ceil(n/3)*4`, not `n*4/3`).
- Version bumped 0.1.0 → 0.1.1 (`package.json`, `src/index.ts`).

Build checks re-run for 0.1.1: `npm run typecheck` PASS (zero
errors); `npm run build` PASS; MCP Inspector CLI `--method tools/list`
PASS (4 tools; the Inspector CLI still spawns the server with its own
environment, so a shell-exported `MEMDRIVE_ROOT` does not reach it —
same caveat as §3, not a server defect).

New protocol checks (9, all PASS on Linux VM, Node v24.22.1).
The harness itself is Windows-compatible: hashing uses Node crypto
(no `sha256sum` shell-out), the directory-symlink check uses a
junction, the file-symlink check skips on EPERM, and the clipboard
check accepts all four graceful outcomes (unsupported / empty /
text-only / image captured) — the same three Windows traps fixed for
the 0.1.0 harness on the user's machine.

| # | Check | Result |
| --- | --- | --- |
| 25 | `tools/list`: `read_file` exposes `include_images: boolean`; its description states the 950,000 budget, `MEMDRIVE_RESPONSE_BUDGET_BYTES`, and two-step reading; `save_file` description starts with `CLIPBOARD FIRST` and forbids asking the user to paste / claiming the clipboard cannot be read / the library is text-only; `images` description puts clipboard first | PASS |
| 26 | `read_file` with `include_images=false` returns text only (0 image blocks) plus the library-relative image path list | PASS |
| 27 | Bundled read of a 786,488-byte BMP (base64 1,048,652 > 950,000 — the 813 KB screenshot shape): total text+base64 ≤ 950,000, image downscaled to JPEG in memory, on-disk SHA-256 unchanged | PASS |
| 28 | Text-first: 1.2 MB text + image reference stays ≤ 950,000, text truncated with a note, image skipped with a budget note, `isError` unset | PASS |
| 29 | Budget resolver unit checks via `dist/config.js`: unset/empty/`abc` → 950,000; `1000` → 100,000; `99999999` → 50,000,000; `2000000` → 2,000,000 | PASS |
| 30 | Under-budget image on a direct read passes through byte-identical (PNG, original MIME) | PASS |
| 31 | Second server with `MEMDRIVE_RESPONSE_BUDGET_BYTES=200000`: bundled read never errors and stays ≤ 200,000 | PASS |
| 32 | Same small-budget server: oversized undecodable `.png` (800,000 bytes of filler) skipped with a note in a bundled read, and a direct read returns explanatory text with no image and no error | PASS |
| 33 | Two-step on the small-budget server: the text-heavy document's bundled read drops the image (0 blocks, ≤ 200,000), while a direct read of the same image returns it (JPEG, ≤ 200,000); on-disk SHA-256 unchanged after all budget reads | PASS |

Behavior changes vs 0.1.0, documented here so they are deliberate,
not accidental:

- Text truncation is now `min(1,000,000, budget)` (a 1 MB text file
  under the default budget is truncated at 950,000, with a note).
  SVG text is truncated the same way (previously untruncated).
- A direct image read that cannot be fitted within the budget at all
  now returns explanatory text (`isError` unset) instead of the old
  `IMAGE_TOO_LARGE` error — the "never fail the whole read" rule
  applied to direct reads too. Undecodable images *under* the cap
  still pass through untouched, as before.
- Budget accounting counts the text block as sent (UTF-8 bytes) plus
  each image's base64 string length. JSON framing overhead is not
  counted; the 950,000 default leaves ~98 KB of headroom against the
  1,048,576 transport ceiling for that overhead and for notes.

Still NOT tested (carried over, with 0.1.1 status):

1. **Step 2 retest — the user's job, still open.** Re-run the real
   Claude Desktop conversation with 0.1.1: save a note with a
   clipboard screenshot, then read it back both ways (packed read,
   and two-step: `include_images=false` then a direct image read)
   and confirm the picture comes back. The protocol suite proves the
   server-side budget arithmetic; only the real host proves the
   model follows the new tool descriptions.
2. **macOS clipboard branch** — unchanged from §4: implemented from
   the documented pattern, no macOS machine available.
3. **Windows clipboard branch** — save side verified on the user's
   real Windows machine on 2026-10-28 (screenshot captured and
   archived via `images: ["clipboard"]` on the second attempt, after
   an explicit instruction); the *read-back* side is what 0.1.1
   fixes and what item 1 above still has to confirm. The headless-VM
   graceful-failure path is still covered by check 21.
4. **WebP over the budget** — jimp has no WebP decoder, so an
   over-budget WebP is skipped with a note (check 32 covers the
   equivalent undecodable case with a filler PNG); a large real WebP
   fixture was not generated.
5. **External-network URL downloads, npm packaging** — unchanged
   from §4.

## 7. Update 0.1.2 (2026-10-28): preview ladder uses the budget

Bug found by the user in Claude Desktop, not by the test suite: a
direct (single-image) read of a 1.22 MB screenshot returned the
*identical* 143.9 KB preview as the bundled read, at ~660 px wide,
even though the direct read had the whole ~927.7 KB budget to itself.
Root cause, verified in the code: `makePreview` started its shrink
ladder at scale 0.7 (`IMAGE_PREVIEW_SCALE_STEP`) and returned the
FIRST attempt under the cap. With a ~712 KB binary cap, the 0.7-step
JPEG (143.9 KB) fit immediately, so the ladder never tried full
resolution or 0.8/0.9 — and the bundled and direct reads computed
the same cap (text was ~156 B), so they deterministically produced
the same preview. The preview sizes were never literally "fixed"
(44.1 / 63.1 / 143.9 KB for three different images), but the *step*
was fixed, which wasted most of the budget.

Fix (`src/images.ts`, `src/config.ts`): the ladder now tries a
full-resolution JPEG re-encode first (scale 1.0, no resize), then
shrinks in 0.9 steps (`IMAGE_PREVIEW_SCALE_STEP = 0.9`), returning
the first attempt that fits. Quality stays 80; the minimum-dimension
quality retries (60/40/20) are unchanged.

Measured on the deterministic 512×512 noise-BMP fixture (786,488 B,
binary cap 712,116 B): old ladder → 131,455 B at 358×358; new ladder
→ 366,469 B at 512×512 (base64 488,628 B, inside the 950,000 budget).
Same fixture, same cap, ~2.8× more preview bytes at full resolution.

New check 34 (PASS): a direct read of the BMP fixture returns a JPEG
whose decoded dimensions are the original 512×512, with the total
response inside the budget. Full run: `npm run typecheck` PASS,
`npm run build` PASS, `npm test` **34/34** on the Linux VM. The
0.1.2 preview-quality improvement in Claude Desktop itself (does
the comment screenshot now come back near full resolution?) still
needs the user's real-conversation retest — the protocol suite
proves the server-side ladder, not what the model reports.

## 8. Update 0.1.3 (2026-10-28): preview quality ladder + three-layer limit description + CHANGELOG

Two threads converged in this release.

**Host-limit confirmation (experiment, no code).** The §7 open retest
has now run: in Claude Desktop, 0.1.2 returned a 215.4 KB preview for
the 1.22 MB comment screenshot (was 143.9 KB under 0.1.1), clearer,
and the model read fine details and self-corrected its earlier
"143.9 KB is the cap" guess. Separately, a single-variable
experiment confirmed the host cap: with the budget disabled via
`MEMDRIVE_RESPONSE_BUDGET_BYTES=50000000`, the same bundled read
failed twice with the exact "Tool result is too large. Maximum size
is 1MB" error, while the default budget reads it fine. The ~1 MB
host ceiling and the 950,000 budget logic stay. ChatGPT/Grok and
other hosts remain untested; the ~1 MB ceiling is assumed for all
of them until proven otherwise.

**Quality ladder (`src/images.ts`, `src/config.ts`).** The 215.4 KB
result showed the 0.1.2 ladder working as designed — full-resolution
JPEG at quality 80 fit the cap on the first attempt — but also that
quality headroom was left unused: quality 80 used only ~30% of the
cap on that image. The ladder now tries JPEG qualities 95, 90, then
80 at full resolution (first fit wins) before any shrinking;
smaller scales stay at quality 80, so shrinking still prefers
resolution over quality, and the minimum-dimension retries
(60/40/20) are unchanged. New constant
`IMAGE_PREVIEW_QUALITIES = [95, 90, 80]`; `IMAGE_PREVIEW_QUALITY`
(80) remains the shrink-step quality. At most two extra encodes per
image, only at full resolution.

Measured on the deterministic screenshot-like fixture (1080×2400,
seeded Jimp generation — photo-texture top region, comment rows
below; binary cap 712,116 B): PNG re-encode 2,495,610 B (a lossless
PNG-first route is impossible for this shape of image), JPEG q80
453,308 B, q90 662,386 B, q95 874,042 B. `makePreview` returns the
q90 encode (662,386 B) at full 1080×2400: q95 exceeds the cap, q90
fits. For the user's real comment screenshot (full-res q80 measured
at 215.4 KB in Claude Desktop), quality 90/95 is estimated at
~315/415 KB by the same ratios — an estimate, not a measurement;
the real-conversation retest below is the proof.

**Three-layer description (`src/tools.ts`).** The `read_file`
description now states the three limit layers separately — (1) the
host's ~1 MB whole-result cap (Claude Desktop verified; other hosts
untested), (2) this server's 950,000 total budget and 3.5 MB
per-image ceiling (with the pre-0.1.1 no-budget history), (3) the
model's own pixel/token scaling — so the model answers limit
questions from the description instead of guessing from API docs or
earlier failures. No behavior change in the tools themselves.

**Docs.** README Limits/status updated (quality ladder, host-limit
experiment, three layers). New `CHANGELOG.md` (Keep a Changelog
format) covering 0.1.0 → 0.1.3; when the repository goes public,
each section maps to a GitHub Release. Version bumped 0.1.2 →
0.1.3 (`package.json`, `src/index.ts`).

New check 35 (PASS): a direct read of the deterministic
screenshot-like fixture returns a JPEG at the original 1080×2400
dimensions, inside the budget, with strictly more bytes than the
quality-80-only encoding of the same pixels computed in the harness
with the same Jimp — proving the ladder spent the headroom on
quality. Full run: `npm run typecheck` PASS, `npm run build` PASS,
`npm test` **35/35** on the Linux VM.

Still open (carried over):

1. **Real-conversation retest of the quality ladder** — the user's
   job: direct read of the 1.22 MB comment screenshot in Claude
   Desktop under 0.1.3; expect a larger preview than 215.4 KB and
   clearer comment text. Exact size depends on content; ~300–450 KB
   is the ratio-based estimate, not a promise.
2. **macOS clipboard branch** — unchanged from §4/§6.
3. **Other hosts** — ChatGPT/Grok limits untested; ~1 MB assumed.

## 9. Update 0.2.0 (2026-10-29): `open_image` + setup wizard + launchers

Scope, exactly as approved: version bump, the fifth tool, the
wizard, the three launchers, docs, and tests. No changes to the
response budget, preview ladder, preview logic, or sandbox rules;
zero new dependencies; Node >= 18; no `.mcpb`; no FUNDING.yml; no
npm publish; no WebDAV; no registry-primary probing; no hardcoded
`G:`; no budget env written by the wizard.

What changed (code):

- `src/viewer.ts` (new): `viewerCommandFor(platform, path)` — a
  pure function returning the exact launch command (Windows
  `cmd.exe /c start "" <path>`, macOS `open <path>`, Linux
  `xdg-open <path>`) — and `openInViewer`, which launches it
  detached with stdio ignored and unref'd, and never throws: a
  launcher that exits non-zero quickly resolves to a graceful
  note, and a launcher still running after 10 s is treated as a
  successful open (the viewer is up; it is never killed, so a
  long-lived viewer is not closed by a timeout).
- `src/tools.ts`: `handleOpenImage` runs the existing sandbox gate,
  rejects directories and missing files, accepts a file as an image
  by extension (`mimeFromExtension`) or, for extensionless files,
  by magic bytes (`detectImageMime` on the first 16 bytes), and
  returns a short text confirmation or a graceful note — never
  image bytes. The tool description states the explicit-request-
  only rule and the never-auto-open rule. Tool-count mentions
  updated (header comment, server startup log).
- `src/host-config.ts` (new): the per-host adapter
  (`claudeDesktopAdapter`: config discovery + `mcpServers` /
  `memdrive` keys), the one-star glob expander, the pure JSON
  merge (`mergeConfigJson`, preserving all other keys/servers,
  refusing corrupt JSON / non-object documents / non-object
  `mcpServers`), and `writeHostConfig` (missing file -> never
  created; backup `.bak` / `.bak-<timestamp>` written before any
  change).
- `src/wizard.ts` (new): `probeCandidateRoots` (injectable
  platform/env/home/existence/drive-letter probe; OneDrive,
  Google Drive 3-step chain on Windows, iCloud, `~/memdrive`
  default always listed), `expandCustomPath` (absolute-only, `~`
  expansion), `buildServerEntry` / `configSnippet` (entry carries
  `MEMDRIVE_ROOT` only), and the interactive `runSetupWizard`
  (numbered menu, custom-path loop, config pick when several
  files exist, snippet when none exists, restart instruction).
- `src/index.ts`: `node dist/index.js setup` runs the wizard and
  returns its exit code; no-arg invocation still starts the MCP
  server. `package.json` already declared the `bin` entry
  (`memdrive-mcp: dist/index.js`) and the shebang was already in
  `index.ts`, so `npx memdrive-mcp setup` needs no further
  wiring — it activates on npm publish, which is deferred.
- Launchers (repo root): `setup.bat`, `setup.sh`, `setup.command`
  — Node presence + Node 18+ check (missing Node -> friendly
  message + offer to open https://nodejs.org), `npm install` +
  `npm run build` with plain failures that stop the script, then
  the wizard. `setup.sh`/`setup.command` verified end-to-end on
  this VM (see below); `setup.bat` could not run here.
- Docs: README (status 0.2.0, wizard-first Quick start, Setup
  section, SmartScreen "More info -> Run anyway" steps,
  `open_image` section, one-verified-row host-limit note,
  Roadmap manual-test items) and CHANGELOG.md (0.2.0 entry).

VM measurements (Linux, Node v24.22.1, 2026-10-29):

- `npm run typecheck` PASS (zero errors); `npm run build` PASS;
  `dist/` contains 11 modules; `dist/index.js` keeps its
  executable bit and shebang.
- `npm test` **56/56**: the 35 checks from 0.1.0-0.1.3 (including
  the small-budget checks) plus 21 new checks — 8 `open_image`
  protocol checks (description wording; `../` escape; absolute
  outside path; non-image file; missing file; directory;
  headless-Linux graceful note with the server alive afterwards;
  extensionless PNG identified by magic bytes) and 13 unit
  checks (viewer commands per platform + hostile-filename
  single-argument check; candidate probing on Linux/Windows/
  macOS fakes, including the no-DriveFS probe-never-runs check;
  custom-path validation; server-entry contents; config merge
  preservation and refusals; backup naming; config write with
  backup + second-write timestamped backup; missing/corrupt
  handling; Windows glob + macOS config discovery).
- `xdg-open` on this VM: present at `/usr/bin/xdg-open`, exits 3
  with "no method available" for a file on a headless machine —
  the `open_image` protocol check confirms that failure surfaces
  as a text note (`isError` unset, zero image blocks) and the
  server answers the next call.
- Wizard smoke test (scratch `$HOME`, piped choice `1`):
  menu listed the default root only, `mkdir -p` created it, no
  Claude Desktop config existed so nothing was written, and the
  printed snippet pointed at the absolute `dist/index.js` of the
  working copy with the chosen `MEMDRIVE_ROOT`. Exit code 0.
- `setup.sh` end-to-end on this VM (scratch `$HOME`, choice `1`):
  Node check printed, `npm install` up to date, build clean,
  wizard ran to the snippet, exit code 0. `sh -n` clean for
  both `.sh` and `.command`.

Spec deviations / judgment calls:

- **Viewer launch uses `spawn`, not `execFile`.** The spec's
  launch shape is an argument array with no shell, detached,
  stdio ignored, unref'd. `ExecFileOptions` in the installed
  @types/node (26.6.5) has no `detached` option, so `execFile`
  cannot express the detached launch; `spawn` provides exactly
  the same no-shell, argument-array semantics with `detached`
  supported. The path is still never concatenated into a
  command line, and there is still no viewer-command override.
- **Extensionless images are opened via magic bytes.** The spec
  names both `mimeFromExtension` and `detectImageMime`; the
  extension check runs first and the 16-byte sniff only runs
  when the extension does not identify an image. A `.txt` file
  holding PNG bytes would open; that is the documented cost of
  honoring both identification routes, and it cannot escape
  the sandbox.
- **Multiple config files get a "skip" option.** The spec says
  the user picks one; the menu adds "Skip — just show me the
  snippet" as the last entry, so a user who does not want any
  file written can still finish setup with the manual snippet.
- **`setup.bat` Y/N uses delayed expansion.** `%OPENBROWSER%`
  inside the missing-Node block would expand to its pre-block
  (empty) value; `setlocal EnableDelayedExpansion` +
  `!OPENBROWSER!` reads the value just typed. Untested on
  Windows — see below.

Still NOT tested (the user's Windows machine, or a Mac):

1. **Wizard end-to-end on real Windows** — OneDrive/Google
   Drive candidates on his profile, the PowerShell drive-letter
   probe against a real Google Drive volume, the
   `%LOCALAPPDATA%\Claude-Data\*` config discovery against his
   actual `claude_pzs8sxrjxfjjc` config, backup restore, and the
   restart-and-connect check in Claude Desktop.
2. **`setup.bat` flow** — Node check, `npm install` + build,
   wizard invocation, and the missing-Node Y/N browser prompt.
   Batch syntax was reviewed, not executed (no Windows here).
3. **`open_image` actually opening** — a real viewer window on
   Windows/macOS, and the 10 s still-running assumption on a
   Linux desktop with a blocking viewer.
4. **macOS branches** — `setup.command` double-click, `open`
   viewer command, iCloud/Google Drive candidates, and the
   macOS Claude Desktop config path; all covered only by
   injected-fake unit checks.
5. **npm packaging** — unchanged from §4: not published;
   `npx memdrive-mcp setup` is wired (`bin` + shebang) but
   unverified until first publish.

## 10. Clean-extraction re-verification (2026-10-29)

The delivered zip (`memdrive-mcp-0.2.0.zip`, top-level
`memdrive-mcp/` folder, `node_modules` excluded) was unzipped into
a fresh directory on this VM and verified from scratch:
`npm install` from the committed lockfile, `npm run typecheck`
(clean), `npm run build` (clean), `npm test` **56/56**. The
executable bits survived the round trip: after extraction,
`dist/index.js`, `setup.sh`, and `setup.command` are all
executable, and the extracted `package.json` reports version
0.2.0. Extracting the zip's *contents* (not a nested copy) into
the target folder is the documented install step, matching the
0.1.x zips.

## 11. setup.bat CRLF fix (2026-10-29, same 0.2.0 version)

Bug found on the user's Windows machine, not by the VM suite:
running `.\setup.bat` in PowerShell printed only

    此时不应有 install。

("install was unexpected at this time") and returned at once —
no `node -v` output, no "Installing dependencies..." line, no
wizard. Repeat `npm install` was ruled out as the cause before
any file was changed: `npm install` is idempotent (a second run
reports "up to date"), and a batch parse error before any command
runs cannot be caused by an earlier install.

Verified cause (checked, not guessed): the `setup.bat` in the
first 0.2.0 zip — written on the Linux VM — had LF-only line
endings: 0 CRLF sequences, 56 LF-only line breaks, confirmed by
byte count in both the working copy and the delivered zip.
cmd.exe does not parse LF-only batch files reliably, and the
symptom (immediate parse error, nothing executed) matches that
failure. This is an inference from the verified LF-only bytes
plus the observed symptom, not a cmd.exe trace: no Windows
machine with a debugger was available here, and the fixed file
still needs its first successful run on the user's machine to
close the loop.

Fix, in the same 0.2.0 version (no version bump: no code, tool,
or wizard behavior changed):

- `setup.bat` converted to CRLF (71 CRLF sequences, 0 LF-only
  breaks, verified by byte count after conversion).
- Rewritten in goto-label style with no parenthesized `if`
  blocks: the old file's parenthesized blocks plus quoted
  parentheses (`(Y/N)`, `(it is free)`) and an inline
  `node -e` check containing parentheses, braces, and `<`
  are all cmd.exe parsing hazards. The new file has no
  parenthesized blocks; the only remaining parentheses are a
  REM comment and the standard `for /f` idiom.
- Node version check no longer uses inline JS: `for /f
  "tokens=1 delims=v."` parses `node -v` (`v24.22.1` ->
  major 24) and `LSS 18` rejects older majors. The missing-Node
  Y/N prompt uses `%OPENBROWSER%` (no delayed expansion, no
  block) and plain text with no parentheses.
- `npm` is invoked explicitly as `npm.cmd` (`call npm.cmd
  install`, `call npm.cmd run build`).
- `setup.sh` and `setup.command` were checked and correctly
  left LF-only: Unix shells require LF.

Still NOT tested: the fixed `setup.bat` itself has not yet run
successfully on Windows — the user deleted the extracted folder
and will re-extract the fixed zip and run it. The wizard
end-to-end and backup restore remain open with it. The
`open_image` Claude Desktop test, by contrast, already passed
on his machine ("非常丝滑") and is not affected by this fix.

## 12. Update 0.3.0 (2026-10-29): Cursor adapter + wizard host selection

Starting point verified before any change: the working copy was
clean 0.2.0 — `npm run typecheck` clean, `npm test` 56/56 on the
VM. (The 0.2.0 Windows chain was closed separately on the user's
machine after §11 was written: the fixed `setup.bat` ran
end-to-end, wizard choice 2, Claude Desktop restart, read/save/
open_image all passed, per his report.)

Design (per the approved 0.3.0 spec in
`workspace/goals/memdrive-mcp-memory-server/hidden_files/0.3.0-BUILD-SPEC.md`):

- One new host adapter, `cursorAdapter`, in `src/host-config.ts`,
  next to `claudeDesktopAdapter`. The shared backup/parse/merge/
  write logic is untouched except for the create-if-missing path
  (below). The entry difference is data, not logic: Cursor
  entries carry `type: "stdio"` (required by Cursor's official
  MCP docs, fetched 2026-10-29); Claude entries carry no `type`
  field, so the optional `type` on `HostConfigEntry` stays unset
  for Claude and `JSON.stringify` omits it — Claude entries are
  byte-identical to 0.2.0.
- Cursor discovery is global-config only:
  `<home>/.cursor/mcp.json` on every platform, returned only
  when the `.cursor` directory exists. Project-level
  `.cursor/mcp.json` is not probed or written. Stale legacy paths
  from old articles (`globalStorage/mcp.json`, `mcp-servers.json`)
  are not checked. macOS/Linux Cursor paths use the same
  home-based logic and are marked untested.
- Create-if-missing is gated by `adapter.createIfMissing`
  (Cursor only): a missing file is created with parent
  directories, a minimal `{mcpServers: {memdrive: entry}}`
  document, no backup, status `'created'`. A missing Claude file
  is still never created; corrupt files abort untouched for
  every host.
- Wizard host selection: `runSetupWizard(hostArgument?)`, with
  `process.argv[3]` passed through from `src/index.ts`. No
  argument → numbered host menu (1 Claude Desktop, 2 Cursor,
  Enter = 1), then the unchanged folder menu, in one run.
  `setup cursor` / `setup claude` / `setup claude-desktop`
  (case-insensitive) skips the host question; an unrecognised
  argument prints an "Unknown host" line and falls back to the
  prompt, never guessing. Parsing is a pure exported function,
  `parseHostArgument`. Wizard output uses the chosen adapter's
  display name; the corrupt-config message is host-generic.
- No changes to the response budget, preview ladder, sandbox
  rules, or any tool. No new dependencies. Cursor's size limit
  is unmeasured and was not guessed: the 950,000-byte
  conservative default stays in force for Cursor.

VM verification (2026-10-29, Node v24.22.1):

- `npm run typecheck` clean; `npm run build` clean.
  (One type error was caught and fixed during the build: the
  injectable filesystem's `mkdir` type did not match
  `fs.promises.mkdir` overloads; the interface now uses
  `typeof fs.mkdir`.)
- `npm test` **63/63**: 56 existing checks plus 7 new ones —
  Cursor entry/snippet shape, host-argument parsing, Cursor
  merge preserving `type`, Cursor discovery (Windows/macOS/
  Linux fakes, legacy paths never returned), create-if-missing
  with and without an existing file, corrupt Cursor config
  untouched. All pass.
- Wizard smoke tests with a scratch `$HOME` (delayed piped
  input, because `readline/promises` closes on piped-EOF before
  a second question when all input arrives at once — an
  interactive terminal, where stdin stays open, does not hit
  this; the same artifact would affect 0.2.0's second question):
  `setup cursor` + Enter created
  `$HOME/.cursor/mcp.json` with `type: "stdio"` and no backup;
  prompt mode, choosing 2 then Enter, created the same file;
  `setup bogus` printed "Unknown host", fell back to the prompt,
  and the Claude snippet printed with no `type` field and
  nothing written.

Still NOT tested: everything that needs the user's Windows
machine — wizard host prompt and argument in PowerShell, the
Cursor config create/merge/backup against his real `.cursor`
directory, restarting Cursor, tools + read/save/open_image in a
real Cursor conversation (MCP Logs on failure), and the Cursor
size-limit single-variable experiment. VS Code, project-level
config, and `npx memdrive-mcp setup` (pending npm publish) are
out of scope for this version.

## 13. Update 0.4.0 (2026-10-30): VS Code adapter + per-host budgets

Starting point verified before any change: the working copy was
clean 0.3.0 — `npm run typecheck` clean, `npm test` 63/63 on the
VM.

Design (per the approved 0.4.0 spec in
`workspace/goals/memdrive-mcp-memory-server/hidden_files/0.4.0-BUILD-SPEC.md`):

- One new host adapter, `vscodeAdapter`, in `src/host-config.ts`,
  next to `claudeDesktopAdapter` and `cursorAdapter`. `HOST_ADAPTERS`
  order is Claude Desktop, Cursor, VS Code. VS Code discovery is
  Copilot Global config only: `<home>/.copilot/mcp-config.json` on
  every platform, returned only when the `<home>/.copilot`
  directory exists; `COPILOT_HOME` is deliberately not read.
  `createIfMissing: true`, same as Cursor (VS Code itself creates
  the file when a server is added from its UI); Claude stays
  `false`. macOS/Linux VS Code paths use the same home-based
  logic and are marked untested. The entry shape was verified on
  the user's real Windows machine (manual `MCP: Add Server` flow,
  Copilot Global config): top-level `mcpServers`, entry
  `type: "stdio"`, `command: "node"`, absolute `dist/index.js`
  args, plus VS Code-generated `"tools": ["*"]` alongside them.
- Per-host budgets are data on the adapter, not logic: an
  optional `responseBudgetBytes` (`HostConfigAdapter`), written
  by `buildServerEntry` into the entry's `env` as
  `MEMDRIVE_RESPONSE_BUDGET_BYTES` only when the adapter defines
  it — Claude Desktop: unset (server default 950,000); Cursor:
  5,000,000; VS Code: 10,000,000. `configSnippet` uses
  `buildServerEntry`, so snippets carry the same budget env. No
  `clientInfo` identification, no startup probing, no guessing
  from a client name: MCP `initialize` carries no host/limit
  information, so the per-host env value is the only way to pass
  the budget through. The old "entry never carries a budget"
  comment in `host-config.ts` was replaced with the per-host
  budget evidence; `src/config.ts` keeps
  `RESPONSE_BUDGET_DEFAULT_BYTES` at 950,000 with a comment
  pointing at the per-host overrides. The clamp range
  (100,000–50,000,000) is unchanged. Budget evidence, stated
  without exaggeration in code comments and in README.md Limits:
  Claude Desktop verified (2026-10-28 single-variable
  experiment); Cursor partly verified (2026-10-29 three-image
  bundled read, ~3.91 MB binary / ~5.21 MB base64 from
  two-decimal sizes, exact ceiling unmeasured, re-probe closed);
  VS Code partly verified (2026-10-29 four-image bundled read,
  four distinct 10.44 MB PNG copies, ~8.96 MB binary /
  ~11.95 MB base64 from two-decimal previews, ~2 MB headroom,
  exact ceiling unmeasured, ladder closed).
- `mergeConfigJson` now carries over a host-generated field the
  new entry does not define: when the existing `memdrive` entry
  is an object carrying `tools` and the new entry does not define
  `tools`, the merged entry keeps `tools`. The rule is generic
  (any host), a freshly created entry gains no `tools` field, and
  every other key and server is preserved as before. Corrupt /
  non-object handling is unchanged for every host.
- Wizard host selection: `parseHostArgument` gains a `vscode`
  branch — only the single word `vscode` (case-insensitive,
  trimmed) selects VS Code; `vs-code` and `code` are not aliases
  and fall back to the prompt, never guessed. `HostId` is
  extended, `hostAdapterForId` handles all three adapters, and
  the numbered menu is driven by `HOST_ADAPTERS`, so it now
  reads 1 Claude Desktop, 2 Cursor, 3 VS Code (Enter = 1).
  Wizard output already used the chosen adapter's `displayName`.
  `setup.bat` is unchanged (no-argument wizard call; the prompt
  now covers VS Code).
- Docs: README.md gains a VS Code config section (Copilot Global
  path, create-if-missing, `tools` preservation, restart + enable
  note, macOS/Linux untested, only `list_directory` and a bundled
  image read verified in VS Code on a real machine so far), the
  Limits section gains the three-row per-host budget table with
  the evidence above, Cursor is removed from the "untested for
  the limit" list, and the WebDAV wording is updated throughout
  the README and in the `src/index.ts` header comment (designed
  in behind `StorageBackend`, not implemented, later
  implementation depends on user demand). CHANGELOG.md gains a
  0.4.0 entry. `package.json` changes only in version
  (0.3.0 → 0.4.0); description/keywords keep their WebDAV wording
  until publish time, per the spec.
- No changes to tool logic, the sandbox, the preview ladder, or
  the 3.5 MB per-image ceiling. No new dependencies. No WebDAV
  implementation, no `.mcpb`, no FUNDING.yml, no npm publish, no
  registry probing, no hardcoded drive letters, no project-level
  config, no read-only mode, no advanced search filtering, no
  host beyond the three.

VM verification (2026-10-30, Node v24.22.1):

- `npm run typecheck` clean; `npm run build` clean.
- `npm test` **69/69**: 63 existing checks plus 6 new ones —
  VS Code entry/snippet shape with the 10,000,000 budget,
  VS Code host-argument parsing (`vscode` only, `vs-code`/`code`
  fall back to prompt), `tools` preservation in merges (kept
  when present, never invented for fresh entries), VS Code
  discovery (Windows/macOS/Linux fakes, `COPILOT_HOME` ignored),
  VS Code create-if-missing with and without an existing file,
  corrupt VS Code config untouched. Two existing checks were
  updated for the intentional behaviour change: the Cursor entry
  check now expects the 5,000,000 budget env, and the
  host-argument check now expects `vscode` to parse and the
  three-adapter menu order. All pass. The Claude entry check is
  unchanged and still passes (no `type`, no budget env).
- Wizard smoke tests with scratch `$HOME` directories (delayed
  piped input, same `readline/promises` artifact as §12):
  `setup vscode` + Enter created `$HOME/.copilot/mcp-config.json`
  with `type: "stdio"` and the 10,000,000 budget env, no backup;
  prompt mode, choosing 3 then Enter, created the same file;
  `setup vs-code` printed "Unknown host", fell back to the
  prompt, and the Claude snippet printed with no `type` field,
  no budget env, and nothing written; a pre-existing VS Code
  config with `"tools": ["*"]`, another server, and another key
  merged with `tools` preserved, the other server/key intact,
  and a `.bak` backup of the original.
- Clean-extraction re-verification: the delivered zip was
  extracted to a fresh directory, `npm install` + `npm run build`
  + `npm test` run there — 69/69, same suite, no failures.

Still NOT tested: everything that needs the user's Windows
machine — wizard host prompt choice 3 and `setup vscode` in
PowerShell, the VS Code config create/merge/backup against his
real `.copilot` directory (including `"tools": ["*"]`
preservation), restarting VS Code, all five tools in a real
VS Code conversation (only `list_directory` and a bundled image
read have been verified there; `search_files`, `save_file`,
`read_file` single-image, and `open_image` still need their
VS Code checks; MCP Logs on failure), the Claude Desktop
regression check (its entry is byte-identical in the tests, but
the real-machine read still needs a look), and the Cursor
regression read once Cursor's free quota returns. No further
Cursor or VS Code size-limit probing is planned. Project-level
config and `npx memdrive-mcp setup` (pending npm publish) remain
out of scope.

## 14. Update 0.5.0 (2026-10-30): Cursor budget 10,000,000 + `open_containing_folder`

Starting point verified before any change: the working copy was
clean 0.4.0 — `npm run typecheck` clean, `npm run build` clean,
`npm test` 69/69 on the VM.

Design (per the approved 0.5.0 spec in
`workspace/goals/memdrive-mcp-memory-server/hidden_files/0.5.0-BUILD-SPEC.md`):

- Cursor budget is data on the adapter, not logic:
  `cursorAdapter.responseBudgetBytes` in `src/host-config.ts`
  goes from 5,000,000 to 10,000,000, and the file-header comment
  and the `responseBudgetBytes` field comment carry the new
  evidence. No `clientInfo` identification, no startup probing,
  no guessing from a client name: MCP `initialize` carries no
  host/limit information, so the per-host env value written by
  the wizard remains the only way to pass the budget through.
  `src/config.ts` keeps `RESPONSE_BUDGET_DEFAULT_BYTES` at
  950,000 (the constant is unchanged); its comment is synced to
  say Cursor writes 10,000,000. The clamp range
  (100,000–50,000,000) is unchanged. Budget evidence, stated
  without exaggeration in code comments and in README.md Limits:
  Claude Desktop verified (2026-10-28 single-variable
  experiment); Cursor verified (2026-10-30 single bundled read
  of `notes/测试A.md`, four image references, test budget
  50,000,000, 26 seconds, no host size error; each preview
  downscaled in memory to 2.24 MB, original untouched; ~8.96 MB
  binary / ~11.95 MB base64, ~2 MB headroom; exact ceiling
  unmeasured, ladder closed; the test line was then restored
  to 10,000,000 and a normal read re-verified); VS Code partly
  verified (2026-10-29, as in §13). A consequence of the
  wizard-env mechanism, stated plainly: changing the adapter
  value does not rewrite config files already written on a
  user's machine — an existing install keeps its old
  5,000,000 env until the wizard is re-run or the value is
  edited by hand. New wizard runs write 10,000,000.
- New tool `open_containing_folder` (6th tool) in `src/tools.ts`,
  next to the other five. Semantics, as approved: a file opens
  its parent folder, a folder opens itself, an empty path opens
  the whole library root; no highlight, no selection (no
  `explorer /select`, no Finder selection, no
  reveal-with-selection). The handler runs the same
  `sandboxPath` gate as `open_image` first (lexical + realpath
  checks: `..` escapes, outside absolute paths, and symlink
  escapes are rejected), then `stat`s the path and rejects a
  missing path with a `NotFoundError`-style readable error
  before anything opens. It reuses `openInViewer` /
  `viewerCommandFor` from `src/viewer.ts` — argument array, no
  shell, detached, stdio ignored, unref, 10 s launch timeout —
  with no new launcher and no environment-variable command
  override. It deliberately does none of `open_image`'s image
  checks (no extension/magic-byte check, no `NOT_AN_IMAGE`
  rejection) and must accept directories; it does no preview
  or downscaling. The result is text only, naming the folder
  opened by its library-relative display path (the root shows
  as `.`, as in the other tools), and it never counts against
  the image/response budget. Failure follows the `open_image`
  style: a readable note plus "Nothing was modified. Open the
  folder manually from the library folder instead.", never an
  unhandled exception. The tool description is all English
  (with one short Chinese example phrase, "在系统里打开这个笔记
  所在的文件夹", the same anchor style as the two retained
  phrases) and states USE ONLY WHEN THE USER EXPLICITLY ASKS,
  never automatically after another tool call. Execution
  decision, recorded per the spec (§4.2): `path` is optional,
  following the `list_directory` / `search_files` convention
  for optional inputs — omitting it (or passing `""`) opens
  the library root, so the empty/root semantics hold.
- `resolveContainingFolder(rootDir, absolutePath, isDirectory)`
  is exported from `src/tools.ts` as a pure function (file →
  parent, folder → itself, root → itself; no filesystem
  access), so the resolution logic is directly unit-testable
  without opening a file manager.
- `src/viewer.ts` wording only: the header now says "file or
  folder" and the launcher error says "did not open the
  requested path" instead of "did not open the image", so
  folder-open failures read correctly. Launch shape is
  unchanged. `src/index.ts` gains the new tool name in its
  startup stderr line and the 0.5.0 version; its WebDAV header
  wording is aligned to the approved form below.
- Docs: README.md gains the sixth tool (intro count, tools
  table, a new `open_containing_folder` section, Cursor budget
  row and Cursor config example at 10,000,000 with the new
  evidence, Roadmap still-to-verify updated to six tools and
  §14), and the WebDAV wording is checked and aligned to the
  approved form throughout the README and the `src/index.ts`
  header: interface reserved behind `StorageBackend`; whether
  to implement later depends on user feedback; consider it
  only if the user base is large with clear demand. CHANGELOG.md
  gains a 0.5.0 entry. `package.json` changes only in version
  (0.4.0 → 0.5.0); description/keywords keep their WebDAV
  wording until publish time, per the spec. The Chinese README
  reading-aid file in the goal `files/` directory was not
  touched (it is not a project file).
- No changes to the other five tools' logic, the sandbox, the
  preview ladder, or the 3.5 MB per-image ceiling. No new
  dependencies. No WebDAV implementation, no `.mcpb`, no
  FUNDING.yml, no npm publish, no registry probing, no
  hardcoded drive letters, no project-level config, no
  read-only mode, no advanced search filtering, no new host.

VM verification (2026-10-30, Node v24.22.1):

- `npm run typecheck` clean; `npm run build` clean.
- `npm test` **74/74**: 69 existing checks plus 5 new ones —
  pure folder resolution (file → parent, folder → itself,
  root → root, root-child file → root, nested folder →
  itself), the new tool's description (explicit-request-only,
  never auto-open, no highlight, path optional), sandbox
  escape rejection, outside-path rejection, and missing-path
  rejection. Two existing checks were updated for the
  intentional behaviour changes: the Cursor entry check now
  expects the 10,000,000 budget env, and the tools/list check
  now expects exactly 6 tools. All pass. No VM test actually
  opens a file manager: the resolution checks use the exported
  pure function and the protocol checks fail at the
  sandbox/existence gate, before any launch; the shared
  launcher failure path is already covered by the `open_image`
  headless check (same `openInViewer`).
- Clean-extraction re-verification: the delivered zip was
  extracted to a fresh directory, `npm install` + `npm run
  typecheck` + `npm run build` + `npm test` run there — 74/74,
  same suite, no failures; the extracted tree contained no
  `node_modules` before install.

Still NOT tested: everything that needs the user's Windows
machine — the new tool opening a folder once plus a normal
read, the new tool opening a folder once each in Claude
Desktop and VS Code with a budget regression read, the
wizard's Cursor/VS Code paths end-to-end with the new budget
(host prompt and argument, config creation/merge, restart,
all six tools), and a Claude Desktop regression check. No
further Cursor or VS Code size-limit probing is planned.
Project-level config and `npx memdrive-mcp setup` (pending npm
publish) remain out of scope.

## 15. Update 0.5.1 (2026-10-30): folder launch forces a new Explorer window on Windows

Starting point verified before any change: the working copy was
clean 0.5.0 — `npm run typecheck` clean, `npm test` 74/74 on the
VM.

Evidence (real machine, user's report, 2026-10-30): with 0.5.0,
`open_containing_folder` for the library root and for `notes/`
opened visibly in Claude Desktop, Cursor, and VS Code, while
`notes/assets` opened visibly in none of the three hosts, in a
new chat with all Explorer windows closed first, and in every
case the tool result text said the folder had opened. The
working hypothesis is Windows 11 tab reuse under the default
"open each folder in the same window" setting: a `cmd /c start`
launch can open the folder as a new tab in an already-open
Explorer window behind the foreground host app. The exact
mechanism is UNVERIFIED; the real-machine test below is the
closing proof, and a failure there refutes the hypothesis
rather than inviting another launcher guess.

Change (one place only, per the 0.5.1 build note in
`workspace/goals/memdrive-mcp-memory-server/hidden_files/0.5.1-BUILD-SPEC.md`):

- `src/viewer.ts`: new pure `folderCommandFor(platform, path)`
  — Windows `explorer.exe` with args `['/n,', absolutePath]`
  (the `/n` switch is documented to always open a new window
  even when the folder is already open); macOS/Linux return
  the same command as `viewerCommandFor`. New
  `openFolderInViewer` shares the launch shape with
  `openInViewer` through an internal `launchViewer` (argument
  array, no shell, detached, stdio ignored, unref, 10 s launch
  timeout, never throws). `openInViewer` / `viewerCommandFor`
  are unchanged.
- `src/tools.ts`: `handleOpenContainingFolder` now calls
  `openFolderInViewer`; `handleOpenImage` still calls
  `openInViewer`, because Explorer given a file path would
  open its folder instead of the image viewer. No changes to
  the other five tools, the sandbox, the preview ladder, the
  3.5 MB per-image ceiling, any budget, the wizard, or any
  tool description. No new dependencies.
- Docs: CHANGELOG.md gains a 0.5.1 entry; README.md gains one
  sentence in the `open_containing_folder` section; version
  0.5.0 → 0.5.1 in `package.json` and `src/index.ts` `VERSION`
  only. The Chinese README reading-aid file was not touched.

VM verification (2026-10-30, Node v24.22.1):

- `npm run typecheck` clean; `npm run build` clean.
- `npm test` **75/75**: 74 existing checks plus 1 new one —
  `folderCommandFor` (Windows `explorer.exe /n,`, distinct
  from the image-viewer command, macOS/Linux unchanged, a
  hostile folder name stays one argument). All pass. No VM
  test actually opens a file manager or runs the Windows
  launch: the new check is a pure command-shape check, and
  the protocol checks fail at the sandbox/existence gate.
- Clean-extraction re-verification: the delivered zip was
  extracted to a fresh directory, `npm install` + `npm run
  typecheck` + `npm run build` + `npm test` run there — 75/75,
  same suite, no failures; the extracted tree contained no
  `node_modules` before install. Verified twice: once from
  the draft package and once from the final package after
  the clean-extraction note above was added to TEST-REPORT
  §15 and the zip was repackaged.

Still NOT tested: everything that needs the user's Windows
machine — the folder launch itself, with the three-step test
in the 0.5.1 build note (assets, notes, assets again, each
must appear as a new window, with all Explorer windows closed
first), in one host and then the other two. If any step
fails, the tab-reuse hypothesis is refuted and the next step
is a new investigation, not a launcher tweak.

## §16 — 0.5.2 folder-launch fix (2026-10-30)

Scope: one change only — the Windows folder launch in
`src/viewer.ts` (`folderCommandFor`), from a direct
`explorer.exe` spawn with two arguments (`/n,`, path) to a
shell-mediated `cmd /c start "" explorer.exe /n,<path>` with
the switch and path in one comma-joined argument. Reason:
the 0.5.1 launch failed outright on the real machine
(explorer.exe exit code 1, no window, root and notes/, Cursor
and Claude Desktop, confirmed by the user's own eyes). The
audit also found no error in the sandbox gate, folder
resolution, or existence check, and a test gap: the VM suite
only ever asserted the command shape and never launched a
folder on Windows. No changes to the other five tools, the
sandbox, the preview ladder, budgets, wizard, or any tool
description. Version 0.5.1 → 0.5.2 in `package.json` and
`src/index.ts` `VERSION` only.

VM verification (2026-10-30, Node v24.22.1):

- `npm run typecheck` clean; `npm run build` clean.
- `npm test` **75/75**: the one `folderCommandFor` check
  updated to the new exact Windows command (cmd/start +
  explorer /n,path, distinct from the image-viewer command,
  macOS/Linux unchanged, a hostile folder name stays inside
  the single /n,path element). No VM test actually opens a
  file manager or runs the Windows launch.
- Clean-extraction re-verification: the delivered zip was
  extracted to a fresh directory, `npm install` + `npm run
  typecheck` + `npm run build` + `npm test` run there — 75/75,
  same suite, no failures; the extracted tree contained no
  `node_modules` before install. Verified twice, as before.

Still NOT tested: everything that needs the user's Windows
machine — the folder launch itself, with the three-step test
(close all Explorer windows first; open root, then notes,
then assets; each must appear as a visible new window),
in one host and then the other two. A failure on any step
is a failure of the 0.5.2 launch, to be diagnosed from what
his eyes saw, not from tool text.
