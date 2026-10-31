/**
 * Host configuration writing, behind a small adapter per host.
 *
 * Wizard targets Claude Desktop, Cursor, VS Code, and Claude Code
 * for automatic config writes. Adding another host later means adding one adapter
 * object (how to find that host's config files, and under which key
 * the server entry lives) — the backup / parse / merge / write logic
 * below is shared and host-independent. Other hosts are deliberately
 * NOT added here until each one's config surface is verified on a
 * real machine: Codex and Gemini are CLIs with no desktop config
 * file, Grok has no desktop MCP config surface, and no Muse
 * desktop app exists. EXCEPTION: Claude Code (0.6.0) was added
 * on the basis of Anthropic's official docs only (checked
 * 2026-10-31, code.claude.com), with NO real-machine test; its
 * budget is an estimate, not a measurement (see below), and
 * that status is stated in the README, CHANGELOG, and
 * TEST-REPORT. Never present Claude Code support as verified.
 *
 * Safety rules, for every host:
 *   - Only files that already exist are ever written, with ONE
 *     exception: Cursor's and VS Code's global config files are
 *     created when missing AND the host's config directory already
 *     exists (evidence the host is installed; each host itself
 *     creates the file when a server is added from its UI). A
 *     missing Claude Desktop or Claude Code config file is
 *     reported, never created: `~/.claude.json` is Claude Code's
 *     own main state file, not a dedicated MCP file, and
 *     creating a bare copy was never verified on a real machine
 *     (B方案, user decision 2026-10-31; the wizard prints the
 *     ready-to-paste snippet instead).
 *   - A backup is written BEFORE any change to an existing file:
 *     `<file>.bak` when no backup exists yet, otherwise
 *     `<file>.bak-<timestamp>`, so an earlier backup is never
 *     overwritten. A newly created file has nothing to back up.
 *   - Corrupt JSON, a non-object document, or a non-object
 *     `mcpServers` value aborts the write entirely: nothing is
 *     backed up, nothing is written, and the caller gets a clear
 *     reason. The user's config is never "repaired" by guessing.
 *   - The merge preserves every other key and every other server.
 *     Only the one server entry is added or replaced. When the
 *     existing entry carries a host-generated field the new entry
 *     does not define — VS Code's `"tools": ["*"]` — that field
 *     is carried over to the merged entry; a freshly created
 *     entry never gains it.
 *   - Per-host response budgets: the server cannot tell hosts
 *     apart (MCP `initialize` carries no host/limit information,
 *     and no `clientInfo` identification is done here), so the
 *     wizard writes the budget into each host's own config entry
 *     as `MEMDRIVE_RESPONSE_BUDGET_BYTES` (see
 *     `responseBudgetBytes` on the adapter). Claude Desktop gets
 *     no budget env and keeps the server default of 950,000
 *     (verified: 2026-10-28 single-variable experiment, budget
 *     disabled, same bundled read failed twice with the exact
 *     1,048,576 error; 950,000 leaves ~98 KB headroom). Cursor
 *     gets 10,000,000 (verified: 2026-10-30 single bundled read
 *     of notes/测试A.md with a 50,000,000 test budget passed in
 *     26 seconds with no host size error; four image references,
 *     each preview downscaled in memory to 2.24 MB, original
 *     untouched; ~8.96 MB binary / ~11.95 MB base64, ~2 MB
 *     headroom; exact ceiling unmeasured, ladder closed; the
 *     test line was then restored to 10,000,000 and a normal
 *     read re-verified). VS Code gets 10,000,000 (partly
 *     verified: 2026-10-29 four-image bundled read passed, four
 *     distinct 10.44 MB PNG copies, ~8.96 MB binary /
 *     ~11.95 MB base64 from two-decimal previews, ~2 MB
 *     headroom; exact ceiling unmeasured, ladder closed).
 *     Claude Code gets 10,000,000 — ESTIMATED, UNVERIFIED
 *     (user decision 2026-10-31, no real-machine test: Code is
 *     a paid product, so its limit cannot reasonably be as
 *     stingy as Desktop's; if the estimate is wrong, user
 *     reports will drive a patch). Claude Code also applies
 *     its OWN output limits on top of this server-side budget
 *     (default 25,000 tokens per tool result; long text
 *     results are spilled to a file), so this value controls
 *     only how much the server sends, not how much the model
 *     sees inline; see the README budget table.
 */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** The MCP server entry written into a host config file. */
export interface HostConfigEntry {
  /**
   * Transport type, when the host requires it. Cursor stdio
   * entries require `type: "stdio"`; Claude Desktop entries
   * carry no `type` field, so this stays unset for Claude and
   * `JSON.stringify` omits it.
   */
  type?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** How to locate and address one host's config file(s). */
export interface HostConfigAdapter {
  /** Stable id, e.g. 'claude-desktop'. */
  id: string;
  /** Human-readable name shown in wizard output. */
  displayName: string;
  /** Top-level key holding the server map (Claude Desktop: `mcpServers`). */
  serversKey: string;
  /** Key for this server inside the server map (Claude Desktop: `memdrive`). */
  serverKey: string;
  /**
   * Transport type written into the entry, when the host requires
   * one. Cursor: `'stdio'`; Claude Desktop: unset.
   */
  entryType?: string;
  /**
   * Per-host total response budget written into the entry's `env`
   * as `MEMDRIVE_RESPONSE_BUDGET_BYTES`, when defined. The server
   * cannot identify the host, so this is the only way to give each
   * host its measured budget: Claude Desktop: unset (server
   * default 950,000, verified 2026-10-28); Cursor: 10,000,000
   * (verified 2026-10-30, exact ceiling unmeasured);
   * VS Code: 10,000,000 (partly verified 2026-10-29, exact
   * ceiling unmeasured); Claude Code: 10,000,000
   * (ESTIMATED, UNVERIFIED — user decision 2026-10-31, no
   * real-machine test; see the file header). See the file header for the evidence.
   */
  responseBudgetBytes?: number;
  /**
   * When true, a missing config file is created (only when the
   * host's config directory already exists — see the adapter).
   * When false, a missing file is reported and never created.
   */
  createIfMissing?: boolean;
  /** Existing config files for this host, deduped. Empty when the host is not installed. */
  findConfigPaths: (deps: HostProbeDeps) => Promise<string[]>;
}

/**
 * Injectable environment for probing: the real process values by
 * default, fakes in tests. `exists`/`readdir` are async so the same
 * code path serves real disks and temp-dir fixtures.
 */
export interface HostProbeDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  exists?: (filePath: string) => Promise<boolean> | boolean;
  readdir?: (dirPath: string) => Promise<string[]>;
}

function probePlatform(deps: HostProbeDeps): NodeJS.Platform {
  return deps.platform ?? process.platform;
}

function probeEnv(deps: HostProbeDeps): NodeJS.ProcessEnv {
  return deps.env ?? process.env;
}

function probeHome(deps: HostProbeDeps): string {
  return deps.homeDir ?? homedir();
}

async function probeExists(
  deps: HostProbeDeps,
  filePath: string,
): Promise<boolean> {
  if (deps.exists !== undefined) {
    return deps.exists(filePath);
  }
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function probeReaddir(
  deps: HostProbeDeps,
  dirPath: string,
): Promise<string[]> {
  if (deps.readdir !== undefined) {
    return deps.readdir(dirPath);
  }
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

/** Path module matching the probed platform (win32 paths on Windows). */
export function pathModuleFor(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * Expand a pattern containing exactly one `*` segment (e.g.
 * `<dir>/Claude-Data\/*\/claude_desktop_config.json`): list the
 * parent directory, keep entries matching the starred segment, and
 * re-join the remaining segments. Returns only paths that exist.
 * No glob library, no recursion, no `**`.
 */
export async function expandOneStarPattern(
  pattern: string,
  pathMod: typeof path.posix,
  deps: HostProbeDeps,
): Promise<string[]> {
  const segments = pattern.split(pathMod.sep);
  const starIndex = segments.findIndex((segment) => segment.includes('*'));
  if (starIndex === -1) {
    return (await probeExists(deps, pattern)) ? [pattern] : [];
  }
  const parent = segments.slice(0, starIndex).join(pathMod.sep);
  const starSegment = segments[starIndex] as string;
  const rest = segments.slice(starIndex + 1);
  const matcher = new RegExp(
    `^${starSegment
      .split('*')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*')}$`,
  );
  const entries = await probeReaddir(deps, parent === '' ? pathMod.sep : parent);
  const results: string[] = [];
  for (const entry of entries) {
    if (!matcher.test(entry)) {
      continue;
    }
    const candidate = pathMod.join(parent, entry, ...rest);
    if (await probeExists(deps, candidate)) {
      results.push(candidate);
    }
  }
  return results;
}

function dedupePaths(paths: string[], pathMod: typeof path.posix): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const key =
      pathMod === path.win32 ? p.toLowerCase() : p;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(p);
    }
  }
  return out;
}

/**
 * Claude Desktop config locations, probed in order. Windows has two
 * extra glob locations because Claude Desktop on Windows (Store /
 * per-user installs) stores its config under versioned
 * `%LOCALAPPDATA%` directories as well as the classic
 * `%APPDATA%\Claude` path; the glob patterns only ever return files
 * that actually exist.
 */
export const claudeDesktopAdapter: HostConfigAdapter = {
  id: 'claude-desktop',
  displayName: 'Claude Desktop',
  serversKey: 'mcpServers',
  serverKey: 'memdrive',
  findConfigPaths: async (deps: HostProbeDeps): Promise<string[]> => {
    const platform = probePlatform(deps);
    const env = probeEnv(deps);
    const home = probeHome(deps);
    const pathMod = pathModuleFor(platform);
    const patterns: string[] = [];
    if (platform === 'darwin') {
      patterns.push(
        pathMod.join(
          home,
          'Library',
          'Application Support',
          'Claude',
          'claude_desktop_config.json',
        ),
      );
    } else if (platform === 'win32') {
      const appData = env['APPDATA'];
      const localAppData = env['LOCALAPPDATA'];
      if (appData) {
        patterns.push(
          pathMod.join(appData, 'Claude', 'claude_desktop_config.json'),
        );
      }
      if (localAppData) {
        patterns.push(
          pathMod.join(
            localAppData,
            'Packages',
            'Claude_*',
            'LocalCache',
            'Roaming',
            'Claude',
            'claude_desktop_config.json',
          ),
        );
        patterns.push(
          pathMod.join(
            localAppData,
            'Claude-Data',
            '*',
            'claude_desktop_config.json',
          ),
        );
      }
    } else {
      return [];
    }
    const found: string[] = [];
    for (const pattern of patterns) {
      found.push(...(await expandOneStarPattern(pattern, pathMod, deps)));
    }
    return dedupePaths(found, pathMod);
  },
};

/**
 * Cursor global config: `<home>/.cursor/mcp.json` on every platform
 * (Windows: `%USERPROFILE%\.cursor\mcp.json`). The path is returned
 * only when the `<home>/.cursor` directory already exists — evidence
 * the host is installed. The file itself may not exist yet (fresh
 * install); `createIfMissing` then lets the writer create it.
 * Project-level `.cursor/mcp.json` files are deliberately NOT
 * probed: the wizard writes the global config only. Stale legacy
 * paths from old articles (`globalStorage/mcp.json`,
 * `mcp-servers.json`) are deliberately NOT checked.
 */
export const cursorAdapter: HostConfigAdapter = {
  id: 'cursor',
  displayName: 'Cursor',
  serversKey: 'mcpServers',
  serverKey: 'memdrive',
  entryType: 'stdio',
  responseBudgetBytes: 10_000_000,
  createIfMissing: true,
  findConfigPaths: async (deps: HostProbeDeps): Promise<string[]> => {
    const platform = probePlatform(deps);
    const home = probeHome(deps);
    const pathMod = pathModuleFor(platform);
    const configDir = pathMod.join(home, '.cursor');
    if (!(await probeExists(deps, configDir))) {
      return [];
    }
    return [pathMod.join(configDir, 'mcp.json')];
  },
};

/**
 * VS Code Copilot Global config: `<home>/.copilot/mcp-config.json` on
 * every platform (Windows: `%USERPROFILE%\.copilot\mcp-config.json`).
 * The path is returned only when the `<home>/.copilot` directory
 * already exists — evidence the host is installed (VS Code itself
 * creates the file when a server is added from its UI). The file
 * itself may not exist yet; `createIfMissing` then lets the writer
 * create it. `COPILOT_HOME` is deliberately NOT read: only the
 * home-directory location above is probed (it is untested). The
 * entry shape was verified on a real Windows machine: top-level
 * `mcpServers`, entry `type: "stdio"`, `command: "node"`, absolute
 * `dist/index.js` args, plus VS Code-generated `"tools": ["*"]`
 * alongside them — the merge preserves `tools` (see
 * `mergeConfigJson`). macOS/Linux paths use the same home-based
 * logic and are marked untested.
 */
export const vscodeAdapter: HostConfigAdapter = {
  id: 'vscode',
  displayName: 'VS Code',
  serversKey: 'mcpServers',
  serverKey: 'memdrive',
  entryType: 'stdio',
  responseBudgetBytes: 10_000_000,
  createIfMissing: true,
  findConfigPaths: async (deps: HostProbeDeps): Promise<string[]> => {
    const platform = probePlatform(deps);
    const home = probeHome(deps);
    const pathMod = pathModuleFor(platform);
    const configDir = pathMod.join(home, '.copilot');
    if (!(await probeExists(deps, configDir))) {
      return [];
    }
    return [pathMod.join(configDir, 'mcp-config.json')];
  },
};

/**
 * Claude Code, user scope: the top-level `mcpServers` key of the
 * ONE `~/.claude.json` file (Windows:
 * `%USERPROFILE%\.claude.json`). Local scope (per-project entry
 * inside the same file) and project scope (`.mcp.json` in a
 * project root) are deliberately NOT probed: the wizard writes
 * the user-global config only, matching the Cursor/VS Code
 * global-only rule. When `CLAUDE_CONFIG_DIR` is set and
 * non-empty, the file lives inside that directory instead, per
 * the official docs. The file is returned ONLY when it already
 * exists (B方案): a missing file is reported and never created,
 * because `~/.claude.json` is Claude Code's own main state file
 * and creating a bare copy was never verified. The entry carries
 * NO `type` field: an entry without a `type` is read as a stdio
 * server, the same shape as the Claude Desktop entry.
 * Budget 10,000,000 is ESTIMATED, UNVERIFIED (user decision
 * 2026-10-31; see the file header). Verified only against
 * Anthropic's official docs (2026-10-31), never on a real
 * machine.
 */
export const claudeCodeAdapter: HostConfigAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  serversKey: 'mcpServers',
  serverKey: 'memdrive',
  responseBudgetBytes: 10_000_000,
  findConfigPaths: async (deps: HostProbeDeps): Promise<string[]> => {
    const env = probeEnv(deps);
    const home = probeHome(deps);
    const pathMod = pathModuleFor(probePlatform(deps));
    const override = env['CLAUDE_CONFIG_DIR']?.trim();
    const configPath = override
      ? pathMod.join(pathMod.resolve(home, override), '.claude.json')
      : pathMod.join(home, '.claude.json');
    return (await probeExists(deps, configPath)) ? [configPath] : [];
  },
};

/** All host adapters, in wizard menu order: Claude Desktop first. */
export const HOST_ADAPTERS: HostConfigAdapter[] = [
  claudeDesktopAdapter,
  cursorAdapter,
  vscodeAdapter,
  claudeCodeAdapter,
];

export type HostId = 'claude-desktop' | 'cursor' | 'vscode' | 'claude-code';

/**
 * Parse the optional host argument after `setup`
 * (`node dist/index.js setup cursor`). Returns the host id, or
 * null when no argument was given or it is unrecognised — the
 * caller then falls back to prompting, never guessing a host.
 * Matching is case-insensitive after trimming; `claude-desktop`
 * is accepted as an alias for `claude`. Only the single word
 * `vscode` selects VS Code: `vs-code` and `code` are NOT aliases
 * and fall back to the prompt, never guessed. Only
 * `claude-code` selects Claude Code: `code` is NOT an alias for
 * it either.
 */
export function parseHostArgument(
  input: string | undefined,
): HostId | null {
  if (input === undefined) {
    return null;
  }
  const word = input.trim().toLowerCase();
  if (word === '') {
    return null;
  }
  if (word === 'claude' || word === 'claude-desktop') {
    return 'claude-desktop';
  }
  if (word === 'claude-code') {
    return 'claude-code';
  }
  if (word === 'cursor') {
    return 'cursor';
  }
  if (word === 'vscode') {
    return 'vscode';
  }
  return null;
}

/** Adapter for a parsed host id. */
export function hostAdapterForId(id: HostId): HostConfigAdapter {
  if (id === 'cursor') {
    return cursorAdapter;
  }
  if (id === 'vscode') {
    return vscodeAdapter;
  }
  if (id === 'claude-code') {
    return claudeCodeAdapter;
  }
  return claudeDesktopAdapter;
}

/** Timestamp stem for numbered backups: `20261029-102800-123`. */
export function backupTimestamp(date: Date): string {
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
    `-${pad(date.getMilliseconds(), 3)}`
  );
}

/**
 * Backup path for a config file: `<file>.bak` when no backup exists
 * yet, otherwise `<file>.bak-<timestamp>`. Pure given an existence
 * predicate, so the "never overwrite an earlier backup" rule is
 * directly testable.
 */
export function backupPathFor(
  configPath: string,
  existsSync: (filePath: string) => boolean,
  now: Date = new Date(),
): string {
  const plain = `${configPath}.bak`;
  if (!existsSync(plain)) {
    return plain;
  }
  return `${plain}-${backupTimestamp(now)}`;
}

export type MergeConfigResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

/**
 * Pure merge: parse `existingText` as JSON and return the config
 * text with `entry` installed under
 * `serversKey.serverKey`, preserving every other key and server.
 * A host-generated field on the existing entry that the new entry
 * does not define — VS Code's `"tools"` — is carried over to the
 * merged entry (generic: any host, any such field named `tools`);
 * when there is no existing entry, or the new entry already
 * defines `tools`, nothing extra is added. Fails (without
 * producing text) on corrupt JSON, a non-object document, or a
 * non-object servers map — the caller must then write nothing.
 */
export function mergeConfigJson(
  existingText: string,
  adapter: HostConfigAdapter,
  entry: HostConfigEntry,
): MergeConfigResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(existingText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Config file is not valid JSON: ${message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      reason: 'Config file does not contain a JSON object; refusing to modify it.',
    };
  }
  const doc = parsed as Record<string, unknown>;
  const existingServers = doc[adapter.serversKey];
  if (existingServers !== undefined) {
    if (
      typeof existingServers !== 'object' ||
      existingServers === null ||
      Array.isArray(existingServers)
    ) {
      return {
        ok: false,
        reason: `Config file's "${adapter.serversKey}" is not a JSON object; refusing to modify it.`,
      };
    }
  }
  const existingEntry = (existingServers as Record<string, unknown> | undefined)?.[
    adapter.serverKey
  ];
  let effectiveEntry: Record<string, unknown> = { ...entry };
  if (
    typeof existingEntry === 'object' &&
    existingEntry !== null &&
    !Array.isArray(existingEntry) &&
    'tools' in existingEntry &&
    !('tools' in effectiveEntry)
  ) {
    effectiveEntry = {
      ...effectiveEntry,
      tools: (existingEntry as Record<string, unknown>)['tools'],
    };
  }
  const servers = {
    ...((existingServers as Record<string, unknown> | undefined) ?? {}),
    [adapter.serverKey]: effectiveEntry,
  };
  const merged = { ...doc, [adapter.serversKey]: servers };
  return { ok: true, text: `${JSON.stringify(merged, null, 2)}\n` };
}

export type WriteConfigResult =
  | { status: 'written'; configPath: string; backupPath: string }
  | { status: 'created'; configPath: string }
  | { status: 'missing'; configPath: string; message: string }
  | { status: 'corrupt'; configPath: string; message: string };

/**
 * Write `entry` into a host config file via `adapter`: back up
 * first, then merge and write. Missing files are never created
 * unless the adapter sets `createIfMissing` (Cursor and VS Code,
 * and only when the host directory already exists — the caller
 * decides that via `findConfigPaths`); a created file takes no
 * backup. Corrupt files are never touched. The `fs` parameter is
 * injectable for temp-dir tests; defaults to the real filesystem.
 */
export async function writeHostConfig(
  adapter: HostConfigAdapter,
  configPath: string,
  entry: HostConfigEntry,
  fileSystem: {
    readFile: (path: string, encoding: 'utf8') => Promise<string>;
    writeFile: (path: string, data: string, encoding: 'utf8') => Promise<void>;
    copyFile: (src: string, dest: string) => Promise<void>;
    access: (path: string) => Promise<void>;
    mkdir?: typeof fs.mkdir;
  } = fs,
): Promise<WriteConfigResult> {
  let existing: string;
  try {
    existing = await fileSystem.readFile(configPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (!adapter.createIfMissing) {
        return {
          status: 'missing',
          configPath,
          message: `Config file not found: ${configPath}. Nothing was written.`,
        };
      }
      const created = {
        [adapter.serversKey]: { [adapter.serverKey]: entry },
      };
      const mkdirFn = fileSystem.mkdir ?? fs.mkdir;
      await mkdirFn(path.dirname(configPath), { recursive: true });
      await fileSystem.writeFile(
        configPath,
        `${JSON.stringify(created, null, 2)}\n`,
        'utf8',
      );
      return { status: 'created', configPath };
    }
    throw error;
  }
  const merged = mergeConfigJson(existing, adapter, entry);
  if (!merged.ok) {
    return { status: 'corrupt', configPath, message: merged.reason };
  }
  const backupExists = async (p: string): Promise<boolean> => {
    try {
      await fileSystem.access(p);
      return true;
    } catch {
      return false;
    }
  };
  const plainBackup = `${configPath}.bak`;
  const backupPath = (await backupExists(plainBackup))
    ? `${plainBackup}-${backupTimestamp(new Date())}`
    : plainBackup;
  await fileSystem.copyFile(configPath, backupPath);
  await fileSystem.writeFile(configPath, merged.text, 'utf8');
  return { status: 'written', configPath, backupPath };
}
