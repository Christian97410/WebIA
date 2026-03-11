import { ProjectsView } from './views/projects.js';
import { EditorView } from './views/editor.js';
import { api } from './utils/api.js';

class App {
  constructor() {
    this.root = document.getElementById('app');
    this.currentView = null;
    this.state = {
      currentProject: null,
    };
  }

  async init() {
    // Check if launched with a project path
    try {
      const serverState = await api.get('/api/state');
      if (serverState.currentProject) {
        await this.openProject(serverState.currentProject);
        return;
      }
    } catch (err) {
      console.error('Failed to load server state:', err);
    }
    this.showProjects();
  }

  showProjects() {
    this.root.innerHTML = '';
    this.currentView = new ProjectsView({
      onOpen: (path) => this.openProject(path),
    });
    this.root.appendChild(this.currentView.el);
  }

  async openProject(projectPath) {
    this.root.innerHTML = '';
    this.state.currentProject = projectPath;

    try {
      // Register in recents
      await api.post('/api/projects', {
        path: projectPath,
        name: projectPath.split('/').pop(),
      });

      // Detect project type (fallback to static if endpoint unavailable)
      let detection = { framework: null, isStatic: true };
      try {
        detection = await api.get(`/api/devserver/detect?dir=${encodeURIComponent(projectPath)}`);
      } catch {
        // devserver route not available — treat as static
      }

      if (detection.framework && !detection.isStatic) {
        // Framework project — start dev server
        await this.openFrameworkProject(projectPath, detection);
      } else {
        // Static project — use existing flow
        await this.openStaticProject(projectPath);
      }
    } catch (err) {
      console.error('Failed to open project:', err);
      this.showProjects();
    }
  }

  async openStaticProject(projectPath) {
    const { files } = await api.get(`/api/files/scan?dir=${encodeURIComponent(projectPath)}`);
    const htmlFiles = files.filter(f => f.type === 'html');

    if (htmlFiles.length === 0) {
      this.showProjects();
      return;
    }

    this.currentView = new EditorView({
      projectPath,
      files,
      htmlFiles,
      onBack: () => this.showProjects(),
    });
    this.root.appendChild(this.currentView.el);
  }

  async openFrameworkProject(projectPath, detection) {
    const fw = detection.framework;
    const projName = projectPath.split('/').pop();

    // Build loading UI
    const loading = document.createElement('div');
    loading.className = 'projects-view';
    loading.innerHTML = `
      <div class="devserver-loading">
        <div class="devserver-loading__header">
          <svg class="devserver-loading__icon" width="24" height="24" viewBox="0 0 24 24" fill="none">
            <rect class="ds-bar ds-bar--1" x="4" y="10" width="3" height="4" rx="1" fill="currentColor"/>
            <rect class="ds-bar ds-bar--2" x="10.5" y="6" width="3" height="12" rx="1" fill="currentColor"/>
            <rect class="ds-bar ds-bar--3" x="17" y="8" width="3" height="8" rx="1" fill="currentColor"/>
          </svg>
          <div>
            <div class="devserver-loading__title">Starting ${fw} dev server</div>
            <div class="devserver-loading__subtitle">${projName}</div>
          </div>
        </div>
        <div class="devserver-loading__logs" id="ds-logs"></div>
        <div class="devserver-loading__status" id="ds-status">Compiling...</div>
        <button class="devserver-loading__cancel" id="ds-cancel">Cancel</button>
      </div>`;
    this.root.appendChild(loading);

    const logsEl = loading.querySelector('#ds-logs');
    const statusEl = loading.querySelector('#ds-status');
    const cancelBtn = loading.querySelector('#ds-cancel');

    let cancelled = false;
    cancelBtn.onclick = () => {
      cancelled = true;
      api.post('/api/devserver/stop', { dir: projectPath }).catch(() => {});
      this.root.innerHTML = '';
      this.showProjects();
    };

    try {
      // Fire start (returns immediately now)
      const server = await api.post('/api/devserver/start', { dir: projectPath });

      // Poll status until ready or crashed
      const ready = await new Promise((resolve, reject) => {
        let lastLogLen = 0;
        const steps = ['Compiling...', 'Building modules...', 'Starting server...', 'Almost there...'];
        let stepIdx = 0;

        const poll = async () => {
          if (cancelled) return reject(new Error('Cancelled'));
          try {
            const s = await api.get(`/api/devserver/status?dir=${encodeURIComponent(projectPath)}`);

            // Update logs (show last lines)
            if (s.logs && s.logs.length > lastLogLen) {
              lastLogLen = s.logs.length;
              const lines = s.logs.trim().split('\n').slice(-8);
              logsEl.textContent = lines.join('\n');
              logsEl.scrollTop = logsEl.scrollHeight;
              // Advance status step based on log content
              if (s.logs.includes('compil') || s.logs.includes('Compil')) stepIdx = Math.max(stepIdx, 1);
              if (s.logs.includes('Ready') || s.logs.includes('ready') || s.logs.includes('started')) stepIdx = Math.max(stepIdx, 3);
            }
            // Show status based on server state
            if (s.status === 'installing') {
              statusEl.textContent = 'Installing dependencies...';
            } else {
              statusEl.textContent = steps[Math.min(stepIdx, steps.length - 1)];
            }

            if (s.status === 'ready') return resolve(s);
            if (s.status === 'crashed') return reject(new Error(s.error || 'Dev server crashed'));
            if (!s.running) return reject(new Error('Dev server stopped unexpectedly'));
          } catch {
            // Status endpoint failed, keep trying
          }
          stepIdx = Math.min(stepIdx + 1, steps.length - 1);
          setTimeout(poll, 1000);
        };
        setTimeout(poll, 1500); // Give it a moment before first poll
      });

      // Server ready — open editor
      const scanDir = detection.projectDir || projectPath;
      const { files } = await api.get(`/api/files/scan?dir=${encodeURIComponent(scanDir)}`);
      const sourceFiles = files.filter(f => ['tsx', 'jsx', 'ts', 'js', 'css', 'html'].includes(f.type));

      this.root.innerHTML = '';
      this.currentView = new EditorView({
        projectPath,
        files,
        htmlFiles: sourceFiles,
        devServer: { port: server.port, framework: server.framework },
        onBack: () => {
          api.post('/api/devserver/stop', { dir: projectPath }).catch(() => {});
          this.showProjects();
        },
      });
      this.root.appendChild(this.currentView.el);
    } catch (err) {
      if (cancelled) return;
      console.error('Failed to start dev server:', err);
      this.root.innerHTML = '';

      const errDiv = document.createElement('div');
      errDiv.className = 'projects-view';
      errDiv.innerHTML = `
        <div class="devserver-loading">
          <div class="devserver-loading__title" style="color:var(--text-primary)">Dev server failed</div>
          <div class="devserver-loading__subtitle">${err.message || 'Unknown error'}</div>
          <div style="font-size:11px;opacity:0.4;margin-top:12px">Falling back to static mode...</div>
        </div>`;
      this.root.appendChild(errDiv);
      await new Promise(r => setTimeout(r, 2000));
      this.root.innerHTML = '';
      await this.openStaticProject(projectPath);
    }
  }
}

const app = new App();
app.init();
