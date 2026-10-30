/**
 * Setup wizard: `node dist/index.js setup` (or `npx memdrive-mcp
 * setup` once the package is published). An optional host argument
 * (`setup cursor`, `setup claude`, `setup vscode`) skips the host
 * question; without one, the wizard asks which host to configure
 * first.
 *
 * Zero new dependencies: probing and prompting use only Node
 * built-ins. The wizard never touches the network, never installs
 * anything silently, and never probes the Windows registry as its
 * primary lookup (ordinary machines lack the value; it is an
 * enterprise-only fallback that is not implemented here).
 *
 * Flow: choose a host (Claude Desktop, Cursor, or VS Code) →
 * probe for existing sync folders (OneDrive / Google Drive /
 * iCloud) plus the `~/memdrive` default → numbered menu, or a
 * custom path → `mkdir -p` the chosen root → find the chosen
 * host's config (see host-config.ts) → back it up, merge the
 * server entry (or create the file for Cursor / VS Code when its
 * config directory exists), and print the restart instruction.
 * The entry carries the host's response budget in its `env` when
 * the adapter defines one (Cursor, VS Code); Claude Desktop
 * entries carry no budget env. When no config file is found, the
 * wizard writes nothing and prints a ready-to-paste JSON snippet
 * instead.
 *
 * The pure/testable parts (candidate probing with injectable
 * environment and filesystem, custom-path validation, server-entry
 * construction) live in exported functions below; only the
 * readline prompting is interactive and therefore Windows-manual-
 * test only.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  claudeDesktopAdapter,
  HOST_ADAPTERS,
  hostAdapterForId,
  parseHostArgument,
  pathModuleFor,
  writeHostConfig,
  type HostConfigAdapter,
  type HostConfigEntry,
  type HostProbeDeps,
} from './host-config.js';

const execFileAsync = promisify(execFile);

/** Timeout for the PowerShell Google Drive volume-label probe. */
export const DRIVE_LETTER_PROBE_TIMEOUT_MS = 10_000;

export interface CandidateRoot {
  /** Absolute path of the candidate library root. */
  path: string;
  /** Short label shown in the menu, e.g. 'OneDrive'. */
  label: string;
}

export interface ProbeDeps extends HostProbeDeps {
  /**
   * Override for the Google Drive volume-letter probe (Windows
   * only). Returns a drive letter like 'G', or null when the probe
   * found nothing. Defaults to the real PowerShell probe; tests
   * inject a fake so no PowerShell runs on Linux.
   */
  driveLetterProbe?: () => Promise<string | null>;
}

async function defaultExists(
  deps: ProbeDeps,
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

function dedupeCandidates(
  candidates: CandidateRoot[],
  pathMod: typeof path.posix,
): CandidateRoot[] {
  const seen = new Set<string>();
  const out: CandidateRoot[] = [];
  for (const candidate of candidates) {
    const key =
      pathMod === path.win32 ? candidate.path.toLowerCase() : candidate.path;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * Probe the Google Drive volume label on Windows with PowerShell:
 * returns the drive letter of a volume labelled '*Google Drive*',
 * or null on any failure (PowerShell missing, no such volume,
 * timeout, unparsable output). Failures fall through silently —
 * the common-path fallback candidates below still get checked.
 * Never throws.
 */
export async function probeGoogleDriveLetter(): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        "(Get-Volume | Where-Object { $_.FileSystemLabel -Like '*Google Drive*' }).DriveLetter",
      ],
      { timeout: DRIVE_LETTER_PROBE_TIMEOUT_MS, windowsHide: true },
    );
    const match = String(stdout).match(/[A-Za-z]/);
    return match ? match[0].toUpperCase() : null;
  } catch {
    return null;
  }
}

/**
 * Probe candidate library roots for the current OS. Only roots that
 * exist are returned, except the `~/memdrive` default, which is
 * always listed (the wizard creates it). Order: OneDrive, Google
 * Drive, iCloud, default. Google Drive on Windows uses the 3-step
 * chain from the spec: DriveFS presence → PowerShell label probe →
 * existence-checked common paths. No drive letter is ever hardcoded
 * as the answer: `G:`/`H:` paths are candidates only when they exist.
 */
export async function probeCandidateRoots(
  deps: ProbeDeps = {},
): Promise<CandidateRoot[]> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const home = deps.homeDir ?? homedir();
  const pathMod = pathModuleFor(platform);
  const exists = (p: string): Promise<boolean> => defaultExists(deps, p);
  const found: CandidateRoot[] = [];
  const maybeAdd = async (
    candidatePath: string,
    label: string,
  ): Promise<void> => {
    if (await exists(candidatePath)) {
      found.push({ path: candidatePath, label });
    }
  };

  if (platform === 'win32') {
    const oneDrive = env['OneDrive'];
    if (oneDrive) {
      await maybeAdd(oneDrive, 'OneDrive');
    }
    const localAppData = env['LOCALAPPDATA'];
    const userProfile = env['USERPROFILE'];
    const driveFs =
      localAppData !== undefined
        ? pathMod.join(localAppData, 'Google', 'DriveFS')
        : undefined;
    if (driveFs !== undefined && (await exists(driveFs))) {
      const probe = deps.driveLetterProbe ?? probeGoogleDriveLetter;
      const letter = await probe();
      if (letter !== null) {
        await maybeAdd(
          pathMod.join(`${letter}:`, 'My Drive'),
          'Google Drive',
        );
        await maybeAdd(
          pathMod.join(`${letter}:`, '我的云端硬盘'),
          'Google Drive',
        );
      }
    }
    // Common-path fallback: existence-checked only, never assumed.
    await maybeAdd(pathMod.join('G:', 'My Drive'), 'Google Drive');
    await maybeAdd(pathMod.join('G:', '我的云端硬盘'), 'Google Drive');
    await maybeAdd(pathMod.join('H:', 'My Drive'), 'Google Drive');
    if (userProfile !== undefined) {
      await maybeAdd(
        pathMod.join(userProfile, 'Google Drive'),
        'Google Drive',
      );
      await maybeAdd(
        pathMod.join(userProfile, 'iCloudDrive'),
        'iCloud Drive',
      );
    }
  } else {
    await maybeAdd(pathMod.join(home, 'OneDrive'), 'OneDrive');
    if (platform === 'darwin') {
      await maybeAdd(
        pathMod.join(pathMod.sep, 'Volumes', 'GoogleDrive'),
        'Google Drive',
      );
      await maybeAdd(pathMod.join(home, 'Google Drive'), 'Google Drive');
      await maybeAdd(
        pathMod.join(
          home,
          'Library',
          'Mobile Documents',
          'com~apple~CloudDocs',
        ),
        'iCloud Drive',
      );
    }
  }

  // The default is always offered; the wizard creates it if missing.
  // It must match the server default in config.ts (`~/memdrive`).
  found.push({
    path: pathMod.join(home, 'memdrive'),
    label: 'Default (~/memdrive)',
  });
  return dedupeCandidates(found, pathMod);
}

/**
 * Validate a user-typed custom path: expand a leading `~`, strip
 * surrounding quotes, and require an absolute path (or `~/...`).
 * Returns the absolute path, or null when the input is not usable.
 * Pure: no filesystem access, no creation — the caller mkdirs.
 */
export function expandCustomPath(
  input: string,
  homeDir: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathMod = pathModuleFor(platform);
  let p = input.trim();
  for (;;) {
    if (
      p.length >= 2 &&
      ((p.startsWith('"') && p.endsWith('"')) ||
        (p.startsWith("'") && p.endsWith("'")))
    ) {
      p = p.slice(1, -1).trim();
      continue;
    }
    break;
  }
  if (p.length === 0) {
    return null;
  }
  if (p === '~') {
    return homeDir;
  }
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    p = pathMod.join(homeDir, p.slice(2));
  }
  if (!pathMod.isAbsolute(p)) {
    return null;
  }
  return pathMod.normalize(p);
}

/**
 * Absolute path of the MCP server entry point, resolved from this
 * module's own location: the wizard ships in `dist/` next to
 * `dist/index.js`, so the entry is always the sibling file. This is
 * what the wizard writes into the host config's `args`.
 */
export function serverScriptPath(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'index.js',
  );
}

/**
 * Build the host-config server entry for a chosen library root.
 * The entry carries the adapter's per-host response budget in its
 * `env` only when the adapter defines one (Cursor, VS Code);
 * Claude Desktop entries carry no budget env and keep the server
 * default. `configSnippet` uses this function, so snippets carry
 * the same budget env.
 */
export function buildServerEntry(
  rootPath: string,
  adapter: HostConfigAdapter = claudeDesktopAdapter,
): HostConfigEntry {
  return {
    ...(adapter.entryType !== undefined ? { type: adapter.entryType } : {}),
    command: 'node',
    args: [serverScriptPath()],
    env: {
      MEMDRIVE_ROOT: rootPath,
      ...(adapter.responseBudgetBytes !== undefined
        ? {
            MEMDRIVE_RESPONSE_BUDGET_BYTES: String(
              adapter.responseBudgetBytes,
            ),
          }
        : {}),
    },
  };
}

/** Ready-to-paste JSON snippet for manual host configuration. */
export function configSnippet(
  rootPath: string,
  adapter: HostConfigAdapter = claudeDesktopAdapter,
): string {
  return JSON.stringify(
    { [adapter.serversKey]: { [adapter.serverKey]: buildServerEntry(rootPath, adapter) } },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/* Interactive wizard                                                  */
/* ------------------------------------------------------------------ */

async function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return rl.question(question);
}

export async function runSetupWizard(
  hostArgument?: string,
): Promise<number> {
  const home = homedir();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log('MemDrive setup');
    console.log('==============');
    console.log('');

    // Host first (prompt-first default; an argument skips this).
    const parsedHost = parseHostArgument(hostArgument);
    let adapter: HostConfigAdapter;
    if (parsedHost !== null) {
      adapter = hostAdapterForId(parsedHost);
    } else {
      if (
        hostArgument !== undefined &&
        hostArgument.trim() !== ''
      ) {
        console.log(`Unknown host "${hostArgument.trim()}". Please choose a host:`);
      }
      console.log('Choose a host:');
      HOST_ADAPTERS.forEach((candidate, i) => {
        console.log(`  ${i + 1}. ${candidate.displayName}`);
      });
      console.log('');
      adapter = HOST_ADAPTERS[0] as HostConfigAdapter;
      for (;;) {
        const answer = (
          await ask(
            rl,
            `Choose a host [1-${HOST_ADAPTERS.length}] (Enter = 1): `,
          )
        ).trim();
        if (answer === '') {
          break;
        }
        const n = Number(answer);
        if (
          Number.isInteger(n) &&
          n >= 1 &&
          n <= HOST_ADAPTERS.length
        ) {
          adapter = HOST_ADAPTERS[n - 1] as HostConfigAdapter;
          break;
        }
        console.log(
          `Please enter a number between 1 and ${HOST_ADAPTERS.length}.`,
        );
      }
      console.log('');
    }

    console.log('Probing for sync folders (OneDrive / Google Drive / iCloud)...');
    const candidates = await probeCandidateRoots();
    const entries: Array<{ label: string; path: string | null }> =
      candidates.map((c) => ({
        label: `${c.label} — ${c.path}`,
        path: c.path,
      }));
    entries.push({ label: 'Enter a custom path…', path: null });
    for (let i = 0; i < entries.length; i += 1) {
      console.log(`  ${i + 1}. ${(entries[i] as { label: string }).label}`);
    }
    console.log('');

    let chosen: string | null = null;
    for (;;) {
      const answer = (
        await ask(rl, `Choose a library folder [1-${entries.length}] (Enter = 1): `)
      ).trim();
      if (answer === '') {
        chosen = (entries[0] as { path: string | null }).path;
        if (chosen === null) {
          // First entry can only be the custom option when no
          // candidates exist at all; the default is always listed,
          // so this is unreachable in practice — stay safe anyway.
          continue;
        }
        break;
      }
      const n = Number(answer);
      if (
        !Number.isInteger(n) ||
        n < 1 ||
        n > entries.length
      ) {
        console.log(`Please enter a number between 1 and ${entries.length}.`);
        continue;
      }
      const picked = entries[n - 1] as { label: string; path: string | null };
      if (picked.path !== null) {
        chosen = picked.path;
        break;
      }
      // Custom path: keep asking until an absolute path is given.
      for (;;) {
        const custom = await ask(
          rl,
          'Custom library folder (absolute path, ~ allowed): ',
        );
        const expanded = expandCustomPath(custom, home);
        if (expanded !== null) {
          chosen = expanded;
          break;
        }
        console.log(
          'That is not an absolute path. Examples: C:\\Users\\you\\memory, ~/memory, /Users/you/memory.',
        );
      }
      break;
    }
    const rootPath = chosen as string;

    try {
      await fs.mkdir(rootPath, { recursive: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(`Could not create the library folder ${rootPath}: ${message}`);
      return 1;
    }
    console.log(`\nLibrary folder: ${rootPath}`);

    const entry = buildServerEntry(rootPath, adapter);
    const configPaths = await adapter.findConfigPaths({});
    let configPath: string | undefined;
    if (configPaths.length === 0) {
      console.log(
        `\nNo ${adapter.displayName} config file was found, so nothing was written.`,
      );
    } else if (configPaths.length === 1) {
      configPath = configPaths[0];
    } else {
      console.log(`\nMultiple ${adapter.displayName} config files were found:`);
      configPaths.forEach((p, i) => console.log(`  ${i + 1}. ${p}`));
      console.log(`  ${configPaths.length + 1}. Skip — just show me the snippet`);
      for (;;) {
        const answer = (
          await ask(
            rl,
            `Which config file should be updated? [1-${configPaths.length + 1}]: `,
          )
        ).trim();
        const n = Number(answer);
        if (
          Number.isInteger(n) &&
          n >= 1 &&
          n <= configPaths.length + 1
        ) {
          if (n <= configPaths.length) {
            configPath = configPaths[n - 1];
          }
          break;
        }
        console.log(
          `Please enter a number between 1 and ${configPaths.length + 1}.`,
        );
      }
    }

    if (configPath !== undefined) {
      const result = await writeHostConfig(adapter, configPath, entry);
      if (result.status === 'written') {
        console.log(`\n${adapter.displayName} config updated: ${result.configPath}`);
        console.log(`Backup saved as: ${result.backupPath}`);
        console.log(
          `Fully quit and restart ${adapter.displayName} for the change to take effect.`,
        );
        return 0;
      }
      if (result.status === 'created') {
        console.log(`\n${adapter.displayName} config created: ${result.configPath}`);
        console.log(
          `Fully quit and restart ${adapter.displayName} for the change to take effect.`,
        );
        return 0;
      }
      if (result.status === 'missing') {
        console.log(`\n${result.message}`);
      } else {
        console.log(
          `\nCould not update the ${adapter.displayName} config: ${result.message}`,
        );
        console.log('Nothing was changed. Fix the config file, then run setup again.');
        console.log('\nManual snippet for now:');
        console.log(configSnippet(rootPath, adapter));
        return 1;
      }
    }

    console.log(
      `\nAdd this to your ${adapter.displayName} config file manually, then fully quit and restart ${adapter.displayName}:`,
    );
    console.log(configSnippet(rootPath, adapter));
    return 0;
  } catch (error) {
    // Ctrl-C and other readline aborts land here: print a plain
    // message and exit non-zero without a stack trace.
    const message = error instanceof Error ? error.message : String(error);
    if (message.length > 0) {
      console.log(`\nSetup stopped: ${message}`);
    } else {
      console.log('\nSetup stopped.');
    }
    return 1;
  } finally {
    rl.close();
  }
}
