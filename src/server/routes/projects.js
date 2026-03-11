import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

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

  return router;
}
