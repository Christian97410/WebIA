import { Router } from 'express';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { existsSync } from 'fs';

/**
 * AI SDK Router — uses the Claude Code SDK (@anthropic-ai/claude-code-sdk)
 * instead of raw API calls. The SDK provides an agent with file access,
 * streaming responses, and a sandbox-first workflow for changes.
 */

let claudeSDK = null;
let sdkAvailable = false;

// Lazy-load the SDK (no top-level await for SEA compatibility).
try {
  import('@anthropic-ai/claude-code-sdk').then(mod => {
    claudeSDK = mod;
    sdkAvailable = true;
  }).catch(() => {});
} catch {
  // SDK not installed — this module gracefully degrades.
}

/**
 * Check whether the Claude Code SDK is available.
 */
export function isSDKAvailable() {
  return sdkAvailable;
}

/**
 * Create the AI SDK router.
 *
 * Endpoints:
 *   POST /chat        — send a message, get a streamed agent response
 *   POST /accept      — accept pending sandbox changes (apply to real files)
 *   POST /reject      — reject pending sandbox changes (discard)
 *   GET  /status      — SDK availability + session info
 */
export function createAISDKRouter() {
  const router = Router();

  // Active sessions keyed by projectPath.
  // Each session holds the conversation history and pending changes.
  const sessions = new Map();

  // ── POST /chat ──────────────────────────────────────────────────────────────
  router.post('/chat', async (req, res) => {
    const { prompt, context, projectPath, sessionId } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'prompt required' });
    }

    if (!sdkAvailable) {
      return res.status(503).json({
        error: 'Claude Code SDK not available. Install @anthropic-ai/claude-code-sdk.',
      });
    }

    try {
      const resolvedPath = projectPath ? resolve(projectPath) : process.cwd();
      const key = sessionId || resolvedPath;

      // Build the system prompt with context from the editor.
      const systemPrompt = buildSDKSystemPrompt(context, resolvedPath);

      // Prepare conversation history.
      let session = sessions.get(key);
      if (!session) {
        session = { messages: [], pendingChanges: [] };
        sessions.set(key, session);
      }

      // Add the new user message.
      session.messages.push({ role: 'user', content: prompt });

      // Set up SSE for streaming.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Call the Claude Code SDK agent.
      const result = await runAgent({
        projectPath: resolvedPath,
        systemPrompt,
        messages: session.messages,
        onEvent(event) {
          // Stream each event to the client as SSE.
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });

      // Store pending changes in the sandbox.
      if (result.changes && result.changes.length > 0) {
        session.pendingChanges = result.changes;

        // Write changes to a sandbox directory instead of the real project.
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

      // Append the assistant reply to history.
      session.messages.push({
        role: 'assistant',
        content: result.response,
      });

      // Final event.
      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          response: result.response,
          changes: result.changes || [],
        })}\n\n`
      );

      res.end();
    } catch (err) {
      // If headers already sent, write error as SSE event.
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

      // Apply the sandbox changes to the real project files.
      await applyChangesToProject(resolvedPath, session.pendingChanges);

      // Clear pending.
      session.pendingChanges = [];

      // Clean up sandbox.
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

    // Discard pending changes.
    session.pendingChanges = [];

    // Clean up sandbox.
    const resolvedPath = projectPath ? resolve(projectPath) : key;
    await cleanSandbox(join(resolvedPath, '.wia-sandbox'));

    res.json({ rejected: true });
  });

  // ── GET /status ─────────────────────────────────────────────────────────────
  router.get('/status', (req, res) => {
    res.json({
      sdkAvailable,
      activeSessions: sessions.size,
    });
  });

  return router;
}

// ── Agent runner ────────────────────────────────────────────────────────────────

async function runAgent({ projectPath, systemPrompt, messages, onEvent }) {
  // Use the Claude Code SDK to create an agent conversation.
  // The SDK gives the agent file read/write/edit tools scoped to projectPath.

  const { query } = claudeSDK;

  const userMessage = messages[messages.length - 1]?.content || '';

  // Build the full prompt including conversation history.
  const conversationContext = messages
    .slice(0, -1)
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
    .join('\n\n');

  const fullPrompt = conversationContext
    ? `Previous conversation:\n${conversationContext}\n\nUser: ${userMessage}`
    : userMessage;

  let responseText = '';
  const changes = [];

  try {
    // The Claude Code SDK `query` function returns an async iterable of messages.
    const conversation = query({
      prompt: fullPrompt,
      systemPrompt,
      options: {
        cwd: projectPath,
        allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep'],
        maxTurns: 10,
      },
    });

    for await (const message of conversation) {
      if (message.type === 'text') {
        responseText += message.content;
        onEvent({ type: 'text', content: message.content });
      } else if (message.type === 'tool_use') {
        onEvent({
          type: 'tool_use',
          tool: message.tool,
          input: message.input,
        });

        // Track file modifications.
        if (message.tool === 'Edit' || message.tool === 'Write') {
          const filePath = message.input?.file_path || message.input?.path || '';
          changes.push({
            file: filePath,
            action: message.tool === 'Write' ? 'write' : 'edit',
            preview: message.input?.new_string || message.input?.content || null,
            input: message.input,
          });
        }
      } else if (message.type === 'tool_result') {
        onEvent({
          type: 'tool_result',
          tool: message.tool,
          output: message.output,
        });
      } else if (message.type === 'error') {
        onEvent({ type: 'error', error: message.error });
      }
    }
  } catch (err) {
    onEvent({ type: 'error', error: err.message });
    throw err;
  }

  return { response: responseText, changes };
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

/**
 * Apply changes to a sandbox directory (mirror of the project).
 * This lets the user preview before committing.
 */
async function applySandboxChanges(sandboxDir, projectPath, changes) {
  for (const change of changes) {
    if (!change.file) continue;

    const relativePath = change.file.startsWith(projectPath)
      ? change.file.slice(projectPath.length + 1)
      : change.file;

    const sandboxFile = join(sandboxDir, relativePath);
    const originalFile = join(projectPath, relativePath);

    // Ensure the sandbox directory exists.
    await mkdir(dirname(sandboxFile), { recursive: true });

    if (change.action === 'write') {
      // Write the new content directly.
      await writeFile(sandboxFile, change.input?.content || '', 'utf-8');
    } else if (change.action === 'edit') {
      // Read the original, apply the edit, write to sandbox.
      let content = '';
      try {
        content = await readFile(originalFile, 'utf-8');
      } catch {
        // File might not exist yet.
      }

      if (change.input?.old_string && change.input?.new_string) {
        content = content.replace(change.input.old_string, change.input.new_string);
      }

      await writeFile(sandboxFile, content, 'utf-8');
    }
  }
}

/**
 * Apply accepted changes from the sandbox to the real project.
 */
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
      } catch {
        // File may not exist.
      }

      if (change.input?.old_string && change.input?.new_string) {
        content = content.replace(change.input.old_string, change.input.new_string);
      }

      await writeFile(targetFile, content, 'utf-8');
    }
  }
}

/**
 * Remove the sandbox directory.
 */
async function cleanSandbox(sandboxDir) {
  try {
    const { rm } = await import('fs/promises');
    await rm(sandboxDir, { recursive: true, force: true });
  } catch {
    // Ignore — sandbox may not exist.
  }
}
