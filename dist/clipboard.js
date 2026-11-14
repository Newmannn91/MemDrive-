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
import { CLIPBOARD_COMMAND_TIMEOUT_MS, CLIPBOARD_MAX_BYTES, } from './config.js';
import { detectImageMime } from './images.js';
const execFileAsync = promisify(execFile);
/**
 * Run a clipboard command. `ranOk` is true only when the command
 * exited 0. That alone cannot separate "the tool ran and found
 * nothing" (empty clipboard) from "the tool exists but cannot run"
 * (no desktop session): xclip exits 1 in BOTH cases — a real X
 * session with an empty clipboard prints "Error: target STRING not
 * available" (exit 1), and no display prints "Error: Can't open
 * display" (exit 1). The stderr text is the only signal that
 * tells them apart, so it is returned alongside the outcome.
 * `stderr` is the command's stderr on failure, '' on success.
 */
async function runBuffer(command, args) {
    try {
        const { stdout } = await execFileAsync(command, args, {
            encoding: 'buffer',
            maxBuffer: CLIPBOARD_MAX_BYTES,
            timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
            windowsHide: true,
            env: { ...process.env, LC_ALL: 'C' },
        });
        const out = stdout;
        return { data: out.length > 0 ? out : null, ranOk: true, stderr: '' };
    }
    catch (error) {
        const stderr = (error.stderr ?? '').toString();
        return { data: null, ranOk: false, stderr };
    }
}
async function runText(command, args) {
    try {
        const { stdout } = await execFileAsync(command, args, {
            encoding: 'utf8',
            maxBuffer: CLIPBOARD_MAX_BYTES,
            timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
            windowsHide: true,
            env: { ...process.env, LC_ALL: 'C' },
        });
        const text = stdout.trim();
        return { text: text.length > 0 ? text : null, ranOk: true, stderr: '' };
    }
    catch (error) {
        const stderr = (error.stderr ?? '').toString();
        return { text: null, ranOk: false, stderr };
    }
}
/**
 * True when a clipboard command's stderr shows it reached a live
 * desktop session but found nothing on the clipboard (empty), as
 * opposed to having no session at all:
 *   xclip:   "Error: target STRING not available" = empty;
 *            "Error: Can't open display" = no session.
 *   wl-paste: "Nothing is copied" = empty;
 *             "No suitable type of content copied" = empty (the
 *             clipboard holds something, but not the requested
 *             image/png or text/plain — nothing usable to capture);
 *             "Failed to connect to a Wayland server" = no session.
 *             ("Clipboard content is not available as requested
 *             type ..." contains "not available", so it is already
 *             covered; only "No suitable type" needed adding —
 *             Argon round 5.)
 * A `which` check cannot make that distinction, and neither can
 * the exit code — only the stderr text can.
 */
function stderrMeansEmpty(stderr) {
    return (stderr.includes('not available') ||
        stderr.includes('Nothing is copied') ||
        stderr.includes('No suitable type'));
}
/** macOS: ask AppleScript to write the clipboard PNG to a temp file. */
async function readMacOs() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memdrive-clipboard-'));
    const tmp = path.join(dir, 'clip.png');
    try {
        const script = 'set pngData to the clipboard as «class PNGf»\n' +
            `set fp to open for access POSIX file ${JSON.stringify(tmp)} with write permission\n` +
            'write pngData to fp\n' +
            'close access fp';
        await execFileAsync('osascript', ['-e', script], {
            timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
            windowsHide: true,
        });
        const stat = await fs.stat(tmp);
        if (stat.size > CLIPBOARD_MAX_BYTES) {
            return {
                kind: 'unsupported',
                reason: `Clipboard image is too large (${stat.size} bytes; limit is ${CLIPBOARD_MAX_BYTES} bytes). Use a file path or image URL instead.`,
            };
        }
        const data = await fs.readFile(tmp);
        if (detectImageMime(data) === 'image/png') {
            return { kind: 'image', data, mimeType: 'image/png' };
        }
        return { kind: 'empty' };
    }
    catch {
        // No image on the clipboard (or no GUI session): fall back to text.
        try {
            const { stdout } = await execFileAsync('osascript', ['-e', 'return the clipboard'], {
                encoding: 'utf8',
                maxBuffer: CLIPBOARD_MAX_BYTES,
                timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
                windowsHide: true,
            });
            const text = stdout.trim();
            if (text.length > 0) {
                return { kind: 'text', text };
            }
            return { kind: 'empty' };
        }
        catch {
            return {
                kind: 'unsupported',
                reason: 'Could not read the macOS clipboard (osascript failed). Use a file path or image URL instead.',
            };
        }
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** Windows: PowerShell + System.Windows.Forms.Clipboard (STA thread). */
async function readWindows() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'memdrive-clipboard-'));
    const tmp = path.join(dir, 'clip.png');
    // Exit codes: 0 = image saved, 2 = clipboard empty, 3 = text on stdout.
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$img = [System.Windows.Forms.Clipboard]::GetImage()',
        `if ($img -ne $null) { $img.Save('${tmp.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 }`,
        '$text = [System.Windows.Forms.Clipboard]::GetText()',
        'if ([string]::IsNullOrEmpty($text)) { exit 2 }',
        '[Console]::Out.Write($text); exit 3',
    ].join('; ');
    try {
        const { stdout } = await execFileAsync('powershell', [
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-Command',
            script,
        ], {
            encoding: 'buffer',
            maxBuffer: CLIPBOARD_MAX_BYTES,
            timeout: CLIPBOARD_COMMAND_TIMEOUT_MS,
            windowsHide: true,
        });
        // execFile only resolves when the exit code is 0, so reaching here
        // means an image was saved.
        const stat = await fs.stat(tmp);
        if (stat.size > CLIPBOARD_MAX_BYTES) {
            return {
                kind: 'unsupported',
                reason: `Clipboard image is too large (${stat.size} bytes; limit is ${CLIPBOARD_MAX_BYTES} bytes). Use a file path or image URL instead.`,
            };
        }
        const data = await fs.readFile(tmp);
        if (detectImageMime(data) === 'image/png') {
            return { kind: 'image', data, mimeType: 'image/png' };
        }
        return { kind: 'empty' };
    }
    catch (error) {
        const code = error.code;
        if (code === 3) {
            const text = (error.stdout ?? Buffer.alloc(0))
                .toString('utf8')
                .trim();
            if (text.length > 0) {
                return { kind: 'text', text };
            }
            return { kind: 'empty' };
        }
        if (code === 2) {
            return { kind: 'empty' };
        }
        return {
            kind: 'unsupported',
            reason: 'Could not read the Windows clipboard (PowerShell clipboard access failed). Use a file path or image URL instead.',
        };
    }
    finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** Linux: Wayland (wl-paste) first, then X11 (xclip). */
async function readLinux() {
    // A command counts as "ran" when it exited 0 (even with empty
    // output) OR when its stderr shows it reached a live session
    // but found nothing on the clipboard. The exit code alone
    // cannot tell "empty clipboard" from "no desktop session":
    // xclip exits 1 for both, so only the stderr text separates
    // them (see stderrMeansEmpty).
    let anyRanOk = false;
    const imageCommands = [
        ['wl-paste', ['--type', 'image/png']],
        ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']],
    ];
    for (const [command, args] of imageCommands) {
        const { data, ranOk, stderr } = await runBuffer(command, args);
        anyRanOk = anyRanOk || ranOk || stderrMeansEmpty(stderr);
        if (data !== null) {
            const mimeType = detectImageMime(data);
            if (mimeType !== null) {
                return { kind: 'image', data, mimeType };
            }
        }
    }
    const textCommands = [
        ['wl-paste', ['--type', 'text/plain']],
        ['xclip', ['-selection', 'clipboard', '-t', 'STRING', '-o']],
        ['xclip', ['-selection', 'clipboard', '-o']],
    ];
    for (const [command, args] of textCommands) {
        const { text, ranOk, stderr } = await runText(command, args);
        anyRanOk = anyRanOk || ranOk || stderrMeansEmpty(stderr);
        if (text !== null) {
            return { kind: 'text', text };
        }
    }
    // A clipboard tool ran and returned nothing: the clipboard is
    // empty, not "unsupported". When nothing ran at all — no tool,
    // or the tool exists but has no desktop session — clipboard
    // access is unavailable in this environment (0.8.2 #12).
    if (anyRanOk) {
        return { kind: 'empty' };
    }
    return {
        kind: 'unsupported',
        reason: 'Clipboard access is not available in this environment (no wl-paste/xclip, or no desktop session). Use a file path or image URL instead.',
    };
}
/**
 * Read an image from the system clipboard. Never throws; see
 * ClipboardResult for the failure taxonomy.
 */
export async function readClipboardImage() {
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
    }
    catch (error) {
        // Last-resort guard: this function must never take the server down.
        const message = error instanceof Error ? error.message : String(error);
        return {
            kind: 'unsupported',
            reason: `Clipboard capture failed unexpectedly (${message}). Use a file path or image URL instead.`,
        };
    }
}
