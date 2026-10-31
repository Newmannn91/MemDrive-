# Changelog

All notable changes to MemDrive (`memdrive-mcp`) are documented here,
newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project
is pre-1.0 and was published to npm as of 0.5.2 (2026-10-30);
earlier versions were delivered as zips and verified by the
protocol suite (see TEST-REPORT.md). Each section below maps
to a GitHub Release.

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
