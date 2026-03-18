import { Router } from 'express';
import { readFile, writeFile, mkdir, rm, readdir } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
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

// ── Session persistence helpers ──────────────────────────────────────────────

function sessionsDir(projectPath) {
  return join(projectPath, '.wia-sessions');
}

function sessionFilePath(projectPath, sessionId) {
  return join(sessionsDir(projectPath), `${sessionId}.json`);
}

async function loadSession(projectPath, sessionId) {
  try {
    const raw = await readFile(sessionFilePath(projectPath, sessionId), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function saveSession(projectPath, session) {
  const dir = sessionsDir(projectPath);
  await mkdir(dir, { recursive: true });
  await writeFile(sessionFilePath(projectPath, session.id), JSON.stringify(session, null, 2), 'utf-8');
}

async function listSessions(projectPath) {
  const dir = sessionsDir(projectPath);
  try {
    const files = await readdir(dir);
    const sessions = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(dir, f), 'utf-8');
        const s = JSON.parse(raw);
        sessions.push({
          id: s.id,
          title: s.title || 'Untitled',
          createdAt: s.createdAt,
          lastMessageAt: s.lastMessageAt,
          messageCount: (s.messages || []).length,
        });
      } catch {}
    }
    // Newest first
    sessions.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
    return sessions;
  } catch {
    return [];
  }
}

async function deleteSession(projectPath, sessionId) {
  try {
    await rm(sessionFilePath(projectPath, sessionId), { force: true });
  } catch {}
}

/**
 * Create the AI SDK router.
 */
export function createAISDKRouter() {
  const router = Router();

  // Active sessions keyed by sessionId.
  const sessions = new Map();
  // Active CLI child processes keyed by sessionId — ensures we kill previous before launching new.
  const activeProcesses = new Map();

  // ── GET /sessions ────────────────────────────────────────────────────────────
  router.get('/sessions', async (req, res) => {
    const projectPath = req.query.projectPath;
    if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
    const resolved = resolve(projectPath);
    const list = await listSessions(resolved);
    res.json(list);
  });

  // ── GET /sessions/:id ──────────────────────────────────────────────────────
  router.get('/sessions/:id', async (req, res) => {
    const projectPath = req.query.projectPath;
    if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
    const resolved = resolve(projectPath);
    const session = await loadSession(resolved, req.params.id);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    res.json(session);
  });

  // ── DELETE /sessions/:id ───────────────────────────────────────────────────
  router.delete('/sessions/:id', async (req, res) => {
    const projectPath = req.query.projectPath;
    if (!projectPath) return res.status(400).json({ error: 'projectPath required' });
    const resolved = resolve(projectPath);
    await deleteSession(resolved, req.params.id);
    // Also clear in-memory session
    sessions.delete(req.params.id);
    res.json({ deleted: true });
  });

  // ── POST /sessions/new ────────────────────────────────────────────────────
  router.post('/sessions/new', (req, res) => {
    const id = randomUUID();
    res.json({ id });
  });

  // ── POST /chat ──────────────────────────────────────────────────────────────
  router.post('/chat', async (req, res) => {
    const { prompt, context, projectPath, sessionId, editMode, images } = req.body;

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
      const chatSessionId = sessionId || randomUUID();
      const key = chatSessionId;

      const systemPrompt = buildSDKSystemPrompt(context, resolvedPath);

      let session = sessions.get(key);
      if (!session) {
        // Try loading from disk
        const diskSession = await loadSession(resolvedPath, chatSessionId);
        session = diskSession
          ? { messages: diskSession.messages || [], pendingChanges: [] }
          : { messages: [], pendingChanges: [] };
        sessions.set(key, session);
      }

      const now = Date.now();
      session.messages.push({ role: 'user', content: prompt });

      // Build the title from the first user message
      const firstUserMsg = session.messages.find(m => m.role === 'user');
      const title = firstUserMsg
        ? firstUserMsg.content.slice(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
        : 'Untitled';

      // Set up SSE for streaming.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      // Kill any previous CLI process on this session before starting a new one
      const prevChild = activeProcesses.get(chatSessionId);
      if (prevChild && !prevChild.killed) {
        prevChild.kill('SIGTERM');
      }

      // Save attached images to temp dir so Claude CLI can read them
      const imagePaths = [];
      if (images && images.length > 0) {
        const tempDir = join(resolvedPath, '.wia-temp');
        await mkdir(tempDir, { recursive: true });
        for (const img of images) {
          const ext = img.type.split('/')[1] || 'png';
          const filename = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const filePath = join(tempDir, filename);
          // Strip data URL prefix to get raw base64
          const base64Data = img.data.replace(/^data:[^;]+;base64,/, '');
          await writeFile(filePath, Buffer.from(base64Data, 'base64'));
          imagePaths.push(filePath);
        }
      }

      // First user message = create session, subsequent = resume
      const userMsgCount = session.messages.filter(m => m.role === 'user').length;
      const isResume = userMsgCount > 1;

      // Run Claude CLI as subprocess with streaming JSON output.
      const { promise: cliPromise, child: cliChild } = runCLIAgent({
        projectPath: resolvedPath,
        systemPrompt,
        sessionId: chatSessionId,
        isResume,
        messages: session.messages,
        editMode: editMode || 'auto',
        imagePaths,
        onEvent(event) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        },
      });
      activeProcesses.set(chatSessionId, cliChild);
      const result = await cliPromise;
      activeProcesses.delete(chatSessionId);

      // In auto mode, changes are already applied by the CLI directly.
      // In ask mode, store pending changes for accept/reject workflow.
      const mode = editMode || 'auto';
      if (result.changes && result.changes.length > 0) {
        if (mode === 'auto') {
          // Changes already written by CLI — notify client (no accept/reject needed)
          res.write(
            `data: ${JSON.stringify({
              type: 'changes_applied',
              changes: result.changes.map((c) => ({
                file: c.file,
                action: c.action,
                preview: c.preview || null,
              })),
            })}\n\n`
          );
        } else {
          // ask/plan mode — sandbox the changes for review
          session.pendingChanges = result.changes;

          const sandboxDir = sandboxDirFor(resolvedPath);
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
      }

      // Clean up temp images
      if (imagePaths.length > 0) {
        for (const p of imagePaths) {
          try { await rm(p, { force: true }); } catch {}
        }
      }

      session.messages.push({
        role: 'assistant',
        content: result.response,
      });

      // Persist session to disk
      const diskData = await loadSession(resolvedPath, chatSessionId);
      const sessionData = {
        id: chatSessionId,
        title,
        createdAt: diskData?.createdAt || now,
        lastMessageAt: Date.now(),
        messages: session.messages,
      };
      await saveSession(resolvedPath, sessionData);

      res.write(
        `data: ${JSON.stringify({
          type: 'done',
          sessionId: chatSessionId,
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
      await cleanSandbox(sandboxDirFor(resolvedPath));
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
    await cleanSandbox(sandboxDirFor(resolvedPath));
    res.json({ rejected: true });
  });

  // ── POST /abort ─────────────────────────────────────────────────────────────
  router.post('/abort', (req, res) => {
    const { sessionId } = req.body;
    if (sessionId) {
      const child = activeProcesses.get(sessionId);
      if (child && !child.killed) {
        child.kill('SIGTERM');
        activeProcesses.delete(sessionId);
      }
    }
    res.json({ aborted: true });
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

function runCLIAgent({ projectPath, systemPrompt, messages, editMode, sessionId, isResume, imagePaths, onEvent }) {
  const claudePath = resolveCmd('claude');
  const env = shellEnv();

  // Only send the latest user message — CLI manages history via session/resume.
  let fullPrompt = messages[messages.length - 1]?.content || '';

  // Append image references so Claude can read them
  if (imagePaths && imagePaths.length > 0) {
    const refs = imagePaths.map(p => `[Attached image: ${p}]`).join('\n');
    fullPrompt = fullPrompt ? `${fullPrompt}\n\n${refs}` : refs;
  }

  let childRef = null;
  const promise = new Promise((resolve, reject) => {
    // Map editMode to CLI permission flags
    const permArgs = editMode === 'plan'
      ? ['--permission-mode', 'plan']
      : editMode === 'ask'
        ? ['--permission-mode', 'acceptEdits']
        : ['--dangerously-skip-permissions'];

    // First message: --session-id to create session
    // Subsequent messages: --resume to continue (avoids "already in use" lock)
    const sessionArgs = sessionId
      ? (isResume ? ['--resume', sessionId] : ['--session-id', sessionId])
      : [];

    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--verbose',
      ...permArgs,
      ...sessionArgs,
      ...(isResume ? [] : ['--system-prompt', systemPrompt]),
      '--allowed-tools', 'Read,Edit,Write,Glob,Grep',
      '--',
      fullPrompt,
    ];

    let child;
    try {
      child = spawn(claudePath, args, {
        cwd: projectPath,
        env: { ...env, CLAUDECODE: '' }, // Avoid nested session check
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      console.error('[AI-SDK] spawn failed:', spawnErr.code, spawnErr.message);
      onEvent({ type: 'error', error: `Failed to start Claude: ${spawnErr.code} — ${spawnErr.message}` });
      resolve({ response: '', changes: [] });
      return;
    }
    childRef = child;

    child.on('error', (err) => {
      console.error('[AI-SDK] child process error:', err.code, err.message);
      onEvent({ type: 'error', error: `Claude process error: ${err.code} — ${err.message}` });
    });

    // Close stdin immediately — prompt is passed as argument
    child.stdin.end();

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

    let stderrBuffer = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderrBuffer += s;
      if (s.trim()) console.error('[AI-SDK stderr]', s.trim());
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
        // Detect specific CLI errors and provide user-friendly messages
        const err = stderrBuffer.trim();
        console.error('[AI-SDK] CLI exited with code', code, '— stderr:', err);
        if (err.includes('already in use') || err.includes('hit your limit') || err.includes('rate limit') || err.includes('quota')) {
          onEvent({ type: 'error', error: 'Limite API atteinte. Votre quota Claude est epuise — il se reinitialise automatiquement. Reessayez plus tard.', errorCode: 'rate_limit' });
        } else if (err.includes('not authenticated') || err.includes('auth')) {
          onEvent({ type: 'error', error: 'Claude CLI non authentifie. Lancez `claude auth login` dans un terminal.', errorCode: 'auth' });
        } else {
          onEvent({ type: 'error', error: err || `Claude CLI exited with code ${code}` });
        }
        resolve({ response: responseText, changes });
      } else {
        resolve({ response: responseText, changes });
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });

  return { promise, child: childRef };
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
    } else if (msg.delta?.type === 'thinking_delta') {
      onEvent({ type: 'thinking', content: msg.delta.thinking || '' });
    }
  } else if (msg.type === 'content_block_start') {
    if (msg.content_block?.type === 'thinking') {
      onEvent({ type: 'thinking', content: msg.content_block.thinking || '' });
    }
  } else if (msg.type === 'tool_result' || (msg.type === 'user' && msg.message?.role === 'user')) {
    // Claude CLI stream-json: tool results come as type 'tool_result' or as 'user' message with tool_result content blocks
    let blocks = [];
    if (msg.type === 'tool_result') {
      blocks = [{ content: msg.content || msg.output || '', tool_use_id: msg.tool_use_id }];
    } else if (msg.message?.content && Array.isArray(msg.message.content)) {
      blocks = msg.message.content.filter(b => b.type === 'tool_result');
    }
    for (const block of blocks) {
      const raw = block.content || block.output || '';
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(b => b.text || '').join('') : JSON.stringify(raw);
      if (text) {
        onEvent({ type: 'tool_result', tool: block.tool_name || '', content: text, tool_use_id: block.tool_use_id || '' });
      }
    }
  } else if (msg.type === 'result') {
    console.log('[AI-SDK] result:', JSON.stringify({ usage: msg.usage, cost: msg.total_cost_usd, session_id: msg.session_id, num_turns: msg.num_turns, is_error: msg.is_error, subtype: msg.subtype }, null, 2));
    onEvent({ type: 'done', usage: msg.usage || null, cost: msg.total_cost_usd || null });
  } else {
    // Log unhandled message types for debugging
    const preview = JSON.stringify(msg).slice(0, 200);
    if (!['message_start', 'message_delta', 'message_stop', 'content_block_stop'].includes(msg.type)) {
      console.log(`[AI-SDK] unhandled msg type="${msg.type}":`, preview);
    }
  }
}

// ── System prompt builder ───────────────────────────────────────────────────────

function buildSDKSystemPrompt(context, projectPath) {
  let system = `You are a coding assistant embedded in a visual web editor app.
The user's project is located at: ${projectPath}
This is NOT the editor's own codebase — it is the user's separate project. Explore it before making assumptions.

Your role:
- Read, understand, and modify the user's project files
- Use the file tools (Read, Edit, Write, Glob, Grep) to explore and change files
- Make precise, minimal changes that fulfill the user's request
- Explain what you changed and why
- Respond in the same language as the user

Important:
- Always read the relevant file before editing it
- Use Edit (search/replace) for modifying existing content
- Use Write only for creating new files
- Keep changes focused — do not refactor unrelated code
- Never use emojis
- Be concise and direct`;

  if (context) {
    if (context.selectedElement) {
      const el = context.selectedElement;
      system += `\n\n<selected-element>`;
      system += `\nselector: ${el.selector}`;
      if (el.sourceFile) system += `\nsource: ${el.sourceFile}`;
      if (el.parent) {
        const p = el.parent;
        const layout = [p.display, p.flexDirection !== 'row' ? `flex-direction: ${p.flexDirection}` : null,
          p.justifyContent !== 'normal' ? `justify-content: ${p.justifyContent}` : null,
          p.alignItems !== 'normal' ? `align-items: ${p.alignItems}` : null,
          p.gap !== 'normal' && p.gap !== '0px' ? `gap: ${p.gap}` : null,
          `padding: ${p.paddingTop} ${p.paddingRight} ${p.paddingBottom} ${p.paddingLeft}`,
        ].filter(Boolean).join(', ');
        system += `\nparent: ${p.selector} (${layout})`;
      }
      if (el.styles && Object.keys(el.styles).length) {
        system += `\nstyles:`;
        for (const [prop, info] of Object.entries(el.styles)) {
          if (info.source === 'own') {
            const loc = info.file ? ` -- ${info.file}` : '';
            system += `\n  ${prop}: ${info.value} (own, selector: ${info.selector}${loc})`;
          } else if (info.source === 'inherited') {
            const loc = info.file ? ` -- ${info.file}` : '';
            system += `\n  ${prop}: ${info.value} (inherited from ${info.from}${loc})`;
          }
        }
      }
      if (el.customProperties) {
        system += `\ncustom-properties:`;
        for (const [varName, resolved] of Object.entries(el.customProperties)) {
          system += `\n  ${varName}: ${resolved}`;
        }
      }
      if (el.html) system += `\nhtml: ${el.html}`;
      system += `\n</selected-element>`;
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
 * Return a sandbox directory outside the user's project (in OS temp dir).
 * Uses a hash of the project path to keep sandboxes isolated per project.
 */
function sandboxDirFor(projectPath) {
  const hash = createHash('md5').update(projectPath).digest('hex').slice(0, 12);
  return join(tmpdir(), 'wia-sandbox', hash);
}

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
