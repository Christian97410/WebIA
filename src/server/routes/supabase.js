import { Router } from 'express';
import { readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.wia');
const SB_TOKEN_FILE = join(CONFIG_DIR, 'supabase-token');

const SB_API = 'https://api.supabase.com';

// ── Token persistence ──

async function loadToken() {
  try {
    const raw = await readFile(SB_TOKEN_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveToken(data) {
  await mkdir(CONFIG_DIR, { recursive: true });
  await writeFile(SB_TOKEN_FILE, JSON.stringify(data), { mode: 0o600 });
}

async function deleteToken() {
  try { await unlink(SB_TOKEN_FILE); } catch {}
}

// Get a valid access token, refreshing if needed
async function getAccessToken() {
  const data = await loadToken();
  if (!data) return null;

  // If token has no expiry or isn't expired, return it
  if (!data.expires_at || Date.now() < data.expires_at - 60000) {
    return data.access_token;
  }

  // Try refresh
  if (data.refresh_token) {
    try {
      const resp = await fetch(`${SB_API}/v1/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: data.refresh_token,
        }),
      });
      if (resp.ok) {
        const tokens = await resp.json();
        const updated = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token || data.refresh_token,
          expires_at: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
        };
        await saveToken(updated);
        return updated.access_token;
      }
    } catch {}
  }

  return data.access_token;
}

// Proxy helper for Supabase Management API
async function sbFetch(path, options = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('Not authenticated with Supabase');

  const resp = await fetch(`${SB_API}${path}`, {
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
    try { msg = JSON.parse(body).message || body; } catch { msg = body; }
    throw new Error(msg || `Supabase API ${resp.status}`);
  }

  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('application/json')) return resp.json();
  return resp.text();
}

export function createSupabaseRouter() {
  const router = Router();

  // ── Auth: store/check/delete access token ──

  // Check auth status
  router.get('/auth', async (_req, res) => {
    const token = await getAccessToken();
    if (!token) return res.json({ authenticated: false });
    // Validate by listing orgs
    try {
      const resp = await fetch(`${SB_API}/v1/organizations`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (resp.ok) {
        return res.json({ authenticated: true });
      }
    } catch {}
    res.json({ authenticated: false, invalid: true });
  });

  // Save access token (personal access token flow)
  router.post('/auth', async (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'token required' });
    // Validate
    try {
      const resp = await fetch(`${SB_API}/v1/projects`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) return res.status(401).json({ error: 'Invalid token' });
      await saveToken({ access_token: token });
      res.json({ authenticated: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Sign out
  router.delete('/auth', async (_req, res) => {
    await deleteToken();
    res.json({ ok: true });
  });

  // ── Projects ──

  // List all projects
  router.get('/projects', async (_req, res) => {
    try {
      const projects = await sbFetch('/v1/projects');
      res.json(projects.map(p => ({
        id: p.id,
        ref: p.ref || p.id,
        name: p.name,
        region: p.region,
        status: p.status,
        organization_id: p.organization_id,
        created_at: p.created_at,
      })));
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

  // Link a Supabase project to a local directory
  router.post('/link', async (req, res) => {
    const { dir, projectRef, projectName, url, anonKey } = req.body;
    if (!dir || !projectRef) return res.status(400).json({ error: 'dir and projectRef required' });
    try {
      const config = {
        linked: true,
        projectRef,
        projectName: projectName || '',
        url: url || `https://${projectRef}.supabase.co`,
        anonKey: anonKey || '',
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

  // ── Database ──

  // Get schema (tables, columns, types)
  router.get('/schema', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });

      const sql = `
        SELECT
          t.table_schema,
          t.table_name,
          c.column_name,
          c.data_type,
          c.is_nullable,
          c.column_default,
          c.character_maximum_length
        FROM information_schema.tables t
        JOIN information_schema.columns c
          ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        WHERE t.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name, c.ordinal_position
      `;

      const data = await sbFetch(`/v1/projects/${config.projectRef}/database/query`, {
        method: 'POST',
        body: JSON.stringify({ query: sql }),
      });

      // Group by table
      const tables = {};
      for (const row of data) {
        const tbl = row.table_name;
        if (!tables[tbl]) tables[tbl] = { name: tbl, columns: [] };
        tables[tbl].columns.push({
          name: row.column_name,
          type: row.data_type,
          nullable: row.is_nullable === 'YES',
          default: row.column_default,
        });
      }

      res.json({ tables: Object.values(tables) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Run SQL query (for migrations push)
  router.post('/query', async (req, res) => {
    const { dir, sql } = req.body;
    if (!dir || !sql) return res.status(400).json({ error: 'dir and sql required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });

      const data = await sbFetch(`/v1/projects/${config.projectRef}/database/query`, {
        method: 'POST',
        body: JSON.stringify({ query: sql }),
      });

      res.json({ ok: true, data });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Push migrations — reads supabase/migrations/*.sql and executes them
  router.post('/migrations/push', async (req, res) => {
    const { dir } = req.body;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });

      // Find migration files
      const migrationsDir = join(dir, 'supabase', 'migrations');
      let files;
      try {
        const { readdir } = await import('fs/promises');
        files = (await readdir(migrationsDir)).filter(f => f.endsWith('.sql')).sort();
      } catch {
        return res.status(400).json({ error: 'No supabase/migrations/ directory found' });
      }

      if (files.length === 0) return res.json({ ok: true, applied: 0 });

      const results = [];
      for (const file of files) {
        const sql = await readFile(join(migrationsDir, file), 'utf-8');
        try {
          await sbFetch(`/v1/projects/${config.projectRef}/database/query`, {
            method: 'POST',
            body: JSON.stringify({ query: sql }),
          });
          results.push({ file, status: 'ok' });
        } catch (err) {
          results.push({ file, status: 'error', error: err.message });
        }
      }

      res.json({ ok: true, applied: results.filter(r => r.status === 'ok').length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Edge Functions ──

  // List functions
  router.get('/functions', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });
      const fns = await sbFetch(`/v1/projects/${config.projectRef}/functions`);
      res.json(fns);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Deploy a single function
  router.post('/functions/deploy', async (req, res) => {
    const { dir, slug } = req.body;
    if (!dir || !slug) return res.status(400).json({ error: 'dir and slug required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });

      // Read function source from supabase/functions/<slug>/index.ts
      const fnDir = join(dir, 'supabase', 'functions', slug);
      let body;
      for (const entry of ['index.ts', 'index.js']) {
        try {
          body = await readFile(join(fnDir, entry), 'utf-8');
          break;
        } catch {}
      }
      if (!body) return res.status(400).json({ error: `No index.ts/js found in supabase/functions/${slug}/` });

      // Check if function exists
      let exists = false;
      try {
        await sbFetch(`/v1/projects/${config.projectRef}/functions/${slug}`);
        exists = true;
      } catch {}

      if (exists) {
        // Update
        await sbFetch(`/v1/projects/${config.projectRef}/functions/${slug}`, {
          method: 'PATCH',
          body: JSON.stringify({ body, verify_jwt: true }),
        });
      } else {
        // Create
        await sbFetch(`/v1/projects/${config.projectRef}/functions`, {
          method: 'POST',
          body: JSON.stringify({ slug, name: slug, body, verify_jwt: true }),
        });
      }

      res.json({ ok: true, slug });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── TypeScript types generation ──

  router.get('/types', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });
      const types = await sbFetch(`/v1/projects/${config.projectRef}/types/typescript`);
      res.json({ types });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Write types to project
  router.post('/types/write', async (req, res) => {
    const { dir } = req.body;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });
      const types = await sbFetch(`/v1/projects/${config.projectRef}/types/typescript`);
      const outPath = join(dir, 'src', 'types', 'supabase.ts');
      await mkdir(join(dir, 'src', 'types'), { recursive: true });
      await writeFile(outPath, types, 'utf-8');
      res.json({ ok: true, path: 'src/types/supabase.ts' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── API Keys ──

  router.get('/api-keys', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadProjectConfig(dir);
      if (!config?.linked) return res.status(400).json({ error: 'No Supabase project linked' });
      const keys = await sbFetch(`/v1/projects/${config.projectRef}/api-keys`);
      res.json(keys);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

// ── Per-project config (stored in .wia/supabase/<hash>.json) ──

function projectHash(dir) {
  // Simple hash of directory path
  let hash = 0;
  for (let i = 0; i < dir.length; i++) {
    hash = ((hash << 5) - hash + dir.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

const SB_CONFIG_DIR = join(CONFIG_DIR, 'supabase');

async function loadProjectConfig(dir) {
  try {
    const raw = await readFile(join(SB_CONFIG_DIR, `${projectHash(dir)}.json`), 'utf-8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function saveProjectConfig(dir, config) {
  await mkdir(SB_CONFIG_DIR, { recursive: true });
  await writeFile(join(SB_CONFIG_DIR, `${projectHash(dir)}.json`), JSON.stringify(config, null, 2), { mode: 0o600 });
}

async function deleteProjectConfig(dir) {
  try { await unlink(join(SB_CONFIG_DIR, `${projectHash(dir)}.json`)); } catch {}
}
