#!/usr/bin/env node

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));

const args = process.argv.slice(2);

if (args.includes('--version') || args.includes('-v')) {
  console.log(`wia ${pkg.version}`);
  process.exit(0);
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
wia ${pkg.version} - Visual editor for local repos with AI integration

Usage:
  wia [project-path] [options]

Options:
  --port <number>   Port to listen on (default: 3000, or PORT env var)
  --version, -v     Show version
  --help, -h        Show this help

Examples:
  wia ./my-project
  wia /absolute/path --port 8080
  PORT=4000 wia .
`.trim());
  process.exit(0);
}

// Parse --port flag; fall back to PORT env var, then 3000.
let port = parseInt(process.env.PORT || '3000', 10);
const portIndex = args.indexOf('--port');
if (portIndex !== -1 && args[portIndex + 1]) {
  port = parseInt(args[portIndex + 1], 10);
  if (isNaN(port)) {
    console.error('Error: --port requires a numeric value.');
    process.exit(1);
  }
}

// First positional argument that doesn't start with -- is the project path.
const positional = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  // skip the value that follows --port
  if (i > 0 && args[i - 1] === '--port') return false;
  return true;
});

const projectPath = positional[0] ? resolve(positional[0]) : null;

if (!projectPath) {
  console.log('No project path provided. Starting wia without a project.');
  console.log('Open http://localhost:' + port + ' and select a project from the UI.');
  console.log('');
  console.log('Tip: wia /path/to/project');
}

const { startServer } = await import('../src/server/index.js');
startServer({ port, projectPath });
