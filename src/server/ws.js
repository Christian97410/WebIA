import chokidar from 'chokidar';
import { spawn } from 'child_process';
import { platform } from 'os';
import { createRequire } from 'module';

const _require = createRequire(import.meta.url);

// Try to load node-pty for proper terminal emulation
let pty = null;
let ptyChecked = false;
function getPty() {
  if (ptyChecked) return pty;
  ptyChecked = true;
  try {
    pty = _require('node-pty');
    console.log('[terminal] node-pty loaded OK');
  } catch (e) {
    console.warn('[terminal] node-pty not available:', e.message);
  }
  return pty;
}

export function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    let projectWatcher = null;
    let terminalProcess = null;
    let usePty = !!getPty();

    const safeSend = (data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(data));
    };

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'watch') {
        // Watch a project directory for file changes
        if (projectWatcher) projectWatcher.close();

        const dir = msg.path;
        projectWatcher = chokidar.watch(dir, {
          ignored: /(node_modules|\.git|\.next|\.nuxt|\.svelte-kit|dist|\.turbo|\.cache)/,
          ignoreInitial: true,
          awaitWriteFinish: { stabilityThreshold: 300 },
        });

        projectWatcher.on('change', (filePath) => {
          safeSend({ type: 'file-changed', path: filePath });
        });

        projectWatcher.on('add', (filePath) => {
          safeSend({ type: 'file-added', path: filePath });
        });

        projectWatcher.on('unlink', (filePath) => {
          safeSend({ type: 'file-removed', path: filePath });
        });
      }

      // Terminal: spawn a shell session
      if (msg.type === 'terminal-start') {
        if (terminalProcess) {
          if (usePty) terminalProcess.kill();
          else terminalProcess.kill();
          terminalProcess = null;
        }

        const shell = platform() === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
        const cwd = msg.cwd || process.cwd();
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;

        if (usePty) {
          // Real PTY — full terminal emulation (colors, cursor, resize)
          try {
            terminalProcess = getPty().spawn(shell, [], {
              name: 'xterm-256color',
              cols,
              rows,
              cwd,
              env: { ...process.env, LANG: 'en_US.UTF-8' },
            });

            terminalProcess.onData((data) => {
              safeSend({ type: 'terminal-output', data });
            });

            terminalProcess.onExit(({ exitCode }) => {
              safeSend({ type: 'terminal-exit', code: exitCode });
              terminalProcess = null;
            });

            safeSend({ type: 'terminal-ready', shell, cwd, pty: true });
            console.log('[terminal] PTY spawned OK:', shell, cwd);
          } catch (e) {
            console.error('[terminal] PTY spawn failed:', e.message);
            usePty = false;
          }
        }

        if (!usePty) {
          // Fallback: basic pipes (no ANSI, no resize)
          terminalProcess = spawn(shell, [], {
            cwd,
            env: { ...process.env, TERM: 'dumb', LANG: 'en_US.UTF-8' },
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          terminalProcess.stdout.on('data', (data) => {
            safeSend({ type: 'terminal-output', data: data.toString() });
          });

          terminalProcess.stderr.on('data', (data) => {
            safeSend({ type: 'terminal-output', data: data.toString() });
          });

          terminalProcess.on('exit', (code) => {
            safeSend({ type: 'terminal-exit', code });
            terminalProcess = null;
          });

          safeSend({ type: 'terminal-ready', shell, cwd, pty: false });
        }
      }

      // Terminal: write stdin
      if (msg.type === 'terminal-input' && terminalProcess) {
        if (usePty) {
          terminalProcess.write(msg.data);
        } else {
          terminalProcess.stdin.write(msg.data);
        }
      }

      // Terminal: resize
      if (msg.type === 'terminal-resize' && terminalProcess && usePty) {
        try {
          terminalProcess.resize(msg.cols, msg.rows);
        } catch {}
      }
    });

    ws.on('close', () => {
      if (projectWatcher) projectWatcher.close();
      if (terminalProcess) {
        if (usePty) terminalProcess.kill();
        else terminalProcess.kill();
        terminalProcess = null;
      }
    });
  });
}
