/**
 * Host configuration writing, behind a small adapter per host.
 *
 * Wizard targets Claude Desktop, Cursor, and VS Code for automatic
 * config writes. Adding another host later means adding one adapter
 * object (how to find that host's config files, and under which key
 * the server entry lives) — the backup / parse / merge / write logic
 * below is shared and host-independent. Other hosts are deliberately
 * NOT added here until each one's config surface is verified on a
 * real machine: Codex and Gemini are CLIs with no desktop config
 * file, Grok has no desktop MCP config surface, and no Muse
 * desktop app exists.
 *
 * Safety rules, for every host:
 *   - Only files that already exist are ever written, with ONE
 *     exception: Cursor's and VS Code's global config files are
 *     created when missing AND the host's config directory already
 *     exists (evidence the host is installed; each host itself
 *     creates the file when a server is added from its UI). A
 *     missing Claude config file is reported, never created.
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
 */
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
function probePlatform(deps) {
    return deps.platform ?? process.platform;
}
function probeEnv(deps) {
    return deps.env ?? process.env;
}
function probeHome(deps) {
    return deps.homeDir ?? homedir();
}
async function probeExists(deps, filePath) {
    if (deps.exists !== undefined) {
        return deps.exists(filePath);
    }
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function probeReaddir(deps, dirPath) {
    if (deps.readdir !== undefined) {
        return deps.readdir(dirPath);
    }
    try {
        return await fs.readdir(dirPath);
    }
    catch {
        return [];
    }
}
/** Path module matching the probed platform (win32 paths on Windows). */
export function pathModuleFor(platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}
/**
 * Expand a pattern containing exactly one `*` segment (e.g.
 * `<dir>/Claude-Data\/*\/claude_desktop_config.json`): list the
 * parent directory, keep entries matching the starred segment, and
 * re-join the remaining segments. Returns only paths that exist.
 * No glob library, no recursion, no `**`.
 */
export async function expandOneStarPattern(pattern, pathMod, deps) {
    const segments = pattern.split(pathMod.sep);
    const starIndex = segments.findIndex((segment) => segment.includes('*'));
    if (starIndex === -1) {
        return (await probeExists(deps, pattern)) ? [pattern] : [];
    }
    const parent = segments.slice(0, starIndex).join(pathMod.sep);
    const starSegment = segments[starIndex];
    const rest = segments.slice(starIndex + 1);
    const matcher = new RegExp(`^${starSegment
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`);
    const entries = await probeReaddir(deps, parent === '' ? pathMod.sep : parent);
    const results = [];
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
function dedupePaths(paths, pathMod) {
    const seen = new Set();
    const out = [];
    for (const p of paths) {
        const key = pathMod === path.win32 ? p.toLowerCase() : p;
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
export const claudeDesktopAdapter = {
    id: 'claude-desktop',
    displayName: 'Claude Desktop',
    serversKey: 'mcpServers',
    serverKey: 'memdrive',
    findConfigPaths: async (deps) => {
        const platform = probePlatform(deps);
        const env = probeEnv(deps);
        const home = probeHome(deps);
        const pathMod = pathModuleFor(platform);
        const patterns = [];
        if (platform === 'darwin') {
            patterns.push(pathMod.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
        }
        else if (platform === 'win32') {
            const appData = env['APPDATA'];
            const localAppData = env['LOCALAPPDATA'];
            if (appData) {
                patterns.push(pathMod.join(appData, 'Claude', 'claude_desktop_config.json'));
            }
            if (localAppData) {
                patterns.push(pathMod.join(localAppData, 'Packages', 'Claude_*', 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'));
                patterns.push(pathMod.join(localAppData, 'Claude-Data', '*', 'claude_desktop_config.json'));
            }
        }
        else {
            return [];
        }
        const found = [];
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
export const cursorAdapter = {
    id: 'cursor',
    displayName: 'Cursor',
    serversKey: 'mcpServers',
    serverKey: 'memdrive',
    entryType: 'stdio',
    responseBudgetBytes: 10_000_000,
    createIfMissing: true,
    findConfigPaths: async (deps) => {
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
export const vscodeAdapter = {
    id: 'vscode',
    displayName: 'VS Code',
    serversKey: 'mcpServers',
    serverKey: 'memdrive',
    entryType: 'stdio',
    responseBudgetBytes: 10_000_000,
    createIfMissing: true,
    findConfigPaths: async (deps) => {
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
/** All host adapters, in wizard menu order: Claude Desktop first. */
export const HOST_ADAPTERS = [
    claudeDesktopAdapter,
    cursorAdapter,
    vscodeAdapter,
];
/**
 * Parse the optional host argument after `setup`
 * (`node dist/index.js setup cursor`). Returns the host id, or
 * null when no argument was given or it is unrecognised — the
 * caller then falls back to prompting, never guessing a host.
 * Matching is case-insensitive after trimming; `claude-desktop`
 * is accepted as an alias for `claude`. Only the single word
 * `vscode` selects VS Code: `vs-code` and `code` are NOT aliases
 * and fall back to the prompt, never guessed.
 */
export function parseHostArgument(input) {
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
    if (word === 'cursor') {
        return 'cursor';
    }
    if (word === 'vscode') {
        return 'vscode';
    }
    return null;
}
/** Adapter for a parsed host id. */
export function hostAdapterForId(id) {
    if (id === 'cursor') {
        return cursorAdapter;
    }
    if (id === 'vscode') {
        return vscodeAdapter;
    }
    return claudeDesktopAdapter;
}
/** Timestamp stem for numbered backups: `20261029-102800-123`. */
export function backupTimestamp(date) {
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return (`${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
        `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}` +
        `-${pad(date.getMilliseconds(), 3)}`);
}
/**
 * Backup path for a config file: `<file>.bak` when no backup exists
 * yet, otherwise `<file>.bak-<timestamp>`. Pure given an existence
 * predicate, so the "never overwrite an earlier backup" rule is
 * directly testable.
 */
export function backupPathFor(configPath, existsSync, now = new Date()) {
    const plain = `${configPath}.bak`;
    if (!existsSync(plain)) {
        return plain;
    }
    return `${plain}-${backupTimestamp(now)}`;
}
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
export function mergeConfigJson(existingText, adapter, entry) {
    let parsed;
    try {
        parsed = JSON.parse(existingText);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: `Config file is not valid JSON: ${message}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return {
            ok: false,
            reason: 'Config file does not contain a JSON object; refusing to modify it.',
        };
    }
    const doc = parsed;
    const existingServers = doc[adapter.serversKey];
    if (existingServers !== undefined) {
        if (typeof existingServers !== 'object' ||
            existingServers === null ||
            Array.isArray(existingServers)) {
            return {
                ok: false,
                reason: `Config file's "${adapter.serversKey}" is not a JSON object; refusing to modify it.`,
            };
        }
    }
    const existingEntry = existingServers?.[adapter.serverKey];
    let effectiveEntry = { ...entry };
    if (typeof existingEntry === 'object' &&
        existingEntry !== null &&
        !Array.isArray(existingEntry) &&
        'tools' in existingEntry &&
        !('tools' in effectiveEntry)) {
        effectiveEntry = {
            ...effectiveEntry,
            tools: existingEntry['tools'],
        };
    }
    const servers = {
        ...(existingServers ?? {}),
        [adapter.serverKey]: effectiveEntry,
    };
    const merged = { ...doc, [adapter.serversKey]: servers };
    return { ok: true, text: `${JSON.stringify(merged, null, 2)}\n` };
}
/**
 * Write `entry` into a host config file via `adapter`: back up
 * first, then merge and write. Missing files are never created
 * unless the adapter sets `createIfMissing` (Cursor and VS Code,
 * and only when the host directory already exists — the caller
 * decides that via `findConfigPaths`); a created file takes no
 * backup. Corrupt files are never touched. The `fs` parameter is
 * injectable for temp-dir tests; defaults to the real filesystem.
 */
export async function writeHostConfig(adapter, configPath, entry, fileSystem = fs) {
    let existing;
    try {
        existing = await fileSystem.readFile(configPath, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT') {
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
            await fileSystem.writeFile(configPath, `${JSON.stringify(created, null, 2)}\n`, 'utf8');
            return { status: 'created', configPath };
        }
        throw error;
    }
    const merged = mergeConfigJson(existing, adapter, entry);
    if (!merged.ok) {
        return { status: 'corrupt', configPath, message: merged.reason };
    }
    const backupExists = async (p) => {
        try {
            await fileSystem.access(p);
            return true;
        }
        catch {
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
