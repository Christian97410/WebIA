import { Router } from 'express';
import { spawn, execFileSync } from 'child_process';
import { shellEnv, resolveCmd } from '../shell-path.js';

// Lazy-load the SDK route — falls back gracefully if not installed.
let sdkRouter = null;
let sdkAvailable = false;
let sdkInitDone = false;

// Auth status cache (avoid spawning claude every 3s during polling)
let authCache = { authenticated: false, ts: 0 };
const AUTH_CACHE_TTL = 5000; // 5s

async function initSDK() {
  if (sdkInitDone) return;
  sdkInitDone = true;
  try {
    const { createAISDKRouter, isSDKAvailable } = await import('./ai-sdk.js');
    sdkAvailable = isSDKAvailable();
    if (sdkAvailable) {
      sdkRouter = createAISDKRouter();
    }
  } catch {
    // SDK module not available — raw API only.
  }
}

export async function createAIRouter() {
  await initSDK();
  const router = Router();

  // ── SDK sub-router ────────────────────────────────────────────────────────
  // When the Claude Code SDK is available, mount its routes under /sdk/*.
  // The frontend can choose to use /api/ai/sdk/chat for the agent experience,
  // or fall back to /api/ai/chat for the raw API.
  if (sdkRouter) {
    router.use('/sdk', sdkRouter);
  }

  // ── POST /chat ────────────────────────────────────────────────────────────
  // If SDK is available, try it first. Otherwise use the raw API.
  router.post('/chat', async (req, res) => {
    const { prompt, context, projectPath, preferSDK } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt required' });

    // If the SDK is available and the client hasn't opted out, delegate to it.
    if (sdkAvailable && preferSDK !== false) {
      try {
        // Forward the request to the SDK router's chat handler via a
        // simple internal redirect — just call the SDK logic directly.
        const { createAISDKRouter } = await import('./ai-sdk.js');
        // The SDK chat endpoint uses SSE streaming, so we need to let
        // the SDK handler own the response. Re-dispatch to /sdk/chat.
        req.url = '/sdk/chat';
        return sdkRouter(req, res);
      } catch {
        // SDK call failed — fall through to raw API.
      }
    }

    try {
      // Build the system prompt with context
      const systemPrompt = buildSystemPrompt(context, projectPath);

      // For now, check if API key is available
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        return res.json({
          response: 'Claude Code SDK is not available and no ANTHROPIC_API_KEY is set. Make sure `@anthropic-ai/claude-code-sdk` is installed and Claude Code is authenticated (`claude auth login`).',
          changes: [],
        });
      }

      // Call Claude API
      const response = await callClaude(apiKey, systemPrompt, prompt);
      res.json(response);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /key ────────────────────────────────────────────────────────────
  // Accept and validate an Anthropic API key from the frontend.
  router.post('/key', async (req, res) => {
    const { key } = req.body;
    if (!key) return res.status(400).json({ valid: false, error: 'Key required' });

    try {
      // Validate by making a minimal API call
      const check = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });

      if (check.ok || check.status === 200) {
        // Key is valid — store it in process.env for this session
        process.env.ANTHROPIC_API_KEY = key;
        return res.json({ valid: true });
      }

      const data = await check.json().catch(() => ({}));
      const errMsg = data.error?.message || `Invalid key (HTTP ${check.status})`;
      return res.json({ valid: false, error: errMsg });
    } catch (err) {
      return res.json({ valid: false, error: 'Could not reach Anthropic API' });
    }
  });

  // ── GET /setup/status ────────────────────────────────────────────────────
  // Detect Claude Code CLI + SDK + auth state for onboarding flow.
  router.get('/setup/status', (req, res) => {
    let cliInstalled = false;
    let cliPath = null;
    let authenticated = false;

    // Check if `claude` CLI is in PATH
    try {
      cliPath = resolveCmd('claude');
      cliInstalled = cliPath !== 'claude'; // resolveCmd returns the name if not found
    } catch {}

    // Check auth via `claude auth status` (sync, with cache to avoid spawning every 3s)
    if (cliInstalled) {
      const now = Date.now();
      if (authCache.authenticated || now - authCache.ts > AUTH_CACHE_TTL) {
        if (!authCache.authenticated) {
          // Only re-check if not yet authenticated
          try {
            const out = execFileSync(cliPath, ['auth', 'status'], {
              env: shellEnv(),
              timeout: 4000,
              encoding: 'utf-8',
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            const parsed = JSON.parse(out);
            authCache = { authenticated: !!parsed.loggedIn, ts: now };
          } catch {
            authCache = { authenticated: false, ts: now };
          }
        }
        authenticated = authCache.authenticated;
      } else {
        authenticated = authCache.authenticated;
      }
    }

    res.json({
      cliInstalled,
      cliPath,
      sdkAvailable,
      authenticated,
      ready: sdkAvailable && authenticated,
    });
  });

  // ── GET /setup/install ──────────────────────────────────────────────────
  // Install Claude Code CLI globally via npm. Streams progress via SSE.
  router.get('/setup/install', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

    const env = shellEnv();
    const child = spawn('npm', ['install', '-g', '@anthropic-ai/claude-code'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let progress = 0;
    let lastStage = '';

    const parseProgress = (text) => {
      const t = text.toLowerCase();
      // npm outputs progress info to stderr
      if (t.includes('idealtre') || t.includes('resolv')) {
        if (lastStage !== 'resolve') { lastStage = 'resolve'; progress = 10; }
      } else if (t.includes('fetch') || t.includes('http')) {
        if (progress < 40) progress = Math.min(progress + 5, 40);
        lastStage = 'fetch';
      } else if (t.includes('reify') || t.includes('extract')) {
        if (progress < 70) progress = Math.min(progress + 3, 70);
        lastStage = 'reify';
      } else if (t.includes('added') || t.includes('link')) {
        progress = 85;
        lastStage = 'link';
      }
      return progress;
    };

    const stages = { resolve: 'Resolving dependencies...', fetch: 'Downloading packages...', reify: 'Installing packages...', link: 'Linking CLI...' };

    send({ progress: 2, stage: 'Starting npm install...' });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      const p = parseProgress(d.toString());
      send({ progress: p, stage: stages[lastStage] || 'Installing...' });
    });

    child.stdout.on('data', (d) => {
      const p = parseProgress(d.toString());
      send({ progress: p, stage: stages[lastStage] || 'Installing...' });
    });

    child.on('close', async (code) => {
      if (code === 0) {
        send({ progress: 90, stage: 'Initializing SDK...' });
        sdkInitDone = false;
        sdkAvailable = false;
        sdkRouter = null;
        await initSDK();
        send({ progress: 100, stage: 'Done', success: true, sdkAvailable });
      } else {
        send({ progress: 0, stage: 'Installation failed', success: false, error: stderr || 'npm install failed' });
      }
      res.end();
    });

    child.on('error', (err) => {
      send({ progress: 0, stage: 'Installation failed', success: false, error: err.message });
      res.end();
    });

    req.on('close', () => { child.kill(); });
  });

  // ── POST /setup/auth ────────────────────────────────────────────────────
  // Start Claude auth login. Opens the browser for OAuth, then polls for completion.
  router.post('/setup/auth', (req, res) => {
    const env = shellEnv();
    const claude = resolveCmd('claude');

    // `claude auth login` opens the browser automatically — no --no-browser flag
    const child = spawn(claude, ['auth', 'login'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';

    child.stdout.on('data', (d) => { output += d.toString(); });
    child.stderr.on('data', (d) => { output += d.toString(); });

    // Respond immediately — browser will open on its own
    res.json({ success: true, browserOpened: true });

    child.on('close', async () => {
      // Re-check SDK availability after auth completes
      sdkInitDone = false;
      sdkAvailable = false;
      sdkRouter = null;
      await initSDK();
    });

    child.on('error', () => {
      // Auth process failed silently — polling will detect it
    });

    // Kill the process if it takes too long
    setTimeout(() => { child.kill(); }, 120000);
  });

  // ── GET /status ───────────────────────────────────────────────────────────
  router.get('/status', (req, res) => {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    res.json({
      providers: {
        anthropic: { connected: hasAnthropic },
        openai: { connected: hasOpenAI },
      },
    });
  });

  // ── GET /providers ────────────────────────────────────────────────────────
  // Returns which AI providers are available and their capabilities.
  router.get('/providers', (req, res) => {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;

    res.json({
      providers: [
        {
          id: 'claude-sdk',
          name: 'Claude Code SDK',
          available: sdkAvailable,
          capabilities: [
            'file-read',
            'file-write',
            'file-edit',
            'streaming',
            'agent',
            'sandbox',
          ],
          description: 'Full agent with file access, streaming, and sandbox workflow.',
        },
        {
          id: 'claude-api',
          name: 'Claude API (raw)',
          available: hasAnthropic,
          capabilities: ['chat', 'structured-changes'],
          description: 'Direct API calls to Claude. Requires ANTHROPIC_API_KEY.',
        },
        {
          id: 'openai',
          name: 'OpenAI',
          available: hasOpenAI,
          capabilities: ['chat'],
          description: 'OpenAI API. Requires OPENAI_API_KEY.',
        },
      ],
      preferred: sdkAvailable
        ? 'claude-sdk'
        : hasAnthropic
          ? 'claude-api'
          : hasOpenAI
            ? 'openai'
            : null,
    });
  });

  return router;
}

function buildSystemPrompt(context, projectPath) {
  let system = `You are an AI assistant integrated into WebIA, a visual web editor.
The user is editing a local web project at: ${projectPath || 'unknown'}

Your role:
- Modify HTML and CSS files to fulfill the user's request
- Return the exact file changes needed
- Be precise with selectors and properties
- Keep changes minimal and focused

Response format:
Return a JSON object with:
{
  "explanation": "Brief description of what you changed",
  "changes": [
    {
      "file": "relative/path/to/file",
      "action": "replace",
      "search": "exact string to find",
      "replace": "replacement string"
    }
  ]
}

For new content, use action "insert":
{
  "file": "relative/path/to/file",
  "action": "insert",
  "after": "string to insert after",
  "content": "new content to insert"
}`;

  if (context) {
    if (context.selectedElement) {
      system += `\n\nCurrently selected element:\n- Tag: ${context.selectedElement.tag}`;
      system += `\n- Classes: ${context.selectedElement.classes || 'none'}`;
      system += `\n- ID: ${context.selectedElement.id || 'none'}`;
      if (context.selectedElement.html) {
        system += `\n- HTML:\n${context.selectedElement.html}`;
      }
    }
    if (context.currentFile) {
      system += `\n\nCurrent page: ${context.currentFile}`;
    }
    if (context.fileContents) {
      for (const [file, content] of Object.entries(context.fileContents)) {
        system += `\n\n--- ${file} ---\n${content}`;
      }
    }
  }

  return system;
}

async function callClaude(apiKey, systemPrompt, userPrompt) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  const data = await response.json();

  if (data.error) {
    throw new Error(data.error.message);
  }

  const text = data.content?.[0]?.text || '';

  // Try to parse JSON from the response
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        response: parsed.explanation || text,
        changes: parsed.changes || [],
      };
    }
  } catch {
    // Not JSON, return as plain text
  }

  return { response: text, changes: [] };
}
