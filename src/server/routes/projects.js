import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { execSync, spawn } from 'child_process';

const CONFIG_DIR = join(homedir(), '.wia');
const CONFIG_FILE = join(CONFIG_DIR, 'projects.json');

async function loadProjects() {
  try {
    const data = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(data);
  } catch {
    return [];
  }
}

async function saveProjects(projects) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(projects, null, 2), 'utf-8');
}

export function createProjectRouter() {
  const router = Router();

  // List recent projects
  router.get('/', async (req, res) => {
    const projects = await loadProjects();
    res.json(projects);
  });

  // Add / update a project
  router.post('/', async (req, res) => {
    const { path, name } = req.body;
    if (!path) return res.status(400).json({ error: 'path required' });

    const projects = await loadProjects();
    const existing = projects.findIndex(p => p.path === path);

    const project = {
      path,
      name: name || path.split('/').pop(),
      lastOpened: new Date().toISOString(),
    };

    if (existing >= 0) {
      projects.splice(existing, 1);
    }
    projects.unshift(project);

    // Keep max 20 recent projects
    const trimmed = projects.slice(0, 20);
    await saveProjects(trimmed);
    res.json(project);
  });

  // Remove a project from recents
  router.delete('/', async (req, res) => {
    const { path } = req.body;
    const projects = await loadProjects();
    const filtered = projects.filter(p => p.path !== path);
    await saveProjects(filtered);
    res.json({ ok: true });
  });

  // Create a new project from template
  router.post('/create', async (req, res) => {
    const { name, location, template } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!location) return res.status(400).json({ error: 'location required' });

    // Resolve ~ to home dir
    const parentDir = location.startsWith('~')
      ? join(homedir(), location.slice(1))
      : location;

    const projectPath = join(parentDir, name);

    try {
      // Ensure parent exists
      await mkdir(parentDir, { recursive: true });

      if (template === 'html') {
        // Simple HTML/CSS project — no npm needed
        await mkdir(projectPath, { recursive: true });
        await writeFile(join(projectPath, 'index.html'), `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>${name}</h1>
  <p>Edit this page to get started.</p>
</body>
</html>
`, 'utf-8');
        await writeFile(join(projectPath, 'style.css'), `* { margin: 0; padding: 0; box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #fafafa;
  color: #111;
}

h1 {
  font-size: 2rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
}

p {
  color: #666;
}
`, 'utf-8');
        return res.json({ path: projectPath });
      }

      // Framework templates — run scaffolding command
      const commands = {
        'vite-react': `npm create vite@latest ${name} -- --template react-ts`,
        'vite-vue':   `npm create vite@latest ${name} -- --template vue-ts`,
        'next':       `npx create-next-app@latest ${name} --ts --app --tailwind --eslint --no-src-dir --import-alias "@/*" --use-npm`,
        'astro':      `npm create astro@latest ${name} -- --template basics --no-install --no-git`,
      };

      const cmd = commands[template];
      if (!cmd) return res.status(400).json({ error: `Unknown template: ${template}` });

      // Run scaffolding in parent dir
      await new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', cmd], {
          cwd: parentDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, npm_config_yes: 'true' },
        });

        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(stderr.trim() || `Scaffolding exited with code ${code}`));
        });

        // Timeout after 60s
        setTimeout(() => {
          child.kill();
          reject(new Error('Scaffolding timed out'));
        }, 60000);
      });

      // Install dependencies
      try {
        await new Promise((resolve, reject) => {
          const child = spawn('npm', ['install'], {
            cwd: projectPath,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: true,
          });
          child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`npm install failed (code ${code})`));
          });
          setTimeout(() => { child.kill(); reject(new Error('npm install timed out')); }, 120000);
        });
      } catch {
        // Non-fatal: project created but deps not installed
      }

      res.json({ path: projectPath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
