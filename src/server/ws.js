import chokidar from 'chokidar';
import { spawn } from 'child_process';
import { platform } from 'os';

export function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    let projectWatcher = null;
    let terminalProcess = null;

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
          ignored: /(node_modules|\.git|\.wia-sandbox|\.next|\.nuxt|\.svelte-kit|dist|\.turbo|\.cache)/,
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
          terminalProcess.kill();
          terminalProcess = null;
        }

        const shell = platform() === 'win32' ? 'cmd.exe' : (process.env.SHELL || '/bin/zsh');
        const cwd = msg.cwd || process.cwd();

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

        safeSend({ type: 'terminal-ready', shell, cwd });
      }

      // Terminal: write stdin
      if (msg.type === 'terminal-input' && terminalProcess) {
        terminalProcess.stdin.write(msg.data);
      }

      // Terminal: resize (no-op without pty, but keep for future)
      if (msg.type === 'terminal-resize') {
        // Would need node-pty for real resize support
      }
    });

    ws.on('close', () => {
      if (projectWatcher) projectWatcher.close();
      if (terminalProcess) {
        terminalProcess.kill();
        terminalProcess = null;
      }
    });
  });
}
