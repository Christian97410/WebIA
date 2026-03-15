import { Router } from 'express';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

const MCP_FILE = '.mcp.json';

// ── Presets for popular MCP servers ──

const PRESETS = {
  supabase: {
    name: 'Supabase',
    description: 'Database, auth, storage, edge functions',
    config: {
      type: 'http',
      url: 'https://mcp.supabase.com/mcp',
    },
    envHint: null,
  },
  github: {
    name: 'GitHub',
    description: 'Repos, issues, PRs, code search',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' },
    },
    envHint: 'GITHUB_TOKEN',
  },
  filesystem: {
    name: 'Filesystem',
    description: 'Read/write files, search, directory listing',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '${PROJECT_DIR}'],
    },
    envHint: null,
  },
  postgres: {
    name: 'PostgreSQL',
    description: 'Query and manage PostgreSQL databases',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-postgres'],
      env: { DATABASE_URL: '${DATABASE_URL}' },
    },
    envHint: 'DATABASE_URL',
  },
  sentry: {
    name: 'Sentry',
    description: 'Error tracking and monitoring',
    config: {
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
    },
    envHint: null,
  },
  notion: {
    name: 'Notion',
    description: 'Pages, databases, search',
    config: {
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
    },
    envHint: null,
  },
};

// ── Helpers ──

async function loadMcpConfig(dir) {
  try {
    const raw = await readFile(join(dir, MCP_FILE), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { mcpServers: {} };
  }
}

async function saveMcpConfig(dir, config) {
  await writeFile(join(dir, MCP_FILE), JSON.stringify(config, null, 2), 'utf-8');
}

export function createMcpRouter() {
  const router = Router();

  // List presets
  router.get('/presets', (_req, res) => {
    const list = Object.entries(PRESETS).map(([id, p]) => ({
      id,
      name: p.name,
      description: p.description,
      envHint: p.envHint,
    }));
    res.json(list);
  });

  // Get current MCP config for a project
  router.get('/config', async (req, res) => {
    const { dir } = req.query;
    if (!dir) return res.status(400).json({ error: 'dir required' });
    try {
      const config = await loadMcpConfig(dir);
      const servers = Object.entries(config.mcpServers || {}).map(([name, cfg]) => ({
        name,
        ...cfg,
      }));
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Add a server (from preset or custom)
  router.post('/servers', async (req, res) => {
    const { dir, name, preset, config: customConfig, env } = req.body;
    if (!dir) return res.status(400).json({ error: 'dir required' });

    try {
      const mcpConfig = await loadMcpConfig(dir);
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};

      let serverConfig;
      let serverName;

      if (preset && PRESETS[preset]) {
        serverName = name || preset;
        serverConfig = JSON.parse(JSON.stringify(PRESETS[preset].config));

        // Replace ${PROJECT_DIR} placeholder
        if (serverConfig.args) {
          serverConfig.args = serverConfig.args.map(a =>
            a.replace('${PROJECT_DIR}', dir)
          );
        }

        // Merge provided env vars
        if (env && serverConfig.env) {
          for (const [k, v] of Object.entries(env)) {
            serverConfig.env[k] = v;
          }
        }
      } else if (customConfig) {
        serverName = name || 'custom';
        serverConfig = customConfig;
      } else {
        return res.status(400).json({ error: 'preset or config required' });
      }

      mcpConfig.mcpServers[serverName] = serverConfig;
      await saveMcpConfig(dir, mcpConfig);

      res.json({ ok: true, name: serverName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Remove a server
  router.delete('/servers', async (req, res) => {
    const { dir, name } = req.body;
    if (!dir || !name) return res.status(400).json({ error: 'dir and name required' });

    try {
      const mcpConfig = await loadMcpConfig(dir);
      if (mcpConfig.mcpServers) {
        delete mcpConfig.mcpServers[name];
      }
      await saveMcpConfig(dir, mcpConfig);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update a server's env vars
  router.patch('/servers', async (req, res) => {
    const { dir, name, env } = req.body;
    if (!dir || !name) return res.status(400).json({ error: 'dir and name required' });

    try {
      const mcpConfig = await loadMcpConfig(dir);
      const server = mcpConfig.mcpServers?.[name];
      if (!server) return res.status(404).json({ error: 'Server not found' });

      if (env) {
        server.env = { ...server.env, ...env };
      }

      await saveMcpConfig(dir, mcpConfig);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
