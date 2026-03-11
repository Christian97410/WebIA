import { h, timeAgo } from '../utils/dom.js';
import { api } from '../utils/api.js';

export class ProjectsView {
  constructor({ onOpen }) {
    this.onOpen = onOpen;
    this.el = h('div', { className: 'projects-view' });
    this.load();
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
        )
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
