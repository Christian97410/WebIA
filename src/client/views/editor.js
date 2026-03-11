import { h } from '../utils/dom.js';
import { api } from '../utils/api.js';
import { ShortcutManager } from '../utils/shortcuts.js';
import { CommandPalette } from '../components/command-palette.js';
import { MediaPanel } from '../components/media-panel.js';

export class EditorView {
  constructor({ projectPath, files, htmlFiles, onBack, devServer }) {
    this.projectPath = projectPath;
    this.files = files;
    this.htmlFiles = htmlFiles;
    this.onBack = onBack;
    this.devServer = devServer || null; // { port, framework } if framework project
    this.activePage = htmlFiles[0] || null;
    this.selectedElement = null;
    this.breakpoint = 'desktop';
    this.zoom = 100;
    this.chatHeight = 200;

    this.undoStack = [];
    this.redoStack = [];
    this.cssRulesCache = {};

    this.el = h('div', { className: 'editor-view' });
    this.render();
    this.connectWebSocket();
    this.setupShortcuts();
    this.setupCommandPalette();
    this.loadGitBranch();
    this.listenForUpdates();
  }

  render() {
    this.el.innerHTML = '';

    // Top bar
    this.el.appendChild(this.renderTopbar());

    // Left panel
    this.el.appendChild(this.renderLeftPanel());

    // Center (canvas + chat)
    this.el.appendChild(this.renderCenter());

    // Right panel
    this.panelRight = this.renderRightPanel();
    this.el.appendChild(this.panelRight);

    // Bottom bar
    this.el.appendChild(this.renderBottombar());

    // Load the first page
    if (this.activePage) {
      this.loadPage(this.activePage);
    }
  }

  renderTopbar() {
    const breakpoints = [
      { id: 'desktop', label: 'Desktop', width: '100%' },
      { id: 'tablet', label: 'Tablet', width: '768px' },
      { id: 'mobile', label: 'Mobile', width: '375px' },
    ];

    // Tool mode buttons (select vs AI marquee)
    this._toolSelect = h('button', {
      className: 'tool-btn active',
      onClick: () => this._setTool('select'),
      title: 'Select tool (V)',
    });
    this._toolSelect.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 2l8 6-4 1-2 4-2-11z" fill="currentColor"/></svg>';

    this._toolMarquee = h('button', {
      className: 'tool-btn',
      onClick: () => this._setTool('marquee'),
      title: 'AI zone select (M)',
    });
    this._toolMarquee.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 2h4M10 2h4M2 2v4M14 2v4M2 10v4M14 10v4M2 14h4M10 14h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="2" fill="var(--accent)" opacity="0.7"/></svg>';

    this._toolAdd = h('button', {
      className: 'tool-btn',
      onClick: () => this.toggleAddPanel(),
      title: 'Add element (A)',
    });
    this._toolAdd.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';

    this._toolMedia = h('button', {
      className: 'tool-btn',
      onClick: () => this.toggleMediaPanel(),
      title: 'Media library (I)',
    });
    this._toolMedia.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="6.5" r="1.5" fill="currentColor"/><path d="M1.5 11l3.5-3 2.5 2 3-4 4 5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

    return h('div', { className: 'topbar' },
      // Left: back + project name + tools
      h('div', { className: 'topbar-left' },
        h('button', { className: 'topbar-btn', onClick: () => this.onBack() }, '\u25C0'),
        h('span', { className: 'topbar-project-name' }, this.projectPath.split('/').pop()),
        h('div', { className: 'topbar-separator' }),
        h('div', { className: 'tool-group' },
          this._toolSelect,
          this._toolAdd,
          this._toolMarquee,
          this._toolMedia,
        ),
      ),

      // Center: breakpoints + zoom
      h('div', { className: 'topbar-center' },
        h('div', { className: 'breakpoint-selector' },
          ...breakpoints.map(bp =>
            h('button', {
              className: `breakpoint-btn${bp.id === this.breakpoint ? ' active' : ''}`,
              onClick: () => this.setBreakpoint(bp.id),
            }, bp.label)
          )
        ),
        h('div', { className: 'topbar-separator' }),
        h('span', {
          className: 'topbar-btn',
          style: { fontSize: '11px' },
        }, `${this.zoom}%`),
      ),

      // Right: undo/redo + preview + changes
      h('div', { className: 'topbar-right' },
        h('button', { className: 'topbar-btn', onClick: () => this.undo() }, '\u21A9'),
        h('button', { className: 'topbar-btn', onClick: () => this.redo() }, '\u21AA'),
        h('div', { className: 'topbar-separator' }),
        h('button', { className: 'topbar-btn', onClick: () => this.togglePreview() }, '\u25B6'),
        h('button', { className: 'topbar-btn', onClick: () => this.showChanges() }, 'Changes'),
      ),
    );
  }

  renderLeftPanel() {
    const panel = h('div', { className: 'panel-left' });

    // Pages section
    panel.appendChild(h('div', { className: 'panel-section-header' }, 'Pages'));
    const pagesList = h('div', { className: 'pages-list' });

    if (this.devServer) {
      // Framework project: build a folder tree from relativePaths
      const tree = {};
      for (const page of this.htmlFiles) {
        const parts = page.relativePath.replace(/^src\//, '').split('/');
        let node = tree;
        for (let i = 0; i < parts.length - 1; i++) {
          const dir = parts[i];
          if (!node[dir]) node[dir] = {};
          node = node[dir];
        }
        node['__file_' + parts[parts.length - 1]] = page;
      }

      const renderTree = (node, depth = 0) => {
        const entries = Object.entries(node).sort(([a], [b]) => {
          const aIsFile = a.startsWith('__file_');
          const bIsFile = b.startsWith('__file_');
          if (aIsFile !== bIsFile) return aIsFile ? 1 : -1;
          return a.localeCompare(b);
        });

        for (const [key, value] of entries) {
          if (key.startsWith('__file_')) {
            const page = value;
            const fileName = key.slice(7);
            pagesList.appendChild(
              h('div', {
                className: `page-item${page === this.activePage ? ' active' : ''}`,
                style: { paddingLeft: `${8 + depth * 12}px` },
                onClick: () => this.loadPage(page),
              },
                h('span', { className: 'page-item-name' }, fileName),
                page === this.activePage ? h('div', { className: 'page-item-indicator' }) : document.createTextNode('')
              )
            );
          } else {
            // Folder
            const isGroup = key.startsWith('(') && key.endsWith(')');
            const label = isGroup ? key.slice(1, -1) : key;
            pagesList.appendChild(
              h('div', {
                className: `page-folder${isGroup ? ' page-folder--group' : ''}`,
                style: { paddingLeft: `${8 + depth * 12}px` },
              }, label)
            );
            renderTree(value, depth + 1);
          }
        }
      };
      renderTree(tree);
    } else {
      // Static project: flat list
      for (const page of this.htmlFiles) {
        pagesList.appendChild(
          h('div', {
            className: `page-item${page === this.activePage ? ' active' : ''}`,
            onClick: () => this.loadPage(page),
          },
            h('span', {}, page.name),
            page === this.activePage ? h('div', { className: 'page-item-indicator' }) : document.createTextNode('')
          )
        );
      }
    }
    panel.appendChild(pagesList);

    // Layers section
    panel.appendChild(h('div', { className: 'panel-section-header' }, 'Layers'));
    this.layersTree = h('div', { className: 'layers-tree' });
    panel.appendChild(this.layersTree);

    return panel;
  }

  renderCenter() {
    const center = h('div', { className: 'center-area' });

    // Canvas
    this.canvasWrapper = h('div', { className: 'canvas-wrapper' });
    this.iframeContainer = h('div', { className: 'canvas-iframe-container' });
    this.iframe = h('iframe', { sandbox: 'allow-same-origin allow-scripts' });
    this.overlay = h('div', { className: 'canvas-overlay' });

    this.iframeContainer.appendChild(this.iframe);

    // Route bar for framework projects
    if (this.devServer) {
      this._devPath = '/';
      const urlBar = h('div', { className: 'canvas-urlbar' });

      // Route selector dropdown
      this._routeSelect = h('select', { className: 'canvas-urlbar__select' });
      this._routeSelect.innerHTML = '<option value="/">/ (loading routes...)</option>';
      this._routeSelect.addEventListener('change', () => {
        this._navigateDevPreview(this._routeSelect.value);
      });

      // Manual URL input (smaller, secondary)
      this._urlInput = h('input', {
        className: 'canvas-urlbar__input',
        type: 'text',
        value: '/',
        placeholder: '/custom-path',
        spellcheck: 'false',
      });
      this._urlInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this._navigateDevPreview(this._urlInput.value.trim() || '/');
          this._urlInput.blur();
        }
      });

      const urlRefresh = h('button', {
        className: 'canvas-urlbar__btn',
        title: 'Reload',
        onClick: () => this._navigateDevPreview(this._devPath),
      });
      urlRefresh.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M13.5 8a5.5 5.5 0 11-1.5-3.8M12 1v3.5H8.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      urlBar.append(this._routeSelect, this._urlInput, urlRefresh);
      this.canvasWrapper.appendChild(urlBar);

      // Fetch routes in background
      this._loadRoutes();
    }

    this.canvasWrapper.appendChild(this.iframeContainer);
    this.canvasWrapper.appendChild(this.overlay);
    center.appendChild(this.canvasWrapper);

    // Splitter
    const splitter = h('div', { className: 'splitter-h' });
    this.setupSplitter(splitter, center);
    center.appendChild(splitter);

    // Chat
    this.chatPanel = this.renderChatPanel();
    center.appendChild(this.chatPanel);

    return center;
  }

  renderChatPanel() {
    const panel = h('div', { className: 'chat-panel' });
    panel.style.height = `${this.chatHeight}px`;

    // Claude logo SVG (from Bootstrap Icons)
    this._claudeLogoSvg = (size = 24) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="#E87443"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871"/></svg>`;

    // Auth state container — shown when not connected
    this.chatAuthScreen = h('div', { className: 'chat-auth-screen' });
    this.chatAuthScreen.innerHTML = `
      <div class="chat-auth-logo">${this._claudeLogoSvg(32)}</div>
      <div class="chat-auth-title">Claude</div>
      <div class="chat-auth-text">Sign in to start editing with AI</div>
      <button class="chat-auth-btn">Sign in with Claude</button>
    `;
    this.chatAuthScreen.querySelector('.chat-auth-btn').addEventListener('click', () => this.startClaudeAuth());
    panel.appendChild(this.chatAuthScreen);

    // Chat content (hidden until auth)
    this.chatContent = h('div', { className: 'chat-content' });
    this.chatContent.style.display = 'none';

    // Header
    const chatHeader = h('div', { className: 'chat-header' });
    chatHeader.innerHTML = `
      <div class="chat-header-left">
        ${this._claudeLogoSvg(14)}
        <span class="chat-header-title">Claude</span>
      </div>
      <div class="chat-header-right">
        <span class="chat-status-dot"></span>
      </div>
    `;
    this.chatContent.appendChild(chatHeader);

    // Messages
    this.chatMessages = h('div', { className: 'chat-messages' });
    this.chatContent.appendChild(this.chatMessages);

    // Context bar (shows selected element info)
    this.chatContextBar = h('div', { className: 'chat-context-bar' });
    this.chatContextBar.style.display = 'none';
    this.chatContent.appendChild(this.chatContextBar);

    // Input area
    const inputWrapper = h('div', { className: 'chat-input-wrapper' });

    this.chatInput = h('textarea', {
      className: 'chat-input',
      placeholder: 'Ask Claude...',
      rows: '1',
    });

    this.chatInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.sendChatMessage(this.chatInput.value.trim());
        this.chatInput.value = '';
        this.chatInput.style.height = 'auto';
      }
    });

    // Auto-resize textarea
    this.chatInput.addEventListener('input', () => {
      this.chatInput.style.height = 'auto';
      this.chatInput.style.height = Math.min(this.chatInput.scrollHeight, 120) + 'px';
    });

    const sendBtn = h('button', { className: 'chat-send-btn', onClick: () => {
      this.sendChatMessage(this.chatInput.value.trim());
      this.chatInput.value = '';
      this.chatInput.style.height = 'auto';
    }});
    sendBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M12 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

    inputWrapper.appendChild(this.chatInput);
    inputWrapper.appendChild(sendBtn);

    // Footer hint
    const footer = h('div', { className: 'chat-footer' });
    footer.innerHTML = '<span class="chat-footer-hint"><kbd>Enter</kbd> to send &middot; <kbd>Shift+Enter</kbd> for new line</span>';
    inputWrapper.appendChild(footer);

    this.chatContent.appendChild(inputWrapper);
    panel.appendChild(this.chatContent);

    // Check auth status
    this.checkClaudeAuth();

    return panel;
  }

  async checkClaudeAuth() {
    try {
      const status = await api.get('/api/ai/providers');
      const claudeSdk = status.providers?.find(p => p.id === 'claude-sdk');
      const claudeApi = status.providers?.find(p => p.id === 'claude-api');
      const isConnected = claudeSdk?.available || claudeApi?.available;

      if (isConnected) {
        this.setChatConnected(claudeSdk?.available ? 'Claude Code' : 'Claude API');
      }
    } catch {
      // Server might not be ready yet, stay on auth screen
    }
  }

  setChatConnected(providerName) {
    this.chatAuthScreen.style.display = 'none';
    this.chatContent.style.display = 'flex';
    const dot = this.chatContent.querySelector('.chat-status-dot');
    if (dot) dot.classList.add('connected');
    const title = this.chatContent.querySelector('.chat-header-title');
    if (title) title.textContent = providerName || 'Claude';

    // Show welcome screen if no messages yet
    if (this.chatMessages.children.length === 0) {
      this.showChatWelcome();
    }
  }

  showChatWelcome() {
    const welcome = h('div', { className: 'chat-welcome' });
    welcome.innerHTML = `
      <div class="chat-welcome-logo">${this._claudeLogoSvg(28)}</div>
      <div class="chat-welcome-title">What would you like to build?</div>
      <div class="chat-welcome-hint">Describe what you want to change and Claude will edit your code.</div>
    `;
    this.chatMessages.appendChild(welcome);
  }

  async startClaudeAuth() {
    const btn = this.chatAuthScreen.querySelector('.chat-auth-btn');
    btn.disabled = true;
    btn.textContent = 'Checking...';

    try {
      // Try Tauri IPC first (desktop app)
      if (window.__TAURI__) {
        const { invoke } = await import('@tauri-apps/api/core');
        const sdkStatus = await invoke('check_claude_sdk');

        if (sdkStatus.has_credentials) {
          this.setChatConnected('Claude Code');
          return;
        }

        if (sdkStatus.cli_available) {
          btn.textContent = 'Opening Claude login...';
          // Launch claude auth login via shell
          const { Command } = await import('@tauri-apps/plugin-shell');
          const cmd = Command.create('claude', ['auth', 'login']);
          await cmd.execute();
          // Re-check after auth
          await this.checkClaudeAuth();
          return;
        }
      }

      // Fallback: re-check server-side providers
      await this.checkClaudeAuth();

      if (this.chatContent.style.display === 'none') {
        btn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
            <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
          No provider found
        `;
        btn.disabled = false;
        setTimeout(() => {
          btn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M15 3h6v6M14 10l6.1-6.1M9 21H3v-6M10 14l-6.1 6.1" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Sign in with Claude
          `;
        }, 2000);
      }
    } catch (err) {
      btn.textContent = 'Error — retry';
      btn.disabled = false;
    }
  }

  updateChatContext() {
    if (!this.chatContextBar) return;
    if (this.selectedElement) {
      const tag = this.selectedElement.tagName?.toLowerCase() || '';
      const cls = this.selectedElement.className ? `.${this.selectedElement.className.split(' ')[0]}` : '';
      this.chatContextBar.style.display = 'flex';
      this.chatContextBar.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M5.5 3L2 8l3.5 5M10.5 3L14 8l-3.5 5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg><span>${tag}${cls}</span>`;
    } else {
      this.chatContextBar.style.display = 'none';
    }
  }

  // Format computed value: round numbers, convert rgb to hex
  _fmt(raw) {
    if (!raw || raw === 'none' || raw === 'normal' || raw === 'auto') return raw;
    // Round decimals
    const rounded = raw.replace(/(\d+\.\d{2})\d+/g, (_, m) => parseFloat(m).toFixed(0));
    return rounded;
  }

  _fmtColor(raw) {
    return this.rgbToHex(raw || '#000000');
  }

  renderRightPanel() {
    const panel = h('div', { className: 'panel-right' });

    if (!this.selectedElement) {
      panel.appendChild(h('div', { className: 'sp-empty' }, 'Select an element'));
      return panel;
    }

    // Element tag badge
    const tag = this.selectedElement.tagName.toLowerCase();
    const cls = this.selectedElement.className && typeof this.selectedElement.className === 'string'
      ? `.${this.selectedElement.className.split(' ').filter(Boolean)[0] || ''}`
      : '';
    panel.appendChild(h('div', { className: 'sp-tag' }, `${tag}${cls}`));

    panel.appendChild(this._renderLayout());
    panel.appendChild(this._renderSpacing());
    panel.appendChild(this._renderSize());
    panel.appendChild(this._renderTypo());
    panel.appendChild(this._renderFill());
    panel.appendChild(this._renderBorder());
    panel.appendChild(this._renderPosition());

    return panel;
  }

  // Compact section wrapper
  _sec(title) {
    const s = h('div', { className: 'sp-sec' });
    const hdr = h('div', { className: 'sp-hdr' });
    hdr.textContent = title;
    hdr.addEventListener('click', () => s.classList.toggle('collapsed'));
    s.appendChild(hdr);
    const b = h('div', { className: 'sp-body' });
    s.appendChild(b);
    return { s, b };
  }

  // Compact toggle group
  _tog(opts, current, onChange) {
    const g = h('div', { className: 'sp-tog' });
    for (const o of opts) {
      const btn = h('button', {
        className: `sp-tog-btn${current === o.v ? ' on' : ''}`,
        title: o.v,
      }, o.l);
      btn.addEventListener('click', () => {
        onChange(o.v);
        g.querySelectorAll('.sp-tog-btn').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
      });
      g.appendChild(btn);
    }
    return g;
  }

  // Compact input with unit
  _inu(prop) {
    const raw = this.getComputedStyle(prop) || '';
    const m = raw.match(/^(-?[\d.]+)(px|rem|%|em|vw|vh)?$/);
    const num = m ? Math.round(parseFloat(m[1])) : raw.replace('px', '');
    const unit = m ? (m[2] || 'px') : 'px';
    const units = ['px', '%', 'auto'];

    const w = h('div', { className: 'sp-inu' });
    const inp = h('input', { className: 'sp-inp', value: raw === 'auto' ? 'auto' : num });
    let cur = raw === 'auto' ? 'auto' : unit;
    const ubtn = h('button', { className: 'sp-unit' }, cur);

    ubtn.addEventListener('click', () => {
      const i = units.indexOf(cur);
      cur = units[(i + 1) % units.length];
      ubtn.textContent = cur;
      if (cur === 'auto') { inp.value = 'auto'; this.setStyle(prop, 'auto'); }
      else { const v = inp.value === 'auto' ? '' : inp.value; inp.value = v; if (v) this.setStyle(prop, v + cur); }
    });
    inp.addEventListener('change', () => {
      if (inp.value === 'auto' || !inp.value) this.setStyle(prop, inp.value || '');
      else this.setStyle(prop, cur === 'auto' ? inp.value : inp.value + cur);
    });
    w.appendChild(inp); w.appendChild(ubtn);
    return w;
  }

  // Color field: swatch + hex with custom popover picker
  _col(prop) {
    const raw = this.getComputedStyle(prop) || '#000';
    const hex = this.rgbToHex(raw);
    const f = h('div', { className: 'sp-col' });
    const sw = h('div', { className: 'sp-sw', style: { backgroundColor: hex } });
    const inp = h('input', { className: 'sp-inp', value: hex });

    const applyColor = (color) => {
      inp.value = color;
      sw.style.backgroundColor = color;
      this.setStyle(prop, color);
    };

    sw.addEventListener('click', () => {
      this._openColorPicker(hex, applyColor, sw);
    });
    inp.addEventListener('change', () => {
      const v = inp.value.startsWith('#') ? inp.value : '#' + inp.value;
      applyColor(v);
    });
    f.appendChild(sw); f.appendChild(inp);
    return f;
  }

  // Custom color picker popover (HSV)
  _openColorPicker(initialHex, onChange, anchor) {
    // Close any existing picker
    document.querySelector('.cp-popover')?.remove();

    // HSV utilities
    const hexToRgb = (hex) => {
      const c = hex.replace('#', '');
      return [parseInt(c.slice(0,2),16), parseInt(c.slice(2,4),16), parseInt(c.slice(4,6),16)];
    };
    const rgbToHex = (r, g, b) => '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join('');
    const rgbToHsv = (r, g, b) => {
      r /= 255; g /= 255; b /= 255;
      const max = Math.max(r,g,b), min = Math.min(r,g,b), d = max - min;
      let hue = 0;
      if (d) {
        if (max === r) hue = ((g - b) / d + 6) % 6;
        else if (max === g) hue = (b - r) / d + 2;
        else hue = (r - g) / d + 4;
        hue *= 60;
      }
      return [hue, max ? d / max : 0, max];
    };
    const hsvToRgb = (h2, s, v) => {
      const c = v * s, x = c * (1 - Math.abs((h2 / 60) % 2 - 1)), m = v - c;
      let r = 0, g = 0, b = 0;
      if (h2 < 60) { r = c; g = x; }
      else if (h2 < 120) { r = x; g = c; }
      else if (h2 < 180) { g = c; b = x; }
      else if (h2 < 240) { g = x; b = c; }
      else if (h2 < 300) { r = x; b = c; }
      else { r = c; b = x; }
      return [Math.round((r+m)*255), Math.round((g+m)*255), Math.round((b+m)*255)];
    };

    const [ir, ig, ib] = hexToRgb(initialHex);
    let [hue, sat, val] = rgbToHsv(ir, ig, ib);

    const updateFromHsv = () => {
      const [r, g, b] = hsvToRgb(hue, sat, val);
      const hex = rgbToHex(r, g, b);
      onChange(hex);
      // Update SV area background
      svArea.style.background = `hsl(${hue}, 100%, 50%)`;
      // Update knob
      svKnob.style.left = `${sat * 100}%`;
      svKnob.style.top = `${(1 - val) * 100}%`;
      svKnob.style.backgroundColor = hex;
      // Update hue thumb indicator
      hueSlider.value = hue;
      // Update hex input
      hexInput.value = hex;
      // Update preview
      preview.style.backgroundColor = hex;
    };

    // Popover
    const pop = h('div', { className: 'cp-popover' });

    // Position below anchor
    const aRect = anchor.getBoundingClientRect();
    pop.style.position = 'fixed';
    pop.style.zIndex = '2500';

    // SV area
    const svArea = h('div', { className: 'cp-sv' });
    svArea.style.background = `hsl(${hue}, 100%, 50%)`;
    const svWhite = h('div', { className: 'cp-sv-white' });
    const svBlack = h('div', { className: 'cp-sv-black' });
    const svKnob = h('div', { className: 'cp-sv-knob' });
    svKnob.style.left = `${sat * 100}%`;
    svKnob.style.top = `${(1 - val) * 100}%`;
    svKnob.style.backgroundColor = initialHex;
    svArea.append(svWhite, svBlack, svKnob);

    // SV drag
    const handleSV = (e) => {
      const r2 = svArea.getBoundingClientRect();
      sat = Math.max(0, Math.min(1, (e.clientX - r2.left) / r2.width));
      val = Math.max(0, Math.min(1, 1 - (e.clientY - r2.top) / r2.height));
      updateFromHsv();
    };
    svArea.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handleSV(e);
      const onMove = (ev) => handleSV(ev);
      const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Hue slider
    const hueRow = h('div', { className: 'cp-slider-row' });
    const hueSlider = h('input', { type: 'range', min: '0', max: '360', step: '1', value: String(Math.round(hue)), className: 'cp-hue-range' });
    hueSlider.addEventListener('input', () => {
      hue = Number(hueSlider.value);
      updateFromHsv();
    });
    hueRow.appendChild(hueSlider);

    // Hex input row + preview
    const inputRow = h('div', { className: 'cp-input-row' });
    const preview = h('div', { className: 'cp-preview' });
    preview.style.backgroundColor = initialHex;
    const hexInput = h('input', { className: 'sp-inp cp-hex-inp', value: initialHex });
    hexInput.addEventListener('change', () => {
      let v = hexInput.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-fA-F]{6}$/.test(v)) {
        const [r, g, b] = hexToRgb(v);
        [hue, sat, val] = rgbToHsv(r, g, b);
        updateFromHsv();
      }
    });

    // Eyedropper button (if API available)
    let eyeBtn = null;
    if (window.EyeDropper) {
      eyeBtn = h('button', { className: 'cp-eye-btn', title: 'Eyedropper' });
      eyeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/><path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9"/><path d="m15 6 6 6"/></svg>';
      eyeBtn.addEventListener('click', async () => {
        try {
          const dropper = new EyeDropper();
          const result = await dropper.open();
          const picked = this.rgbToHex(result.sRGBHex);
          const [r, g, b] = hexToRgb(picked);
          [hue, sat, val] = rgbToHsv(r, g, b);
          updateFromHsv();
        } catch {}
      });
    }
    inputRow.append(preview, hexInput);
    if (eyeBtn) inputRow.appendChild(eyeBtn);

    // Presets
    const presets = ['#000000','#FFFFFF','#FF3B30','#FF9500','#FFCC00','#34C759','#00C7BE','#007AFF','#5856D6','#AF52DE','#FF2D55','#8E8E93'];
    const presetsRow = h('div', { className: 'cp-presets' });
    for (const pc of presets) {
      const btn = h('button', { className: 'cp-preset' });
      btn.style.setProperty('--preset-color', pc);
      btn.addEventListener('click', () => {
        const [r, g, b] = hexToRgb(pc);
        [hue, sat, val] = rgbToHsv(r, g, b);
        updateFromHsv();
      });
      presetsRow.appendChild(btn);
    }

    pop.append(svArea, hueRow, inputRow, presetsRow);
    document.body.appendChild(pop);

    // Position after append so we can measure
    const popRect = pop.getBoundingClientRect();
    let top = aRect.bottom + 6;
    let left = aRect.left;
    // Keep within viewport
    if (top + popRect.height > window.innerHeight) top = aRect.top - popRect.height - 6;
    if (left + popRect.width > window.innerWidth) left = window.innerWidth - popRect.width - 8;
    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;

    // Close on outside click
    const closeHandler = (e) => {
      if (!pop.contains(e.target) && e.target !== anchor) {
        pop.remove();
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    // Delay to avoid immediate close
    setTimeout(() => document.addEventListener('mousedown', closeHandler), 0);

    // Close on Escape
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        pop.remove();
        document.removeEventListener('keydown', escHandler);
        document.removeEventListener('mousedown', closeHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  }

  // Row with label
  _row(label, ...children) {
    const r = h('div', { className: 'sp-row' });
    if (label) r.appendChild(h('span', { className: 'sp-lbl' }, label));
    for (const c of children) r.appendChild(c);
    return r;
  }

  // Pair row (2 fields)
  _pair(l1, c1, l2, c2) {
    const r = h('div', { className: 'sp-pair' });
    const f1 = h('div', { className: 'sp-f' });
    f1.appendChild(h('span', { className: 'sp-lbl-s' }, l1));
    f1.appendChild(c1);
    r.appendChild(f1);
    const f2 = h('div', { className: 'sp-f' });
    f2.appendChild(h('span', { className: 'sp-lbl-s' }, l2));
    f2.appendChild(c2);
    r.appendChild(f2);
    return r;
  }

  // Simple select
  _sel(prop, opts) {
    const cur = this.getComputedStyle(prop) || '';
    const sel = h('select', { className: 'sp-sel' });
    for (const o of opts) {
      const op = h('option', { value: o }, o);
      if (cur === o) op.selected = true;
      sel.appendChild(op);
    }
    sel.addEventListener('change', () => this.setStyle(prop, sel.value));
    return sel;
  }

  // Range slider + value
  _range(prop, min, max, step, unit) {
    const raw = this.getComputedStyle(prop) || '0';
    const num = parseFloat(raw) || 0;
    const w = h('div', { className: 'sp-range' });
    const slider = h('input', { type: 'range', min: String(min), max: String(max), step: String(step || 1), value: String(Math.min(max, Math.max(min, num))) });
    const val = h('span', { className: 'sp-range-val' }, `${Math.round(num)}${unit || ''}`);
    slider.addEventListener('input', () => {
      const v = parseFloat(slider.value);
      val.textContent = `${Math.round(v)}${unit || ''}`;
      this.setStyle(prop, unit ? v + unit : String(v));
    });
    w.appendChild(slider); w.appendChild(val);
    return w;
  }

  // Simple input
  _inp(prop, placeholder) {
    const v = this._fmt(this.getComputedStyle(prop) || '');
    const inp = h('input', { className: 'sp-inp', value: v, placeholder: placeholder || '' });
    inp.addEventListener('change', () => this.setStyle(prop, inp.value));
    return inp;
  }

  // ── LAYOUT ──
  _renderLayout() {
    const { s, b } = this._sec('Layout');
    const d = this.getComputedStyle('display') || 'block';

    b.appendChild(this._tog([
      { l: 'Block', v: 'block' }, { l: 'Flex', v: 'flex' },
      { l: 'Grid', v: 'grid' }, { l: 'None', v: 'none' },
    ], d, v => this.setStyle('display', v)));

    if (d === 'flex' || d === 'inline-flex') {
      const dir = this.getComputedStyle('flexDirection') || 'row';
      b.appendChild(this._tog([
        { l: '\u2192', v: 'row' }, { l: '\u2193', v: 'column' },
        { l: '\u2190', v: 'row-reverse' }, { l: '\u2191', v: 'column-reverse' },
      ], dir, v => this.setStyle('flexDirection', v)));

      b.appendChild(this._pair(
        'J', this._sel('justifyContent', ['flex-start', 'center', 'flex-end', 'space-between', 'space-around', 'space-evenly']),
        'A', this._sel('alignItems', ['stretch', 'flex-start', 'center', 'flex-end', 'baseline'])
      ));

      b.appendChild(this._pair('W', this._sel('flexWrap', ['nowrap', 'wrap', 'wrap-reverse']), 'G', this._range('gap', 0, 64, 1, 'px')));
    }

    return s;
  }

  // ── SPACING (box model) ──
  _renderSpacing() {
    const { s, b } = this._sec('Spacing');
    const viz = h('div', { className: 'box-model-viz' });
    const mbox = h('div', { className: 'box-model-margin-box' });
    mbox.appendChild(h('span', { className: 'box-model-zone-label' }, 'M'));

    for (const [prop, cls] of [['marginTop','val-top'],['marginRight','val-right'],['marginBottom','val-bottom'],['marginLeft','val-left']]) {
      const v = Math.round(parseFloat(this.getComputedStyle(prop)) || 0);
      const inp = h('input', { className: `box-model-val ${cls}`, value: v, title: prop });
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('change', () => this.setStyle(prop, inp.value + 'px'));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      mbox.appendChild(inp);
    }

    const pbox = h('div', { className: 'box-model-padding-box' });
    pbox.appendChild(h('span', { className: 'box-model-zone-label' }, 'P'));

    for (const [prop, cls] of [['paddingTop','val-top'],['paddingRight','val-right'],['paddingBottom','val-bottom'],['paddingLeft','val-left']]) {
      const v = Math.round(parseFloat(this.getComputedStyle(prop)) || 0);
      const inp = h('input', { className: `box-model-val ${cls}`, value: v, title: prop });
      inp.addEventListener('focus', () => inp.select());
      inp.addEventListener('change', () => this.setStyle(prop, inp.value + 'px'));
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') inp.blur(); });
      pbox.appendChild(inp);
    }

    const w = Math.round(parseFloat(this.getComputedStyle('width')) || 0);
    const hh = Math.round(parseFloat(this.getComputedStyle('height')) || 0);
    pbox.appendChild(h('div', { className: 'box-model-content-box' },
      h('span', { className: 'box-model-content-label' }, `${w} \u00D7 ${hh}`)
    ));

    mbox.appendChild(pbox);
    viz.appendChild(mbox);
    b.appendChild(viz);
    return s;
  }

  // ── SIZE ──
  _renderSize() {
    const { s, b } = this._sec('Size');
    b.appendChild(this._pair('W', this._inu('width'), 'H', this._inu('height')));
    b.appendChild(this._pair('mW', this._inu('minWidth'), 'mH', this._inu('minHeight')));
    b.appendChild(this._pair('MW', this._inu('maxWidth'), 'MH', this._inu('maxHeight')));
    return s;
  }

  // ── TYPOGRAPHY ──
  _renderTypo() {
    const { s, b } = this._sec('Type');
    b.appendChild(this._row(null, this._fontPicker()));
    b.appendChild(this._pair('Sz', this._inu('fontSize'), 'Wt', this._sel('fontWeight', ['100','200','300','400','500','600','700','800','900'])));
    b.appendChild(this._pair('Lh', this._inp('lineHeight', '1.5'), 'Ls', this._inp('letterSpacing', '0')));
    b.appendChild(this._row(null, this._col('color')));

    const ta = this.getComputedStyle('textAlign') || 'left';
    b.appendChild(this._tog([
      { l: '\u2261', v: 'left' }, { l: '\u2261', v: 'center' },
      { l: '\u2261', v: 'right' }, { l: '\u2261', v: 'justify' },
    ], ta, v => this.setStyle('textAlign', v)));

    return s;
  }

  // Google Fonts picker
  _fontPicker() {
    const FONTS = {
      'Sans-Serif': ['Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Poppins', 'Nunito', 'Raleway', 'Ubuntu', 'Work Sans', 'DM Sans', 'Rubik', 'Mulish'],
      'Serif': ['Roboto Slab', 'Merriweather', 'Playfair Display', 'Lora', 'PT Serif', 'Libre Baskerville', 'EB Garamond'],
      'Display': ['Bebas Neue', 'Abril Fatface', 'Lobster', 'Righteous'],
      'Mono': ['Roboto Mono', 'Source Code Pro', 'Fira Code', 'JetBrains Mono'],
      'System': ['system-ui', 'Arial', 'Helvetica', 'Georgia', 'inherit'],
    };
    const current = this.getComputedStyle('fontFamily') || 'inherit';
    const currentClean = current.replace(/['"]/g, '').split(',')[0].trim();
    const w = h('div', { className: 'sp-font-picker' });
    const btn = h('button', { className: 'sp-font-btn' }, currentClean);
    btn.style.fontFamily = current;
    w.appendChild(btn);

    btn.addEventListener('click', () => {
      // Create dropdown
      const dd = h('div', { className: 'sp-font-dropdown' });

      for (const [group, fonts] of Object.entries(FONTS)) {
        dd.appendChild(h('div', { className: 'sp-font-group' }, group));
        for (const font of fonts) {
          const isSystem = group === 'System';
          const item = h('div', {
            className: `sp-font-item${font === currentClean ? ' active' : ''}`,
            onClick: () => {
              if (!isSystem) {
                this._loadGoogleFont(font);
                this._installGoogleFontInProject(font);
              }
              this.setStyle('fontFamily', `'${font}', ${this._fontFallback(group)}`);
              dd.remove();
              btn.textContent = font;
              btn.style.fontFamily = `'${font}'`;
            },
          }, font);
          if (!isSystem) item.style.fontFamily = `'${font}', ${this._fontFallback(group)}`;
          // Lazy-load preview for Google Fonts
          if (!isSystem) this._loadGoogleFont(font);
          dd.appendChild(item);
        }
      }

      // Position dropdown
      const rect = btn.getBoundingClientRect();
      dd.style.top = rect.bottom + 'px';
      dd.style.left = rect.left + 'px';
      dd.style.width = rect.width + 'px';
      document.body.appendChild(dd);

      // Close on click outside
      const close = (e) => {
        if (!dd.contains(e.target) && e.target !== btn) {
          dd.remove();
          document.removeEventListener('mousedown', close);
        }
      };
      setTimeout(() => document.addEventListener('mousedown', close), 0);
    });

    return w;
  }

  _fontFallback(group) {
    if (group === 'Serif') return 'serif';
    if (group === 'Mono') return 'monospace';
    return 'sans-serif';
  }

  _loadGoogleFont(fontName) {
    const id = 'gf-' + fontName.replace(/\s+/g, '-').toLowerCase();
    if (document.getElementById(id)) return;
    const link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, '+')}&display=swap`;
    document.head.appendChild(link);

    // Also inject into the iframe for live preview
    try {
      const doc = this.iframe.contentDocument;
      if (doc && !doc.getElementById(id)) {
        const iLink = doc.createElement('link');
        iLink.id = id;
        iLink.rel = 'stylesheet';
        iLink.href = link.href;
        doc.head.appendChild(iLink);
      }
    } catch {}
  }

  // Install Google Font in the user's project
  _installGoogleFontInProject(fontName) {
    if (!this.activePage) return;
    const href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, '+')}&display=swap`;

    if (this.devServer) {
      // Framework project: inject @import into a CSS file instead
      const cssFile = this.files.find(f => f.type === 'css' && (f.name.includes('global') || f.name.includes('index') || f.name.includes('app')))
        || this.files.find(f => f.type === 'css');
      if (cssFile) {
        api.post('/api/writeback/inject-font-css', {
          filePath: cssFile.path,
          fontName,
          href,
        }).catch(() => {});
      }
    } else {
      // Static project: inject <link> into HTML <head>
      api.post('/api/writeback/inject-font', {
        filePath: this.activePage.path,
        href,
        fontName,
      }).catch(() => {});
    }
  }

  // ── FILL (background) ──
  _renderFill() {
    const { s, b } = this._sec('Fill');
    b.appendChild(this._row(null, this._col('backgroundColor')));
    return s;
  }

  // ── BORDER ──
  _renderBorder() {
    const { s, b } = this._sec('Border');
    b.appendChild(this._pair('W', this._inp('borderWidth', '0'), 'R', this._range('borderRadius', 0, 48, 1, 'px')));
    b.appendChild(this._pair('S', this._sel('borderStyle', ['none', 'solid', 'dashed', 'dotted']), null, this._col('borderColor')));
    return s;
  }

  // ── POSITION ──
  _renderPosition() {
    const { s, b } = this._sec('Position');
    b.appendChild(this._row(null, this._sel('position', ['static', 'relative', 'absolute', 'fixed', 'sticky'])));
    b.appendChild(this._pair('T', this._inp('top', 'auto'), 'R', this._inp('right', 'auto')));
    b.appendChild(this._pair('B', this._inp('bottom', 'auto'), 'L', this._inp('left', 'auto')));
    b.appendChild(this._pair('Z', this._inp('zIndex', 'auto'), 'Op', this._range('opacity', 0, 1, 0.01, '')));
    b.appendChild(this._row(null, this._sel('overflow', ['visible', 'hidden', 'scroll', 'auto'])));
    return s;

    return section;
  }

  renderBottombar() {
    this.breadcrumb = h('div', { className: 'breadcrumb' });
    this.gitBranch = h('div', { className: 'git-branch' });

    return h('div', { className: 'bottombar' },
      this.breadcrumb,
      this.gitBranch,
    );
  }

  // Load routes from the server and populate the dropdown
  async _loadRoutes() {
    try {
      const { routes } = await api.get(`/api/devserver/routes?dir=${encodeURIComponent(this.projectPath)}`);

      // Always clear the "loading" placeholder
      this._routeSelect.innerHTML = '';

      if (!routes || routes.length === 0) {
        // No routes found — just show /
        const opt = document.createElement('option');
        opt.value = '/';
        opt.textContent = '/';
        this._routeSelect.appendChild(opt);
        return;
      }

      // Group routes by their group property
      const groups = {};
      const ungrouped = [];
      for (const r of routes) {
        if (r.group) {
          (groups[r.group] = groups[r.group] || []).push(r);
        } else {
          ungrouped.push(r);
        }
      }

      const addOption = (r, parent) => {
        const opt = document.createElement('option');
        opt.value = r.raw;
        const label = r.isDynamic ? `${r.path}` : r.path;
        opt.textContent = label;
        if (r.isDynamic) opt.disabled = true;
        parent.appendChild(opt);
      };

      // Ungrouped first
      for (const r of ungrouped) addOption(r, this._routeSelect);

      // Then each group as optgroup
      for (const [name, groupRoutes] of Object.entries(groups)) {
        const optgroup = document.createElement('optgroup');
        optgroup.label = name;
        for (const r of groupRoutes) addOption(r, optgroup);
        this._routeSelect.appendChild(optgroup);
      }

      // Select "/" if available
      this._routeSelect.value = '/';
    } catch (err) {
      console.warn('Failed to load routes:', err);
    }
  }

  // Navigate framework preview to a specific path
  _navigateDevPreview(path) {
    if (!path.startsWith('/')) path = '/' + path;
    this._devPath = path;
    if (this._urlInput) this._urlInput.value = path;
    if (this._routeSelect) this._routeSelect.value = path;

    const setAndLoad = () => {
      this.iframe.src = `${api.baseUrl}/devpreview` + path;
      this.iframe.onload = () => this.setupCanvasInteraction();
    };

    if (!this._devProxyReady) {
      this._devProxyReady = true;
      fetch(`${api.baseUrl}/devpreview/set?port=${this.devServer.port}`)
        .then(setAndLoad);
    } else {
      setAndLoad();
    }
  }

  // Canvas & iframe
  loadPage(page) {
    this.activePage = page;

    if (this.devServer) {
      this._navigateDevPreview(this._devPath || '/');
    } else {
      // Static project: serve from /preview/
      const previewUrl = `${api.baseUrl}/preview/${page.relativePath}?project=${encodeURIComponent(this.projectPath)}`;
      this.iframe.src = previewUrl;
      this.iframe.onload = () => this.setupCanvasInteraction();
    }
    this.updatePagesList();
  }

  updatePagesList() {
    const items = this.el.querySelectorAll('.page-item');
    items.forEach((item, i) => {
      const isActive = this.htmlFiles[i] === this.activePage;
      item.className = `page-item${isActive ? ' active' : ''}`;
    });
  }

  setupCanvasInteraction() {
    const doc = this.iframe.contentDocument;
    if (!doc) return;

    // Size iframe container to match breakpoint
    this.updateCanvasSize();

    // Hover
    doc.addEventListener('mousemove', (e) => {
      const target = e.target;
      if (target === doc.body || target === doc.documentElement) {
        this.clearHover();
        return;
      }
      this.showHover(target);
    });

    // Click to select
    doc.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const target = e.target;
      if (target !== doc.body && target !== doc.documentElement) {
        this.selectElement(target);
      }
    });

    // Double-click for text editing
    doc.addEventListener('dblclick', (e) => {
      e.preventDefault();
      const target = e.target;
      if (target.childNodes.length === 1 && target.childNodes[0].nodeType === 3) {
        this.startTextEdit(target);
      }
    });

    // Build layers
    this.buildLayersTree(doc.body);
  }

  // Selection
  showHover(element) {
    // Don't touch overlay during resize drag
    if (this._resizing) return;

    // Remove only hover elements, keep selection
    this.overlay.querySelectorAll('.hover-outline, .hover-label').forEach(el => el.remove());

    const rect = this.getRelativeRect(element);
    if (!rect) return;

    const outline = h('div', { className: 'hover-outline' });
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;

    const tag = element.tagName.toLowerCase();
    const cls = element.className && typeof element.className === 'string'
      ? `.${element.className.split(' ').filter(Boolean).join('.')}`
      : '';
    const label = h('div', { className: 'hover-label' }, `${tag}${cls}`);
    label.style.left = `${rect.left}px`;
    label.style.top = `${rect.top}px`;

    this.overlay.appendChild(outline);
    this.overlay.appendChild(label);
  }

  clearHover() {
    if (this._resizing) return;
    this.overlay.querySelectorAll('.hover-outline, .hover-label').forEach(el => el.remove());
  }

  selectElement(element) {
    this.selectedElement = element;
    this.showSelection();
    this.updateBreadcrumb(element);
    this.refreshRightPanel();
    this.highlightLayer(element);
    this.updateChatContext();
  }

  showSelection() {
    this.overlay.innerHTML = '';
    if (!this.selectedElement) return;

    const rect = this.getRelativeRect(this.selectedElement);
    if (!rect) return;

    const outline = h('div', { className: 'selection-outline' });
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.width}px`;
    outline.style.height = `${rect.height}px`;
    this.overlay.appendChild(outline);

    // Resize handles
    const positions = [
      { x: -5, y: -5, cursor: 'nw-resize' },
      { x: rect.width / 2 - 5, y: -5, cursor: 'n-resize' },
      { x: rect.width - 5, y: -5, cursor: 'ne-resize' },
      { x: rect.width - 5, y: rect.height / 2 - 5, cursor: 'e-resize' },
      { x: rect.width - 5, y: rect.height - 5, cursor: 'se-resize' },
      { x: rect.width / 2 - 5, y: rect.height - 5, cursor: 's-resize' },
      { x: -5, y: rect.height - 5, cursor: 'sw-resize' },
      { x: -5, y: rect.height / 2 - 5, cursor: 'w-resize' },
    ];

    for (const pos of positions) {
      const handle = h('div', { className: 'resize-handle' });
      handle.style.left = `${rect.left + pos.x}px`;
      handle.style.top = `${rect.top + pos.y}px`;
      handle.style.cursor = pos.cursor;

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();

        this._resizing = true;
        const direction = pos.cursor.replace('-resize', '');
        const startX = e.clientX;
        const startY = e.clientY;
        const startRect = this.selectedElement.getBoundingClientRect();
        const startLeft = parseFloat(this.selectedElement.style.left) || 0;
        const startTop = parseFloat(this.selectedElement.style.top) || 0;
        const startWidth = startRect.width;
        const startHeight = startRect.height;

        // Invisible shield over the whole viewport to capture mouse events
        // even when cursor moves over the iframe
        const shield = h('div', {});
        Object.assign(shield.style, {
          position: 'fixed', inset: '0', zIndex: '9999',
          cursor: pos.cursor,
        });
        document.body.appendChild(shield);

        const onMouseMove = (ev) => {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;

          let newWidth = startWidth;
          let newHeight = startHeight;
          let newLeft = startLeft;
          let newTop = startTop;

          if (direction.includes('e')) newWidth = Math.max(10, startWidth + dx);
          if (direction.includes('w')) { newWidth = Math.max(10, startWidth - dx); newLeft = startLeft + dx; }
          if (direction.includes('s')) newHeight = Math.max(10, startHeight + dy);
          if (direction.includes('n')) { newHeight = Math.max(10, startHeight - dy); newTop = startTop + dy; }

          this.selectedElement.style.width = `${newWidth}px`;
          this.selectedElement.style.height = `${newHeight}px`;
          if (direction.includes('w')) this.selectedElement.style.left = `${newLeft}px`;
          if (direction.includes('n')) this.selectedElement.style.top = `${newTop}px`;

          // Update selection outline AND resize handles dynamically
          const newRect = this.getRelativeRect(this.selectedElement);
          if (newRect) {
            const outline = this.overlay.querySelector('.selection-outline');
            if (outline) {
              outline.style.left = `${newRect.left}px`;
              outline.style.top = `${newRect.top}px`;
              outline.style.width = `${newRect.width}px`;
              outline.style.height = `${newRect.height}px`;
            }
            // Reposition all resize handles
            const handlePositions = [
              { x: -5, y: -5 },
              { x: newRect.width / 2 - 5, y: -5 },
              { x: newRect.width - 5, y: -5 },
              { x: newRect.width - 5, y: newRect.height / 2 - 5 },
              { x: newRect.width - 5, y: newRect.height - 5 },
              { x: newRect.width / 2 - 5, y: newRect.height - 5 },
              { x: -5, y: newRect.height - 5 },
              { x: -5, y: newRect.height / 2 - 5 },
            ];
            const handles = this.overlay.querySelectorAll('.resize-handle');
            handles.forEach((hdl, i) => {
              if (handlePositions[i]) {
                hdl.style.left = `${newRect.left + handlePositions[i].x}px`;
                hdl.style.top = `${newRect.top + handlePositions[i].y}px`;
              }
            });
          }
        };

        const onMouseUp = () => {
          shield.remove();
          document.removeEventListener('mousemove', onMouseMove);
          document.removeEventListener('mouseup', onMouseUp);
          this._resizing = false;

          // Persist changed properties
          this.writebackStyle('width', this.selectedElement.style.width);
          this.writebackStyle('height', this.selectedElement.style.height);
          if (direction.includes('w')) this.writebackStyle('left', this.selectedElement.style.left);
          if (direction.includes('n')) this.writebackStyle('top', this.selectedElement.style.top);

          // Redraw selection with updated handle positions
          this.showSelection();
          this.refreshRightPanel();
        };

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
      });

      this.overlay.appendChild(handle);
    }
  }

  getRelativeRect(element) {
    try {
      const iframeRect = this.iframe.getBoundingClientRect();
      const elemRect = element.getBoundingClientRect();
      const containerRect = this.canvasWrapper.getBoundingClientRect();

      return {
        left: iframeRect.left - containerRect.left + elemRect.left,
        top: iframeRect.top - containerRect.top + elemRect.top,
        width: elemRect.width,
        height: elemRect.height,
      };
    } catch {
      return null;
    }
  }

  updateBreadcrumb(element) {
    this.breadcrumb.innerHTML = '';
    const path = [];
    let el = element;
    while (el && el !== el.ownerDocument.documentElement) {
      const tag = el.tagName.toLowerCase();
      const cls = el.className && typeof el.className === 'string'
        ? `.${el.className.split(' ').filter(Boolean)[0] || ''}`
        : '';
      path.unshift({ tag: `${tag}${cls}`, el });
      el = el.parentElement;
    }

    path.forEach((item, i) => {
      if (i > 0) {
        this.breadcrumb.appendChild(h('span', { className: 'breadcrumb-separator' }, '\u203A'));
      }
      this.breadcrumb.appendChild(
        h('span', {
          className: 'breadcrumb-item',
          onClick: () => this.selectElement(item.el),
        }, item.tag)
      );
    });
  }

  // Convert rgb/rgba/named colors to hex for color input
  rgbToHex(color) {
    if (!color) return '#000000';
    // Already hex
    if (color.startsWith('#')) {
      if (color.length === 4) {
        return '#' + color[1]+color[1] + color[2]+color[2] + color[3]+color[3];
      }
      return color.slice(0, 7);
    }
    // Parse rgb(r, g, b) or rgba(r, g, b, a)
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (match) {
      const r = parseInt(match[1]).toString(16).padStart(2, '0');
      const g = parseInt(match[2]).toString(16).padStart(2, '0');
      const b = parseInt(match[3]).toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
    return '#000000';
  }

  // Styles
  getComputedStyle(prop) {
    if (!this.selectedElement) return '';
    try {
      const doc = this.iframe.contentDocument;
      const computed = doc.defaultView.getComputedStyle(this.selectedElement);
      return computed[prop] || '';
    } catch {
      return '';
    }
  }

  setStyle(prop, value) {
    if (!this.selectedElement) return;
    const oldValue = this.selectedElement.style[prop];
    this.selectedElement.style[prop] = value;
    this.showSelection();

    this.pushUndo({
      undo: () => { this.selectedElement.style[prop] = oldValue; this.writebackStyle(prop, oldValue); },
      redo: () => { this.selectedElement.style[prop] = value; this.writebackStyle(prop, value); },
    });

    this.writebackStyle(prop, value);
  }

  refreshRightPanel() {
    const parent = this.panelRight.parentElement;
    const newPanel = this.renderRightPanel();
    parent.replaceChild(newPanel, this.panelRight);
    this.panelRight = newPanel;
  }

  // Layers tree
  buildLayersTree(rootElement) {
    this.layersTree.innerHTML = '';
    this.buildLayerItems(rootElement, 0);
  }

  buildLayerItems(element, depth) {
    if (element.nodeType !== 1) return;
    const tag = element.tagName.toLowerCase();

    // Skip script, style, link, meta, etc.
    if (['script', 'style', 'link', 'meta', 'head', 'noscript'].includes(tag)) return;

    const indent = h('span', { className: 'layer-indent' });
    indent.style.width = `${depth * 16}px`;

    const hasChildren = Array.from(element.children).some(
      c => !['script', 'style', 'link', 'meta'].includes(c.tagName.toLowerCase())
    );

    const toggle = h('span', { className: 'layer-toggle' }, hasChildren ? '\u25BE' : '');

    const cls = element.className && typeof element.className === 'string'
      ? element.className.split(' ').filter(Boolean)[0]
      : '';

    const item = h('div', {
      className: 'layer-item',
      onClick: () => this.selectElement(element),
    },
      indent,
      toggle,
      h('span', { className: 'layer-tag' }, tag),
      cls ? h('span', { className: 'layer-class' }, `.${cls}`) : document.createTextNode('')
    );

    this.layersTree.appendChild(item);

    for (const child of element.children) {
      this.buildLayerItems(child, depth + 1);
    }
  }

  highlightLayer(element) {
    const items = this.layersTree.querySelectorAll('.layer-item');
    items.forEach(item => item.classList.remove('selected'));
    // Simple approach: find by matching tag
    // TODO: better matching
  }

  // Text editing
  startTextEdit(element) {
    element.contentEditable = true;
    element.focus();
    element.style.outline = 'none';

    const finish = () => {
      element.contentEditable = false;
      element.removeEventListener('blur', finish);
      element.removeEventListener('keydown', onKey);
      // TODO: write back to HTML file
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        finish();
      }
    };

    element.addEventListener('blur', finish);
    element.addEventListener('keydown', onKey);
  }

  // Breakpoints
  setBreakpoint(bp) {
    this.breakpoint = bp;
    this.updateCanvasSize();
    // Re-render topbar to update active state
    const topbar = this.el.querySelector('.topbar');
    topbar.replaceWith(this.renderTopbar());
  }

  updateCanvasSize() {
    const widths = { desktop: '100%', tablet: '768px', mobile: '375px' };
    this.iframeContainer.style.width = widths[this.breakpoint];
    this.iframeContainer.style.height = '100%';
  }

  // Splitter
  setupSplitter(splitter) {
    let startY, startHeight;

    const onMouseMove = (e) => {
      const delta = startY - e.clientY;
      const newHeight = Math.max(48, Math.min(600, startHeight + delta));
      this.chatHeight = newHeight;
      this.chatPanel.style.height = `${newHeight}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    splitter.addEventListener('mousedown', (e) => {
      startY = e.clientY;
      startHeight = this.chatHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  }

  // Chat with AI
  async sendChatMessage(text) {
    if (!text) return;

    // Clear welcome screen on first message
    const welcome = this.chatMessages.querySelector('.chat-welcome');
    if (welcome) welcome.remove();

    // Add user message
    const userMsg = h('div', { className: 'chat-message chat-message-user' }, text);
    this.chatMessages.appendChild(userMsg);
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;

    // Build context
    const context = {
      currentFile: this.activePage?.relativePath,
      fileContents: {},
    };

    if (this.selectedElement) {
      context.selectedElement = {
        tag: this.selectedElement.tagName?.toLowerCase(),
        classes: this.selectedElement.className || '',
        id: this.selectedElement.id || '',
        html: this.selectedElement.outerHTML?.slice(0, 2000),
      };
    }

    // Load current file contents for context
    for (const file of this.files.filter(f => f.type === 'html' || f.type === 'css')) {
      try {
        const data = await api.get(`/api/files/read?path=${encodeURIComponent(file.path)}`);
        context.fileContents[file.relativePath] = data.content;
      } catch {}
    }

    // Loading indicator — Claude style
    const loading = h('div', { className: 'chat-message chat-message-ai chat-loading' });
    loading.innerHTML = '<div class="chat-loader"><div class="chat-loader-dot"></div></div><span>Thinking...</span>';
    this.chatMessages.appendChild(loading);

    try {
      const result = await api.post('/api/ai/chat', {
        prompt: text,
        context,
        projectPath: this.projectPath,
      });

      loading.remove();

      const aiMsg = h('div', { className: 'chat-message chat-message-ai' }, result.response);

      if (result.changes && result.changes.length > 0) {
        const actions = h('div', { className: 'chat-actions' },
          h('button', {
            className: 'chat-btn-accept',
            onClick: () => this.applyAIChanges(result.changes, actions),
          }, 'Accept'),
          h('button', {
            className: 'chat-btn-reject',
            onClick: () => actions.remove(),
          }, 'Reject'),
        );
        aiMsg.appendChild(actions);
      }

      this.chatMessages.appendChild(aiMsg);
    } catch (err) {
      loading.remove();
      this.chatMessages.appendChild(
        h('div', { className: 'chat-message chat-message-ai' }, `Error: ${err.message}`)
      );
    }

    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  async applyAIChanges(changes, actionsEl) {
    for (const change of changes) {
      const filePath = `${this.projectPath}/${change.file}`;
      try {
        const { content } = await api.get(`/api/files/read?path=${encodeURIComponent(filePath)}`);
        let newContent = content;

        if (change.action === 'replace') {
          newContent = content.replace(change.search, change.replace);
        } else if (change.action === 'insert' && change.after) {
          const idx = content.indexOf(change.after);
          if (idx !== -1) {
            newContent = content.slice(0, idx + change.after.length) + '\n' + change.content + content.slice(idx + change.after.length);
          }
        }

        await api.post('/api/files/write', { path: filePath, content: newContent });
      } catch (err) {
        console.error('Failed to apply change:', err);
      }
    }
    actionsEl.remove();
    // Canvas will auto-refresh via file watcher
  }

  // Writeback — save style change to CSS file (debounced, error-protected)
  writebackStyle(prop, value) {
    if (!this.selectedElement || !this.activePage) return;

    // Debounce: batch rapid changes (e.g. dragging a slider)
    const key = prop;
    if (this._writebackTimers?.[key]) clearTimeout(this._writebackTimers[key]);
    if (!this._writebackTimers) this._writebackTimers = {};

    this._writebackTimers[key] = setTimeout(() => {
      this._doWriteback(prop, value);
      delete this._writebackTimers[key];
    }, 150);
  }

  async _doWriteback(prop, value) {
    if (!this.selectedElement || !this.activePage) return;

    // Stop retrying if CSS file is broken
    if (this._writebackBroken) return;

    const element = this.selectedElement;
    const classes = (element.className || '').split(/\s+/).filter(Boolean);
    const tag = element.tagName.toLowerCase();

    const selector = classes.length > 0 ? `.${classes[0]}` : tag;

    const cssFile = this.files.find(f => f.type === 'css');
    if (!cssFile) return;

    const cssProp = prop.replace(/([A-Z])/g, '-$1').toLowerCase();

    let mediaQuery = null;
    if (this.breakpoint === 'tablet') mediaQuery = '(max-width: 768px)';
    if (this.breakpoint === 'mobile') mediaQuery = '(max-width: 375px)';

    try {
      await api.post('/api/writeback/css', {
        filePath: cssFile.path,
        selector,
        prop: cssProp,
        value,
        mediaQuery,
      });
      // Reset error state on success
      this._writebackBroken = false;
    } catch (err) {
      console.error('Writeback failed:', err);
      // If CSS file is corrupt, stop spamming the server
      if (err.message?.includes('parse error') || err.message?.includes('Unexpected')) {
        this._writebackBroken = true;
        console.warn('CSS file appears corrupt — writeback paused. Fix the CSS file to resume.');
      }
    }
  }

  // Undo/Redo
  undo() {
    if (this.undoStack.length === 0) return;
    const action = this.undoStack.pop();
    this.redoStack.push(action);
    if (action.undo) action.undo();
  }

  redo() {
    if (this.redoStack.length === 0) return;
    const action = this.redoStack.pop();
    this.undoStack.push(action);
    if (action.redo) action.redo();
  }

  pushUndo(action) {
    this.undoStack.push(action);
    this.redoStack = [];
  }

  // ── Add element panel ──
  toggleAddPanel() {
    if (this._addPanel) {
      this._addPanel.remove();
      this._addPanel = null;
      this._toolAdd.classList.remove('active');
      return;
    }
    this._toolAdd.classList.add('active');

    const panel = h('div', { className: 'add-panel' });

    const ELEMENTS = [
      { group: 'Layout', items: [
        { tag: 'div', label: 'Div', desc: 'Container', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 2"/></svg>' },
        { tag: 'section', label: 'Section', desc: 'Page section', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="3" width="14" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/></svg>' },
        { tag: 'nav', label: 'Nav', desc: 'Navigation', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="4" width="14" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M4 8h2M7 8h2M10 8h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>' },
        { tag: 'header', label: 'Header', desc: 'Page header', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="1" y="9" width="14" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2" opacity="0.3"/></svg>' },
        { tag: 'footer', label: 'Footer', desc: 'Page footer', icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2" opacity="0.3"/><rect x="1" y="9" width="14" height="5" rx="1.5" stroke="currentColor" stroke-width="1.2"/></svg>' },
      ]},
      { group: 'Text', items: [
        { tag: 'h1', label: 'Heading 1', desc: 'Large title', text: 'Heading' },
        { tag: 'h2', label: 'Heading 2', desc: 'Section title', text: 'Heading' },
        { tag: 'h3', label: 'Heading 3', desc: 'Subtitle', text: 'Heading' },
        { tag: 'p', label: 'Paragraph', desc: 'Body text', text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.' },
        { tag: 'span', label: 'Span', desc: 'Inline text', text: 'Text' },
        { tag: 'a', label: 'Link', desc: 'Hyperlink', text: 'Link text', attrs: { href: '#' } },
      ]},
      { group: 'Interactive', items: [
        { tag: 'button', label: 'Button', desc: 'Click action', text: 'Button' },
        { tag: 'input', label: 'Input', desc: 'Text field', attrs: { type: 'text', placeholder: 'Enter text...' }, selfClosing: true },
        { tag: 'textarea', label: 'Textarea', desc: 'Multi-line', attrs: { placeholder: 'Enter text...', rows: '3' } },
        { tag: 'select', label: 'Select', desc: 'Dropdown', children: [{ tag: 'option', text: 'Option 1' }, { tag: 'option', text: 'Option 2' }] },
      ]},
      { group: 'Media', items: [
        { tag: 'img', label: 'Image', desc: 'Picture', attrs: { src: '', alt: 'Image' }, selfClosing: true, icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="6.5" r="1.5" fill="currentColor"/><path d="M1.5 11l3.5-3 2.5 2 3-4 4 5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>' },
        { tag: 'video', label: 'Video', desc: 'Video player', attrs: { controls: true }, icon: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M6 5.5l5 2.5-5 2.5z" fill="currentColor"/></svg>' },
      ]},
      { group: 'List', items: [
        { tag: 'ul', label: 'Unordered List', desc: 'Bullet list', children: [{ tag: 'li', text: 'Item 1' }, { tag: 'li', text: 'Item 2' }, { tag: 'li', text: 'Item 3' }] },
        { tag: 'ol', label: 'Ordered List', desc: 'Numbered list', children: [{ tag: 'li', text: 'Item 1' }, { tag: 'li', text: 'Item 2' }, { tag: 'li', text: 'Item 3' }] },
      ]},
    ];

    for (const group of ELEMENTS) {
      panel.appendChild(h('div', { className: 'add-group-title' }, group.group));
      const grid = h('div', { className: 'add-grid' });

      for (const item of group.items) {
        const el = h('div', {
          className: 'add-item',
          draggable: true,
          onClick: () => this._addElement(item),
        });

        const iconWrap = h('div', { className: 'add-item-icon' });
        if (item.icon) {
          iconWrap.innerHTML = item.icon;
        } else {
          iconWrap.textContent = `<${item.tag}>`;
          iconWrap.style.fontSize = '9px';
          iconWrap.style.fontFamily = 'monospace';
        }
        el.appendChild(iconWrap);
        el.appendChild(h('div', { className: 'add-item-label' }, item.label));

        // Drag support
        el.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/plain', JSON.stringify(item));
          e.dataTransfer.effectAllowed = 'copy';
        });

        grid.appendChild(el);
      }
      panel.appendChild(grid);
    }

    // Position under tool button
    const toolRect = this._toolAdd.getBoundingClientRect();
    panel.style.top = (toolRect.bottom + 4) + 'px';
    panel.style.left = toolRect.left + 'px';
    document.body.appendChild(panel);
    this._addPanel = panel;

    // Close on click outside
    const close = (e) => {
      if (!panel.contains(e.target) && e.target !== this._toolAdd && !this._toolAdd.contains(e.target)) {
        panel.remove();
        this._addPanel = null;
        this._toolAdd.classList.remove('active');
        document.removeEventListener('mousedown', close);
      }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  _addElement(item) {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;

    const el = doc.createElement(item.tag);

    // Set text content
    if (item.text) el.textContent = item.text;

    // Set attributes
    if (item.attrs) {
      for (const [k, v] of Object.entries(item.attrs)) {
        if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, v);
      }
    }

    // Add children
    if (item.children) {
      for (const child of item.children) {
        const c = doc.createElement(child.tag);
        if (child.text) c.textContent = child.text;
        el.appendChild(c);
      }
    }

    // Insert: inside selected element, or append to body
    const parent = this.selectedElement || doc.body;
    parent.appendChild(el);

    // Select the new element
    this.selectElement(el);

    // Close panel
    if (this._addPanel) {
      this._addPanel.remove();
      this._addPanel = null;
      this._toolAdd.classList.remove('active');
    }
  }

  // Media panel
  toggleMediaPanel() {
    if (this._mediaPanel) {
      this._mediaPanel.el.remove();
      this._mediaPanel = null;
      return;
    }

    this._mediaPanel = new MediaPanel({
      projectPath: this.projectPath,
      onInsert: (relativePath, type) => this._insertMedia(relativePath, type),
      onClose: () => {
        if (this._mediaPanel) {
          this._mediaPanel.el.remove();
          this._mediaPanel = null;
        }
      },
    });

    // Add as overlay in the canvas area
    const canvasWrap = this.el.querySelector('.canvas-wrapper');
    if (canvasWrap) canvasWrap.appendChild(this._mediaPanel.el);
  }

  // Tool mode switching
  _setTool(mode) {
    this._currentTool = mode;

    // Update button states
    this._toolSelect.classList.toggle('active', mode === 'select');
    this._toolMarquee.classList.toggle('active', mode === 'marquee');

    if (mode === 'marquee') {
      this.toggleAIMarquee();
    } else {
      // Deactivate marquee if switching away
      if (this._marqueeActive) {
        this._marqueeActive = false;
        const overlay = this.el.querySelector('.canvas-overlay');
        if (overlay) overlay.style.cursor = '';
      }
    }
  }

  // Smart media insertion with contextual options
  _insertMedia(relativePath, type) {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;

    const sel = this.selectedElement;
    const isImage = type === 'image';
    const isVideo = type === 'video';

    // Case 1: Selected <img> → replace its src
    if (sel && sel.tagName === 'IMG' && isImage) {
      sel.src = relativePath;
      this.writebackAttribute(sel, 'src', relativePath);
      return;
    }

    // Case 2: Selected <video> → replace its src
    if (sel && (sel.tagName === 'VIDEO' || sel.tagName === 'SOURCE') && isVideo) {
      const target = sel.tagName === 'SOURCE' ? sel : sel;
      target.src = relativePath;
      this.writebackAttribute(target, 'src', relativePath);
      return;
    }

    // Case 3: Selected element → show choice popup
    if (sel) {
      this._showMediaInsertMenu(relativePath, type, sel, doc);
      return;
    }

    // Case 4: No selection → append to body
    const el = this._createMediaElement(doc, relativePath, type);
    doc.body.appendChild(el);
    this.selectElement(el);
  }

  _showMediaInsertMenu(relativePath, type, sel, doc) {
    // Remove existing menu
    if (this._mediaMenu) this._mediaMenu.remove();

    const isImage = type === 'image';
    const overlay = this.el.querySelector('.canvas-overlay');
    const rect = overlay?.getBoundingClientRect();
    if (!rect) return;

    const menu = h('div', { className: 'media-insert-menu' });

    const options = [];

    if (isImage) {
      options.push({ label: 'Set as background', action: () => {
        this.setStyle('backgroundImage', `url('${relativePath}')`);
        this.setStyle('backgroundSize', 'cover');
        this.setStyle('backgroundPosition', 'center');
      }});
      options.push({ label: 'Insert inside element', action: () => {
        const el = this._createMediaElement(doc, relativePath, type);
        sel.appendChild(el);
        this.selectElement(el);
      }});
      options.push({ label: 'Insert after element', action: () => {
        const el = this._createMediaElement(doc, relativePath, type);
        sel.parentNode.insertBefore(el, sel.nextSibling);
        this.selectElement(el);
      }});
      if (sel.tagName === 'IMG') {
        options.unshift({ label: 'Replace image', action: () => {
          sel.src = relativePath;
        }});
      }
    } else {
      options.push({ label: 'Insert inside element', action: () => {
        const el = this._createMediaElement(doc, relativePath, type);
        sel.appendChild(el);
        this.selectElement(el);
      }});
      options.push({ label: 'Insert after element', action: () => {
        const el = this._createMediaElement(doc, relativePath, type);
        sel.parentNode.insertBefore(el, sel.nextSibling);
        this.selectElement(el);
      }});
    }

    for (const opt of options) {
      menu.appendChild(h('button', {
        className: 'media-insert-option',
        onClick: () => { opt.action(); menu.remove(); this._mediaMenu = null; },
      }, opt.label));
    }

    // Position near selection
    const elRect = sel.getBoundingClientRect();
    const iframeRect = this.iframe.getBoundingClientRect();
    menu.style.top = (iframeRect.top - rect.top + elRect.bottom + 4) + 'px';
    menu.style.left = (iframeRect.left - rect.left + elRect.left) + 'px';

    overlay.appendChild(menu);
    this._mediaMenu = menu;

    // Close on click outside
    const close = (e) => {
      if (!menu.contains(e.target)) { menu.remove(); this._mediaMenu = null; document.removeEventListener('mousedown', close); }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  _createMediaElement(doc, relativePath, type) {
    if (type === 'video') {
      const el = doc.createElement('video');
      el.src = relativePath;
      el.controls = true;
      el.style.maxWidth = '100%';
      return el;
    }
    const el = doc.createElement('img');
    el.src = relativePath;
    el.style.maxWidth = '100%';
    return el;
  }

  // Stub for attribute writeback (HTML attribute changes)
  writebackAttribute(el, attr, value) {
    // For now, attribute changes are only live — full writeback needs HTML source mapping
  }

  // ── AI Marquee: draw a rectangle on the page to select a zone for AI ──
  toggleAIMarquee() {
    if (this._marqueeActive) {
      this._marqueeActive = false;
      if (this._marqueeOverlay) { this._marqueeOverlay.remove(); this._marqueeOverlay = null; }
      return;
    }

    this._marqueeActive = true;
    const overlay = this.el.querySelector('.canvas-overlay');
    if (!overlay) return;

    overlay.style.cursor = 'crosshair';
    let startX, startY, rect;

    const onDown = (e) => {
      startX = e.offsetX;
      startY = e.offsetY;
      rect = h('div', { className: 'ai-marquee' });
      rect.style.left = startX + 'px';
      rect.style.top = startY + 'px';
      rect.style.width = '0';
      rect.style.height = '0';
      overlay.appendChild(rect);
    };

    const onMove = (e) => {
      if (!rect) return;
      const x = Math.min(e.offsetX, startX);
      const y = Math.min(e.offsetY, startY);
      const w = Math.abs(e.offsetX - startX);
      const hh = Math.abs(e.offsetY - startY);
      rect.style.left = x + 'px';
      rect.style.top = y + 'px';
      rect.style.width = w + 'px';
      rect.style.height = hh + 'px';
    };

    const onUp = (e) => {
      overlay.removeEventListener('mousedown', onDown);
      overlay.removeEventListener('mousemove', onMove);
      overlay.removeEventListener('mouseup', onUp);
      overlay.style.cursor = '';
      this._marqueeActive = false;

      if (!rect) return;

      const marqueeRect = rect.getBoundingClientRect();
      const iframeRect = this.iframe.getBoundingClientRect();

      // Find all elements inside the marquee zone
      const doc = this.iframe.contentDocument;
      if (!doc) { rect.remove(); return; }

      const zoneX = marqueeRect.left - iframeRect.left;
      const zoneY = marqueeRect.top - iframeRect.top;
      const zoneW = marqueeRect.width;
      const zoneH = marqueeRect.height;

      // Collect elements that overlap with the marquee
      const elements = [];
      const all = doc.body.querySelectorAll('*');
      for (const el of all) {
        const r = el.getBoundingClientRect();
        if (r.right > zoneX && r.left < zoneX + zoneW &&
            r.bottom > zoneY && r.top < zoneY + zoneH &&
            el.children.length === 0) {
          elements.push(el);
        }
      }

      // Find the common parent
      let target = null;
      if (elements.length > 0) {
        target = elements[0];
        for (let i = 1; i < elements.length; i++) {
          target = this._commonAncestor(target, elements[i]);
        }
      }

      // Show AI prompt for this zone
      this._showAIZonePrompt(rect, target, elements);
    };

    overlay.addEventListener('mousedown', onDown);
    overlay.addEventListener('mousemove', onMove);
    overlay.addEventListener('mouseup', onUp);
  }

  _commonAncestor(a, b) {
    const parents = new Set();
    let node = a;
    while (node) { parents.add(node); node = node.parentElement; }
    node = b;
    while (node) { if (parents.has(node)) return node; node = node.parentElement; }
    return a.ownerDocument.body;
  }

  _showAIZonePrompt(marqueeDiv, target, elements) {
    // Create inline prompt attached to the marquee
    const prompt = h('div', { className: 'ai-zone-prompt' });

    const info = target
      ? `${target.tagName.toLowerCase()}${target.className ? '.' + target.className.split(' ')[0] : ''} (${elements.length} elements)`
      : 'Empty zone';

    prompt.appendChild(h('div', { className: 'ai-zone-info' }, info));

    const input = h('textarea', {
      className: 'ai-zone-input',
      placeholder: 'Describe what to change in this zone...',
      rows: '2',
    });
    prompt.appendChild(input);

    const btns = h('div', { className: 'ai-zone-btns' });
    btns.appendChild(h('button', {
      className: 'ai-zone-btn cancel',
      onClick: () => { marqueeDiv.remove(); prompt.remove(); },
    }, 'Cancel'));
    btns.appendChild(h('button', {
      className: 'ai-zone-btn send',
      onClick: () => {
        const text = input.value.trim();
        if (!text) return;

        // Build a context-rich prompt with the zone info
        const zoneHTML = target ? target.outerHTML.slice(0, 3000) : '';
        const aiPrompt = `[Zone selection: ${info}]\n\nUser request: ${text}\n\nSelected HTML:\n${zoneHTML}`;

        marqueeDiv.remove();
        prompt.remove();

        // Send to AI chat
        this.chatInput.value = '';
        this.sendChatMessage(aiPrompt);
      },
    }, 'Send to AI'));
    prompt.appendChild(btns);

    // Position below marquee
    const mRect = marqueeDiv.getBoundingClientRect();
    const overlay = marqueeDiv.parentElement;
    const oRect = overlay.getBoundingClientRect();
    prompt.style.position = 'absolute';
    prompt.style.top = (mRect.bottom - oRect.top + 4) + 'px';
    prompt.style.left = (mRect.left - oRect.left) + 'px';
    prompt.style.width = Math.max(mRect.width, 280) + 'px';

    overlay.appendChild(prompt);
    input.focus();

    // Allow Enter to send
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        btns.querySelector('.send').click();
      }
      if (e.key === 'Escape') {
        marqueeDiv.remove();
        prompt.remove();
      }
    });
  }

  // Preview mode
  togglePreview() {
    const left = this.el.querySelector('.panel-left');
    const right = this.el.querySelector('.panel-right');
    const topbar = this.el.querySelector('.topbar');
    const bottombar = this.el.querySelector('.bottombar');
    const chat = this.chatPanel;

    this._previewMode = !this._previewMode;

    const display = this._previewMode ? 'none' : '';
    left.style.display = display;
    right.style.display = display;
    chat.style.display = display;
    bottombar.style.display = this._previewMode ? 'none' : 'flex';

    if (this._previewMode) {
      this.el.style.gridTemplateColumns = '0 1fr 0';
    } else {
      this.el.style.gridTemplateColumns = `var(--panel-w) 1fr var(--panel-right-w)`;
    }
  }

  // Show changes (git diff)
  async showChanges() {
    try {
      const diff = await api.get(`/api/git/diff?dir=${encodeURIComponent(this.projectPath)}`);
      const status = await api.get(`/api/git/status?dir=${encodeURIComponent(this.projectPath)}`);

      const overlay = h('div', {
        style: {
          position: 'fixed', inset: '0', zIndex: '8000',
          background: 'rgba(0,0,0,0.5)', display: 'flex',
          justifyContent: 'center', alignItems: 'center',
        },
        onClick: (e) => { if (e.target === overlay) overlay.remove(); },
      });

      const modal = h('div', {
        style: {
          background: 'var(--bg-panel)', border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md)', width: '640px', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        },
      });

      // Header
      modal.appendChild(h('div', {
        style: {
          padding: '12px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        },
      },
        h('span', { style: { fontWeight: '500', fontSize: '14px' } }, 'Changes'),
        h('button', { onClick: () => overlay.remove(), style: { color: 'var(--text-tertiary)' } }, '\u2715')
      ));

      // Diff content
      const diffContent = h('pre', {
        style: {
          padding: '12px 16px', overflow: 'auto', flex: '1',
          fontSize: '12px', fontFamily: "'SF Mono', 'Fira Code', monospace",
          lineHeight: '1.5', color: 'var(--text-secondary)', whiteSpace: 'pre-wrap',
        },
      }, diff.diff || 'No changes');
      modal.appendChild(diffContent);

      // Commit section
      const commitInput = h('input', {
        className: 'style-input',
        placeholder: 'Commit message...',
        style: { margin: '0', borderRadius: '0' },
      });

      const commitSection = h('div', {
        style: {
          padding: '12px 16px', borderTop: '1px solid var(--border)',
          display: 'flex', gap: '8px', alignItems: 'center',
        },
      },
        commitInput,
        h('button', {
          style: {
            background: 'var(--accent)', color: '#fff', padding: '6px 16px',
            borderRadius: 'var(--radius-sm)', fontSize: '12px', fontWeight: '500',
          },
          onClick: async () => {
            const msg = commitInput.value.trim();
            if (!msg) return;
            await api.post('/api/git/commit', { dir: this.projectPath, message: msg });
            overlay.remove();
          },
        }, 'Commit')
      );
      modal.appendChild(commitSection);

      overlay.appendChild(modal);
      document.body.appendChild(overlay);
    } catch (err) {
      console.error('Git error:', err);
    }
  }

  // Git branch
  async loadGitBranch() {
    try {
      const data = await api.get(`/api/git/branch?dir=${encodeURIComponent(this.projectPath)}`);
      this.gitBranch.textContent = data.current || '';
    } catch {
      this.gitBranch.textContent = '';
    }
  }

  // Auto-update listener (Tauri only)
  async listenForUpdates() {
    if (!window.__TAURI__) return;
    try {
      const { listen } = await import('@tauri-apps/api/event');
      listen('update-available', (event) => {
        const { version } = event.payload;
        this.showUpdateBanner(version);
      });
    } catch {
      // Not in Tauri or plugin not available.
    }
  }

  showUpdateBanner(version) {
    // Insert a subtle banner in the topbar-right area
    const topbarRight = this.el.querySelector('.topbar-right');
    if (!topbarRight || topbarRight.querySelector('.update-btn')) return;

    const btn = h('button', {
      className: 'update-btn',
      onClick: async () => {
        btn.textContent = 'Installing...';
        btn.disabled = true;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('install_update');
        } catch (err) {
          btn.textContent = `Update v${version}`;
          btn.disabled = false;
        }
      },
    }, `Update v${version}`);

    topbarRight.prepend(h('div', { className: 'topbar-separator' }));
    topbarRight.prepend(btn);
  }

  // Shortcuts
  setupShortcuts() {
    this.shortcuts = new ShortcutManager();

    this.shortcuts.register('cmd+z', () => this.undo(), 'Undo');
    this.shortcuts.register('cmd+shift+z', () => this.redo(), 'Redo');
    this.shortcuts.register('cmd+d', () => this.duplicateSelected(), 'Duplicate element');
    this.shortcuts.register('delete', () => this.deleteSelected(), 'Delete element');
    this.shortcuts.register('backspace', () => this.deleteSelected(), 'Delete element');
    this.shortcuts.register('escape', () => this.deselectAll(), 'Deselect');
    this.shortcuts.register('cmd+k', () => this.commandPalette?.open(), 'Command palette');
    this.shortcuts.register('cmd+i', () => this.chatInput?.focus(), 'Focus AI chat');

    // Tool shortcuts (single keys, only when not typing)
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'v' || e.key === 'V') { e.preventDefault(); this._setTool('select'); }
      if (e.key === 'a' || e.key === 'A') { e.preventDefault(); this.toggleAddPanel(); }
      if (e.key === 'm' || e.key === 'M') { e.preventDefault(); this._setTool('marquee'); }
      if (e.key === 'i' || e.key === 'I') { e.preventDefault(); this.toggleMediaPanel(); }
    });
  }

  // Command palette
  setupCommandPalette() {
    this.commandPalette = new CommandPalette();
    document.body.appendChild(this.commandPalette.el);

    const items = [
      { id: 'undo', label: 'Undo', shortcut: 'cmd+z', section: 'Edit', action: () => this.undo() },
      { id: 'redo', label: 'Redo', shortcut: 'cmd+shift+z', section: 'Edit', action: () => this.redo() },
      { id: 'delete', label: 'Delete element', shortcut: 'delete', section: 'Edit', action: () => this.deleteSelected() },
      { id: 'duplicate', label: 'Duplicate element', shortcut: 'cmd+d', section: 'Edit', action: () => this.duplicateSelected() },
      { id: 'preview', label: 'Toggle preview', section: 'View', action: () => this.togglePreview() },
      { id: 'changes', label: 'View changes', section: 'Git', action: () => this.showChanges() },
      { id: 'chat', label: 'Focus AI chat', shortcut: 'cmd+i', section: 'AI', action: () => this.chatInput?.focus() },
    ];

    // Add pages
    for (const page of this.htmlFiles) {
      items.push({
        id: `page-${page.name}`,
        label: `Open ${page.name}`,
        section: 'Pages',
        action: () => this.loadPage(page),
      });
    }

    this.commandPalette.setItems(items);
  }

  // Element actions
  duplicateSelected() {
    if (!this.selectedElement) return;
    const clone = this.selectedElement.cloneNode(true);
    this.selectedElement.parentNode.insertBefore(clone, this.selectedElement.nextSibling);
    this.selectElement(clone);
    // TODO: writeback to HTML
  }

  deleteSelected() {
    if (!this.selectedElement) return;
    const parent = this.selectedElement.parentNode;
    const el = this.selectedElement;
    this.pushUndo({
      undo: () => { parent.appendChild(el); },
      redo: () => { el.remove(); },
    });
    el.remove();
    this.selectedElement = null;
    this.overlay.innerHTML = '';
    this.refreshRightPanel();
    // TODO: writeback to HTML
  }

  deselectAll() {
    this.selectedElement = null;
    this.overlay.innerHTML = '';
    this.refreshRightPanel();
    this.breadcrumb.innerHTML = '';
  }

  // WebSocket for file watching
  connectWebSocket() {
    const connect = () => {
      const wsHost = api.baseUrl ? new URL(api.baseUrl).host : location.host;
      const ws = new WebSocket(`ws://${wsHost}`);
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'watch', path: this.projectPath }));
      };
      let reloadTimer = null;
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'file-changed') {
          // Debounce reload — multiple file changes (HMR, build output) can fire rapidly
          if (reloadTimer) clearTimeout(reloadTimer);
          reloadTimer = setTimeout(() => {
            reloadTimer = null;
            // For framework projects, skip reload if the dev server has its own HMR
            if (this.devServer) return;
            this.iframe.contentWindow?.location.reload();
          }, 400);
        }
      };
      ws.onclose = () => {
        // Reconnect after a short delay
        setTimeout(connect, 2000);
      };
    };
    connect();
  }
}
