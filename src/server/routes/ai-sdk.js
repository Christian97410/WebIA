import { Router } from 'express';
import { readFile, writeFile, mkdir, rm } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { spawn } from 'child_process';
import { shellEnv, resolveCmd } from '../shell-path.js';

/**
 * AI SDK Router — uses the Claude Code CLI (`claude --print --output-format stream-json`)
 * to provide an agent with file access, streaming responses, and a sandbox-first workflow.
 */

/**
 * Check whether the Claude CLI is available for SDK use.
 */
export function isSDKAvailable() {
  try {
    const p = resolveCmd('claude');
    return p !== 'claude';
  } catch {
    return false;
  }
}

/**
 * Create the AI SDK router.
 */
export function createAISDKRouter() {
  const router = Router();

  // Active sessions keyed by projectPath.
  const sessions = new Map();

  // ── POST /chat ──────────────────────────────────────────────────────────────
  router.post('/chat', async (req, res) => {
    const { prompt, context, projectPath, sessionId } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'prompt required' });
    }

    if (!isSDKAvailable()) {
      return res.status(503).json({
        error: 'Claude Code SDK is not available and no ANTHROPIC_API_KEY is set. '
          + 'Make sure `@anthropic-ai/claude-code` is installed and Claude Code is authenticated (`claude auth login`).',
      });
    }

    try {
      const resolvedPath = projectPath ? resolve(projectPath) : process.cwd();
      const key = sessionId || resolvedPath;

      const systemPrompt = buildSDKSystemPrompt(context, resolvedPath);

      let session = sessions.get(key);
      if (!session) {
        session = { messages: [], pendingChanges: [] };
        sessions.set(key, session);
      }

      session.messages.push({ role: 'user', content: prompt });

      // Set up SSE for streaming.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Run Claude CLI as subprocess with streaming JSON output.
      const result = await runCLIAgent({
        projectPath: resolvedPath,
        systemPrompt,
        messages: session.messages,
        onEvent(event) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });

      // Store pending changes in the sandbox.
      if (result.changes && result.changes.length > 0) {
        session.pendingChanges = result.changes;

        const sandboxDir = join(resolvedPath, '.wia-sandbox');
        await applySandboxChanges(sandboxDir, resolvedPath, result.changes);

        res.write(
          `data: ${JSON.stringify({
            type: 'changes_pending',
            changes: result.changes.map((c) => ({
              file: c.file,
              action: c.action,
              preview: c.preview || null,
            })),
          })}\n\n`
        );
      }

      session.messages.push({
        role: 'assistant',
        content: result.response,
      });

      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          response: result.response,
          changes: result.changes || [],
        })}\n\n`
      );

      res.end();
    } catch (err) {
      if (res.headersSent) {
        res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
        res.end();
      } else {
        res.status(500).json({ error: err.message });
      }
    }
  });

  // ── POST /accept ────────────────────────────────────────────────────────────
  router.post('/accept', async (req, res) => {
    const { projectPath, sessionId } = req.body;
    const key = sessionId || (projectPath ? resolve(projectPath) : null);

    if (!key) {
      return res.status(400).json({ error: 'projectPath or sessionId required' });
    }

    const session = sessions.get(key);
    if (!session || session.pendingChanges.length === 0) {
      return res.status(404).json({ error: 'No pending changes to accept' });
    }

    try {
      const resolvedPath = projectPath ? resolve(projectPath) : key;
      await applyChangesToProject(resolvedPath, session.pendingChanges);
      session.pendingChanges = [];
      await cleanSandbox(join(resolvedPath, '.wia-sandbox'));
      res.json({ accepted: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /reject ────────────────────────────────────────────────────────────
  router.post('/reject', async (req, res) => {
    const { projectPath, sessionId } = req.body;
    const key = sessionId || (projectPath ? resolve(projectPath) : null);

    if (!key) {
      return res.status(400).json({ error: 'projectPath or sessionId required' });
    }

    const session = sessions.get(key);
    if (!session) {
      return res.status(404).json({ error: 'No active session' });
    }

    session.pendingChanges = [];
    const resolvedPath = projectPath ? resolve(projectPath) : key;
    await cleanSandbox(join(resolvedPath, '.wia-sandbox'));
    res.json({ rejected: true });
  });

  // ── GET /status ─────────────────────────────────────────────────────────────
  router.get('/status', (req, res) => {
    res.json({
      sdkAvailable: isSDKAvailable(),
      activeSessions: sessions.size,
    });
  });

  return router;
}

// ── CLI Agent runner ─────────────────────────────────────────────────────────

async function runCLIAgent({ projectPath, systemPrompt, messages, onEvent }) {
  const claudePath = resolveCmd('claude');
  const env = shellEnv();

  // Build the prompt from conversation history
  const userMessage = messages[messages.length - 1]?.content || '';
  const conversationContext = messages
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  const fullPrompt = conversationContext
    ? `Previous conversation:\n${conversationContext}\n\nUser: ${userMessage}`
    : userMessage;

  return new Promise((resolve, reject) => {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
      '--system-prompt', systemPrompt,
      '--allowed-tools', 'Read', 'Edit', 'Write', 'Glob', 'Grep',
      fullPrompt,
    ];

    const child = spawn(claudePath, args, {
      cwd: projectPath,
      env: { ...env, CLAUDECODE: '' }, // Avoid nested session check
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let responseText = '';
    const changes = [];
    let buffer = '';

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          processStreamMessage(msg, { onEvent, responseText: (t) => { responseText += t; }, changes });
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    child.stderr.on('data', (d) => {
      const err = d.toString().trim();
      if (err) onEvent({ type: 'error', error: err });
    });

    child.on('close', (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer);
          processStreamMessage(msg, { onEvent, responseText: (t) => { responseText += t; }, changes });
        } catch {}
      }

      if (code !== 0 && !responseText) {
        reject(new Error(`Claude CLI exited with code ${code}`));
      } else {
        resolve({ response: responseText, changes });
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

function processStreamMessage(msg, { onEvent, responseText, changes }) {
  // stream-json format: each line is a JSON message
  if (msg.type === 'assistant' && msg.message) {
    // Full message block
    const content = msg.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          responseText(block.text);
          onEvent({ type: 'text', content: block.text });
        } else if (block.type === 'tool_use') {
          onEvent({ type: 'tool_use', tool: block.name, input: block.input });
          if (block.name === 'Edit' || block.name === 'Write') {
            changes.push({
              file: block.input?.file_path || block.input?.path || '',
              action: block.name === 'Write' ? 'write' : 'edit',
              preview: block.input?.new_string || block.input?.content || null,
              input: block.input,
            });
          }
        }
      }
    }
  } else if (msg.type === 'content_block_delta') {
    if (msg.delta?.type === 'text_delta') {
      responseText(msg.delta.text);
      onEvent({ type: 'text', content: msg.delta.text });
    }
  } else if (msg.type === 'result') {
    // Final result message
    if (msg.result) {
      responseText(msg.result);
      onEvent({ type: 'text', content: msg.result });
    }
  }
}

// ── System prompt builder ───────────────────────────────────────────────────────

function buildSDKSystemPrompt(context, projectPath) {
  let system = `You are an AI assistant integrated into WebIA, a visual web editor.
The user is editing a local web project at: ${projectPath}

Your role:
- Read, understand, and modify the project's HTML and CSS files
- Use the file tools (Read, Edit, Write, Glob, Grep) to explore and change files
- Make precise, minimal changes that fulfill the user's request
- Explain what you changed and why

Important:
- Always read the relevant file before editing it
- Use Edit (search/replace) for modifying existing content
- Use Write only for creating new files
- Keep changes focused — do not refactor unrelated code`;

  if (context) {
    if (context.selectedElement) {
      system += `\n\nCurrently selected element:`;
      system += `\n- Tag: ${context.selectedElement.tag}`;
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

// ── Sandbox helpers ─────────────────────────────────────────────────────────────

async function applySandboxChanges(sandboxDir, projectPath, changes) {
  for (const change of changes) {
    if (!change.file) continue;

    const relativePath = change.file.startsWith(projectPath)
      ? change.file.slice(projectPath.length + 1)
      : change.file;

    const sandboxFile = join(sandboxDir, relativePath);
    const originalFile = join(projectPath, relativePath);

    await mkdir(dirname(sandboxFile), { recursive: true });

    if (change.action === 'write') {
      await writeFile(sandboxFile, change.input?.content || '', 'utf-8');
    } else if (change.action === 'edit') {
      let content = '';
      try {
        content = await readFile(originalFile, 'utf-8');
      } catch {}

      if (change.input?.old_string && change.input?.new_string) {
        content = content.replace(change.input.old_string, change.input.new_string);
      }

      await writeFile(sandboxFile, content, 'utf-8');
    }
  }
}

async function applyChangesToProject(projectPath, changes) {
  for (const change of changes) {
    if (!change.file) continue;

    const relativePath = change.file.startsWith(projectPath)
      ? change.file.slice(projectPath.length + 1)
      : change.file;

    const targetFile = join(projectPath, relativePath);

    await mkdir(dirname(targetFile), { recursive: true });

    if (change.action === 'write') {
      await writeFile(targetFile, change.input?.content || '', 'utf-8');
    } else if (change.action === 'edit') {
      let content = '';
      try {
        content = await readFile(targetFile, 'utf-8');
      } catch {}

      if (change.input?.old_string && change.input?.new_string) {
        content = content.replace(change.input.old_string, change.input.new_string);
      }

      await writeFile(targetFile, content, 'utf-8');
    }
  }
}

async function cleanSandbox(sandboxDir) {
  try {
    await rm(sandboxDir, { recursive: true, force: true });
  } catch {}
}
