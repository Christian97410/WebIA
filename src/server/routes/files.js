import { Router } from 'express';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { join, extname, relative } from 'path';
import { execSync } from 'child_process';
import { validateFilePath } from '../path-guard.js';

export function createFileRouter() {
  const router = Router();

  // Read a file
  router.get('/read', async (req, res) => {
    try {
      const { path: filePath } = req.query;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const safePath = validateFilePath(req, res, filePath);
      if (!safePath) return; // 403 already sent
      const content = await readFile(safePath, 'utf-8');
      res.json({ content, path: safePath });
    } catch (err) {
      res.status(404).json({ error: err.message });
    }
  });

  // Write a file
  router.post('/write', async (req, res) => {
    try {
      const { path: filePath, content } = req.body;
      if (!filePath) return res.status(400).json({ error: 'path required' });
      const safePath = validateFilePath(req, res, filePath);
      if (!safePath) return;
      await writeFile(safePath, content, 'utf-8');
      res.json({ ok: true, path: safePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Scan project directory for HTML/CSS files
  router.get('/scan', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const files = await scanDir(dir, dir);
      res.json({ files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Browse directories (for the file picker modal)
  router.get('/browse', async (req, res) => {
    try {
      const dir = (req.query.dir && req.query.dir.trim()) || process.env.HOME || '/';
      const entries = await readdir(dir, { withFileTypes: true });
      const dirs = [];
      const files = [];

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isDirectory()) {
          dirs.push(entry.name);
        } else {
          const ext = extname(entry.name).toLowerCase();
          if (['.html', '.css', '.js'].includes(ext)) {
            files.push(entry.name);
          }
        }
      }

      dirs.sort((a, b) => a.localeCompare(b));
      files.sort((a, b) => a.localeCompare(b));

      res.json({ dir, dirs, files });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Native OS folder picker
  router.get('/pick-folder', async (req, res) => {
    try {
      let folder = null;

      if (process.platform === 'darwin') {
        folder = execSync(
          `osascript -e 'POSIX path of (choose folder with prompt "Select project folder")'`,
          { encoding: 'utf-8', timeout: 60000 }
        ).trim();
      } else if (process.platform === 'win32') {
        const ps = `Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.FolderBrowserDialog; if($f.ShowDialog() -eq 'OK'){$f.SelectedPath}`;
        folder = execSync(`powershell -Command "${ps}"`, { encoding: 'utf-8', timeout: 60000 }).trim();
      } else {
        // Linux — try zenity, then kdialog
        try {
          folder = execSync('zenity --file-selection --directory', { encoding: 'utf-8', timeout: 60000 }).trim();
        } catch {
          folder = execSync('kdialog --getexistingdirectory ~', { encoding: 'utf-8', timeout: 60000 }).trim();
        }
      }

      if (folder) {
        // Remove trailing slash
        folder = folder.replace(/\/+$/, '');
        res.json({ folder });
      } else {
        res.json({ folder: null, cancelled: true });
      }
    } catch (err) {
      // User cancelled the dialog or error
      res.json({ folder: null, cancelled: true });
    }
  });

  return router;
}

const IGNORED = ['node_modules', '.git', '.next', 'dist', 'build', '.cache'];
const EXTENSIONS = ['.html', '.css', '.js', '.jsx', '.ts', '.tsx', '.json', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp'];

async function scanDir(dir, root, depth = 0) {
  if (depth > 5) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (IGNORED.includes(entry.name) || entry.name.startsWith('.')) continue;

    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = await scanDir(fullPath, root, depth + 1);
      results.push(...children);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (EXTENSIONS.includes(ext)) {
        results.push({
          name: entry.name,
          path: fullPath,
          relativePath: relative(root, fullPath),
          type: ext.slice(1),
        });
      }
    }
  }

  return results;
}
