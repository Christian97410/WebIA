import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import simpleGit from 'simple-git';
import { shellEnv } from '../shell-path.js';

const CONFIG_DIR = join(homedir(), '.wia');
const GH_TOKEN_FILE = join(CONFIG_DIR, 'github-token');

// Read stored GitHub token (plain text file in ~/.wia/)
async function loadGitHubToken() {
  try {
    return (await readFile(GH_TOKEN_FILE, 'utf-8')).trim();
  } catch { return null; }
}

async function saveGitHubToken(token) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(GH_TOKEN_FILE, token, { mode: 0o600 });
}

async function deleteGitHubToken() {
  try { const { unlink } = await import('fs/promises'); await unlink(GH_TOKEN_FILE); } catch {}
}

// Configure git remote URL with token for auth
function tokenizeUrl(url, token) {
  if (!token || !url) return url;
  // https://github.com/user/repo.git -> https://<token>@github.com/user/repo.git
  return url.replace(/^https:\/\//, `https://${token}@`);
}

function cleanUrl(url) {
  if (!url) return url;
  return url.replace(/^https:\/\/[^@]+@/, 'https://');
}

export function createGitRouter() {
  const router = Router();

  // Git status (branch, modified, staged, remote info)
  router.get('/status', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);

      const isRepo = await git.checkIsRepo();
      if (!isRepo) return res.json({ isRepo: false });

      const status = await git.status();

      // Check remote
      let remote = null;
      let ahead = 0;
      let behind = 0;
      try {
        const remotes = await git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');
        if (origin) {
          remote = cleanUrl(origin.refs.push || origin.refs.fetch);
          // Fetch silently to get ahead/behind
          try {
            await git.fetch({ '--quiet': null });
            const statusAfter = await git.status();
            ahead = statusAfter.ahead || 0;
            behind = statusAfter.behind || 0;
          } catch { /* offline or no upstream */ }
        }
      } catch {}

      res.json({
        isRepo: true,
        branch: status.current,
        modified: status.modified,
        staged: status.staged,
        not_added: status.not_added,
        conflicted: status.conflicted,
        created: status.created,
        deleted: status.deleted,
        renamed: status.renamed,
        isClean: status.isClean(),
        remote,
        ahead,
        behind,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get diff
  router.get('/diff', async (req, res) => {
    try {
      const { dir, file } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      const diff = file ? await git.diff(['--', file]) : await git.diff();
      const diffStaged = file ? await git.diff(['--cached', '--', file]) : await git.diff(['--cached']);
      res.json({ diff: diff + diffStaged });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Init repo
  router.post('/init', async (req, res) => {
    try {
      const { dir } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      await git.init();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Stage files
  router.post('/stage', async (req, res) => {
    try {
      const { dir, files } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      if (files && files.length) {
        await git.add(files);
      } else {
        await git.add('.');
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unstage files
  router.post('/unstage', async (req, res) => {
    try {
      const { dir, files } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      await git.reset(files || []);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Commit
  router.post('/commit', async (req, res) => {
    try {
      const { dir, message } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      if (!message) return res.status(400).json({ error: 'message required' });
      const git = simpleGit(dir);
      // Stage all if nothing staged
      const status = await git.status();
      if (status.staged.length === 0) {
        await git.add('.');
      }
      const result = await git.commit(message);
      res.json({
        ok: true,
        commit: result.commit,
        summary: {
          changes: result.summary.changes,
          insertions: result.summary.insertions,
          deletions: result.summary.deletions,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Push
  router.post('/push', async (req, res) => {
    try {
      const { dir } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir, { env: shellEnv() });

      // Inject token into remote URL if available
      const token = await loadGitHubToken();
      if (token) {
        const remotes = await git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');
        if (origin) {
          const authUrl = tokenizeUrl(cleanUrl(origin.refs.push || origin.refs.fetch), token);
          await git.push(authUrl, await git.branchLocal().then(b => b.current));
          return res.json({ ok: true });
        }
      }

      await git.push();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Pull
  router.post('/pull', async (req, res) => {
    try {
      const { dir } = req.body;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir, { env: shellEnv() });

      const token = await loadGitHubToken();
      if (token) {
        const remotes = await git.getRemotes(true);
        const origin = remotes.find(r => r.name === 'origin');
        if (origin) {
          const authUrl = tokenizeUrl(cleanUrl(origin.refs.push || origin.refs.fetch), token);
          await git.pull(authUrl, await git.branchLocal().then(b => b.current));
          return res.json({ ok: true });
        }
      }

      await git.pull();
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Branches
  router.get('/branch', async (req, res) => {
    try {
      const { dir } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      const branch = await git.branchLocal();
      res.json({ current: branch.current, branches: branch.all });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create branch
  router.post('/branch', async (req, res) => {
    try {
      const { dir, name, checkout } = req.body;
      if (!dir || !name) return res.status(400).json({ error: 'dir and name required' });
      const git = simpleGit(dir);
      if (checkout) {
        await git.checkoutLocalBranch(name);
      } else {
        await git.branch([name]);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Checkout branch
  router.post('/checkout', async (req, res) => {
    try {
      const { dir, branch } = req.body;
      if (!dir || !branch) return res.status(400).json({ error: 'dir and branch required' });
      const git = simpleGit(dir);
      await git.checkout(branch);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add remote
  router.post('/remote', async (req, res) => {
    try {
      const { dir, url } = req.body;
      if (!dir || !url) return res.status(400).json({ error: 'dir and url required' });
      const git = simpleGit(dir);
      const remotes = await git.getRemotes();
      if (remotes.find(r => r.name === 'origin')) {
        await git.remote(['set-url', 'origin', url]);
      } else {
        await git.addRemote('origin', url);
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Log (recent commits)
  router.get('/log', async (req, res) => {
    try {
      const { dir, n } = req.query;
      if (!dir) return res.status(400).json({ error: 'dir required' });
      const git = simpleGit(dir);
      const log = await git.log({ maxCount: parseInt(n) || 20 });
      res.json({ commits: log.all.map(c => ({
        hash: c.hash.slice(0, 7),
        message: c.message,
        author: c.author_name,
        date: c.date,
      }))});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GitHub auth — store/read/delete token
  router.get('/github/auth', async (_req, res) => {
    const token = await loadGitHubToken();
    if (!token) return res.json({ authenticated: false });
    // Validate token by calling GitHub API
    try {
      const resp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'WebIA' },
      });
      if (resp.ok) {
        const user = await resp.json();
        return res.json({ authenticated: true, user: user.login, avatar: user.avatar_url });
      }
    } catch {}
    res.json({ authenticated: false, invalid: true });
  });

  router.post('/github/auth', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    // Validate
    try {
      const resp = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'WebIA' },
      });
      if (!resp.ok) return res.status(401).json({ error: 'Invalid token' });
      const user = await resp.json();
      await saveGitHubToken(token);
      res.json({ authenticated: true, user: user.login, avatar: user.avatar_url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/github/auth', async (_req, res) => {
    await deleteGitHubToken();
    res.json({ ok: true });
  });

  // Create GitHub repo
  router.post('/github/create-repo', async (req, res) => {
    try {
      const { dir, name, private: isPrivate } = req.body;
      const token = await loadGitHubToken();
      if (!token) return res.status(401).json({ error: 'Not authenticated with GitHub' });

      const resp = await fetch('https://api.github.com/user/repos', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'WebIA',
        },
        body: JSON.stringify({ name, private: isPrivate !== false, auto_init: false }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        return res.status(resp.status).json({ error: err.message || 'Failed to create repo' });
      }

      const repo = await resp.json();
      const git = simpleGit(dir);

      // Set remote
      const remotes = await git.getRemotes();
      if (remotes.find(r => r.name === 'origin')) {
        await git.remote(['set-url', 'origin', repo.clone_url]);
      } else {
        await git.addRemote('origin', repo.clone_url);
      }

      // Push
      const branch = (await git.branchLocal()).current || 'main';
      const authUrl = tokenizeUrl(repo.clone_url, token);
      try {
        await git.push(authUrl, branch, ['--set-upstream']);
      } catch {
        // First push might need -u
        await git.push(['-u', authUrl, branch]);
      }

      res.json({ ok: true, url: repo.html_url, clone_url: repo.clone_url });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
