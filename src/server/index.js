import express from 'express';
import { createServer, request as httpRequest } from 'http';
import { exec } from 'child_process';
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

  // Allow cross-origin API access (needed when Tauri WebView navigates
  // from the tauri:// protocol to http://localhost — origin may differ).
  app.use('/api', (req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // When a framework dev server is active, proxy iframe requests BEFORE
  // express.static so the root "/" serves the project page, not WebIA's index.html.
  // Sec-Fetch-Dest: iframe identifies the initial <iframe src="..."> load.
  app.use((req, res, next) => {
    if (!devProxyPort) return next();
    const sfd = req.headers['sec-fetch-dest'];
    if (sfd !== 'iframe') return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) return next();
    console.log(`[iframe-proxy] ${req.method} ${req.path} sec-fetch-dest=${sfd} → port ${devProxyPort}`);
    proxyToDevServer(req, res, req.originalUrl);
  });

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
  let blockRedirects = false;

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

      // Handle redirects
      if (headers.location && (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400)) {
        if (blockRedirects) {
          // Block the redirect: consume the response and serve the target page instead
          proxyRes.resume();
          let loc = headers.location;
          try { loc = new URL(loc).pathname + (new URL(loc).search || ''); } catch {}
          // Re-fetch the redirect target directly from the dev server
          const retryReq = httpRequest({
            hostname: 'localhost', port: targetPort, path: loc, method: 'GET', headers: fwdHeaders,
          }, (retryRes) => {
            const retryHeaders = { ...retryRes.headers };
            delete retryHeaders['x-frame-options'];
            delete retryHeaders['content-security-policy'];
            // If it's another redirect, just follow it (max 1 hop)
            res.writeHead(retryRes.statusCode, retryHeaders);
            retryRes.pipe(res);
          });
          retryReq.on('error', () => res.status(502).json({ error: 'Dev server not responding' }));
          retryReq.end();
          return;
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

  app.get('/devpreview/block-redirects', (req, res) => {
    blockRedirects = req.query.enabled === 'true';
    res.json({ ok: true, blockRedirects });
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

  // Catch-all: proxy unmatched routes to the dev server when active.
  // Handles client-side navigation (e.g. /dashboard) and server redirects.
  app.use((req, res, next) => {
    if (!devProxyPort) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/preview/')) return next();
    proxyToDevServer(req, res, req.originalUrl);
  });

  setupWebSocket(wss);

  // ── Update check endpoint (works without Tauri IPC) ──
  const UPDATE_URL = 'https://github.com/Christian97410/WebIA/releases/latest/download/latest.json';
  let cachedUpdate = null;

  // Parse --version=X.Y.Z from CLI args
  const versionArg = process.argv.find(a => a.startsWith('--version='));
  const currentVersion = versionArg ? versionArg.split('=')[1] : null;

  app.get('/api/update-check', async (req, res) => {
    if (!currentVersion) return res.json({ available: false, reason: 'dev-mode' });
    if (cachedUpdate) return res.json(cachedUpdate);

    try {
      const resp = await fetch(UPDATE_URL);
      if (!resp.ok) return res.json({ available: false });
      const data = await resp.json();
      const latest = data.version;
      const available = latest && latest !== currentVersion && compareVersions(latest, currentVersion) > 0;
      cachedUpdate = { available, currentVersion, latestVersion: latest, downloadUrl: `https://github.com/Christian97410/WebIA/releases/tag/v${latest}` };
      res.json(cachedUpdate);
    } catch {
      res.json({ available: false });
    }
  });

  function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1;
      if ((pa[i] || 0) < (pb[i] || 0)) return -1;
    }
    return 0;
  }

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
      const cmd = process.platform === 'darwin' ? 'open' :
                  process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} ${url}`);
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

  // Skip argv[0] (node) and argv[1] (script path) — real args start at index 2.
  // For SEA binaries, argv[1] is already the first real arg.
  const argsStart = _isSEA ? 1 : 2;
  for (const arg of process.argv.slice(argsStart)) {
    if (arg.startsWith('--port=')) port = parseInt(arg.split('=')[1], 10);
    else if (!arg.startsWith('-')) projectPath = arg;
  }

  startServer({ projectPath, port });
}
