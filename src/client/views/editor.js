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
    this._currentTool = 'select';

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

    // Tool mode buttons
    this._toolNavigate = h('button', {
      className: 'tool-btn',
      onClick: () => this._setTool('navigate'),
      title: 'Navigate mode (N)',
    });
    this._toolNavigate.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 3C4 2.4 4.4 2 5 2h6c.6 0 1 .4 1 1v10c0 .6-.4 1-1 1H5c-.6 0-1-.4-1-1V3z" stroke="currentColor" stroke-width="1.2" fill="none"/><path d="M6 5h4M6 7.5h4" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/><path d="M8 10l-1.5 2h3L8 10z" fill="currentColor" opacity="0.6"/></svg>';

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
          this._toolNavigate,
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

      // Right: undo/redo + code/preview + changes
      h('div', { className: 'topbar-right' },
        h('button', { className: 'topbar-btn', onClick: () => this.undo() }, '\u21A9'),
        h('button', { className: 'topbar-btn', onClick: () => this.redo() }, '\u21AA'),
        h('div', { className: 'topbar-separator' }),
        (() => {
          this._codeToggleBtn = h('button', {
            className: 'topbar-btn',
            onClick: () => this.toggleCodeMode(),
            title: 'Toggle code editor',
          });
          this._codeToggleBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M5.5 4L2 8l3.5 4M10.5 4L14 8l-3.5 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          return this._codeToggleBtn;
        })(),
        h('button', { className: 'topbar-btn', onClick: () => this.togglePreview() }, '\u25B6'),
        (() => {
          const btn = h('button', {
            className: 'topbar-btn topbar-btn--git',
            onClick: () => this.showGitPanel(),
            title: 'Git',
          });
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" fill="currentColor"/></svg><span>Commit</span>';
          return btn;
        })(),
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
    // Framework projects load cross-origin (direct dev server port) —
    // no sandbox needed, the cross-origin boundary provides isolation.
    // Static projects use sandbox for safety since they're same-origin.
    this.iframe = this.devServer
      ? h('iframe', {})
      : h('iframe', { sandbox: 'allow-same-origin allow-scripts' });
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

      // Block redirects toggle
      this._blockRedirects = false;
      const redirectBtn = h('button', {
        className: 'canvas-urlbar__btn',
        title: 'Block redirects (useful when the app auto-redirects away from the page you want to edit)',
        onClick: () => {
          this._blockRedirects = !this._blockRedirects;
          redirectBtn.classList.toggle('active', this._blockRedirects);
          fetch(`${api.baseUrl}/devpreview/block-redirects?enabled=${this._blockRedirects}`);
          if (this._blockRedirects) this._navigateDevPreview(this._devPath);
        },
      });
      redirectBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M2 2l12 12M8 1a7 7 0 100 14A7 7 0 008 1z" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';

      urlBar.append(this._routeSelect, this._urlInput, redirectBtn, urlRefresh);
      this.canvasWrapper.appendChild(urlBar);

      // Fetch routes in background
      this._loadRoutes();
    }

    this.canvasWrapper.appendChild(this.iframeContainer);
    this.canvasWrapper.appendChild(this.overlay);
    center.appendChild(this.canvasWrapper);

    // Code editor (hidden by default)
    this.codeEditorWrapper = h('div', { className: 'code-editor-wrapper' });
    this.codeEditorWrapper.style.display = 'none';

    this._codeTabBar = h('div', { className: 'code-tabs' });
    this._codeOpenTabs = []; // { path, name, modified }

    this.codeTextarea = h('textarea', {
      className: 'code-textarea',
      spellcheck: 'false',
      placeholder: 'Select a file to view its source...',
    });
    this.codeTextarea.addEventListener('input', () => {
      this._codeModified = true;
      this._updateCodeTab();
    });
    this.codeTextarea.addEventListener('keydown', (e) => {
      // Tab inserts 2 spaces
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = this.codeTextarea.selectionStart;
        const end = this.codeTextarea.selectionEnd;
        this.codeTextarea.value = this.codeTextarea.value.substring(0, start) + '  ' + this.codeTextarea.value.substring(end);
        this.codeTextarea.selectionStart = this.codeTextarea.selectionEnd = start + 2;
        this._codeModified = true;
        this._updateCodeTab();
      }
      // Cmd/Ctrl+S to save
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        this._saveCurrentCodeFile();
      }
    });

    this.codeEditorWrapper.appendChild(this._codeTabBar);
    this.codeEditorWrapper.appendChild(this.codeTextarea);
    center.appendChild(this.codeEditorWrapper);

    // Splitter
    const splitter = h('div', { className: 'splitter-h' });
    this.setupSplitter(splitter, center);
    center.appendChild(splitter);

    // Bottom panel (tabs: Chat | Terminal)
    this.bottomPanel = h('div', { className: 'bottom-panel' });
    this.bottomPanel.style.height = `${this.chatHeight}px`;

    // Tab bar
    this._bottomTabBar = h('div', { className: 'bottom-tabs' });
    this._bottomActiveTab = 'chat';

    const chatTabBtn = h('button', {
      className: 'bottom-tab active',
      onClick: () => this._switchBottomTab('chat'),
    }, 'Chat');
    const termTabBtn = h('button', {
      className: 'bottom-tab',
      onClick: () => this._switchBottomTab('terminal'),
    }, 'Terminal');
    this._bottomTabBtns = { chat: chatTabBtn, terminal: termTabBtn };
    this._bottomTabBar.append(chatTabBtn, termTabBtn);
    this.bottomPanel.appendChild(this._bottomTabBar);

    // Chat panel
    this.chatPanel = this.renderChatPanel();
    this.bottomPanel.appendChild(this.chatPanel);

    // Terminal panel
    this.terminalPanel = this.renderTerminalPanel();
    this.terminalPanel.style.display = 'none';
    this.bottomPanel.appendChild(this.terminalPanel);

    center.appendChild(this.bottomPanel);

    return center;
  }

  renderChatPanel() {
    const panel = h('div', { className: 'chat-panel' });

    // Claude logo SVG (from Bootstrap Icons)
    this._claudeLogoSvg = (size = 24) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="#E87443"><path d="m3.127 10.604 3.135-1.76.053-.153-.053-.085H6.11l-.525-.032-1.791-.048-1.554-.065-1.505-.08-.38-.081L0 7.832l.036-.234.32-.214.455.04 1.009.069 1.513.105 1.097.064 1.626.17h.259l.036-.105-.089-.065-.068-.064-1.566-1.062-1.695-1.121-.887-.646-.48-.327-.243-.306-.104-.67.435-.48.585.04.15.04.593.456 1.267.981 1.654 1.218.242.202.097-.068.012-.049-.109-.181-.9-1.626-.96-1.655-.428-.686-.113-.411a2 2 0 0 1-.068-.484l.496-.674L4.446 0l.662.089.279.242.411.94.666 1.48 1.033 2.014.302.597.162.553.06.17h.105v-.097l.085-1.134.157-1.392.154-1.792.052-.504.25-.605.497-.327.387.186.319.456-.045.294-.19 1.23-.37 1.93-.243 1.29h.142l.161-.16.654-.868 1.097-1.372.484-.545.565-.601.363-.287h.686l.505.751-.226.775-.707.895-.585.759-.839 1.13-.524.904.048.072.125-.012 1.897-.403 1.024-.186 1.223-.21.553.258.06.263-.218.536-1.307.323-1.533.307-2.284.54-.028.02.032.04 1.029.098.44.024h1.077l2.005.15.525.346.315.424-.053.323-.807.411-3.631-.863-.872-.218h-.12v.073l.726.71 1.331 1.202 1.667 1.55.084.383-.214.302-.226-.032-1.464-1.101-.565-.497-1.28-1.077h-.084v.113l.295.432 1.557 2.34.08.718-.112.234-.404.141-.444-.08-.911-1.28-.94-1.44-.759-1.291-.093.053-.448 4.821-.21.246-.484.186-.403-.307-.214-.496.214-.98.258-1.28.21-1.016.19-1.263.112-.42-.008-.028-.092.012-.953 1.307-1.448 1.957-1.146 1.227-.274.109-.477-.247.045-.44.266-.39 1.586-2.018.956-1.25.617-.723-.004-.105h-.036l-4.212 2.736-.75.096-.324-.302.04-.496.154-.162 1.267-.871"/></svg>`;

    // Auth state container — shown when not connected
    this.chatAuthScreen = h('div', { className: 'chat-auth-screen' });
    this._renderAuthScreen();
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
      // 1. Check SDK setup status first
      const setup = await api.get('/api/ai/setup/status');
      if (setup.ready) {
        this.setChatConnected('Claude Code');
        return;
      }
      if (setup.sdkAvailable) {
        this.setChatConnected('Claude Code');
        return;
      }

      // 2. Try to restore key from Tauri Stronghold
      if (window.__TAURI__) {
        try {
          const storedKey = await window.__TAURI__.core.invoke('get_token', { provider: 'anthropic' });
          if (storedKey) {
            const result = await api.post('/api/ai/key', { key: storedKey });
            if (result.valid) {
              this.setChatConnected('Claude');
              return;
            }
          }
        } catch {}
      }

      // 3. Check server-side providers (raw API key already set as env var)
      const status = await api.get('/api/ai/providers');
      const claudeApi = status.providers?.find(p => p.id === 'claude-api');
      if (claudeApi?.available) {
        this.setChatConnected('Claude');
        return;
      }

      // 4. Show appropriate auth screen based on setup state
      this._renderAuthScreen(setup);
    } catch {
      // Server might not be ready yet, stay on auth screen
    }
  }

  // Terminal panel
  renderTerminalPanel() {
    const panel = h('div', { className: 'terminal-panel' });

    // xterm.js container
    this._termContainer = h('div', { className: 'term-xterm-wrap' });
    panel.appendChild(this._termContainer);

    return panel;
  }

  _initXterm() {
    if (this._xterm) return;

    const Terminal = window.Terminal;
    const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;
    const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;

    if (!Terminal) return; // xterm.js not loaded

    this._xterm = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 12,
      fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'Monaco', monospace",
      lineHeight: 1.3,
      scrollback: 5000,
      theme: {
        background: '#1a1a1a',
        foreground: '#cccccc',
        cursor: '#cccccc',
        cursorAccent: '#1a1a1a',
        selectionBackground: 'rgba(255, 255, 255, 0.15)',
        black: '#1a1a1a',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#60a5fa',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#cccccc',
        brightBlack: '#666666',
        brightRed: '#fca5a5',
        brightGreen: '#86efac',
        brightYellow: '#fde68a',
        brightBlue: '#93c5fd',
        brightMagenta: '#d8b4fe',
        brightCyan: '#67e8f9',
        brightWhite: '#ffffff',
      },
    });

    this._fitAddon = FitAddon ? new FitAddon() : null;
    if (this._fitAddon) this._xterm.loadAddon(this._fitAddon);
    if (WebLinksAddon) this._xterm.loadAddon(new WebLinksAddon());

    this._xterm.open(this._termContainer);
    if (this._fitAddon) this._fitAddon.fit();

    // Send input to server
    this._xterm.onData((data) => {
      if (this.ws?.readyState === 1) {
        this.ws.send(JSON.stringify({ type: 'terminal-input', data }));
      }
    });

    // Resize handling
    this._termResizeObs = new ResizeObserver(() => {
      if (this._fitAddon && this.terminalPanel.style.display !== 'none') {
        try {
          this._fitAddon.fit();
          if (this.ws?.readyState === 1 && this._xterm) {
            this.ws.send(JSON.stringify({
              type: 'terminal-resize',
              cols: this._xterm.cols,
              rows: this._xterm.rows,
            }));
          }
        } catch {}
      }
    });
    this._termResizeObs.observe(this._termContainer);
  }

  _termWrite(text) {
    if (this._xterm) {
      this._xterm.write(text);
    }
  }

  _termSendInput(data) {
    if (this.ws?.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'terminal-input', data }));
    }
  }

  _startTerminal() {
    if (this._termStarted) return;
    this._termStarted = true;

    this._initXterm();

    if (this.ws?.readyState === 1) {
      const cols = this._xterm?.cols || 80;
      const rows = this._xterm?.rows || 24;
      this.ws.send(JSON.stringify({
        type: 'terminal-start',
        cwd: this.projectPath,
        cols,
        rows,
      }));
    }
  }

  _switchBottomTab(tab) {
    this._bottomActiveTab = tab;
    this.chatPanel.style.display = tab === 'chat' ? '' : 'none';
    this.terminalPanel.style.display = tab === 'terminal' ? '' : 'none';

    Object.entries(this._bottomTabBtns).forEach(([id, btn]) => {
      btn.classList.toggle('active', id === tab);
    });

    if (tab === 'terminal') {
      this._startTerminal();
      // Refit after display change
      requestAnimationFrame(() => {
        if (this._fitAddon) this._fitAddon.fit();
        this._xterm?.focus();
      });
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

  _renderAuthScreen(setup) {
    this.chatAuthScreen.innerHTML = '';

    // If CLI not installed → show install flow
    if (!setup || !setup.cliInstalled) {
      this.chatAuthScreen.innerHTML = `
        <div class="chat-auth-logo">${this._claudeLogoSvg(32)}</div>
        <div class="chat-auth-title">Claude Code</div>
        <div class="chat-auth-subtitle">Install Claude Code to use AI editing</div>
        <div class="chat-auth-steps">
          <div class="chat-auth-step">
            <span class="chat-auth-step-num">1</span>
            <span>Click install to set up Claude Code CLI</span>
          </div>
          <div class="chat-auth-step">
            <span class="chat-auth-step-num">2</span>
            <span>Sign in with your Anthropic account</span>
          </div>
          <div class="chat-auth-step">
            <span class="chat-auth-step-num">3</span>
            <span>Start editing with AI</span>
          </div>
        </div>
        <button class="chat-auth-btn chat-setup-install-btn">Install Claude Code</button>
        <div class="chat-auth-error"></div>
        <div class="chat-auth-divider"><span>or</span></div>
        <div class="chat-auth-subtitle" style="font-size: 11px; opacity: .6">Use an API key instead</div>
        <div class="chat-auth-input-row">
          <input type="password" class="chat-auth-input" placeholder="sk-ant-..." spellcheck="false" autocomplete="off" />
          <button class="chat-auth-btn chat-auth-key-btn">Connect</button>
        </div>
      `;
      this.chatAuthScreen.querySelector('.chat-setup-install-btn').addEventListener('click', () => this._installClaudeCode());
      const keyBtn = this.chatAuthScreen.querySelector('.chat-auth-key-btn');
      const keyInput = this.chatAuthScreen.querySelector('.chat-auth-input');
      keyBtn.addEventListener('click', () => this._submitApiKey());
      keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._submitApiKey(); });
      return;
    }

    // CLI installed but not authenticated → show auth flow
    if (!setup.authenticated) {
      this.chatAuthScreen.innerHTML = `
        <div class="chat-auth-logo">${this._claudeLogoSvg(32)}</div>
        <div class="chat-auth-title">Claude Code</div>
        <div class="chat-auth-subtitle">Sign in to your Anthropic account</div>
        <div class="chat-auth-steps">
          <div class="chat-auth-step">
            <span class="chat-auth-step-num chat-auth-step-done">&#10003;</span>
            <span>Claude Code installed</span>
          </div>
          <div class="chat-auth-step">
            <span class="chat-auth-step-num">2</span>
            <span>Click below to sign in</span>
          </div>
        </div>
        <button class="chat-auth-btn chat-setup-auth-btn">Sign in with Anthropic</button>
        <div class="chat-auth-error"></div>
      `;
      this.chatAuthScreen.querySelector('.chat-setup-auth-btn').addEventListener('click', () => this._authClaude());
      return;
    }

    // Fallback: API key screen
    this.chatAuthScreen.innerHTML = `
      <div class="chat-auth-logo">${this._claudeLogoSvg(32)}</div>
      <div class="chat-auth-title">Claude</div>
      <div class="chat-auth-subtitle">Connect your API key to start editing with AI</div>
      <div class="chat-auth-input-row">
        <input type="password" class="chat-auth-input" placeholder="sk-ant-..." spellcheck="false" autocomplete="off" />
        <button class="chat-auth-btn">Connect</button>
      </div>
      <div class="chat-auth-error"></div>
    `;
    this.chatAuthScreen.querySelector('.chat-auth-btn').addEventListener('click', () => this._submitApiKey());
    this.chatAuthScreen.querySelector('.chat-auth-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._submitApiKey();
    });
  }

  async _installClaudeCode() {
    const btn = this.chatAuthScreen.querySelector('.chat-setup-install-btn');
    const errorEl = this.chatAuthScreen.querySelector('.chat-auth-error');
    btn.disabled = true;
    btn.style.display = 'none';
    errorEl.textContent = '';

    // Insert progress bar after the button
    const progressWrap = document.createElement('div');
    progressWrap.className = 'chat-install-progress';
    progressWrap.innerHTML = `
      <div class="chat-install-progress-bar"><div class="chat-install-progress-fill"></div></div>
      <div class="chat-install-progress-info">
        <span class="chat-install-progress-stage">Starting...</span>
        <span class="chat-install-progress-pct">0%</span>
      </div>
    `;
    btn.parentNode.insertBefore(progressWrap, btn.nextSibling);

    const fill = progressWrap.querySelector('.chat-install-progress-fill');
    const stage = progressWrap.querySelector('.chat-install-progress-stage');
    const pct = progressWrap.querySelector('.chat-install-progress-pct');

    try {
      const es = new EventSource('/api/ai/setup/install');
      es.onmessage = async (e) => {
        const data = JSON.parse(e.data);
        fill.style.width = `${data.progress}%`;
        stage.textContent = data.stage || 'Installing...';
        pct.textContent = `${data.progress}%`;

        if (data.success === true) {
          es.close();
          const setup = await api.get('/api/ai/setup/status');
          if (setup.sdkAvailable || setup.ready) {
            this.setChatConnected('Claude Code');
          } else {
            this._renderAuthScreen(setup);
          }
        } else if (data.success === false) {
          es.close();
          progressWrap.remove();
          errorEl.textContent = data.error || 'Installation failed';
          btn.style.display = '';
          btn.disabled = false;
          btn.textContent = 'Install Claude Code';
        }
      };
      es.onerror = () => {
        es.close();
        progressWrap.remove();
        errorEl.textContent = 'Installation failed — try again';
        btn.style.display = '';
        btn.disabled = false;
        btn.textContent = 'Install Claude Code';
      };
    } catch (err) {
      progressWrap.remove();
      errorEl.textContent = 'Installation failed — try again';
      btn.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Install Claude Code';
    }
  }

  async _authClaude() {
    const btn = this.chatAuthScreen.querySelector('.chat-setup-auth-btn');
    const errorEl = this.chatAuthScreen.querySelector('.chat-auth-error');
    btn.disabled = true;
    btn.textContent = 'Opening browser...';
    errorEl.textContent = '';

    try {
      const result = await api.post('/api/ai/setup/auth', {});
      if (result.success && result.browserOpened) {
        // Browser was opened by the CLI directly
        btn.textContent = 'Waiting for sign in...';
        errorEl.textContent = '';
        this._pollAuthStatus();
      } else if (result.sdkAvailable) {
        this.setChatConnected('Claude Code');
      } else {
        errorEl.textContent = result.error || 'Could not start authentication';
        btn.disabled = false;
        btn.textContent = 'Sign in with Anthropic';
      }
    } catch (err) {
      errorEl.textContent = 'Authentication failed — try again';
      btn.disabled = false;
      btn.textContent = 'Sign in with Anthropic';
    }
  }

  async _pollAuthStatus() {
    // Poll every 3s for up to 2 minutes
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      try {
        const setup = await api.get('/api/ai/setup/status');
        if (setup.authenticated || setup.ready) {
          this.setChatConnected('Claude Code');
          return;
        }
      } catch {}
    }
    const errorEl = this.chatAuthScreen.querySelector('.chat-auth-error');
    if (errorEl) errorEl.textContent = 'Sign in timed out — try again';
    const btn = this.chatAuthScreen.querySelector('.chat-setup-auth-btn');
    if (btn) { btn.disabled = false; btn.textContent = 'Sign in with Anthropic'; }
  }

  async _submitApiKey() {
    const input = this.chatAuthScreen.querySelector('.chat-auth-input');
    const btn = input?.parentElement?.querySelector('.chat-auth-btn, .chat-auth-key-btn');
    const errorEl = this.chatAuthScreen.querySelector('.chat-auth-error');
    const key = input?.value?.trim();

    if (!key) {
      if (errorEl) errorEl.textContent = 'Please enter your API key';
      return;
    }
    if (!key.startsWith('sk-ant-')) {
      if (errorEl) errorEl.textContent = 'API key should start with sk-ant-...';
      return;
    }

    if (errorEl) errorEl.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Verifying...'; }

    try {
      const result = await api.post('/api/ai/key', { key });
      if (result.valid) {
        if (window.__TAURI__) {
          try {
            await window.__TAURI__.core.invoke('store_token', { provider: 'anthropic', token: key });
          } catch {}
        }
        this.setChatConnected('Claude');
      } else {
        if (errorEl) errorEl.textContent = result.error || 'Invalid API key';
        if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
      }
    } catch (err) {
      if (errorEl) errorEl.textContent = 'Connection error — try again';
      if (btn) { btn.disabled = false; btn.textContent = 'Connect'; }
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
    this.gitBranch = h('div', { className: 'git-branch', onClick: () => this.showGitPanel() });

    // Panel toggle buttons (VS Code style)
    const panelToggles = h('div', { className: 'bottombar-toggles' });

    this._toggleLeftBtn = h('button', {
      className: 'bottombar-toggle active',
      title: 'Toggle left panel (Cmd+B)',
      onClick: () => this._togglePanel('left'),
    });
    this._toggleLeftBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" stroke-width="1.2"/></svg>';

    this._toggleBottomBtn = h('button', {
      className: 'bottombar-toggle active',
      title: 'Toggle bottom panel (Cmd+J)',
      onClick: () => this._togglePanel('bottom'),
    });
    this._toggleBottomBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="1" y1="9.5" x2="15" y2="9.5" stroke="currentColor" stroke-width="1.2"/></svg>';

    this._toggleRightBtn = h('button', {
      className: 'bottombar-toggle active',
      title: 'Toggle right panel',
      onClick: () => this._togglePanel('right'),
    });
    this._toggleRightBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="1" y="2" width="14" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="10.5" y1="2" x2="10.5" y2="14" stroke="currentColor" stroke-width="1.2"/></svg>';

    panelToggles.append(this._toggleLeftBtn, this._toggleBottomBtn, this._toggleRightBtn);

    return h('div', { className: 'bottombar' },
      this.breadcrumb,
      h('div', { style: { flex: '1' } }),
      this.gitBranch,
      panelToggles,
    );
  }

  _togglePanel(panel) {
    if (panel === 'left') {
      const el = this.el.querySelector('.panel-left');
      this._leftHidden = !this._leftHidden;
      el.style.display = this._leftHidden ? 'none' : '';
      this._toggleLeftBtn.classList.toggle('active', !this._leftHidden);
      this._updateGridColumns();
    }
    if (panel === 'right') {
      const el = this.el.querySelector('.panel-right');
      this._rightHidden = !this._rightHidden;
      el.style.display = this._rightHidden ? 'none' : '';
      this._toggleRightBtn.classList.toggle('active', !this._rightHidden);
      this._updateGridColumns();
    }
    if (panel === 'bottom') {
      this._bottomHidden = !this._bottomHidden;
      this.bottomPanel.style.display = this._bottomHidden ? 'none' : '';
      this.el.querySelector('.splitter-h').style.display = this._bottomHidden ? 'none' : '';
      this._toggleBottomBtn.classList.toggle('active', !this._bottomHidden);
    }
  }

  _updateGridColumns() {
    const left = this._leftHidden ? '0' : 'var(--panel-w)';
    const right = (this._rightHidden || this._codeMode) ? '0' : 'var(--panel-right-w)';
    this.el.style.gridTemplateColumns = `${left} 1fr ${right}`;
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

      // Always add "/" first at the top level if it exists (regardless of group)
      const rootRoute = routes.find(r => r.path === '/');
      if (rootRoute) {
        addOption(rootRoute, this._routeSelect);
      }

      // Ungrouped (skip "/" since already added)
      for (const r of ungrouped) {
        if (r.path === '/') continue;
        addOption(r, this._routeSelect);
      }

      // Then each group as optgroup (skip "/" since already added at top)
      for (const [name, groupRoutes] of Object.entries(groups)) {
        const filtered = groupRoutes.filter(r => r.path !== '/');
        if (filtered.length === 0) continue;
        const optgroup = document.createElement('optgroup');
        optgroup.label = name;
        for (const r of filtered) addOption(r, optgroup);
        this._routeSelect.appendChild(optgroup);
      }

      // Select "/" if available, ensuring _devPath is also set
      this._routeSelect.value = '/';
      if (rootRoute) this._devPath = '/';
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

    // Load through WebIA server (same-origin) so iframe.contentDocument
    // is accessible for editor interactions (hover, select, edit).
    // The catch-all proxy forwards to the dev server while keeping
    // the real path, so client-side routing works correctly.
    const setAndLoad = () => {
      this.iframe.src = api.baseUrl + path;
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
    // Always size the canvas, even for cross-origin iframes
    this.updateCanvasSize();

    const doc = this.iframe.contentDocument;
    if (!doc) return;

    // Hover (editor modes only)
    doc.addEventListener('mousemove', (e) => {
      if (this._currentTool === 'navigate') return;
      const target = e.target;
      if (target === doc.body || target === doc.documentElement) {
        this.clearHover();
        return;
      }
      this.showHover(target);
    });

    // Click to select (editor modes) or navigate freely
    doc.addEventListener('click', (e) => {
      if (this._currentTool === 'navigate') {
        // Let clicks through — but track iframe navigation
        this._onIframeNavigate();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const target = e.target;
      if (target !== doc.body && target !== doc.documentElement) {
        this.selectElement(target);
      }
    });

    // Double-click for text editing (editor modes only)
    doc.addEventListener('dblclick', (e) => {
      if (this._currentTool === 'navigate') return;
      e.preventDefault();
      const target = e.target;
      if (target === doc.body || target === doc.documentElement) return;
      // Allow editing on elements that contain text content (leaf-level elements)
      const isTextEditable = target.children.length === 0 ||
        ['SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'A', 'LI', 'LABEL', 'BUTTON', 'TD', 'TH', 'FIGCAPTION', 'BLOCKQUOTE', 'STRONG', 'EM', 'B', 'I', 'SMALL', 'MARK', 'DEL', 'INS', 'SUB', 'SUP'].includes(target.tagName);
      if (isTextEditable && target.textContent.trim().length > 0) {
        this.startTextEdit(target);
      }
    });

    // Update selection/hover overlays on scroll so they track the element
    doc.addEventListener('scroll', () => {
      if (this._currentTool === 'navigate') return;
      if (this.selectedElement) this.showSelection();
      this.clearHover();
    }, { passive: true });

    // Build layers
    this.buildLayersTree(doc.body);
  }

  // Track navigation in the iframe (navigate mode)
  _onIframeNavigate() {
    // Re-setup interaction after iframe navigates
    this.iframe.addEventListener('load', () => {
      this.setupCanvasInteraction();
      // Update URL bar for framework projects
      if (this.devServer && this.iframe.contentWindow) {
        try {
          const loc = this.iframe.contentWindow.location;
          const path = loc.pathname.replace(/^\/devpreview/, '') || '/';
          this._devPath = path;
          if (this._urlInput) this._urlInput.value = path;
          if (this._routeSelect) this._routeSelect.value = path;
        } catch { /* cross-origin */ }
      }
    }, { once: true });
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
      undo: () => { this.selectedElement.style[prop] = oldValue; this.writebackStyle(prop, oldValue); if (prop === 'display') this.refreshRightPanel(); },
      redo: () => { this.selectedElement.style[prop] = value; this.writebackStyle(prop, value); if (prop === 'display') this.refreshRightPanel(); },
    });

    this.writebackStyle(prop, value);

    if (prop === 'display') this.refreshRightPanel();
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
      this.bottomPanel.style.height = `${newHeight}px`;
    };

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (this.iframe) this.iframe.style.pointerEvents = '';
    };

    splitter.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startY = e.clientY;
      startHeight = this.chatHeight;
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
      if (this.iframe) this.iframe.style.pointerEvents = 'none';
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
    const cssProp = prop.replace(/([A-Z])/g, '-$1').toLowerCase();

    let mediaQuery = null;
    if (this.breakpoint === 'tablet') mediaQuery = '(max-width: 768px)';
    if (this.breakpoint === 'mobile') mediaQuery = '(max-width: 375px)';

    // 1. Try CSSOM: find the exact rule + file that styles this element
    const source = this._resolveStyleSource(element, cssProp);

    let filePath, selector;

    if (source) {
      filePath = source.filePath;
      selector = source.selector;
    } else {
      // 2. Fallback: use basic selector + first safe CSS file
      const classes = (element.className || '').split(/\s+/).filter(Boolean);
      selector = classes.length > 0 ? `.${classes[0]}` : element.tagName.toLowerCase();
      const cssFile = this._getWritebackCSSFile();
      if (!cssFile) return;
      filePath = cssFile.path;
    }

    try {
      await api.post('/api/writeback/css', {
        filePath,
        selector,
        prop: cssProp,
        value,
        mediaQuery,
      });
      this._writebackBroken = false;
    } catch (err) {
      console.error('Writeback failed:', err);
      if (err.message?.includes('parse error') || err.message?.includes('Unexpected') || err.message?.includes('Tailwind')) {
        this._writebackBroken = true;
        console.warn('CSS writeback paused:', err.message);
      }
    }
  }

  // Resolve which CSS file + selector defines a property for this element (like DevTools)
  _resolveStyleSource(element, cssProp) {
    const doc = this.iframe?.contentDocument;
    if (!doc) return null;

    let bestMatch = null;

    try {
      for (const sheet of doc.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; } // skip cross-origin sheets

        // Resolve sheet href to a project file path
        const filePath = this._resolveSheetPath(sheet);
        if (!filePath) continue; // skip inline <style> or unresolvable sheets

        for (const rule of rules) {
          if (rule.type !== 1 /* CSSRule.STYLE_RULE */) continue;
          try {
            if (!element.matches(rule.selectorText)) continue;
          } catch { continue; } // invalid selector

          // This rule matches the element — check if it defines the property
          // Always keep the last match (highest specificity in cascade order)
          if (rule.style.getPropertyValue(cssProp)) {
            bestMatch = { filePath, selector: rule.selectorText };
          }
        }
      }

      // Even if the property isn't set, find ANY matching rule in a writable file
      // so we can add the property to the right selector
      if (!bestMatch) {
        for (const sheet of doc.styleSheets) {
          let rules;
          try { rules = sheet.cssRules; } catch { continue; }
          const filePath = this._resolveSheetPath(sheet);
          if (!filePath) continue;

          for (const rule of rules) {
            if (rule.type !== 1) continue;
            try {
              if (!element.matches(rule.selectorText)) continue;
            } catch { continue; }
            bestMatch = { filePath, selector: rule.selectorText };
          }
        }
      }
    } catch (e) {
      console.warn('Style source resolution failed:', e);
    }

    return bestMatch;
  }

  // Map a CSSStyleSheet to a project file path
  _resolveSheetPath(sheet) {
    if (!sheet.href) return null; // inline <style> — can't write back

    try {
      const url = new URL(sheet.href);
      const pathname = url.pathname;

      // Static project: /preview/style.css → match relative path
      if (pathname.startsWith('/preview/')) {
        const rel = pathname.replace('/preview/', '');
        const file = this.files.find(f => f.relativePath === rel);
        return file?.path || null;
      }

      // Framework project: /src/App.css or similar → match against file list
      const file = this.files.find(f =>
        pathname.endsWith(f.relativePath) || pathname.endsWith('/' + f.relativePath)
      );
      return file?.path || null;
    } catch {
      return null;
    }
  }

  // Find a safe CSS file for writeback (skip framework entry files)
  _getWritebackCSSFile() {
    if (this._writebackCSSFile) return this._writebackCSSFile;

    const cssFiles = this.files.filter(f => f.type === 'css');
    if (cssFiles.length === 0) return null;

    // For static projects (no devServer), use the first CSS file as before
    if (!this.devServer) {
      this._writebackCSSFile = cssFiles[0];
      return this._writebackCSSFile;
    }

    // For framework projects, skip files with @tailwind / @layer / heavy @import usage
    // These are framework entry points that PostCSS shouldn't rewrite
    const unsafe = /index\.css$|globals?\.css$|tailwind\.css$/i;
    const safe = cssFiles.find(f => !unsafe.test(f.path));
    this._writebackCSSFile = safe || null;
    return this._writebackCSSFile;
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
    this._toolNavigate.classList.toggle('active', mode === 'navigate');
    this._toolSelect.classList.toggle('active', mode === 'select');
    this._toolMarquee.classList.toggle('active', mode === 'marquee');

    if (mode === 'navigate') {
      // Clear selection & hover, allow free navigation
      this.selectedElement = null;
      this.overlay.innerHTML = '';
      this.clearHover();
      this.iframeContainer.classList.add('navigate-mode');
      // Deactivate marquee
      if (this._marqueeActive) {
        this._marqueeActive = false;
        const overlay = this.el.querySelector('.canvas-overlay');
        if (overlay) overlay.style.cursor = '';
      }
    } else if (mode === 'marquee') {
      this.iframeContainer.classList.remove('navigate-mode');
      this.toggleAIMarquee();
    } else {
      this.iframeContainer.classList.remove('navigate-mode');
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
    this._previewMode = !this._previewMode;

    const display = this._previewMode ? 'none' : '';
    left.style.display = display;
    right.style.display = display;
    this.bottomPanel.style.display = display;
    this.el.querySelector('.splitter-h').style.display = display;
    bottombar.style.display = this._previewMode ? 'none' : 'flex';

    if (this._previewMode) {
      this.el.style.gridTemplateColumns = '0 1fr 0';
    } else {
      this.el.style.gridTemplateColumns = `var(--panel-w) 1fr var(--panel-right-w)`;
    }
  }

  // Code editor mode
  toggleCodeMode() {
    this._codeMode = !this._codeMode;
    this._codeToggleBtn.classList.toggle('active', this._codeMode);

    const right = this.el.querySelector('.panel-right');
    const panelLeft = this.el.querySelector('.panel-left');
    if (this._codeMode) {
      this.canvasWrapper.style.display = 'none';
      this.codeEditorWrapper.style.display = 'flex';
      this.overlay.style.display = 'none';
      right.style.display = 'none';
      this.el.style.gridTemplateColumns = `var(--panel-w) 1fr 0`;

      // Swap left panel content to file tree
      this._renderFileTree(panelLeft);

      // Auto-open current page file
      if (this.activePage) {
        this._openCodeFile(this.activePage.path || (this.projectPath + '/' + this.activePage.relativePath));
      }
    } else {
      // Save before switching back
      this._saveCurrentCodeFile();
      this.canvasWrapper.style.display = '';
      this.codeEditorWrapper.style.display = 'none';
      this.overlay.style.display = '';
      right.style.display = '';
      this.el.style.gridTemplateColumns = `var(--panel-w) 1fr var(--panel-right-w)`;

      // Restore left panel by re-rendering it
      const newLeft = this.renderLeftPanel();
      panelLeft.replaceWith(newLeft);
      // Rebuild layers from iframe
      const doc = this.iframe?.contentDocument;
      if (doc?.body) this.buildLayersTree(doc.body);
    }
  }

  _renderFileTree(panel) {
    panel.innerHTML = '';
    panel.appendChild(h('div', { className: 'panel-section-header' }, 'Files'));

    const tree = h('div', { className: 'code-file-tree' });
    panel.appendChild(tree);

    // Build tree from this.files
    const root = {};
    for (const f of this.files) {
      const rel = f.relativePath || f.path.replace(this.projectPath + '/', '');
      const parts = rel.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node['__f_' + parts[parts.length - 1]] = f;
    }

    const renderNode = (node, container, depth = 0) => {
      const entries = Object.entries(node).sort(([a], [b]) => {
        const af = a.startsWith('__f_'), bf = b.startsWith('__f_');
        if (af !== bf) return af ? 1 : -1;
        return a.localeCompare(b);
      });

      for (const [key, val] of entries) {
        if (key.startsWith('__f_')) {
          const file = val;
          const name = key.slice(4);
          const item = h('div', {
            className: 'code-file-item',
            style: { paddingLeft: `${8 + depth * 14}px` },
            onClick: () => this._openCodeFile(file.path || (this.projectPath + '/' + (file.relativePath || name))),
          }, this._fileIcon(name), h('span', {}, name));
          item.dataset.filePath = file.path || (this.projectPath + '/' + (file.relativePath || name));
          container.appendChild(item);
        } else {
          // Folder
          const folder = h('div', { className: 'code-folder' });
          const header = h('div', {
            className: 'code-folder-header',
            style: { paddingLeft: `${8 + depth * 14}px` },
          });
          const arrow = h('span', { className: 'code-folder-arrow open' });
          arrow.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          header.append(arrow, h('span', {}, key));

          const children = h('div', { className: 'code-folder-children' });
          renderNode(val, children, depth + 1);

          header.addEventListener('click', () => {
            const open = children.style.display !== 'none';
            children.style.display = open ? 'none' : '';
            arrow.classList.toggle('open', !open);
          });

          folder.append(header, children);
          container.appendChild(folder);
        }
      }
    };

    renderNode(root, tree);
  }

  _fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const colors = { js: '#f7df1e', jsx: '#61dafb', ts: '#3178c6', tsx: '#61dafb', css: '#1572b6', html: '#e34f26', json: '#999', md: '#999' };
    const color = colors[ext] || 'var(--text-tertiary)';
    const el = h('span', { className: 'code-file-icon', style: { color } });
    el.textContent = ext.toUpperCase().slice(0, 3);
    return el;
  }

  async _openCodeFile(filePath) {
    // Save previous file if modified
    await this._saveCurrentCodeFile();

    this._currentCodeFile = filePath;
    this._codeModified = false;

    const url = `/api/files/read?path=${encodeURIComponent(filePath)}`;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (attempt > 0) await new Promise(r => setTimeout(r, 300));
        const data = await api.get(url);
        this.codeTextarea.value = data.content || '';
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      console.error('[code-editor] Failed to load file:', url, lastErr);
      this.codeTextarea.value = `// Error loading file: ${lastErr.message}\n// Path: ${filePath}`;
    }

    // Update tab bar
    const name = filePath.split('/').pop();
    const existing = this._codeOpenTabs.find(t => t.path === filePath);
    if (!existing) {
      this._codeOpenTabs.push({ path: filePath, name, modified: false });
    }
    this._renderCodeTabs();

    // Highlight active file in tree
    this.el.querySelectorAll('.code-file-item').forEach(item => {
      item.classList.toggle('active', item.dataset.filePath === filePath);
    });
  }

  _renderCodeTabs() {
    this._codeTabBar.innerHTML = '';
    for (const tab of this._codeOpenTabs) {
      const isActive = tab.path === this._currentCodeFile;
      const tabEl = h('div', {
        className: `code-tab${isActive ? ' active' : ''}`,
        onClick: () => this._openCodeFile(tab.path),
      },
        h('span', {}, (tab.modified ? '\u2022 ' : '') + tab.name),
        h('button', {
          className: 'code-tab-close',
          onClick: (e) => {
            e.stopPropagation();
            this._closeCodeTab(tab.path);
          },
        }, '\u00d7'),
      );
      this._codeTabBar.appendChild(tabEl);
    }
  }

  _updateCodeTab() {
    const tab = this._codeOpenTabs.find(t => t.path === this._currentCodeFile);
    if (tab) {
      tab.modified = this._codeModified;
      this._renderCodeTabs();
    }
  }

  async _closeCodeTab(filePath) {
    if (this._currentCodeFile === filePath && this._codeModified) {
      await this._saveCurrentCodeFile();
    }
    this._codeOpenTabs = this._codeOpenTabs.filter(t => t.path !== filePath);
    if (this._currentCodeFile === filePath) {
      if (this._codeOpenTabs.length) {
        this._openCodeFile(this._codeOpenTabs[this._codeOpenTabs.length - 1].path);
      } else {
        this._currentCodeFile = null;
        this.codeTextarea.value = '';
        this._renderCodeTabs();
      }
    } else {
      this._renderCodeTabs();
    }
  }

  async _saveCurrentCodeFile() {
    if (!this._currentCodeFile || !this._codeModified) return;
    try {
      await api.post('/api/files/write', {
        path: this._currentCodeFile,
        content: this.codeTextarea.value,
      });
      this._codeModified = false;
      this._updateCodeTab();
    } catch (e) {
      console.error('Failed to save file:', e);
    }
  }

  // Show changes (git diff)
  async showGitPanel() {
    const dir = this.projectPath;
    const q = (p) => `${p}${p.includes('?') ? '&' : '?'}dir=${encodeURIComponent(dir)}`;

    // Show overlay immediately with loading state
    const overlay = h('div', { className: 'git-overlay' });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    const panel = h('div', { className: 'git-panel' });

    // Show loading header immediately
    const headerLeft = h('div', { className: 'git-header-left' },
      h('span', { className: 'git-header-title' }, 'Git'),
    );
    panel.appendChild(h('div', { className: 'git-header' },
      headerLeft,
      h('button', { className: 'git-close', onClick: () => overlay.remove() }, '\u2715'),
    ));

    const loadingEl = h('div', { className: 'git-loading' }, 'Loading...');
    panel.appendChild(loadingEl);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Fetch status + auth in parallel
    let status, authInfo;
    try {
      [status, authInfo] = await Promise.all([
        api.get(q('/api/git/status')),
        api.get('/api/git/github/auth'),
      ]);
    } catch (err) {
      loadingEl.textContent = 'Failed to load git status';
      console.error('Git error:', err);
      return;
    }

    // Remove loading, update header with branch
    loadingEl.remove();
    if (status.isRepo && status.branch) {
      headerLeft.appendChild(h('span', { className: 'git-header-branch' }, status.branch));
    }

    // Not a repo yet — init
    if (!status.isRepo) {
      const statusMsg = h('div', { className: 'git-status-msg' });
      panel.appendChild(h('div', { className: 'git-publish' },
        h('div', { className: 'git-publish-text' }, 'This project is not a git repository yet.'),
        h('button', {
          className: 'git-btn git-btn-primary',
          onClick: async () => {
            await api.post('/api/git/init', { dir });
            overlay.remove();
            this.showGitPanel();
          },
        }, 'Initialize repository'),
        statusMsg,
      ));
      return;
    }

    // Tabs
    const tabContent = h('div', { className: 'git-tab-content' });
    let activeTab = 'changes';

    const renderTab = async (tab) => {
      activeTab = tab;
      tabs.querySelectorAll('.git-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      tabContent.innerHTML = '';

      if (tab === 'changes') {
        await this._renderGitChanges(tabContent, status, dir, overlay);
      } else if (tab === 'history') {
        await this._renderGitHistory(tabContent, dir);
      } else if (tab === 'settings') {
        await this._renderGitSettings(tabContent, dir, authInfo, status, overlay);
      }
    };

    const tabs = h('div', { className: 'git-tabs' },
      h('div', { className: 'git-tab active', dataset: { tab: 'changes' }, onClick: () => renderTab('changes') }, 'Changes'),
      h('div', { className: 'git-tab', dataset: { tab: 'history' }, onClick: () => renderTab('history') }, 'History'),
      h('div', { className: 'git-tab', dataset: { tab: 'settings' }, onClick: () => renderTab('settings') }, 'Settings'),
    );
    panel.appendChild(tabs);
    panel.appendChild(tabContent);

    // Sync bar (push/pull)
    if (status.remote) {
      const syncInfo = h('div', { className: 'git-sync-info' }, status.remote.replace('https://github.com/', '').replace('.git', ''));
      const syncBar = h('div', { className: 'git-sync-bar' },
        syncInfo,
        h('div', { className: 'git-sync-badges' },
          status.ahead ? h('span', { className: 'git-sync-badge' }, `${status.ahead}\u2191`) : null,
          status.behind ? h('span', { className: 'git-sync-badge' }, `${status.behind}\u2193`) : null,
        ),
        h('button', {
          className: 'git-btn git-btn-secondary',
          onClick: async (e) => {
            e.target.textContent = 'Pulling...';
            e.target.disabled = true;
            try { await api.post('/api/git/pull', { dir }); } catch (err) { syncInfo.textContent = err.message; }
            overlay.remove(); this.showGitPanel();
          },
        }, 'Pull'),
        h('button', {
          className: 'git-btn git-btn-secondary',
          onClick: async (e) => {
            e.target.textContent = 'Pushing...';
            e.target.disabled = true;
            try { await api.post('/api/git/push', { dir }); } catch (err) { syncInfo.textContent = err.message; }
            overlay.remove(); this.showGitPanel();
          },
        }, 'Push'),
      );
      panel.appendChild(syncBar);
    }

    // Render initial tab
    renderTab('changes');
  }

  async _renderGitChanges(container, status, dir, overlay) {
    const allChanges = [
      ...status.modified.map(f => ({ name: f, status: 'M' })),
      ...status.created.map(f => ({ name: f, status: 'A' })),
      ...(status.not_added || []).map(f => ({ name: f, status: 'A' })),
      ...status.deleted.map(f => ({ name: f, status: 'D' })),
      ...status.conflicted.map(f => ({ name: f, status: 'U' })),
    ];

    if (allChanges.length === 0) {
      container.appendChild(h('div', { className: 'git-empty' }, 'No changes'));
    } else {
      container.appendChild(h('div', { className: 'git-section-title' }, `${allChanges.length} changed file${allChanges.length > 1 ? 's' : ''}`));
      const list = h('div', { className: 'git-file-list' });
      for (const f of allChanges) {
        list.appendChild(h('div', { className: 'git-file' },
          h('span', { className: `git-file-status ${f.status.toLowerCase()}` }, f.status),
          h('span', { className: 'git-file-name' }, f.name),
        ));
      }
      container.appendChild(list);
    }

    // Commit section
    const commitInput = h('textarea', {
      className: 'git-commit-input',
      placeholder: 'Commit message...',
      rows: '2',
    });

    const statusMsg = h('div', { className: 'git-status-msg' });
    const commitBtn = h('button', {
      className: 'git-btn git-btn-primary',
      onClick: async () => {
        const msg = commitInput.value.trim();
        if (!msg) { statusMsg.textContent = 'Enter a commit message'; return; }
        commitBtn.disabled = true;
        commitBtn.textContent = 'Committing...';
        try {
          const result = await api.post('/api/git/commit', { dir, message: msg });
          statusMsg.textContent = `Committed ${result.commit}`;
          // Refresh
          setTimeout(() => { overlay.remove(); this.showGitPanel(); }, 600);
        } catch (err) {
          statusMsg.textContent = err.message;
          commitBtn.disabled = false;
          commitBtn.textContent = 'Commit';
        }
      },
    }, 'Commit');

    container.appendChild(h('div', { className: 'git-commit-section' },
      commitInput,
      h('div', { className: 'git-commit-actions' },
        statusMsg,
        commitBtn,
      ),
    ));

    commitInput.focus();
  }

  async _renderGitHistory(container, dir) {
    try {
      const data = await api.get(`/api/git/log?dir=${encodeURIComponent(dir)}&n=30`);
      if (!data.commits || data.commits.length === 0) {
        container.appendChild(h('div', { className: 'git-empty' }, 'No commits yet'));
        return;
      }
      for (const c of data.commits) {
        const date = new Date(c.date);
        const ago = this._timeAgo(date);
        container.appendChild(h('div', { className: 'git-commit-item' },
          h('span', { className: 'git-commit-hash' }, c.hash),
          h('span', { className: 'git-commit-msg' }, c.message),
          h('span', { className: 'git-commit-date' }, ago),
        ));
      }
    } catch {
      container.appendChild(h('div', { className: 'git-empty' }, 'Could not load history'));
    }
  }

  _timeAgo(date) {
    const s = Math.floor((Date.now() - date.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    if (s < 604800) return `${Math.floor(s / 86400)}d ago`;
    return date.toLocaleDateString();
  }

  async _renderGitSettings(container, dir, authInfo, status, overlay) {
    // GitHub Auth
    container.appendChild(h('div', { className: 'git-section-title' }, 'GitHub'));

    const authSection = h('div', { className: 'git-auth-section' });

    if (authInfo.authenticated) {
      authSection.appendChild(h('div', { className: 'git-auth-status' },
        authInfo.avatar ? h('img', { className: 'git-auth-avatar', src: authInfo.avatar }) : null,
        h('span', {}, 'Signed in as '),
        h('span', { className: 'git-auth-user' }, authInfo.user),
      ));
      authSection.appendChild(h('button', {
        className: 'git-btn git-btn-secondary',
        onClick: async () => {
          await api.del('/api/git/github/auth');
          overlay.remove();
          this.showGitPanel();
        },
      }, 'Sign out'));
    } else {
      const tokenInput = h('input', {
        className: 'git-auth-input',
        type: 'password',
        placeholder: 'ghp_...',
      });
      const authStatus = h('div', { className: 'git-status-msg' });
      authSection.appendChild(h('div', { className: 'git-auth-hint' }, 'Enter a GitHub Personal Access Token with repo scope.'));
      authSection.appendChild(tokenInput);
      authSection.appendChild(h('div', { className: 'git-commit-actions' },
        authStatus,
        h('button', {
          className: 'git-btn git-btn-primary',
          onClick: async () => {
            const token = tokenInput.value.trim();
            if (!token) return;
            try {
              const result = await api.post('/api/git/github/auth', { token });
              if (result.authenticated) {
                overlay.remove();
                this.showGitPanel();
              }
            } catch (err) {
              authStatus.textContent = err.message || 'Invalid token';
            }
          },
        }, 'Connect'),
      ));
    }
    container.appendChild(authSection);

    // Publish to GitHub (if no remote)
    if (!status.remote && authInfo.authenticated) {
      container.appendChild(h('div', { className: 'git-section-title' }, 'Publish'));
      const repoInput = h('input', {
        className: 'git-repo-name-input',
        placeholder: 'repository-name',
        value: dir.split('/').pop(),
      });
      const privCheck = h('input', { type: 'checkbox', checked: true });
      const pubStatus = h('div', { className: 'git-status-msg' });
      container.appendChild(h('div', { className: 'git-auth-section' },
        h('div', { className: 'git-auth-hint' }, 'Create a new GitHub repository and push your code.'),
        repoInput,
        h('div', { className: 'git-publish-row' },
          h('label', {}, privCheck, ' Private'),
          h('div', { style: { flex: '1' } }),
          h('button', {
            className: 'git-btn git-btn-primary',
            onClick: async (e) => {
              e.target.textContent = 'Publishing...';
              e.target.disabled = true;
              try {
                const result = await api.post('/api/git/github/create-repo', {
                  dir,
                  name: repoInput.value.trim(),
                  private: privCheck.checked,
                });
                pubStatus.textContent = 'Published!';
                setTimeout(() => { overlay.remove(); this.showGitPanel(); this.loadGitBranch(); }, 800);
              } catch (err) {
                pubStatus.textContent = err.message;
                e.target.textContent = 'Publish';
                e.target.disabled = false;
              }
            },
          }, 'Publish to GitHub'),
        ),
        pubStatus,
      ));
    }

    // Remote URL
    if (status.remote) {
      container.appendChild(h('div', { className: 'git-section-title' }, 'Remote'));
      container.appendChild(h('div', { className: 'git-auth-section' },
        h('div', { style: { fontSize: '12px', fontFamily: "'SF Mono', 'Fira Code', monospace", color: 'var(--text-secondary)' } }, status.remote),
      ));
    }
  }

  // Git branch
  async loadGitBranch() {
    try {
      const data = await api.get(`/api/git/branch?dir=${encodeURIComponent(this.projectPath)}`);
      this.gitBranch.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" style="opacity:0.6"><path d="M11 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 16a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM5 4a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z" fill="currentColor"/><path d="M5 4v8M11 4v2a2 2 0 0 1-2 2H7a2 2 0 0 0-2 2" stroke="currentColor" stroke-width="1.5"/></svg> ' + (data.current || '');
    } catch {
      this.gitBranch.textContent = '';
    }
  }

  // Auto-update listener (Tauri only)
  async listenForUpdates() {
    try {
      const data = await api.get('/api/update-check');
      if (data.available) this.showUpdateBanner(data.latestVersion, data.downloadUrl);
    } catch {}
  }

  showUpdateBanner(version, downloadUrl) {
    const topbarRight = this.el.querySelector('.topbar-right');
    if (!topbarRight || topbarRight.querySelector('.update-btn')) return;

    const btn = h('button', {
      className: 'update-btn',
      onClick: () => { window.open(downloadUrl, '_blank'); },
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
    this.shortcuts.register('cmd+e', () => this.toggleCodeMode(), 'Toggle code editor');
    this.shortcuts.register('cmd+b', () => this._togglePanel('left'), 'Toggle left panel');
    this.shortcuts.register('cmd+j', () => this._togglePanel('bottom'), 'Toggle bottom panel');

    // Tool shortcuts (single keys, only when not typing)
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); this._setTool('navigate'); }
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
      { id: 'navigate', label: 'Navigate mode', shortcut: 'N', section: 'Tools', action: () => this._setTool('navigate') },
      { id: 'select-tool', label: 'Select tool', shortcut: 'V', section: 'Tools', action: () => this._setTool('select') },
      { id: 'preview', label: 'Toggle preview', section: 'View', action: () => this.togglePreview() },
      { id: 'code-mode', label: 'Toggle code editor', shortcut: 'cmd+e', section: 'View', action: () => this.toggleCodeMode() },
      { id: 'toggle-left', label: 'Toggle left panel', shortcut: 'cmd+b', section: 'View', action: () => this._togglePanel('left') },
      { id: 'toggle-bottom', label: 'Toggle bottom panel', shortcut: 'cmd+j', section: 'View', action: () => this._togglePanel('bottom') },
      { id: 'toggle-right', label: 'Toggle right panel', section: 'View', action: () => this._togglePanel('right') },
      { id: 'terminal', label: 'Open terminal', section: 'View', action: () => this._switchBottomTab('terminal') },
      { id: 'git', label: 'Open Git panel', section: 'Git', action: () => this.showGitPanel() },
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
      this.ws = ws;
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'watch', path: this.projectPath }));
        // Re-start terminal if it was previously started
        if (this._termStarted) {
          this._termStarted = false;
          if (this._xterm) this._xterm.clear();
          this._startTerminal();
        }
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
        // Terminal output
        if (msg.type === 'terminal-output') {
          this._termWrite(msg.data);
        }
        if (msg.type === 'terminal-ready') {
          // PTY mode: shell prompt will appear naturally
          // Pipe mode: show a connection message
          if (!msg.pty && this._xterm) {
            this._xterm.write(`\x1b[2m${msg.shell} in ${msg.cwd}\x1b[0m\r\n`);
          }
        }
        if (msg.type === 'terminal-exit') {
          if (this._xterm) {
            this._xterm.write(`\r\n\x1b[2mProcess exited (code ${msg.code})\x1b[0m\r\n`);
          }
          this._termStarted = false;
        }
      };
      ws.onclose = () => {
        this.ws = null;
        // Reconnect after a short delay
        setTimeout(connect, 2000);
      };
    };
    connect();
  }
}
