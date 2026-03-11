import express from 'express';
import { createServer, request as httpRequest } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createFileRouter } from './routes/files.js';
import { createProjectRouter } from './routes/projects.js';
import { createWritebackRouter } from './routes/writeback.js';
import { createGitRouter } from './routes/git.js';
import { createAIRouter } from './routes/ai.js';
import { createDevServerRouter } from './routes/devserver.js';
import { createMediaRouter } from './routes/media.js';
import { setupWebSocket } from './ws.js';

// In ESM: derive __filename/__dirname from import.meta.url
// In CJS/SEA: these are already globally defined, skip
const _file = import.meta.url ? fileURLToPath(import.meta.url) : (typeof __filename !== 'undefined' ? __filename : process.argv[0]);
const _dir = dirname(_file);

// Find the client files: try multiple locations
// 1. Dev: src/client (relative to src/server/index.js)
// 2. Tauri bundle: ../Resources/dist (relative to MacOS/wia-server)
// 3. Tauri bundle: dist (next to the binary)
import { existsSync } from 'fs';
const clientCandidates = [
  join(_dir, '..', 'client'),
  join(_dir, '..', 'Resources', '_up_', 'dist'),
  join(_dir, '..', 'Resources', 'dist'),
  join(_dir, 'dist'),
  join(process.cwd(), 'dist'),
  join(process.cwd(), 'src', 'client'),
];
const clientPath = clientCandidates.find(p => existsSync(p)) || clientCandidates[0];

export async function startServer({ port = 3000, projectPath = null } = {}) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server });

  app.use(express.json({ limit: '5mb' }));
  app.use(express.static(clientPath));

  app.use('/api/files', createFileRouter());
  app.use('/api/projects', createProjectRouter());
  app.use('/api/writeback', createWritebackRouter());
  app.use('/api/git', createGitRouter());
  app.use('/api/ai', await createAIRouter());
  app.use('/api/devserver', createDevServerRouter());
  app.use('/api/media', createMediaRouter());

  // Serve the target project's files (images, css, js, etc.)
  // Track the last project dir for static preview (CSS/JS loaded without ?project= param)
  let lastPreviewProject = projectPath;

  app.use('/preview', (req, res, next) => {
    if (req.query.project) lastPreviewProject = req.query.project;
    const projectDir = req.query.project || lastPreviewProject;
    if (!projectDir) return res.status(400).json({ error: 'No project path' });
    express.static(projectDir)(req, res, next);
  });

  // Proxy to framework dev server
  let devProxyPort = null;

  function proxyToDevServer(req, res, targetPath) {
    const targetPort = req.query.port ? parseInt(req.query.port, 10) : devProxyPort;
    if (!targetPort) return res.status(400).json({ error: 'No dev server port configured' });

    // Strip sec-fetch-* headers so the proxied app doesn't think it's in an iframe
    // (e.g. Shopify middleware uses sec-fetch-dest to detect iframe → redirect)
    const fwdHeaders = { ...req.headers, host: `localhost:${targetPort}` };
    for (const key of Object.keys(fwdHeaders)) {
      if (key.startsWith('sec-fetch-')) delete fwdHeaders[key];
    }

    const options = {
      hostname: 'localhost',
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: fwdHeaders,
    };

    const proxyReq = httpRequest(options, (proxyRes) => {
      const headers = { ...proxyRes.headers };
      delete headers['x-frame-options'];
      delete headers['content-security-policy'];

      // Rewrite redirect locations to go through /devpreview/
      if (headers.location && (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400)) {
        let loc = headers.location;
        // Absolute URL → extract path
        try { loc = new URL(loc).pathname; } catch {}
        // Rewrite to go through our proxy
        if (loc.startsWith('/') && !loc.startsWith('/devpreview/')) {
          headers.location = '/devpreview' + loc;
        }
      }

      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.status(502).json({ error: 'Dev server not responding' });
    });
    req.pipe(proxyReq);
  }

  app.get('/devpreview/set', (req, res) => {
    devProxyPort = parseInt(req.query.port, 10);
    res.json({ ok: true, port: devProxyPort });
  });

  app.use('/devpreview', (req, res) => {
    const targetPath = req.originalUrl.replace(/^\/devpreview/, '') || '/';
    proxyToDevServer(req, res, targetPath);
  });

  // Next.js uses absolute paths for assets, HMR, and devtools
  app.use('/_next', (req, res) => {
    proxyToDevServer(req, res, req.originalUrl);
  });

  app.use('/__nextjs', (req, res) => {
    proxyToDevServer(req, res, req.originalUrl);
  });

  setupWebSocket(wss);

  // If launched with a project path, auto-open it
  const state = { currentProject: projectPath };

  app.get('/api/state', (req, res) => {
    res.json(state);
  });

  server.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.log(`WebIA running at ${url}`);

    // Auto-open browser (skip when running as Tauri sidecar)
    if (!process.env.TAURI_ENV && !process.argv.includes('--no-open')) {
      import('child_process').then(({ exec }) => {
        const cmd = process.platform === 'darwin' ? 'open' :
                    process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${cmd} ${url}`);
      });
    }
  });

  return server;
}

// Run directly — detect if this is the main entry point
// Works for: node src/server/index.js, SEA binary (wia-server), bin/wia.js import
const _isSEA = (() => { try { return require('node:sea').isSea(); } catch { return false; } })();
const _isDirectRun = _isSEA || (process.argv[1] && process.argv[1].includes('server'));

if (_isDirectRun) {
  // Parse --port=N from argv (Tauri sidecar passes this)
  let port = parseInt(process.env.PORT || '3000', 10);
  let projectPath = null;

  for (const arg of process.argv.slice(1)) {
    if (arg.startsWith('--port=')) port = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--port') && false) { /* handled by = format */ }
    else if (!arg.startsWith('-')) projectPath = arg;
  }

  startServer({ projectPath, port });
}
