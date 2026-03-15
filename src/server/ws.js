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
    const terminals = new Map(); // id -> { process, isPty }
    const usePty = !!getPty();

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
        const id = msg.id || 'default';

        // Kill existing terminal with same id
        const existing = terminals.get(id);
        if (existing) {
          existing.process.kill();
          terminals.delete(id);
        }

        const shell = platform() === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
        const cwd = msg.cwd || process.cwd();
        const cols = msg.cols || 80;
        const rows = msg.rows || 24;

        let spawned = false;

        if (usePty) {
          // Real PTY — full terminal emulation (colors, cursor, resize)
          try {
            const proc = getPty().spawn(shell, [], {
              name: 'xterm-256color',
              cols,
              rows,
              cwd,
              env: shellEnv({ LANG: 'en_US.UTF-8' }),
            });

            terminals.set(id, { process: proc, isPty: true });

            proc.onData((data) => {
              safeSend({ type: 'terminal-output', id, data });
            });

            proc.onExit(({ exitCode }) => {
              safeSend({ type: 'terminal-exit', id, code: exitCode });
              terminals.delete(id);
            });

            safeSend({ type: 'terminal-ready', id, shell, cwd, pty: true });
            console.log('[terminal] PTY spawned OK:', id, shell, cwd);
            spawned = true;
          } catch (e) {
            console.error('[terminal] PTY spawn failed:', e.message);
          }
        }

        if (!spawned) {
          // Fallback: use Python pty.fork() to allocate a real PTY without node-pty.
          // `script` doesn't work here because Node.js uses socketpairs for stdio
          // and `script` calls tcgetattr() on stdin which fails on sockets.
          // Python's pty.fork() creates a proper PTY without touching parent stdin.
          const pyPty = `
import pty,os,sys,select,signal
pid,fd=pty.fork()
if pid==0:
 os.chdir(sys.argv[2])
 os.execvp(sys.argv[1],[sys.argv[1]])
else:
 signal.signal(signal.SIGCHLD,lambda *a:os._exit(0))
 while 1:
  try:r,_,_=select.select([0,fd],[],[])
  except:break
  if 0 in r:
   d=os.read(0,4096)
   if not d:break
   os.write(fd,d)
  if fd in r:
   try:d=os.read(fd,4096)
   except:break
   if not d:break
   os.write(1,d)
`;
          const proc = spawn('python3', ['-c', pyPty, shell, cwd], {
            cwd,
            env: shellEnv({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' }),
            stdio: ['pipe', 'pipe', 'pipe'],
          });

          terminals.set(id, { process: proc, isPty: false });

          proc.stdout.on('data', (data) => {
            safeSend({ type: 'terminal-output', id, data: data.toString() });
          });

          proc.stderr.on('data', (data) => {
            safeSend({ type: 'terminal-output', id, data: data.toString() });
          });

          proc.on('exit', (code) => {
            safeSend({ type: 'terminal-exit', id, code });
            terminals.delete(id);
          });

          safeSend({ type: 'terminal-ready', id, shell, cwd, pty: false });
        }
      }

      // Terminal: write stdin
      if (msg.type === 'terminal-input') {
        const t = terminals.get(msg.id || 'default');
        if (t) {
          if (t.isPty) t.process.write(msg.data);
          else t.process.stdin.write(msg.data);
        }
      }

      // Terminal: resize
      if (msg.type === 'terminal-resize') {
        const t = terminals.get(msg.id || 'default');
        if (t?.isPty) {
          try { t.process.resize(msg.cols, msg.rows); } catch {}
        }
      }

      // Terminal: kill a specific instance
      if (msg.type === 'terminal-kill') {
        const id = msg.id || 'default';
        const t = terminals.get(id);
        if (t) {
          t.process.kill();
          terminals.delete(id);
        }
      }
    });

    ws.on('close', () => {
      if (projectWatcher) projectWatcher.close();
      for (const [, t] of terminals) {
        t.process.kill();
      }
      terminals.clear();
    });
  });
}
