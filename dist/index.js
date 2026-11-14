#!/usr/bin/env node
/**
 * MemDrive MCP server — entry point.
 *
 * Stdio transport: the server speaks MCP on stdout, so NOTHING except
 * protocol traffic may be written there. Diagnostics go to stderr.
 *
 * Storage is local-filesystem only. The tools talk to a
 * StorageBackend interface.
 */
import fs from 'node:fs/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolveRootDir, VERSION } from './config.js';
import { LocalSearchIndex } from './search-index.js';
import { LocalStorageBackend } from './storage.js';
import { registerTools, runApplyCleanup } from './tools.js';
import { runSetupWizard } from './wizard.js';
async function main() {
    const USAGE = 'Usage: memdrive-mcp [setup [host] | apply <plan-id> | --help | --version]';
    const cmd = process.argv[2];
    if (cmd === '--help' || cmd === '-h') {
        console.log(`${USAGE}\n  setup [host]   Run the interactive setup wizard\n  apply <plan-id>  Apply a cleanup plan\n  --help         Show this help\n  --version      Show the version\n  (no arguments starts the MCP server on stdio)`);
        return;
    }
    if (cmd === '--version' || cmd === '-v') {
        console.log(`memdrive-mcp ${VERSION}`);
        return;
    }
    if (cmd !== undefined && cmd !== 'setup' && cmd !== 'apply') {
        console.error(`Unknown command: ${cmd}. ${USAGE}`);
        process.exitCode = 1;
        return;
    }
    // `node dist/index.js setup` runs the interactive setup wizard
    // instead of the MCP server. Without a host argument the wizard
    // asks which host to configure; `setup cursor` / `setup claude`
    // / `setup vscode` / `setup claude-code` skips that question. No-arg invocation still starts the
    // server; the wizard writes to stdout freely because no protocol
    // traffic is running in this mode.
    if (cmd === 'setup') {
        process.exitCode = await runSetupWizard(process.argv[3]);
        return;
    }
    if (cmd === 'apply') {
        const planId = process.argv[3]?.trim();
        if (planId === undefined || planId === '' || planId.startsWith('-') || process.argv.length > 4) {
            console.error('Usage: memdrive-mcp apply <plan-id>');
            process.exitCode = 1;
            return;
        }
        const rootDir = resolveRootDir();
        let rootRealDir;
        try {
            rootRealDir = await fs.realpath(rootDir);
        }
        catch (error) {
            if (error.code === 'ENOENT') {
                console.error(`Library root does not exist: ${rootDir}`);
                process.exitCode = 1;
                return;
            }
            throw error;
        }
        const backend = new LocalStorageBackend(rootRealDir);
        const searchIndex = new LocalSearchIndex(rootRealDir, rootRealDir, backend);
        const { lines, exitCode } = await runApplyCleanup(planId, { backend, rootDir: rootRealDir, rootRealDir, searchIndex });
        for (const line of lines)
            console.log(line);
        process.exitCode = exitCode;
        return;
    }
    const rootDir = resolveRootDir();
    await fs.mkdir(rootDir, { recursive: true });
    // Operate on the canonical (symlink-free) root everywhere: lexical
    // checks, realpath checks, display paths, and the backend all agree.
    const rootRealDir = await fs.realpath(rootDir);
    const backend = new LocalStorageBackend(rootRealDir);
    const server = new McpServer({
        name: 'memdrive-mcp',
        version: VERSION,
    });
    // Search index: load a persisted copy when one exists, then build
    // in the background (never block server startup). Searches fall
    // back to a direct scan until the index is ready.
    const searchIndex = new LocalSearchIndex(rootRealDir, rootRealDir, backend);
    void searchIndex
        .load()
        .then(() => searchIndex.ensureReady())
        .catch((error) => {
        console.error(`[memdrive] search index build failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    registerTools(server, backend, rootRealDir, rootRealDir, searchIndex);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[memdrive] serving library root ${rootRealDir} (MEMDRIVE_ROOT=${process.env['MEMDRIVE_ROOT'] ?? '(default ~/memdrive)'})`);
    console.error(`[memdrive] local filesystem backend; tools: list_directory, search_files, save_file, edit_tags, archive_file, restore_file, plan_cleanup, apply_plan, read_file, open_image, open_containing_folder`);
}
main().catch((error) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`[memdrive] fatal: ${message}`);
    process.exit(1);
});
