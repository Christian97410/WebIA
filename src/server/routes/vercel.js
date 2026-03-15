import { Router } from 'express';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.wia');
const VERCEL_TOKEN_FILE = join(CONFIG_DIR, 'vercel-token');
const VERCEL_API = 'https://api.vercel.com';
const VC_OAUTH_CLIENT_ID = process.env.VERCEL_OAUTH_CLIENT_ID || '';
const VC_OAUTH_CLIENT_SECRET = process.env.VERCEL_OAUTH_CLIENT_SECRET || '';
const VC_OAUTH_CALLBACK = '/api/vercel/oauth/callback';
const pendingOAuthStates = new Set();

// ── Token persistence ──

async function loadToken() {
  try {
    const raw = await readFile(VERCEL_TOKEN_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveToken(data) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(VERCEL_TOKEN_FILE, JSON.stringify(data), { mode: 0o600 });
}

async function deleteToken() {
  try { await unlink(VERCEL_TOKEN_FILE); } catch {}
}

async function getAccessToken() {
  const data = await loadToken();
  if (!data) return null;
  return data.access_token;
}

// Proxy helper for Vercel API
async function vercelFetch(path, options = {}) {
  const data = await loadToken();
  if (!data?.access_token) throw new Error('Not authenticated with Vercel');
  const token = data.access_token;

  // Append teamId if stored (from OAuth flow)
  let url = `${VERCEL_API}${path}`;
  if (data.team_id) {
    url += (url.includes('?') ? '&' : '?') + `teamId=${data.team_id}`;
  }

  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!resp.ok) {
    const body = await resp.text();
    let msg;
    try { msg = JSON.parse(body).error?.message || JSON.parse(body).message || body; } catch { msg = body; }
    throw new Error(msg || `Vercel API ${resp.status}`);
  }

  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

export function createVercelRouter() {
  const router = Router();

  // ── Auth: store/check/delete access token ──

  // Check auth status
  router.get('/auth', async (_req, res) => {
    const token = await getAccessToken();
    if (!token) return res.json({ authenticated: false });
    try {
      const resp = await fetch(`${VERCEL_API}/v2/user`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        const data = await resp.json();
        const u = data.user;
        return res.json({ authenticated: true, user: { username: u.username, name: u.name } });
      }
    } catch {}
    res.json({ authenticated: false, invalid: true });
  });

  // Save access token (personal access token flow)
  router.post('/auth', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    try {
      const resp = await fetch(`${VERCEL_API}/v2/user`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return res.status(401).json({ error: 'Invalid token' });
      const data = await resp.json();
      const u = data.user;
      await saveToken({ access_token: token });
      res.json({ authenticated: true, user: { username: u.username, name: u.name } });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sign out
  router.delete('/auth', async (_req, res) => {
    await deleteToken();
    res.json({ ok: true });
  });

  // ── OAuth flow ──

  // Check if OAuth is configured
  router.get('/oauth/config', (_req, res) => {
    res.json({ configured: !!VC_OAUTH_CLIENT_ID });
  });

  // Start OAuth flow
  router.get('/oauth/authorize', (req, res) => {
    if (!VC_OAUTH_CLIENT_ID) return res.status(500).json({ error: 'Vercel OAuth not configured' });

    const state = Math.random().toString(36).slice(2) + Date.now().toString(36);
    pendingOAuthStates.add(state);
    setTimeout(() => pendingOAuthStates.delete(state), 600000);

    // Vercel OAuth uses their integrations URL
    const params = new URLSearchParams({
      client_id: VC_OAUTH_CLIENT_ID,
      redirect_uri: `${req.protocol}://${req.get('host')}${VC_OAUTH_CALLBACK}`,
      state,
    });

    // NOTE: Vercel's OAuth authorize URL might be at vercel.com/integrations/...
    // but the standard flow uses:
    res.json({ url: `https://vercel.com/integrations/${VC_OAUTH_CLIENT_ID}/new?${params}` });
  });

  // Handle OAuth callback
  router.get('/oauth/callback', async (req, res) => {
    const { code, state } = req.query;

    if (!code) return res.status(400).send('Missing authorization code');
    if (!state || !pendingOAuthStates.has(state)) return res.status(400).send('Invalid state');
    pendingOAuthStates.delete(state);

    try {
      const tokenResp = await fetch('https://api.vercel.com/v2/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: VC_OAUTH_CLIENT_ID,
          client_secret: VC_OAUTH_CLIENT_SECRET,
          code,
          redirect_uri: `${req.protocol}://${req.get('host')}${VC_OAUTH_CALLBACK}`,
        }),
      });

      if (!tokenResp.ok) {
        const err = await tokenResp.text();
        return res.status(400).send('OAuth failed: ' + err);
      }

      const data = await tokenResp.json();
      await saveToken({
        access_token: data.access_token,
        team_id: data.team_id || null,
      });

      res.send(`<html><body><script>window.opener?.postMessage({type:'vercel-oauth-success'},'*');window.close();</script><p>Connected! You can close this tab.</p></body></html>`);
    } catch (err) {
      res.status(500).send('OAuth error: ' + err.message);
    }
  });

  // ── Projects ──

  // List all projects
  router.get('/projects', async (_req, res) => {
    try {
      const data = await vercelFetch('/v10/projects');
      res.json(data.projects.map(p => ({
        id: p.id,
        name: p.name,
        framework: p.framework || null,
        gitRepo: p.link ? `${p.link.org}/${p.link.repo}` : null,
        latestDeployment: p.latestDeployments?.[0]
          ? { state: p.latestDeployments[0].readyState || p.latestDeployments[0].state }
          : null,
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create project
  router.post('/projects', async (req, res) => {
    const { name, gitRepo, framework } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    try {
      const body = { name };
      if (framework) body.framework = framework;
      if (gitRepo) {
        body.gitRepository = { type: 'github', repo: gitRepo };
      }
      const project = await vercelFetch('/v11/projects', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      res.json({
        id: project.id,
        name: project.name,
        framework: project.framework || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Project linking (per-project config) ──

  // Get linked project for a local directory
  router.get('/link', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      res.json(config || { linked: false });
    } catch {
      res.json({ linked: false });
    }
  });

  // Link a Vercel project to a local directory
  router.post('/link', async (req, res) => {
    const { dir, projectId, projectName } = req.body;
    if (!dir || !projectId) return res.status(400).json({ error: 'dir and projectId required' });
    try {
      const config = {
        linked: true,
        projectId,
        projectName: projectName || '',
      };
      await saveProjectConfig(dir, config);
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Unlink
  router.delete('/link', async (req, res) => {
    const { dir } = req.body;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      await deleteProjectConfig(dir);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Deployments ──

  // List recent deployments for linked project
  router.get('/deployments', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Vercel project linked' });

      const data = await vercelFetch(`/v6/deployments?projectId=${config.projectId}&limit=10`);
      res.json(data.deployments.map(d => ({
        id: d.uid,
        url: d.url,
        state: d.state || d.readyState,
        target: d.target || null,
        createdAt: d.created || d.createdAt,
        meta: {
          commitMessage: d.meta?.githubCommitMessage || null,
          branch: d.meta?.githubCommitRef || null,
        },
      })));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Trigger deployment
  router.post('/deploy', async (req, res) => {
    const { dir, target } = req.body;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Vercel project linked' });

      const body = {
        name: config.projectName || config.projectId,
        project: config.projectId,
        target: target || 'production',
        gitSource: {
          type: 'github',
          ref: 'main',
        },
      };

      const deployment = await vercelFetch('/v13/deployments', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      res.json({
        id: deployment.id,
        url: deployment.url,
        state: deployment.readyState || deployment.state,
        target: deployment.target,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Build logs ──

  router.get('/deployments/:id/logs', async (req, res) => {
    const { dir, errors } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Vercel project linked' });

      const events = await vercelFetch(`/v3/deployments/${req.params.id}/events`);
      let logs = (Array.isArray(events) ? events : []).map(e => ({
        text: e.text || e.payload?.text || '',
        level: e.type || e.level || 'info',
        created: e.created || e.date || null,
      }));

      if (errors === 'true') {
        logs = logs.filter(l => l.level === 'stderr' || l.level === 'error');
      }

      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Environment variables ──

  // List env vars for linked project
  router.get('/env', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Vercel project linked' });

      const data = await vercelFetch(`/v10/projects/${config.projectId}/env`);
      res.json(data.envs || []);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create/update env var
  router.post('/env', async (req, res) => {
    const { dir, key, value, target } = req.body;
    if (!dir || !key) return res.status(400).json({ error: 'dir and key required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Vercel project linked' });

      const envVar = await vercelFetch(`/v10/projects/${config.projectId}/env?upsert=true`, {
        method: 'POST',
        body: JSON.stringify({
          key,
          value: value || '',
          target: target || ['production', 'preview', 'development'],
          type: 'encrypted',
        }),
      });

      res.json({ ok: true, envVar });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Delete env var
  router.delete('/env/:id', async (req, res) => {
    const { dir } = req.body;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Vercel project linked' });

      await vercelFetch(`/v10/projects/${config.projectId}/env/${req.params.id}`, {
        method: 'DELETE',
      });

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ── Per-project config (stored in .wia/vercel/<hash>.json) ──

function projectHash(dir) {
  // Simple hash of directory path
  let hash = 0;
  for (let i = 0; i < dir.length; i++) {
    hash = ((hash << 5) - hash + dir.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

const VERCEL_CONFIG_DIR = join(CONFIG_DIR, 'vercel');

async function loadProjectConfig(dir) {
  try {
    const raw = await readFile(join(VERCEL_CONFIG_DIR, `${projectHash(dir)}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveProjectConfig(dir, config) {
  await mkdir(VERCEL_CONFIG_DIR, { recursive: true });
  await writeFile(join(VERCEL_CONFIG_DIR, `${projectHash(dir)}.json`), JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function deleteProjectConfig(dir) {
  try { await unlink(join(VERCEL_CONFIG_DIR, `${projectHash(dir)}.json`)); } catch {}
}
