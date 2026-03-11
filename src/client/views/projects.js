import { h, timeAgo } from '../utils/dom.js';
import { api } from '../utils/api.js';

export class ProjectsView {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.el = h('div', { className: 'projects-view' });
    this.load();
    this.listenForUpdates();
  }

  async listenForUpdates() {
    try {
      const data = await api.get('/api/update-check');
      if (data.available) this.showUpdateBanner(data.latestVersion);
    } catch {}
  }

  showUpdateBanner(version) {
    if (document.querySelector('.update-toast')) return;

    const btn = h('button', {
      className: 'update-toast__btn',
      onClick: async () => {
        btn.textContent = 'Installing…';
        btn.disabled = true;
        try { await api.post('/api/install-update'); } catch {}
      },
    }, 'Update');

    const toast = h('div', { className: 'update-toast' },
      h('div', { className: 'update-toast__text' },
        'A new version is available: ',
        h('span', { className: 'update-toast__version' }, `v${version}`),
      ),
      btn,
      h('button', {
        className: 'update-toast__close',
        onClick: () => toast.remove(),
      }, '\u2715'),
    );
    document.body.appendChild(toast);
  }

  async load() {
    const projects = await api.get('/api/projects');
    this.render(projects);
  }

  render(projects) {
    const hasRecents = projects.length > 0;
    this.el.className = `projects-view${hasRecents ? ' has-recents' : ''}`;
    this.el.innerHTML = '';

    // Header
    this.el.appendChild(
      h('div', { className: 'projects-header' },
        h('div', { className: 'projects-logo' }, 'WebIA')
      )
    );

    // Open field
    const input = h('input', {
      type: 'text',
      placeholder: '/path/to/project',
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && input.value.trim()) {
        this.onOpen(input.value.trim());
      }
    });

    this.el.appendChild(
      h('div', { className: 'projects-open' },
        h('div', { className: 'projects-open-field' },
          input,
          h('button', { className: 'btn-browse', onClick: () => this.browse(input) }, 'Browse')
        ),
        h('button', {
          className: 'projects-new-btn',
          onClick: () => this.showCreateModal(),
        }, '+ New project')
      )
    );

    // Recents
    if (hasRecents) {
      const list = h('div', { className: 'projects-recents' },
        h('div', { className: 'projects-recents-title' }, 'Recent')
      );

      for (const project of projects) {
        list.appendChild(
          h('div', {
            className: 'project-item',
            onClick: () => this.onOpen(project.path)
          },
            h('div', { className: 'project-item-info' },
              h('div', { className: 'project-item-name' }, project.name),
              h('div', { className: 'project-item-path' }, project.path)
            ),
            h('div', { className: 'project-item-time' }, timeAgo(project.lastOpened))
          )
        );
      }

      this.el.appendChild(list);
    }
  }

  showCreateModal() {
    const templates = [
      { id: 'empty',      name: 'Empty',         desc: 'Empty folder — let AI decide',  icon: '○' },
      { id: 'html',       name: 'HTML / CSS',    desc: 'Blank static site',             icon: '◇' },
      { id: 'vite-react', name: 'Vite + React',  desc: 'React with Vite & Tailwind',    icon: '⚡' },
      { id: 'vite-vue',   name: 'Vite + Vue',    desc: 'Vue 3 with Vite',               icon: '⚡' },
      { id: 'next',       name: 'Next.js',       desc: 'React fullstack framework',     icon: '▲' },
      { id: 'astro',      name: 'Astro',         desc: 'Content-driven static sites',   icon: '✦' },
    ];

    const overlay = h('div', { className: 'browse-overlay' });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = h('div', { className: 'browse-modal create-modal' });

    // Header
    modal.appendChild(h('div', { className: 'browse-header' },
      h('span', {}, 'New project'),
      h('button', { className: 'browse-close', onClick: () => overlay.remove() }, '\u2715'),
    ));

    // Form
    const form = h('div', { className: 'create-form' });

    // Name
    const nameInput = h('input', {
      type: 'text',
      className: 'create-input',
      placeholder: 'my-project',
      spellcheck: 'false',
    });
    form.appendChild(h('div', { className: 'create-field' },
      h('label', { className: 'create-label' }, 'Name'),
      nameInput,
    ));

    // Location
    const locInput = h('input', {
      type: 'text',
      className: 'create-input',
      placeholder: '~/Projects',
      spellcheck: 'false',
    });
    // Default to home ~/Projects or ~/Desktop
    locInput.value = '~/Projects';
    const locBrowse = h('button', {
      className: 'create-loc-browse',
      onClick: () => this._pickFolder(locInput),
    }, 'Browse');
    form.appendChild(h('div', { className: 'create-field' },
      h('label', { className: 'create-label' }, 'Location'),
      h('div', { className: 'create-loc-row' }, locInput, locBrowse),
    ));

    // Template
    let selectedTemplate = 'empty';
    const templateList = h('div', { className: 'create-templates' });
    const templateEls = [];

    for (const t of templates) {
      const el = h('div', {
        className: `create-template${t.id === selectedTemplate ? ' is-selected' : ''}`,
        onClick: () => {
          selectedTemplate = t.id;
          templateEls.forEach((te, i) => {
            te.classList.toggle('is-selected', templates[i].id === selectedTemplate);
          });
        },
      },
        h('div', { className: 'create-template__icon' }, t.icon),
        h('div', { className: 'create-template__info' },
          h('div', { className: 'create-template__name' }, t.name),
          h('div', { className: 'create-template__desc' }, t.desc),
        ),
      );
      templateEls.push(el);
      templateList.appendChild(el);
    }
    form.appendChild(h('div', { className: 'create-field' },
      h('label', { className: 'create-label' }, 'Template'),
      templateList,
    ));

    modal.appendChild(form);

    // Footer
    const statusEl = h('div', { className: 'create-status' });
    const createBtn = h('button', {
      className: 'browse-btn browse-btn-open',
      onClick: () => this._createProject({
        name: nameInput.value.trim(),
        location: locInput.value.trim(),
        template: selectedTemplate,
        statusEl,
        createBtn,
        overlay,
      }),
    }, 'Create');

    modal.appendChild(h('div', { className: 'browse-footer' },
      statusEl,
      h('button', { className: 'browse-btn browse-btn-cancel', onClick: () => overlay.remove() }, 'Cancel'),
      createBtn,
    ));

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Escape to close
    const onKey = (e) => {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); }
    };
    document.addEventListener('keydown', onKey);

    nameInput.focus();
  }

  async _pickFolder(input) {
    try {
      const data = await api.get('/api/files/pick-folder');
      if (data.folder) input.value = data.folder;
    } catch {
      // Fallback: user types manually
    }
  }

  async _createProject({ name, location, template, statusEl, createBtn, overlay }) {
    if (!name) { statusEl.textContent = 'Enter a project name'; return; }
    if (!location) { statusEl.textContent = 'Enter a location'; return; }

    createBtn.disabled = true;
    createBtn.textContent = 'Creating...';
    statusEl.textContent = '';

    try {
      const result = await api.post('/api/projects/create', { name, location, template });
      overlay.remove();
      this.onOpen(result.path);
    } catch (err) {
      statusEl.textContent = err.message || 'Creation failed';
      createBtn.disabled = false;
      createBtn.textContent = 'Create';
    }
  }

  async browse(input) {
    // Try native OS folder picker first
    try {
      const data = await api.get('/api/files/pick-folder');
      if (data.folder) {
        input.value = data.folder;
        this.onOpen(data.folder);
        return;
      }
      // User cancelled — don't fall through to modal
      if (data.cancelled) return;
    } catch {
      // Native picker not available — fall through to browse modal
    }

    const overlay = h('div', { className: 'browse-overlay' });
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    const modal = h('div', { className: 'browse-modal' });

    // Header
    const header = h('div', { className: 'browse-header' },
      h('span', {}, 'Open project'),
      h('button', { className: 'browse-close', onClick: () => overlay.remove() }, '\u2715'),
    );
    modal.appendChild(header);

    // Current path display
    const pathBar = h('div', { className: 'browse-path' });
    const pathText = h('div', { className: 'browse-path-text' });
    pathBar.appendChild(pathText);
    modal.appendChild(pathBar);

    // Directory listing
    const list = h('div', { className: 'browse-list' });
    modal.appendChild(list);

    // Footer with Open button
    let currentDir = '';
    const footer = h('div', { className: 'browse-footer' },
      h('button', { className: 'browse-btn browse-btn-cancel', onClick: () => overlay.remove() }, 'Cancel'),
      h('button', { className: 'browse-btn browse-btn-open', onClick: () => {
        overlay.remove();
        input.value = currentDir;
        this.onOpen(currentDir);
      }}, 'Open'),
    );
    modal.appendChild(footer);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Navigate to a directory
    const navigateTo = async (dir) => {
      try {
        const data = await api.get(`/api/files/browse?dir=${encodeURIComponent(dir)}`);
        currentDir = data.dir;
        pathText.textContent = data.dir;
        list.innerHTML = '';

        // Parent directory
        if (data.dir !== '/') {
          const parent = data.dir.split('/').slice(0, -1).join('/') || '/';
          list.appendChild(
            h('div', { className: 'browse-item', onClick: () => navigateTo(parent) },
              h('span', { className: 'browse-item-icon' }, '\u2190'),
              h('span', { className: 'browse-item-name' }, '..'),
            )
          );
        }

        // Directories
        for (const name of data.dirs) {
          const fullPath = data.dir === '/' ? `/${name}` : `${data.dir}/${name}`;
          list.appendChild(
            h('div', { className: 'browse-item', onClick: () => navigateTo(fullPath) },
              h('span', { className: 'browse-item-icon' }, '\u25B8'),
              h('span', { className: 'browse-item-name' }, name),
            )
          );
        }

        // Files (informational, shows the dir has web files)
        for (const name of data.files) {
          list.appendChild(
            h('div', { className: 'browse-item is-file' },
              h('span', { className: 'browse-item-icon' }, '\u25CB'),
              h('span', { className: 'browse-item-name' }, name),
            )
          );
        }
      } catch (err) {
        list.innerHTML = '';
        list.appendChild(
          h('div', { style: { padding: '16px', fontSize: '12px', color: 'var(--text-tertiary)' } }, `Cannot access: ${dir}`)
        );
      }
    };

    // Keyboard: Escape to close
    const onKey = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);

    // Start at home directory
    await navigateTo(input.value || '');
  }
}
