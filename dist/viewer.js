/**
 * Open a file or folder in the operating system's default viewer
 * or file manager.
 *
 * The viewer command is built as an argument array and launched with
 * `execFile` — never as a shell string, and the file path is never
 * concatenated into a command line, so a crafted filename cannot
 * inject a second command. Only one viewer command per platform is
 * ever used, and there is no environment-variable override for it
 * (an override would be an arbitrary-execution footgun: any caller
 * able to set the variable could run anything).
 *
 *   Windows (files, open_image): cmd.exe /c start "" <path>  (the empty
 *            string is the window title `start` requires as its first
 *            argument)
 *   Windows (folders, open_containing_folder): cmd.exe /c start ""
 *            explorer.exe /n,<path>  (the switch and the folder path
 *            are ONE comma-joined argument, no space after the
 *            comma). The `start` mediation matters: Explorer is the
 *            shell itself, and launching explorer.exe directly
 *            from a background process failed on the real machine
 *            in 0.5.1 (explorer.exe exited with code 1, no window,
 *            for both the root and notes/, confirmed by the user's
 *            own eyes in Claude Desktop and Cursor). Do NOT go back
 *            to a direct explorer.exe spawn. The /n switch forces a
 *            new Explorer window even when the folder is already
 *            open. Whether this launch opens every folder visibly
 *            (including notes/assets, which the 0.5.0 start-only
 *            launch opened as a hidden tab) is verified only by
 *            the real-machine test, not by the VM suite. Do NOT
 *            use the folder launch for files: explorer given a
 *            file path opens its folder instead of the file's
 *            viewer.
 *   macOS:   open <path>
 *   Linux:   xdg-open <path>
 *
 * The child is detached with stdio ignored and unref'd, so the server
 * does not hold the viewer open and the viewer does not hold the
 * server. Launching never throws: a missing viewer, a headless
 * machine, or a viewer that exits with an error is reported as a
 * value, and callers turn it into a readable note.
 *
 * Implementation note: this uses `spawn`, not `execFile` — the
 * spec's launch shape (argument array, no shell, detached, stdio
 * ignored, unref) is exactly what `spawn` provides, while
 * `ExecFileOptions` in the installed @types/node has no `detached`
 * option, so `execFile` cannot express the detached launch.
 */
import { spawn } from 'node:child_process';
/**
 * Pure function of (platform, path): the exact command that would be
 * launched to open `absolutePath` as a file (image viewer). Unit-tested
 * directly, including the Windows/macOS branches this Linux VM cannot
 * execute.
 */
export function viewerCommandFor(platform, absolutePath) {
    if (platform === 'win32') {
        return { command: 'cmd.exe', args: ['/c', 'start', '', absolutePath] };
    }
    if (platform === 'darwin') {
        return { command: 'open', args: [absolutePath] };
    }
    return { command: 'xdg-open', args: [absolutePath] };
}
/**
 * Pure function of (platform, path): the exact command that would be
 * launched to open `absolutePath` as a folder (file manager). On
 * Windows this goes through `cmd /c start` with explorer.exe as the
 * program and `/n,<path>` as ONE comma-joined argument: `start`
 * mediation is required (direct explorer.exe spawns exited with
 * code 1 and opened nothing in 0.5.1), and the switch must be
 * joined to the path with a comma, not passed as a separate
 * argument. On macOS/Linux the folder command is identical to the
 * file command. Folder paths only: passing a file here would open
 * its containing folder on Windows.
 * Unit-tested directly, including the Windows branch this Linux VM
 * cannot execute.
 */
export function folderCommandFor(platform, absolutePath) {
    if (platform === 'win32') {
        return {
            command: 'cmd.exe',
            args: ['/c', 'start', '', 'explorer.exe', `/n,${absolutePath}`],
        };
    }
    return viewerCommandFor(platform, absolutePath);
}
/**
 * How long to wait for the viewer launcher to exit before assuming
 * the viewer itself is running. Launchers that hand off to a GUI
 * (cmd `start`, macOS `open`, usually `xdg-open`) exit at once; a
 * launcher that stays attached to a long-lived viewer process must
 * not block the tool call forever, and must not be killed — killing
 * it could close the image the user just asked to see. On expiry the
 * launch is treated as successful and the child is left running,
 * detached.
 */
export const VIEWER_LAUNCH_TIMEOUT_MS = 10_000;
/**
 * Launch the OS default viewer for `absolutePath`. Never throws.
 * Resolves ok when the launcher exits 0, or when it is still running
 * after the launch timeout (the viewer is up). Resolves not-ok when
 * the launcher cannot start or exits non-zero quickly (for example
 * `xdg-open` on a headless machine: "no method available").
 */
export async function openInViewer(absolutePath, platform = process.platform) {
    const { command, args } = viewerCommandFor(platform, absolutePath);
    return launchViewer(command, args);
}
/**
 * Launch the OS file manager for the folder `absolutePath` (folder
 * paths only). Same launch shape and result contract as
 * `openInViewer`, except on Windows the command is
 * `cmd /c start "" explorer.exe /n,<path>` (see `folderCommandFor`:
 * shell-mediated, switch joined to the path). Never throws.
 */
export async function openFolderInViewer(absolutePath, platform = process.platform) {
    const { command, args } = folderCommandFor(platform, absolutePath);
    return launchViewer(command, args);
}
async function launchViewer(command, args) {
    return new Promise((resolve) => {
        let settled = false;
        const settle = (result) => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                resolve(result);
            }
        };
        const timer = setTimeout(() => {
            // Still running: the viewer is up. Leave it running, detached.
            settle({ ok: true });
        }, VIEWER_LAUNCH_TIMEOUT_MS);
        // `unref` on the timer too: a waiting launch must not keep a
        // process alive on its own (the MCP server is long-lived anyway,
        // but the wizard/tests must not hang on it either).
        timer.unref?.();
        let child;
        try {
            child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            settle({ ok: false, reason: `${command} could not be started: ${message}` });
            return;
        }
        child.unref?.();
        child.once('error', (error) => {
            settle({ ok: false, reason: `${command} could not be started: ${error.message}` });
        });
        child.once('exit', (code) => {
            if (code === 0) {
                settle({ ok: true });
            }
            else {
                settle({
                    ok: false,
                    reason: `${command} exited with code ${code ?? 'unknown'} and did not open the requested path.`,
                });
            }
        });
    });
}
