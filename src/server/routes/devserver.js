import { Router } from 'express';
import { readFile, rm, readdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative } from 'path';
import { spawn } from 'child_process';
import { createServer as createNetServer } from 'net';
import http from 'http';
import { getShellPath, resolveCmd } from '../shell-path.js';

const ENHANCED_PATH = getShellPath();
const NPX = resolveCmd('npx');
const NPM = resolveCmd('npm');

// Track running dev servers: projectPath → { process, port, framework }
const servers = new Map();

/**
 * Detect framework from package.json
 */
async function detectFramework(projectDir) {
  // Check for package.json in project root and common subdirs
  const candidates = [
    projectDir,
    join(projectDir, 'apps', 'web'),
    join(projectDir, 'packages', 'web'),
    join(projectDir, 'packages', 'app'),
  ];

  for (const dir of candidates) {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['next']) return { framework: 'next', dir, scripts: pkg.scripts };
      if (deps['vite']) return { framework: 'vite', dir, scripts: pkg.scripts };
      if (deps['react-scripts']) return { framework: 'cra', dir, scripts: pkg.scripts };
      if (deps['@remix-run/react']) return { framework: 'remix', dir, scripts: pkg.scripts };
      if (deps['astro']) return { framework: 'astro', dir, scripts: pkg.scripts };
      if (deps['svelte']) return { framework: 'svelte', dir, scripts: pkg.scripts };
      if (deps['nuxt']) return { framework: 'nuxt', dir, scripts: pkg.scripts };
      if (deps['vue']) return { framework: 'vue', dir, scripts: pkg.scripts };

      // Has a dev script → generic framework
      if (pkg.scripts?.dev) return { framework: 'generic', dir, scripts: pkg.scripts };
    } catch {
      // No package.json in this dir
    }
  }

  return null;
}

/**
 * Find a free port
 */
function findPort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/**
 * Start the project's dev server on a given port
 */
function needsInstall(dir) {
  return !existsSync(join(dir, 'node_modules'));
}

function installDeps(dir, entry) {
  console.log(`[devserver] node_modules missing in ${dir}, running npm install...`);
  entry.status = 'installing';
  entry.logs += '[WebIA] Installing dependencies...\n';

  return new Promise((resolve, reject) => {
    const child = spawn(NPM, ['install'], {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
      env: { ...process.env, PATH: ENHANCED_PATH },
    });
    child.stdout.on('data', (d) => { entry.logs += d.toString(); });
    child.stderr.on('data', (d) => { entry.logs += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) {
        entry.logs += '[WebIA] Dependencies installed.\n';
        resolve();
      } else {
        reject(new Error(`npm install failed (code ${code})`));
      }
    });
    setTimeout(() => { child.kill(); reject(new Error('npm install timed out')); }, 120000);
  });
}

async function startDevServer(info, port) {
  const { framework, dir } = info;

  // Build the command based on framework
  let cmd, args;
  const env = { ...process.env, PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0', PATH: ENHANCED_PATH };

  switch (framework) {
    case 'next':
      // Remove stale lock file that blocks startup
      await rm(join(dir, '.next', 'dev', 'lock'), { force: true }).catch(() => {});
      cmd = NPX;
      args = ['next', 'dev', '-p', String(port)];
      break;
    case 'vite':
      cmd = NPX;
      args = ['vite', '--port', String(port), '--strictPort'];
      break;
    case 'cra':
      cmd = NPX;
      args = ['react-scripts', 'start'];
      break;
    case 'remix':
      cmd = NPX;
      args = ['remix', 'dev', '--port', String(port)];
      break;
    case 'astro':
      cmd = NPX;
      args = ['astro', 'dev', '--port', String(port)];
      break;
    default:
      // Generic: use npm run dev with PORT env
      cmd = NPM;
      args = ['run', 'dev'];
      break;
  }

  const child = spawn(cmd, args, {
    cwd: dir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  return child;
}

/**
 * Wait for the dev server to be ready (port responding)
 * Also watches the child process — if it exits early, fail fast.
 */
function waitForServer(port, childProcess, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    let done = false;

    // Fail fast if process crashes before server is ready
    const onExit = (code) => {
      if (!done) {
        done = true;
        reject(new Error(`Dev server process exited with code ${code} before becoming ready`));
      }
    };
    childProcess.on('exit', onExit);

    const check = () => {
      if (done) return;
      if (Date.now() - start > timeoutMs) {
        done = true;
        childProcess.removeListener('exit', onExit);
        return reject(new Error('Dev server startup timed out'));
      }
      {
        const req = http.get(`http://localhost:${port}`, (res) => {
          if (!done) {
            done = true;
            childProcess.removeListener('exit', onExit);
            resolve();
          }
        });
        req.on('error', () => {
          setTimeout(check, 500);
        });
        req.setTimeout(2000, () => {
          req.destroy();
          setTimeout(check, 500);
        });
      }
    };
    check();
  });
}

/**
 * Scan Next.js App Router pages to extract routes
 */
async function scanNextRoutes(appDir) {
  const routes = [];

  async function walk(dir, prefix) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;

      if (entry.isDirectory()) {
        let segment = entry.name;
        // Route groups: (app), (public) → don't add to path but track as group
        const isGroup = segment.startsWith('(') && segment.endsWith(')');
        const nextPrefix = isGroup ? prefix : `${prefix}/${segment}`;
        const group = isGroup ? segment.slice(1, -1) : null;

        await walk(join(dir, entry.name), nextPrefix);

        // Tag routes found in this group
        if (group) {
          for (const r of routes) {
            if (!r.group && r._fromDir?.startsWith(join(dir, entry.name))) {
              r.group = group;
            }
          }
        }
      } else if (entry.name === 'page.tsx' || entry.name === 'page.jsx' || entry.name === 'page.js') {
        const route = prefix || '/';
        routes.push({
          path: route.replace(/\/\[([^\]]+)\]/g, '/:$1'),
          raw: route,
          isDynamic: route.includes('['),
          _fromDir: dir,
        });
      }
    }
  }

  await walk(appDir, '');

  // Clean up internal field and sort
  return routes
    .map(({ _fromDir, ...r }) => r)
    .sort((a, b) => {
      // "/" always first
      if (a.path === '/') return -1;
      if (b.path === '/') return 1;
      // Static routes first, then dynamic
      if (a.isDynamic !== b.isDynamic) return a.isDynamic ? 1 : -1;
      return a.path.localeCompare(b.path);
    });
}

/**
 * Scan routes for any framework
 */
async function scanRoutes(info) {
  const { framework, dir } = info;

  if (framework === 'next') {
    // Try App Router first, then pages/
    const appDir = join(dir, 'src', 'app');
    let routes = await scanNextRoutes(appDir);
    if (routes.length === 0) {
      routes = await scanNextRoutes(join(dir, 'app'));
    }
    return routes;
  }

  // For Vite/generic: try to extract routes from source code, fallback to filesystem
  if (framework === 'vite' || framework === 'generic' || framework === 'vue' || framework === 'svelte') {
    const routes = [{ path: '/', raw: '/', isDynamic: false }];
    const seen = new Set(['/']);

    const addRoute = (p) => {
      const normalized = p.startsWith('/') ? p : '/' + p;
      if (seen.has(normalized)) return;
      seen.add(normalized);
      routes.push({ path: normalized, raw: normalized, isDynamic: normalized.includes(':') || normalized.includes('[') });
    };

    // Strategy 1: grep for pathname-based routes in router/App files
    const routerFiles = [
      join(dir, 'src', 'App.tsx'), join(dir, 'src', 'App.jsx'), join(dir, 'src', 'App.js'),
      join(dir, 'src', 'utils', 'router.tsx'), join(dir, 'src', 'utils', 'router.ts'),
      join(dir, 'src', 'router.tsx'), join(dir, 'src', 'router.ts'),
      join(dir, 'src', 'routes.tsx'), join(dir, 'src', 'routes.ts'),
    ];

    for (const rf of routerFiles) {
      try {
        const content = await readFile(rf, 'utf-8');
        // Match path="/xxx" or path: "/xxx" patterns (React Router)
        const pathMatches = content.matchAll(/path[=:]\s*["']([/][^"']*?)["']/g);
        for (const m of pathMatches) addRoute(m[1]);
        // Match pathname-based routing: pushState/replaceState('/xxx') or navigate('/xxx')
        const navMatches = content.matchAll(/(?:navigate|push|replace|pushState|history\.push)\s*\(\s*["']([/][^"']*?)["']/g);
        for (const m of navMatches) addRoute(m[1]);
      } catch {
        // File doesn't exist
      }
    }

    // Strategy 2: scan pages/routes/views directories for files and folders
    const pageDirs = [
      join(dir, 'src', 'pages'),
      join(dir, 'src', 'routes'),
      join(dir, 'src', 'views'),
    ];

    for (const pageDir of pageDirs) {
      try {
        const entries = await readdir(pageDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) {
            addRoute('/' + entry.name.toLowerCase());
          } else if (/\.(tsx|jsx|vue|svelte)$/.test(entry.name)) {
            // Convert "AboutPage.tsx" → "/about"
            const name = entry.name
              .replace(/\.(tsx|jsx|vue|svelte)$/, '')
              .replace(/Page$/i, '')
              .replace(/([a-z])([A-Z])/g, '$1-$2')
              .toLowerCase();
            if (name !== 'index' && name !== 'app' && name !== 'layout') {
              addRoute('/' + name);
            }
          }
        }
      } catch {
        // No pages dir
      }
    }

    return routes;
  }

  // Astro: file-based routing in src/pages/
  if (framework === 'astro') {
    const routes = [];
    const pagesDir = join(dir, 'src', 'pages');
    try {
      const walk = async (d, prefix) => {
        const entries = await readdir(d, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) {
            await walk(join(d, entry.name), `${prefix}/${entry.name}`);
          } else if (/^index\.(astro|md|mdx)$/.test(entry.name)) {
            routes.push({ path: prefix || '/', raw: prefix || '/', isDynamic: prefix.includes('[') });
          } else if (/\.(astro|md|mdx)$/.test(entry.name)) {
            const name = entry.name.replace(/\.(astro|md|mdx)$/, '');
            const route = `${prefix}/${name}`;
            routes.push({ path: route, raw: route, isDynamic: route.includes('[') });
          }
        }
      };
      await walk(pagesDir, '');
    } catch {
      // No pages dir
    }
    return routes.length > 0 ? routes : [{ path: '/', raw: '/', isDynamic: false }];
  }

  // Nuxt: pages/ directory
  if (framework === 'nuxt') {
    const routes = [];
    const pagesDir = join(dir, 'pages');
    try {
      const walk = async (d, prefix) => {
        const entries = await readdir(d, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
          if (entry.isDirectory()) {
            await walk(join(d, entry.name), `${prefix}/${entry.name}`);
          } else if (entry.name === 'index.vue') {
            routes.push({ path: prefix || '/', raw: prefix || '/', isDynamic: prefix.includes('[') });
          } else if (entry.name.endsWith('.vue')) {
            const name = entry.name.replace('.vue', '');
            const route = `${prefix}/${name}`;
            routes.push({ path: route, raw: route, isDynamic: route.includes('[') });
          }
        }
      };
      await walk(pagesDir, '');
    } catch {
      // No pages dir
    }
    return routes.length > 0 ? routes : [{ path: '/', raw: '/', isDynamic: false }];
  }

  // Fallback: at least show /
  return [{ path: '/', raw: '/', isDynamic: false }];
}

export function createDevServerRouter() {
  const router = Router();

  // Detect project type
  router.get('/detect', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });

      const info = await detectFramework(dir);
      if (!info) {
        return res.json({ framework: null, isStatic: true });
      }

      res.json({
        framework: info.framework,
        projectDir: info.dir,
        isStatic: false,
        hasDevScript: !!info.scripts?.dev,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Start dev server
  router.post('/start', async (req, res) => {
    try {
      const { dir } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });

      // Already running?
      if (servers.has(dir)) {
        const existing = servers.get(dir);
        return res.json({ port: existing.port, framework: existing.framework, alreadyRunning: true });
      }

      const info = await detectFramework(dir);
      if (!info) {
        return res.status(400).json({ error: 'No framework detected. Use static mode.' });
      }

      const port = await findPort();

      // Create entry immediately so client can poll status
      const entry = { process: null, port, framework: info.framework, projectDir: info.dir, status: 'starting', logs: '' };
      servers.set(dir, entry);

      // Respond immediately — everything else happens in background
      res.json({ port, framework: info.framework, projectDir: info.dir, status: 'starting' });

      // Background: install deps if needed, then start dev server
      (async () => {
        try {
          // Step 1: install deps if node_modules is missing
          if (needsInstall(info.dir)) {
            await installDeps(info.dir, entry);
          }

          // Step 2: start the dev server
          entry.status = 'starting';
          const child = await startDevServer(info, port);
          entry.process = child;

          child.stdout.on('data', (d) => { entry.logs += d.toString(); });
          child.stderr.on('data', (d) => { entry.logs += d.toString(); });

          child.on('exit', (code) => {
            console.log(`[devserver] ${info.framework} exited with code ${code}`);
            if (entry.status === 'starting' || entry.status === 'installing') {
              entry.status = 'crashed';
              entry.error = `Process exited with code ${code}`;
              setTimeout(() => servers.delete(dir), 15000);
            } else {
              servers.delete(dir);
            }
          });

          // Step 3: wait for server to respond
          waitForServer(port, child).then(() => {
            entry.status = 'ready';
            console.log(`[devserver] ${info.framework} ready on port ${port}`);
          }).catch((waitErr) => {
            if (!child.killed && child.exitCode !== null) {
              entry.status = 'crashed';
              entry.error = waitErr.message;
              console.log(`[devserver] ${info.framework} crashed: ${waitErr.message}`);
            } else {
              entry.status = 'ready';
              console.log(`[devserver] Warning: timeout waiting for port ${port}, assuming ready`);
            }
          });
        } catch (err) {
          entry.status = 'crashed';
          entry.error = err.message;
          entry.logs += `[WebIA] Error: ${err.message}\n`;
          console.log(`[devserver] Failed to start: ${err.message}`);
          setTimeout(() => servers.delete(dir), 15000);
        }
      })();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stop dev server
  router.post('/stop', async (req, res) => {
    try {
      const { dir } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });

      const entry = servers.get(dir);
      if (!entry) return res.json({ ok: true, message: 'not running' });

      entry.process.kill('SIGTERM');
      servers.delete(dir);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Status (with logs for loading UI)
  router.get('/status', async (req, res) => {
    const { dir } = req.query;
    if (dir && servers.has(dir)) {
      const s = servers.get(dir);
      return res.json({
        running: true,
        port: s.port,
        framework: s.framework,
        status: s.status || 'ready',
        error: s.error || null,
        logs: (s.logs || '').slice(-1500),
      });
    }
    res.json({ running: false });
  });

  // Scan routes for the project
  router.get('/routes', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });

      const info = await detectFramework(dir);
      if (!info) return res.json({ routes: [] });

      const routes = await scanRoutes(info);
      res.json({ routes });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// Cleanup on process exit
process.on('exit', () => {
  for (const [, entry] of servers) {
    entry.process.kill('SIGTERM');
  }
});
