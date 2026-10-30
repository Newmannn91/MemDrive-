/**
 * System clipboard image capture using ONLY operating-system native
 * commands — no third-party clipboard libraries, no native add-ons.
 *
 *   macOS:   osascript (AppleScript, clipboard as PNG)
 *   Windows: PowerShell (System.Windows.Forms.Clipboard, STA thread)
 *   Linux:   wl-paste (Wayland) first, then xclip (X11)
 *
 * This module NEVER throws: every failure mode (no clipboard tool, no
 * desktop environment, empty clipboard, text-only clipboard, command
 * timeout) is reported as a `ClipboardResult` value, and callers degrade
 * gracefully. In headless environments (Docker, servers, NAS) the result
 * is `unsupported` with an actionable message.
 *
 * The clipboard belongs to the machine the server runs on. For the normal
 * stdio setup that is the user's own computer.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  CLIPBOARD_COMMAND_TIMEOUT_MS,
  CLIPBOARD_MAX_BYTES,
} from './config.js';

const execFileAsync = promisify(execFile);

export type ClipboardResult =
  | { kind: 'image'; data: Buffer; mimeType: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' }
  | { kind: 'unsupported'; reason: string };

function isPng(data: Buffer): boolean {
  return (
    data.length >= 8 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  );
}

function detectMime(data: Buffer): string | null {
  if (isPng(data)) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 3 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d) {
    return 'image/bmp';
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

async function runBuffer(
  command: string,
  args: string[],
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'buffer',
      maxBuffer: CLIPBOARD_MAX_BYTES,
      timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const out = stdout as Buffer;
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

async function runText(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      maxBuffer: CLIPBOARD_MAX_BYTES,
      timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const text = (stdout as string).trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

/** macOS: ask AppleScript to write the clipboard PNG to a temp file. */
async function readMacOs(): Promise<ClipboardResult> {
  const tmp = path.join(
    os.tmpdir(),
    `memdrive-clipboard-${process.pid}-${Date.now()}.png`,
  );
  try {
    const script =
      'set pngData to the clipboard as «class PNGf»\n' +
      `set fp to open for access POSIX file ${JSON.stringify(tmp)} with write permission\n` +
      'write pngData to fp\n' +
      'close access fp';
    await execFileAsync('osascript', ['-e', script], {
      timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    });
    const data = await fs.readFile(tmp);
    if (isPng(data)) {
      return { kind: 'image', data, mimeType: 'image/png' };
    }
    return { kind: 'empty' };
  } catch {
    // No image on the clipboard (or no GUI session): fall back to text.
    try {
      const text = await runText('osascript', ['-e', 'return the clipboard']);
      if (text !== null) {
        return { kind: 'text', text };
      }
      return { kind: 'empty' };
    } catch {
      return {
        kind: 'unsupported',
        reason:
          'Could not read the macOS clipboard (osascript failed). Use a file path or image URL instead.',
      };
    }
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

/** Windows: PowerShell + System.Windows.Forms.Clipboard (STA thread). */
async function readWindows(): Promise<ClipboardResult> {
  const tmp = path.join(
    os.tmpdir(),
    `memdrive-clipboard-${process.pid}-${Date.now()}.png`,
  );
  // Exit codes: 0 = image saved, 2 = clipboard empty, 3 = text on stdout.
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$img = [System.Windows.Forms.Clipboard]::GetImage()',
    `if ($img -ne $null) { $img.Save(${JSON.stringify(tmp)}, [System.Drawing.Imaging.ImageFormat]::Png); exit 0 }`,
    '$text = [System.Windows.Forms.Clipboard]::GetText()',
    'if ([string]::IsNullOrEmpty($text)) { exit 2 }',
    '[Console]::Out.Write($text); exit 3',
  ].join('; ');
  try {
    const { stdout } = await execFileAsync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-STA',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        script,
      ],
      {
        encoding: 'buffer',
        maxBuffer: CLIPBOARD_MAX_BYTES,
        timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    // execFile only resolves when the exit code is 0, so reaching here
    // means an image was saved.
    const data = await fs.readFile(tmp);
    if (isPng(data)) {
      return { kind: 'image', data, mimeType: 'image/png' };
    }
    return { kind: 'empty' };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 3) {
      const text = ((error as { stdout?: Buffer }).stdout ?? Buffer.alloc(0))
        .toString('utf8')
        .trim();
      if (text.length > 0) {
        return { kind: 'text', text };
      }
    }
    if (code === 2) {
      return { kind: 'empty' };
    }
    return {
      kind: 'unsupported',
      reason:
        'Could not read the Windows clipboard (PowerShell clipboard access failed). Use a file path or image URL instead.',
    };
  } finally {
    await fs.unlink(tmp).catch(() => undefined);
  }
}

/** Linux: Wayland (wl-paste) first, then X11 (xclip). */
async function readLinux(): Promise<ClipboardResult> {
  const imageCommands: Array<[string, string[]]> = [
    ['wl-paste', ['--type', 'image/png']],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
  ];
  for (const [command, args] of imageCommands) {
    const data = await runBuffer(command, args);
    if (data !== null) {
      const mimeType = detectMime(data);
      if (mimeType !== null) {
        return { kind: 'image', data, mimeType };
      }
    }
  }
  const textCommands: Array<[string, string[]]> = [
    ['wl-paste', ['--type', 'text/plain']],
    ['xclip', ['-selection', 'clipboard', '-t', 'STRING', '-o']],
    ['xclip', ['-selection', 'clipboard', '-o']],
  ];
  for (const [command, args] of textCommands) {
    const text = await runText(command, args);
    if (text !== null) {
      return { kind: 'text', text };
    }
  }
  // Distinguish "no clipboard tool at all" from "clipboard empty" only
  // loosely: both end here in headless environments.
  return {
    kind: 'unsupported',
    reason:
      'Clipboard access is not available in this environment (no wl-paste/xclip, or no desktop session). Use a file path or image URL instead.',
  };
}

/**
 * Read an image from the system clipboard. Never throws; see
 * ClipboardResult for the failure taxonomy.
 */
export async function readClipboardImage(): Promise<ClipboardResult> {
  try {
    if (process.platform === 'darwin') {
      return await readMacOs();
    }
    if (process.platform === 'win32') {
      return await readWindows();
    }
    if (process.platform === 'linux') {
      return await readLinux();
    }
    return {
      kind: 'unsupported',
      reason: `Clipboard capture is not supported on this platform (${process.platform}). Use a file path or image URL instead.`,
    };
  } catch (error) {
    // Last-resort guard: this function must never take the server down.
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'unsupported',
      reason: `Clipboard capture failed unexpectedly (${message}). Use a file path or image URL instead.`,
    };
  }
}
