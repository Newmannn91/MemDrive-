#!/usr/bin/env node
/**
 * MemDrive MCP server — entry point.
 *
 * Stdio transport: the server speaks MCP on stdout, so NOTHING except
 * protocol traffic may be written there. Diagnostics go to stderr.
 *
 * Storage is local-filesystem only. The tools talk to a
 * StorageBackend interface; WebDAV is interface-reserved behind
 * the StorageBackend interface but not implemented. Whether it is
 * implemented later depends on user feedback, and it will only be
 * considered if the user base is large with clear demand.
 */
import fs from 'node:fs/promises';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { resolveRootDir } from './config.js';
import { LocalStorageBackend } from './storage.js';
import { registerTools } from './tools.js';
import { runSetupWizard } from './wizard.js';

const VERSION = '0.6.0';

async function main(): Promise<void> {
  // `node dist/index.js setup` runs the interactive setup wizard
  // instead of the MCP server. Without a host argument the wizard
  // asks which host to configure; `setup cursor` / `setup claude`
  // / `setup vscode` / `setup claude-code` skips that question. No-arg invocation still starts the
  // server; the wizard writes to stdout freely because no protocol
  // traffic is running in this mode.
  if (process.argv[2] === 'setup') {
    process.exitCode = await runSetupWizard(process.argv[3]);
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
  registerTools(server, backend, rootRealDir, rootRealDir);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[memdrive] serving library root ${rootRealDir} (MEMDRIVE_ROOT=${process.env['MEMDRIVE_ROOT'] ?? '(default ~/memdrive)'})`,
  );
  console.error(`[memdrive] local filesystem backend; tools: list_directory, search_files, save_file, read_file, open_image, open_containing_folder`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[memdrive] fatal: ${message}`);
  process.exit(1);
});
