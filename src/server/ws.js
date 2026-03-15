import chokidar from 'chokidar';
import { spawn } from 'child_process';
import { platform } from 'os';
import { shellEnv } from './shell-path.js';

// Try to load node-pty for proper terminal emulation (lazy loaded).
// node-pty is a native module — it cannot be bundled into a SEA binary,
// so we guard the require behind a try/catch. We also avoid calling
// createRequire(import.meta.url) at the top level because esbuild
// bundles this file as CJS for the SEA, where import.meta.url is undefined.
let pty = null;
let ptyChecked = false;
function getPty() {
  if (ptyChecked) return pty;
  ptyChecked = true;
  try {
    pty = require('node-pty');
  } catch {
    // node-pty not available — fall back to basic pipes
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
              env: shellEnv({ LANG: 'en_US.UTF-8' }),
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
          // Fallback: use `script` to allocate a real PTY without node-pty.
          // macOS: script -q /dev/null <shell>
          // Linux: script -qc <shell> /dev/null
          const isLinux = platform() === 'linux';
          const scriptArgs = isLinux
            ? ['-qc', shell, '/dev/null']
            : ['-q', '/dev/null', shell];
          terminalProcess = spawn('script', scriptArgs, {
            cwd,
            env: shellEnv({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }),
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
