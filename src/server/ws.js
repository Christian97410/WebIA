import chokidar from 'chokidar';

export function setupWebSocket(wss) {
  wss.on('connection', (ws) => {
    let projectWatcher = null;

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

        const safeSend = (data) => {
          if (ws.readyState === 1) ws.send(JSON.stringify(data));
        };

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
    });

    ws.on('close', () => {
      if (projectWatcher) projectWatcher.close();
    });
  });
}
