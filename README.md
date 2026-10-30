# MemDrive

An MCP server that gives LLMs persistent memory on your own storage: a
local folder (Google Drive / OneDrive / iCloud sync folder, or any plain
directory) today. WebDAV (NAS, Nextcloud, Alist/Rclone) is
interface-reserved behind the `StorageBackend` interface but not
implemented; whether it is implemented later depends on user
feedback, and it will only be considered if the user base is large
with clear demand.

The model reads and writes **Markdown + a sibling `assets/` image folder**
through six small tools. No cloud service, no account, no server to run —
the MCP server runs on your own machine and touches only the folder you
point it at.

> **Status: MVP 0.5.0.** Local filesystem backend only. WebDAV is
> interface-reserved behind the `StorageBackend` interface but not
> implemented. Whether it is implemented later depends on user
> feedback, and it will only be considered if the user base is large
> with clear demand.
> 0.1.1 added one total response budget to `read_file` (see
> [Reading back](#reading-back-packed-two-step-and-single-image) and
> [Limits](#limits-all-in-srcconfigts-nowhere-else)) and put the
> clipboard rule first in the `save_file` tool description. 0.1.2 fixes
> the preview ladder so previews use the budget instead of stopping
> at the first coarse shrink step (see TEST-REPORT.md §7). 0.1.3 tries
> higher JPEG quality at full resolution before shrinking, states the
> three limit layers (host / server / model) in the `read_file` tool
> description, and adds CHANGELOG.md (see TEST-REPORT.md §8). 0.2.0
> adds `open_image` (open an original image in the OS viewer, only
> when the user explicitly asks) and a setup wizard that finds a
> sync folder and writes the Claude Desktop config for you (see
> [Setup](#setup-wizard--launchers) and TEST-REPORT.md §9). 0.3.0
> adds a Cursor adapter to the wizard: the wizard asks which host
> to configure first and writes Cursor's global config
> (`~/.cursor/mcp.json`) as well (see TEST-REPORT.md §12). 0.4.0
> adds a VS Code adapter (Copilot Global config,
> `~/.copilot/mcp-config.json`) and a per-host response budget
> written by the wizard into each host's config (see
> TEST-REPORT.md §13). 0.5.0 raises the Cursor budget to
> 10,000,000 on the 2026-10-30 verified read and adds
> `open_containing_folder` (open a note's folder in the OS file
> manager, only when the user explicitly asks, no highlight or
> selection — see TEST-REPORT.md §14).

## Quick start

Requires Node.js 18+.

**Easiest — setup wizard (recommended for first install).** Download
the release zip, extract it, and run the launcher for your system
(it installs dependencies, builds, and starts the wizard, which
asks which host to configure and which folder to use, and writes
the Claude Desktop, Cursor, or VS Code config):

- Windows: double-click `setup.bat`
- macOS: double-click `setup.command` (or run `./setup.sh` in a terminal)
- Linux: run `./setup.sh` in a terminal

The wizard needs Node.js 18+ already installed; if it is missing, the
launcher says so and offers to open https://nodejs.org for you. It
never installs anything silently and never changes a config file
without backing it up first (see [Setup](#setup-wizard--launchers)).

```bash
# Run without installing (after this package is published to npm):
npx -y memdrive-mcp

# Or from a checkout:
npm install
npm run build
node dist/index.js
```

The library root defaults to `~/memdrive` (created automatically).
Override it with `MEMDRIVE_ROOT`:

```bash
MEMDRIVE_ROOT=~/Documents/memory npx -y memdrive-mcp
```

## Claude Desktop config

The setup wizard (see [Setup](#setup-wizard--launchers)) writes this
for you. Only edit it by hand if the wizard could not find your
config file — it then prints a ready-to-paste snippet instead.

Add this to your Claude Desktop config file (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "memdrive": {
      "command": "npx",
      "args": ["-y", "memdrive-mcp"],
      "env": {
        "MEMDRIVE_ROOT": "/Users/you/Library/CloudStorage/GoogleDrive-you@example.com/My Drive/memory"
      }
    }
  }
}
```

Point `MEMDRIVE_ROOT` at a folder your sync client already manages and the
official client syncs everything to the cloud in the background — MemDrive
itself does zero network auth and zero uploads.

On Windows use a Windows path (`C:\\Users\\you\\OneDrive\\memory`); on
macOS/Linux use a POSIX path. Restart Claude Desktop after editing the
config.

## Cursor config

The setup wizard (see [Setup](#setup-wizard--launchers)) writes this
for you, in Cursor's **global** config file: `%USERPROFILE%\.cursor\mcp.json`
on Windows, `~/.cursor/mcp.json` on macOS/Linux. If that file does not
exist yet but the `.cursor` directory does, the wizard creates it (no
backup is needed — there is nothing to back up); if the directory does
not exist, the wizard writes nothing and prints a ready-to-paste snippet
instead. Project-level `.cursor/mcp.json` files are not written: the
global config makes the server available in every project. Only the
Windows path has been verified on a real machine; the macOS/Linux
paths use the same home-based logic and are marked untested.

```json
{
  "mcpServers": {
    "memdrive": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/memdrive-mcp/dist/index.js"],
      "env": {
        "MEMDRIVE_ROOT": "/absolute/path/to/your/library",
        "MEMDRIVE_RESPONSE_BUDGET_BYTES": "10000000"
      }
    }
  }
}
```

The `type: "stdio"` field is required by Cursor; Claude Desktop entries
carry no `type` field. The wizard writes the 10,000,000-byte budget
above into Cursor's entry (see
[Limits](#limits-all-in-srcconfigts-nowhere-else) for the evidence:
verified 2026-10-30, exact ceiling unmeasured). Restart Cursor after
editing the config, and make sure the server is enabled in Cursor's
MCP settings. Cursor's MCP logs (Output panel → "MCP Logs") are the
first place to look when a tool does not appear.

## VS Code config

The setup wizard (see [Setup](#setup-wizard--launchers)) writes this
for you, in VS Code's **Copilot Global** config file:
`%USERPROFILE%\.copilot\mcp-config.json` on Windows,
`~/.copilot/mcp-config.json` on macOS/Linux. If that file does not
exist yet but the `.copilot` directory does, the wizard creates it (no
backup is needed — there is nothing to back up); if the directory does
not exist, the wizard writes nothing and prints a ready-to-paste snippet
instead. Only the Windows path has been verified on a real machine; the
macOS/Linux paths use the same home-based logic and are marked untested.
The `COPILOT_HOME` environment variable is not read — only the
home-directory location above is used.

```json
{
  "mcpServers": {
    "memdrive": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/memdrive-mcp/dist/index.js"],
      "env": {
        "MEMDRIVE_ROOT": "/absolute/path/to/your/library",
        "MEMDRIVE_RESPONSE_BUDGET_BYTES": "10000000"
      }
    }
  }
}
```

The entry shape above was verified on a real Windows machine (manual
`MCP: Add Server` flow, Copilot Global config): top-level
`mcpServers`, `type: "stdio"`, `command: "node"`, absolute
`dist/index.js` args, and VS Code's own `"tools": ["*"]` field
alongside them. When the wizard merges into an existing entry, that
`tools` field is preserved, as are every other key and every other
server; a freshly created entry gets no `tools` field. The wizard
writes the 10,000,000-byte budget above into VS Code's entry (see
[Limits](#limits-all-in-srcconfigts-nowhere-else) for the evidence:
partly verified, exact ceiling unmeasured). Fully quit and restart
VS Code after editing the config, and make sure the server is enabled
in VS Code's MCP settings. VS Code's MCP logs are the first place to
look when a tool does not appear. Only `list_directory` and a bundled
image read have been verified in VS Code on a real machine so far;
the other tools still need a real-machine check (see
[Roadmap](#roadmap-not-in-this-mvp)).

Optional: raise (or lower) the `read_file` total response budget if your
client allows larger tool results than Claude Desktop's ~1 MB ceiling:

```json
"env": {
  "MEMDRIVE_ROOT": "...",
  "MEMDRIVE_RESPONSE_BUDGET_BYTES": "5000000"
}
```

The default is 950,000 bytes; values are clamped to 100,000–50,000,000.
See [Limits](#limits-all-in-srcconfigts-nowhere-else) before raising it.

## Setup wizard & launchers

`node dist/index.js setup` runs an interactive wizard (no new
dependencies — plain Node `readline`). After npm publish, the same
wizard runs as `npx memdrive-mcp setup`; until the package is
published, use the zip + launcher form below.

What the wizard does, in order:

0. **Chooses a host.** The wizard asks which host to configure —
   1 Claude Desktop, 2 Cursor, 3 VS Code (Enter = 1). You can skip
   the question with an argument: `node dist/index.js setup cursor`
   (or `setup claude` / `setup claude-desktop`, `setup vscode` —
   only that one word, no `vs-code` / `code` alias). The argument
   is an optional shortcut for people who already know which host
   they want; the prompt is the default, foolproof path, including
   for `npx memdrive-mcp setup` and the launchers, which call the
   wizard with no argument. An unrecognised argument falls back
   to the prompt instead of guessing a host.
1. **Finds a library folder.** It probes for existing sync folders —
   OneDrive, Google Drive, iCloud — plus the `~/memdrive` default,
   and shows a numbered menu. Google Drive on Windows is probed in
   three steps: the DriveFS install folder must exist, then a
   PowerShell volume-label probe finds the drive letter, then
   common paths (`G:\My Drive`, `H:\My Drive`, …) are checked for
   existence — no drive letter is ever assumed. You can also type a
   custom absolute path (`~` is expanded). The chosen folder is
   created if it does not exist.
2. **Finds the host config** by probing the known locations.
   Claude Desktop: macOS Application Support; Windows
   `%APPDATA%\Claude` plus the `%LOCALAPPDATA%` Store/per-user
   locations. Cursor: the global config file only,
   `%USERPROFILE%\.cursor\mcp.json` on Windows and
   `~/.cursor/mcp.json` on macOS/Linux, returned only when the
   `.cursor` directory exists. VS Code: the Copilot Global config
   file only, `%USERPROFILE%\.copilot\mcp-config.json` on Windows
   and `~/.copilot/mcp-config.json` on macOS/Linux, returned only
   when the `.copilot` directory exists. Exactly one file → it is
   used; several → you pick one; none → nothing is written and the
   wizard prints a ready-to-paste snippet instead.
3. **Writes the config safely.** An existing file is backed up
   first (`<file>.bak`, or `<file>.bak-<timestamp>` when a backup
   already exists, so an earlier backup is never overwritten). The
   `mcpServers.memdrive` entry (`command: node`, `args: [<absolute
   path to dist/index.js>]`, `env: {MEMDRIVE_ROOT: <chosen folder>}`,
   plus `type: "stdio"` for Cursor and VS Code, plus the host's
   response budget in `env` for Cursor and VS Code — see
   [Limits](#limits-all-in-srcconfigts-nowhere-else); Claude Desktop
   entries carry no budget env) is merged in; every other key and
   every other server is preserved, and an existing entry's
   `"tools": ["*"]` field (VS Code) is carried over. For Cursor and
   VS Code, a missing config file is created instead (the host
   directory already exists), with no backup to take. A corrupt
   config file aborts the write entirely — nothing is backed up,
   nothing is changed. Then it tells you to fully quit and restart
   the host you configured.

The launchers (`setup.bat` for Windows, `setup.sh` for macOS/Linux,
`setup.command` for double-clicking on macOS) are thin shells: they
check for Node.js 18+, run `npm install` + `npm run build` (failures
shown plainly, script stops), then run the wizard. All logic stays
in Node; the scripts contain no configuration of their own.

**Windows SmartScreen note.** If you downloaded the zip from the
internet, Windows may show "Windows protected your PC" when you run
`setup.bat`. That is SmartScreen reacting to a downloaded file, not
evidence of a problem: `setup.bat` is plain text — open it in
Notepad and read it before running if you like. To proceed, click
**More info**, then **Run anyway**. No code signing is used (a paid
certificate is only worth it once the project earns revenue).

**Other hosts.** The wizard writes Claude Desktop, Cursor, and
VS Code config (global config for Cursor, Copilot Global config
for VS Code). The config-writing code is isolated behind a small
per-host adapter so another host can be added later, but only
after that host's config surface is verified on a real machine —
Codex/Gemini are CLIs with no desktop config file, Grok has no
desktop MCP config surface, and no Muse desktop app exists. New
hosts are added only on user feedback after these three.

## Tools

| Tool | What it does |
| --- | --- |
| `list_directory(path?)` | Lists the immediate children of a directory in the library (root by default). |
| `search_files(keyword, path?)` | Recursive keyword search: file names and, for small text files, contents. |
| `save_file(path, content, mode?, images?)` | Writes text (usually Markdown). Modes: `new` (default, refuses to overwrite), `overwrite`, `append`. Parent folders are created automatically. Say "把截图存下来" and the model passes `images: ["clipboard"]` — the server reads the clipboard on your machine; never paste the image into the chat. |
| `read_file(path, include_images?)` | Reads text, or a Markdown file **together with its referenced images** in one response, within one total response budget. Pass `include_images: false` for text only plus the image-path list (step 1 of two-step reading). |
| `open_image(path)` | Opens an image file in the OS default image viewer, at full original quality. Only when the user explicitly asks to view the original — never automatically, and never returns image bytes to the model. |
| `open_containing_folder(path?)` | Opens the folder containing a file (or the folder itself) in the OS file manager, without highlighting or selecting any file. Only when the user explicitly asks to open the folder — never automatically, and never returns folder contents to the model. Omit the path to open the library root. |

### Reading back: packed, two-step, and single-image

One total budget governs every `read_file` response (text bytes +
base64 bytes of all image blocks together, default 950,000). Text is
guaranteed first; images share only what the text leaves. An image
that does not fit is downscaled in memory to fit the remaining budget,
or skipped with a note — the read never fails as a whole because of an
image, and the file on disk is never modified. Three ways to read:

1. **Packed read (default).** `read_file` on a Markdown file returns
   the text together with its referenced images in one response. Best
   for short notes with one or two small pictures. A large screenshot
   (for example ~800 KB on disk, ~1.1 MB as base64) is downscaled in
   memory to fit the budget instead of blowing up the whole response
   the way it did before 0.1.1.
2. **Two-step read (several images, or one large image).** First call
   `read_file` with `include_images: false`: you get the text plus the
   list of referenced image paths (library-relative, e.g.
   `notes/assets/shot-....png`). Then call `read_file` once per image
   path. Each direct image read gets the *whole* budget to itself, so
   each picture keeps the best quality the budget allows — this is the
   way to get a large screenshot back at full usable quality.
3. **Single-image read.** `read_file` on an image path directly
   returns that one image. It is subject to the same total budget: the
   image is returned untouched when it fits, and downscaled in memory
   only when the image itself exceeds the budget (or the 3.5 MB
   per-image ceiling). If an image cannot be fitted within the budget
   at all (for example a format the built-in decoder cannot shrink),
   the result is text explaining that, not an error.

### Viewing an original image: `open_image`

`read_file` returns a preview that fits the response budget — good
enough to read, not always the original pixels. When the user
explicitly asks to view the original ("open this image", "在系统里打开这张图"),
`open_image` opens the file in the operating system's default image
viewer (Photos on Windows/macOS, the default viewer on Linux) at
full quality. The tool returns only a short text confirmation; no
image bytes go to the model.

The rule is written into the tool description itself: the model must
only call `open_image` on an explicit user request, never
automatically after a read or a save. Opening a viewer window is a
visible side effect on the user's screen, and unprompted popups are
not acceptable. Only image files inside the library root open;
non-images, directories, missing files, and sandbox escapes are
rejected, and the viewer is launched with an argument array (never
a shell string), so a crafted filename cannot inject a command.

### Opening a note's folder: `open_containing_folder`

When the user explicitly asks to open a note's folder in the system
("open the folder", "在系统里打开这个笔记所在的文件夹"),
`open_containing_folder` opens that folder in the operating system's
file manager (Explorer on Windows, Finder on macOS, the default file
manager on Linux). A file opens its parent folder; a folder opens
itself; an empty path opens the whole library root. The folder opens
without highlighting or selecting any file — no `explorer /select`,
no Finder selection, no reveal-with-selection.

The rule is written into the tool description itself, the same way
as `open_image`: only on an explicit user request, never
automatically after a read or a save. The tool returns only a short
text confirmation naming the folder opened; no folder contents go to
the model (use `list_directory` to see what is in the folder).
Only paths inside the library root open; missing paths and sandbox
escapes are rejected, nothing is modified, and the folder is
launched with an argument-array launcher (never a shell string),
so a crafted filename cannot inject a command. On Windows the
folder launch goes through the shell (`cmd /c start "" explorer.exe
/n,<path>`, switch and path in one comma-joined argument), so the
folder opens as a new Explorer window every time instead of a hidden
tab in an already-open Explorer window; image files still open
through the normal viewer launch, unchanged.

### Saving with images

`save_file` accepts an `images` array mixing three source kinds.
Clipboard comes first, because it is the one people get wrong:

- **The literal string `"clipboard"` — first choice for screenshots.**
  Just tell the model "把截图存下来" / "把剪贴板里的图存下来".
  The server reads the clipboard directly on your own machine. You do
  not need to paste, upload, or send the image into the chat, and the
  model must never claim it cannot read the clipboard or that the
  library is text-only. (This rule is written at the very top of the
  `save_file` tool description, so the model sees it before anything
  else.)
- **Local file paths** — e.g. `~/Pictures/shot.png` (quotes stripped, `~` expanded).
- **http(s) URLs** — downloaded directly, zero token cost.

Images land in a sibling `assets/` folder, renamed
`<document-name>-<timestamp>.<ext>`, and for Markdown files a standard
`![alt](assets/...)` reference is appended automatically. Originals are
always kept at full quality.

**Interaction rule (built into the tool description):** before calling
`save_file`, the model must show you the exact destination path and
filename and get your confirmation in the chat. There is no popup — the
confirmation happens in the conversation.

### Clipboard edge cases

- Clipboard empty or holding text instead of an image: the text is still
  saved; the result tells you to re-screenshot.
- Headless environments (Docker, servers, NAS): clipboard capture reports
  itself as unsupported with a suggestion to use a file path or URL.
  The server never crashes on clipboard/image failures.

## Limits (all in `src/config.ts`, nowhere else — except the response budget, which is also env-overridable)

| Constant | Value | Meaning |
| --- | --- | --- |
| `RESPONSE_BUDGET_DEFAULT_BYTES` | 950,000 | Default total budget for one `read_file` response: UTF-8 bytes of the text block plus base64 bytes of every image block, counted together. Overridable with `MEMDRIVE_RESPONSE_BUDGET_BYTES`, clamped to 100,000–50,000,000 (`RESPONSE_BUDGET_MIN/MAX_BYTES`). The wizard writes a per-host override into Cursor's and VS Code's config entries (see the per-host table below); Claude Desktop and unknown hosts keep this default. |
| `TEXT_MAX_BYTES` | 1,000,000 | Text returned by `read_file` is truncated here (with a note) — and also at the total budget, whichever is smaller. Text is guaranteed first; images get only the remainder. |
| `IMAGE_PREVIEW_MAX_BYTES` | 3,500,000 | Per-image preview ceiling (binary bytes). Image previews are downscaled in memory below this *and* below what the remaining response budget allows, whichever is smaller. The preview ladder tries a full-resolution JPEG re-encode first, trying JPEG qualities 95, 90, then 80 before shrinking, then shrinks in 0.9 steps at quality 80, returning the first attempt that fits — so the preview stays close to the largest size the budget allows instead of stopping at a coarse first shrink, and spends headroom on sharpness when full resolution already fits. The on-disk original is never modified. |

Why a total budget, and why 950,000: Claude Desktop rejects a whole
tool result over 1,048,576 bytes. The old per-part caps (1 MB text,
3.5 MB per image, no combined check) let a bundled read blow past
that wall — in the real 2026-10-28 test, an 813.5 KB screenshot
became ~1.11 MB of base64 and the entire read was rejected. 950,000
leaves ~98 KB of headroom for JSON framing and notes. Raise the
budget only if your client demonstrably accepts larger results; the
server cannot detect a client's limit (MCP `initialize` carries no
host/limit information, and no `clientInfo` identification is done),
so the default stays at the lowest known ceiling and is treated as
universal across Claude Desktop plans and unknown hosts. Three
different limits are at work — the host's result cap, this server's
budget and 3.5 MB per-image ceiling, and the model's own
pixel/token scaling — and the `read_file` tool description states
all three, so the model does not have to guess which one bit.

Per-host response budgets (written by the wizard into each host's
config entry as `MEMDRIVE_RESPONSE_BUDGET_BYTES`; the server cannot
identify the host, so the env value is the only way to pass the
budget through). Do not read more into the Cursor and VS Code rows
than the evidence states: Cursor is verified and VS Code is partly
verified, and neither exact ceiling was measured.

| Host | Budget | Evidence |
| --- | --- | --- |
| Claude Desktop | 950,000 | Verified: 2026-10-28 single-variable experiment — with the budget disabled via the environment variable, the same bundled read failed twice with the exact 1,048,576 error; 950,000 leaves ~98 KB of headroom for JSON framing and notes. |
| Cursor | 10,000,000 | Verified: 2026-10-30 single bundled read passed (`notes/测试A.md`, four distinct image references, `include_images` default true, test budget 50,000,000, 26 seconds, no host size error); each preview reported as 2.24 MB downscaled in memory, original untouched, totalling ~8.96 MB binary / ~11.95 MB base64; ~2 MB of headroom is left; the exact ceiling was not measured and the ladder is closed. The test line was then restored to 10,000,000 and a normal read re-verified. |
| VS Code | 10,000,000 | Partly verified: 2026-10-29 four-image bundled read passed (`notes/测试A.md`, four distinct copies of a 10.44 MB PNG); each preview reported as 2.24 MB to two decimals, totalling ~8.96 MB binary / ~11.95 MB base64; ~2 MB of headroom is left; the exact ceiling was not measured and the ladder is closed — no further probing. |

ChatGPT, Grok, and other hosts are untested for the limit; the
950,000 default is treated as universal for unknown hosts rather
than assuming a larger limit any of them has not demonstrated.

Why 3.5 MB: base64 inflates binary by 4/3, so 3.5 MB becomes ~4.67 MB of
base64 text, under every vendor image cap checked in the official docs
(5 MB Bedrock/Vertex, 7 MB Gemini, 10 MB Claude API, 20 MB OpenAI).
Do not raise it without re-checking those docs. It still caps any
single preview even when the total budget is raised above it.

Other caps: at most 20 referenced images per `read_file` response (the
total budget usually binds first);
`search_files` returns at most 200 hits and only content-searches files
under 256 KB; URL downloads have a 30 s timeout and a 500 MB safety
ceiling (a disk-exhaustion guard, not a product limit).

## Security

- **Root sandbox (hard).** Every path is locked to `MEMDRIVE_ROOT`. `../`
  escapes, absolute paths outside the root, and symlinks inside the root
  that point outside are all rejected — including symlinks in the parent
  chain of not-yet-created files. Violations return a clear error.
- **Local image sources are OS paths, not library paths.** A `save_file`
  image entry like `~/Pictures/shot.png` intentionally reads from outside
  the root; only the *destination* is sandboxed.
- **No network listeners.** stdio transport only; nothing is exposed.
- **Zero native dependencies.** Pure-JS dependency tree (MCP SDK, zod,
  jimp). No `node-gyp`, no C++ builds, no Sharp.
- **Image formats.** jimp (the pure-JS decoder) reads PNG/JPEG/GIF/BMP/
  TIFF. WebP files pass through untouched when under the preview cap and
  are reported (not crashed on) when over it; SVG files are returned as
  text, never as image blocks; GIFs read as their first frame.

## Verifying with MCP Inspector (step 1, zero model cost)

```bash
npm run build
npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/list
npx -y @modelcontextprotocol/inspector --cli node dist/index.js --method tools/call --tool-name list_directory
```

Note: the Inspector CLI spawns the server with its own environment, so
`MEMDRIVE_ROOT` set in your shell may not reach it — it defaults to
`~/memdrive`. The interactive Inspector UI (`npx @modelcontextprotocol/inspector`
without `--cli`) lets you set environment variables explicitly.

## Development

```bash
npm install
npm run build      # tsc, strict
npm run typecheck  # tsc --noEmit
npm test           # protocol tests: SDK Client over stdio (see TEST-REPORT.md)
```

The SDK version is pinned exactly (`@modelcontextprotocol/sdk` 1.32.2,
the v1.x maintenance line) and `package-lock.json` is committed. The SDK
has a v2 line under separate package names; this project deliberately
stays on v1.x until there is a reason to migrate.

## Roadmap (not in this MVP)

- WebDAV: interface reserved behind the existing `StorageBackend`
  interface but not implemented. Whether it is implemented later
  depends on user feedback, and it will only be considered if the
  user base is large with clear demand.
- Windows clipboard capture verified on real hardware (2026-10-28,
  screenshot save via Claude Desktop); the macOS clipboard branch is
  still implemented from the documented OS pattern only — no macOS
  machine was available. The 0.1.3 quality ladder passed its
  real-conversation retest in Claude Desktop (2026-10-28: 359.0 KB
  preview of the 1.22 MB comment screenshot, original untouched).
- Still to verify on a real Windows machine (see TEST-REPORT.md
  §14): the setup wizard's VS Code path end-to-end (host prompt
  choice 3 and `setup vscode` argument, Copilot Global config
  creation/merge with `"tools": ["*"]` preserved, restart VS Code,
  all six tools in VS Code — only `list_directory` and a bundled
  image read have been verified there so far), the wizard's Cursor
  path end-to-end (host prompt and argument, global config
  creation, restart Cursor, tools + read/save/open_image/
  open_containing_folder in Cursor), `open_containing_folder`
  opening a folder once in each host, and a Claude Desktop
  regression check (its entry is byte-identical); the macOS wizard branches
  (`setup.command`, iCloud/Google Drive candidates, `open`) and the
  PowerShell Google Drive probe are untested on real hardware.
  No further Cursor or VS Code size-limit probing is planned.

## License

MIT — see [LICENSE](LICENSE).

## Support

If MemDrive saves you time, you can support its development. Thank you!

- **Ko-fi:** [ko-fi.com/newmannn91](https://ko-fi.com/newmannn91)
- **USDT (TRC-20 only):** send only TRC-20 USDT to the address below. Do not send other tokens or use another network — they cannot be recovered.

```
TU9GBiQ1Ji1Fm5YECYThjcchTofj8B6uCD
```

<img src="docs/usdt-qr.png" alt="USDT (TRC-20) QR code" width="220">

- **WeChat Pay:** scan the code below.

微信用户可扫码赞赏。

<img src="docs/wechat-qr.png" alt="WeChat Pay QR code" width="220">
