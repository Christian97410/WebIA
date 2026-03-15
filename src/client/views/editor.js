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

    this._chatSessionId = null;
    this._chatSessionsOpen = false;
    this.undoStack = [];
    this.redoStack = [];
    this.cssRulesCache = {};
    this._currentTool = 'select';
    this._rightTab = 'style'; // 'elements' | 'style'
    this._collapsedElements = new Set(); // track collapsed tree nodes

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
            className: 'topbar-btn topbar-btn--supabase',
            onClick: () => this.showSupabasePanel(),
            title: 'Supabase',
          });
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 109 113" fill="none"><path d="M63.7 110.3c-2.6 3.3-8.1.7-7.8-3.6l3.3-44.4H104c4.8 0 7.4 5.6 4.3 9.2L63.7 110.3Z" fill="currentColor" opacity="0.7"/><path d="M45.3 2.7c2.6-3.3 8.1-.7 7.8 3.6l-1.7 44.4H5c-4.8 0-7.4-5.6-4.3-9.2L45.3 2.7Z" fill="currentColor"/></svg>';
          return btn;
        })(),
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

    // Explorer header
    const explorerHeader = h('div', { className: 'panel-section-header' });
    const projectName = this.projectPath.split('/').pop().toUpperCase();
    explorerHeader.textContent = projectName;
    panel.appendChild(explorerHeader);

    // File tree
    const fileTree = h('div', { className: 'file-tree' });
    this._collapsedFolders = this._collapsedFolders || new Set();

    // Build tree from all files
    const tree = {};
    for (const file of this.files) {
      const parts = file.relativePath.split('/');
      let node = tree;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node['__f_' + parts[parts.length - 1]] = file;
    }

    const fileIcon = (name) => {
      const ext = name.split('.').pop().toLowerCase();
      const icons = {
        js: { color: '#e8d44d', label: 'JS' },
        jsx: { color: '#61dafb', label: 'JSX' },
        ts: { color: '#3178c6', label: 'TS' },
        tsx: { color: '#3178c6', label: 'TSX' },
        css: { color: '#563d7c', label: 'CSS' },
        scss: { color: '#c6538c', label: 'SC' },
        html: { color: '#e34c26', label: 'HTML' },
        json: { color: '#a1a1aa', label: '{}' },
        md: { color: '#519aba', label: 'MD' },
        svg: { color: '#ffb13b', label: 'SVG' },
        png: { color: '#a1a1aa', label: 'IMG' },
        jpg: { color: '#a1a1aa', label: 'IMG' },
        gif: { color: '#a1a1aa', label: 'IMG' },
        lock: { color: '#555', label: 'LK' },
        toml: { color: '#9c4221', label: 'TM' },
        yaml: { color: '#cb171e', label: 'YM' },
        yml: { color: '#cb171e', label: 'YM' },
        rs: { color: '#dea584', label: 'RS' },
        py: { color: '#3572A5', label: 'PY' },
      };
      const i = icons[ext] || { color: '#a1a1aa', label: ext?.toUpperCase()?.slice(0, 3) || '?' };
      return `<span class="file-icon" style="color:${i.color}">${i.label}</span>`;
    };

    const folderIcon = (open) => {
      return open
        ? '<svg class="folder-chevron folder-chevron--open" width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M4 6l4 4 4-4"/></svg>'
        : '<svg class="folder-chevron" width="10" height="10" viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4"/></svg>';
    };

    const renderNode = (node, depth = 0, pathPrefix = '') => {
      const entries = Object.entries(node).sort(([a, av], [b, bv]) => {
        const aFile = a.startsWith('__f_');
        const bFile = b.startsWith('__f_');
        if (aFile !== bFile) return aFile ? 1 : -1;
        return a.localeCompare(b);
      });

      for (const [key, value] of entries) {
        if (key.startsWith('__f_')) {
          const file = value;
          const name = key.slice(4);
          const isPage = this.htmlFiles.includes(file);
          const isActive = file === this.activePage;
          const item = h('div', {
            className: `file-item${isActive ? ' file-item--active' : ''}`,
            style: `padding-left:${12 + depth * 16}px`,
            onClick: () => { if (isPage) this.loadPage(file); },
          });
          item.innerHTML = `${fileIcon(name)}<span class="file-item-name">${name}</span>`;
          if (!isPage) item.classList.add('file-item--readonly');
          fileTree.appendChild(item);
        } else {
          const folderPath = pathPrefix + key;
          const collapsed = this._collapsedFolders.has(folderPath);
          const folder = h('div', {
            className: 'file-folder',
            style: `padding-left:${12 + depth * 16}px`,
          });
          folder.innerHTML = `${folderIcon(!collapsed)}<span class="file-folder-name">${key}</span>`;
          folder.addEventListener('click', () => {
            if (this._collapsedFolders.has(folderPath)) {
              this._collapsedFolders.delete(folderPath);
            } else {
              this._collapsedFolders.add(folderPath);
            }
            // Re-render just the file tree
            const newPanel = this.renderLeftPanel();
            this.el.querySelector('.panel-left').replaceWith(newPanel);
          });
          fileTree.appendChild(folder);

          if (!collapsed) {
            renderNode(value, depth + 1, folderPath + '/');
          }
        }
      }
    };

    renderNode(tree);
    panel.appendChild(fileTree);

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

    this._codeBreadcrumb = h('div', { className: 'code-breadcrumb' });
    this._cmContainer = h('div', { className: 'code-cm-container' });
    this._cmEditor = null; // Lazy-loaded CodeEditor instance

    this.codeEditorWrapper.appendChild(this._codeTabBar);
    this.codeEditorWrapper.appendChild(this._codeBreadcrumb);
    this.codeEditorWrapper.appendChild(this._cmContainer);
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
        <button class="chat-sessions-btn" title="Conversation history">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
      <div class="chat-header-right">
        <button class="chat-new-session-btn" title="New chat">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <span class="chat-status-dot"></span>
      </div>
    `;
    this.chatContent.appendChild(chatHeader);

    // Sessions dropdown
    this._chatSessionsDropdown = h('div', { className: 'chat-sessions-dropdown' });
    this._chatSessionsDropdown.style.display = 'none';
    this.chatContent.appendChild(this._chatSessionsDropdown);

    // Wire up sessions button
    chatHeader.querySelector('.chat-sessions-btn').addEventListener('click', () => {
      this._toggleSessionsDropdown();
    });

    // Wire up new session button
    chatHeader.querySelector('.chat-new-session-btn').addEventListener('click', () => {
      this._startNewChatSession();
    });

    // Close dropdown on outside click
    document.addEventListener('click', (e) => {
      if (this._chatSessionsOpen &&
          !this._chatSessionsDropdown.contains(e.target) &&
          !chatHeader.querySelector('.chat-sessions-btn').contains(e.target)) {
        this._chatSessionsDropdown.style.display = 'none';
        this._chatSessionsOpen = false;
      }
    });

    // Messages
    this.chatMessages = h('div', { className: 'chat-messages' });
    this.chatContent.appendChild(this.chatMessages);

    // Delegated click for file links and copy buttons in chat
    this.chatMessages.addEventListener('click', (e) => {
      // File links
      const link = e.target.closest('.chat-file-link');
      if (link) {
        e.preventDefault();
        const filePath = link.dataset.path;
        const line = link.dataset.line;
        if (filePath) this._openFileFromChat(filePath, line ? parseInt(line) : 0);
        return;
      }
      // Copy buttons
      const copyBtn = e.target.closest('.chat-copy-btn');
      if (copyBtn) {
        e.preventDefault();
        e.stopPropagation();
        let text = copyBtn.dataset.copy;
        if (!text) {
          // For code blocks, get the sibling <code> text
          const code = copyBtn.closest('.chat-code-block')?.querySelector('code');
          if (code) text = code.textContent;
        }
        if (text) {
          navigator.clipboard.writeText(text).then(() => {
            const svg = copyBtn.querySelector('svg');
            const origHTML = svg.outerHTML;
            copyBtn.innerHTML = `<svg width="${svg.getAttribute('width')}" height="${svg.getAttribute('height')}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`;
            setTimeout(() => { copyBtn.innerHTML = origHTML; }, 1500);
          });
        }
      }
    });

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

    // Attach file button
    const attachBtn = h('button', { className: 'chat-attach-btn', title: 'Attach file' });
    attachBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    this._chatAttachInput = h('input', { type: 'file', multiple: true, style: 'display:none' });
    attachBtn.addEventListener('click', () => this._chatAttachInput.click());
    this._chatAttachedFiles = [];
    this._chatAttachInput.addEventListener('change', () => {
      const files = Array.from(this._chatAttachInput.files || []);
      this._chatAttachedFiles = files;
      this._updateAttachPreview();
      this._chatAttachInput.value = '';
    });

    this._chatAttachPreview = h('div', { className: 'chat-attach-preview' });
    this._chatAttachPreview.style.display = 'none';

    const inputRow = h('div', { className: 'chat-input-row' });
    inputRow.appendChild(attachBtn);
    inputRow.appendChild(this.chatInput);
    inputRow.appendChild(sendBtn);
    inputWrapper.appendChild(this._chatAttachPreview);
    inputWrapper.appendChild(inputRow);

    // Status bar: mode toggle + current file + context %
    this._chatEditMode = 'auto'; // 'auto' | 'ask' | 'plan'
    this._chatContextPercent = 0;

    const statusBar = h('div', { className: 'chat-status-bar' });

    // Mode toggle
    this._chatModeBtn = h('button', { className: 'chat-mode-btn' });
    this._updateModeBtn();
    this._chatModeBtn.addEventListener('click', () => {
      const modes = ['auto', 'ask', 'plan'];
      const idx = modes.indexOf(this._chatEditMode);
      this._chatEditMode = modes[(idx + 1) % modes.length];
      this._updateModeBtn();
    });

    // Current file
    this._chatFileLabel = h('span', { className: 'chat-status-file' });
    this._chatFileLabel.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z" stroke="currentColor" stroke-width="2"/><path d="M13 2v7h7" stroke="currentColor" stroke-width="2"/></svg><span>${this.activePage?.relativePath || 'No file'}</span>`;

    // Context %
    this._chatContextLabel = h('span', { className: 'chat-status-context' });
    this._chatContextLabel.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"/><path d="M12 6v6l4 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><span>$0.00</span>`;
    this._sessionCost = 0;

    statusBar.appendChild(this._chatModeBtn);
    statusBar.appendChild(this._chatFileLabel);
    statusBar.appendChild(this._chatContextLabel);
    inputWrapper.appendChild(statusBar);

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
      if (setup.ready || setup.sdkAvailable) {
        this.setChatConnected('Claude Code');
        return;
      }
      // CLI installed + authenticated = good to go (SDK will init when needed)
      if (setup.cliInstalled && setup.authenticated) {
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
    this._aiConnected = true;
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

    // First-time framework setup: ask AI to configure editor integration
    if (this.devServer) {
      this._runEditorSetup();
    }
  }

  // One-time setup: ensure wia-overrides.css is created and imported
  async _runEditorSetup() {
    const setupKey = `wia-setup-done:${this.projectPath}`;
    if (localStorage.getItem(setupKey)) return;

    // Ensure wia-overrides.css file exists + server-side import injection
    let result;
    try {
      result = await api.post('/api/writeback/ensure-override-css', {
        projectDir: this.projectPath,
        htmlFile: this.activePage?.path || null,
        isFramework: true,
      });
    } catch {
      return; // can't create the file, skip setup
    }

    if (result?.importInjected) {
      // Server successfully injected the import — no AI needed
      localStorage.setItem(setupKey, '1');
      return;
    }

    // Server couldn't find a standard entry file — ask AI with precise instructions
    const overridePath = result?.path || `${this.projectPath}/src/wia-overrides.css`;
    const setupPrompt = [
      `[WebIA editor setup — automatic, no user action needed]`,
      ``,
      `A CSS override file has been created at: ${overridePath}`,
      `It needs to be imported so visual editor styles are applied.`,
      ``,
      `Steps:`,
      `1. Find the project's CSS entry file (e.g. globals.css, index.css) or JS/TS entry file (e.g. layout.tsx, main.tsx, _app.tsx)`,
      `2. Check if "wia-overrides.css" is already imported — if yes, do nothing`,
      `3. If not imported, add ONLY this line:`,
      `   - In a CSS file: @import './path/to/wia-overrides.css';  (after other @imports)`,
      `   - In a JS/TS file: import './path/to/wia-overrides.css';  (after other imports)`,
      `4. Compute the relative path from the entry file's directory to ${overridePath}`,
      ``,
      `IMPORTANT:`,
      `- Do NOT modify any existing imports or code`,
      `- Do NOT add the import inside a function, component, or JSX block`,
      `- Add it as a top-level import statement only`,
      `- If unsure, prefer adding to a CSS file over a JS/TS file`,
      `- Respond briefly when done`,
    ].join('\n');

    this.sendChatMessage(setupPrompt);
    localStorage.setItem(setupKey, '1');
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

  // ── Chat sessions ──────────────────────────────────────────────────────────

  async _toggleSessionsDropdown() {
    if (this._chatSessionsOpen) {
      this._chatSessionsDropdown.style.display = 'none';
      this._chatSessionsOpen = false;
      return;
    }
    this._chatSessionsOpen = true;
    this._chatSessionsDropdown.style.display = 'block';
    this._chatSessionsDropdown.innerHTML = '<div class="chat-sessions-loading">Loading...</div>';

    try {
      const sessions = await api.get(`/api/ai/sdk/sessions?projectPath=${encodeURIComponent(this.projectPath)}`);
      this._renderSessionsList(sessions);
    } catch {
      this._chatSessionsDropdown.innerHTML = '<div class="chat-sessions-loading">No conversations yet</div>';
    }
  }

  _renderSessionsList(sessions) {
    this._chatSessionsDropdown.innerHTML = '';

    if (!sessions || sessions.length === 0) {
      this._chatSessionsDropdown.innerHTML = '<div class="chat-sessions-empty">No conversations yet</div>';
      return;
    }

    for (const s of sessions) {
      const item = h('div', {
        className: 'chat-session-item' + (s.id === this._chatSessionId ? ' chat-session-item--active' : ''),
      });

      const title = h('span', { className: 'chat-session-title' }, s.title || 'Untitled');
      const meta = h('span', { className: 'chat-session-meta' });
      meta.textContent = this._relativeDate(s.lastMessageAt || s.createdAt);

      const deleteBtn = h('button', { className: 'chat-session-delete', title: 'Delete' });
      deleteBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await fetch(`/api/ai/sdk/sessions/${s.id}?projectPath=${encodeURIComponent(this.projectPath)}`, { method: 'DELETE' });
        item.remove();
        if (this._chatSessionId === s.id) {
          this._startNewChatSession();
        }
        if (this._chatSessionsDropdown.children.length === 0) {
          this._chatSessionsDropdown.innerHTML = '<div class="chat-sessions-empty">No conversations yet</div>';
        }
      });

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(deleteBtn);

      item.addEventListener('click', () => {
        this._loadChatSession(s.id);
        this._chatSessionsDropdown.style.display = 'none';
        this._chatSessionsOpen = false;
      });

      this._chatSessionsDropdown.appendChild(item);
    }
  }

  async _loadChatSession(sessionId) {
    try {
      const session = await api.get(`/api/ai/sdk/sessions/${sessionId}?projectPath=${encodeURIComponent(this.projectPath)}`);
      this._chatSessionId = sessionId;
      this.chatMessages.innerHTML = '';

      if (!session.messages || session.messages.length === 0) {
        this.showChatWelcome();
        return;
      }

      for (const msg of session.messages) {
        if (msg.role === 'user') {
          const el = h('div', { className: 'chat-message chat-message-user' }, msg.content);
          this.chatMessages.appendChild(el);
        } else if (msg.role === 'assistant') {
          const el = h('div', { className: 'chat-message chat-message-ai' });
          const textDiv = document.createElement('div');
          textDiv.className = 'chat-text';
          textDiv.innerHTML = this._renderMarkdown(msg.content);
          el.appendChild(textDiv);
          this.chatMessages.appendChild(el);
        }
      }

      this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    } catch (err) {
      console.warn('Failed to load session:', err);
    }
  }

  _startNewChatSession() {
    this._chatSessionId = null;
    this.chatMessages.innerHTML = '';
    this.showChatWelcome();
    this._chatSessionsDropdown.style.display = 'none';
    this._chatSessionsOpen = false;
  }

  _relativeDate(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 4) return `${weeks}w ago`;
    return new Date(ts).toLocaleDateString();
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

    // CLI installed + authenticated → should be connected, force it
    if (setup.authenticated) {
      this.setChatConnected('Claude Code');
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

    // Tabs: Elements | Style
    const tabs = h('div', { className: 'rp-tabs' });
    for (const [key, label] of [['elements', 'Elements'], ['style', 'Style']]) {
      tabs.appendChild(h('button', {
        className: `rp-tab${this._rightTab === key ? ' active' : ''}`,
        onClick: () => { this._rightTab = key; this.refreshRightPanel(); },
      }, label));
    }
    panel.appendChild(tabs);

    if (this._rightTab === 'elements') {
      panel.appendChild(this._renderElementsTree());
    } else {
      panel.appendChild(this._renderStyleContent());
    }

    return panel;
  }

  _renderStyleContent() {
    const wrap = h('div', { className: 'sp-wrap' });

    if (!this.selectedElement) {
      wrap.appendChild(h('div', { className: 'sp-empty' }, 'Select an element'));
      return wrap;
    }

    const tag = this.selectedElement.tagName.toLowerCase();
    const cls = this.selectedElement.className && typeof this.selectedElement.className === 'string'
      ? `.${this.selectedElement.className.split(' ').filter(Boolean)[0] || ''}`
      : '';
    wrap.appendChild(h('div', { className: 'sp-tag' }, `${tag}${cls}`));

    // Media button for images/videos/svg
    if (['img', 'video', 'picture', 'svg'].includes(tag)) {
      wrap.appendChild(this._renderMediaAction());
    }

    wrap.appendChild(this._renderLayout());
    wrap.appendChild(this._renderSpacing());
    wrap.appendChild(this._renderSize());
    wrap.appendChild(this._renderTypo());
    wrap.appendChild(this._renderFill());
    wrap.appendChild(this._renderBorder());
    wrap.appendChild(this._renderPosition());

    return wrap;
  }

  // ── Media action (change image/video via media panel) ──
  _renderMediaAction() {
    const tag = this.selectedElement.tagName.toLowerCase();
    const isImg = tag === 'img';
    const isVid = tag === 'video';
    const label = isImg ? 'Change image' : isVid ? 'Change video' : 'Change media';

    const row = h('div', { className: 'sp-media-action' });

    if (isImg || isVid) {
      const src = this.selectedElement.getAttribute('src') || '';
      const srcShort = src.split('/').pop() || '';
      if (srcShort) {
        row.appendChild(h('div', { className: 'sp-media-src' }, srcShort));
      }
    }

    const btn = h('button', {
      className: 'sp-media-btn',
      onClick: () => this.toggleMediaPanel(),
    });
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 16 16" fill="none"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5" cy="6.5" r="1.5" fill="currentColor"/><path d="M1.5 11l3.5-3 2.5 2 3-4 4 5" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
    btn.appendChild(document.createTextNode(' ' + label));
    row.appendChild(btn);

    return row;
  }

  // ── Elements tree (Figma-style) ──
  _renderElementsTree() {
    const wrap = h('div', { className: 'el-tree' });
    const doc = this.iframe?.contentDocument;
    if (!doc?.body) {
      wrap.appendChild(h('div', { className: 'sp-empty' }, 'No page loaded'));
      return wrap;
    }
    this._buildElementTree(wrap, doc.body, 0);
    return wrap;
  }

  _getElementIcon(tag) {
    const icons = {
      body: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/></svg>',
      div: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/></svg>',
      section: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1" opacity="0.4"/></svg>',
      header: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1" opacity="0.4"/></svg>',
      footer: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="10" x2="14" y2="10" stroke="currentColor" stroke-width="1" opacity="0.4"/></svg>',
      nav: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.5"/></svg>',
      main: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/></svg>',
      article: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="6" x2="11" y2="6" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.4"/><line x1="5" y1="8.5" x2="11" y2="8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round" opacity="0.4"/></svg>',
      img: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor"/><path d="M2 11l3-3 2 2 3-4 4 5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>',
      picture: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><circle cx="5.5" cy="6" r="1.2" fill="currentColor"/><path d="M2 11l3-3 2 2 3-4 4 5" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>',
      video: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><path d="M7 6v4l3-2-3-2z" fill="currentColor"/></svg>',
      svg: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="5" stroke="currentColor" stroke-width="1.2"/><path d="M5 8l2 2 4-4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
      a: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6.5 9.5l3-3M7 10c-.8.8-2.2.8-3 0s-.8-2.2 0-3l1.5-1.5M9 6c.8-.8 2.2-.8 3 0s.8 2.2 0 3L10.5 10.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
      button: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="5" width="12" height="6" rx="2" stroke="currentColor" stroke-width="1.2"/></svg>',
      input: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="5" width="12" height="6" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="4" y1="8" x2="4" y2="8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      textarea: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="4" y1="5.5" x2="4" y2="5.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
      form: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3" y="2" width="10" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="5" y1="5" x2="11" y2="5" stroke="currentColor" stroke-width="1" opacity="0.4"/><line x1="5" y1="8" x2="11" y2="8" stroke="currentColor" stroke-width="1" opacity="0.4"/></svg>',
      ul: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="5.5" r="1" fill="currentColor"/><line x1="7" y1="5.5" x2="13" y2="5.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><circle cx="4" cy="8.5" r="1" fill="currentColor"/><line x1="7" y1="8.5" x2="13" y2="8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><circle cx="4" cy="11.5" r="1" fill="currentColor"/><line x1="7" y1="11.5" x2="13" y2="11.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
      ol: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="5.5" r="1" fill="currentColor"/><line x1="7" y1="5.5" x2="13" y2="5.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/><circle cx="4" cy="8.5" r="1" fill="currentColor"/><line x1="7" y1="8.5" x2="13" y2="8.5" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
      li: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="4" cy="8" r="1" fill="currentColor"/><line x1="7" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1" stroke-linecap="round"/></svg>',
      span: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><text x="2" y="12" font-size="11" font-weight="500" fill="currentColor" opacity="0.7">T</text></svg>',
      p: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><line x1="3" y1="5" x2="13" y2="5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="3" y1="8" x2="13" y2="8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/><line x1="3" y1="11" x2="9" y2="11" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
      table: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><line x1="2" y1="6" x2="14" y2="6" stroke="currentColor" stroke-width="1"/><line x1="7" y1="6" x2="7" y2="13" stroke="currentColor" stroke-width="1"/></svg>',
      iframe: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.2"/><rect x="4" y="5" width="8" height="6" rx="1" stroke="currentColor" stroke-width="0.8" opacity="0.5"/></svg>',
      i: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><text x="5" y="12" font-size="11" font-style="italic" font-weight="500" fill="currentColor" opacity="0.7">I</text></svg>',
      strong: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><text x="3" y="12" font-size="11" font-weight="800" fill="currentColor">B</text></svg>',
      b: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><text x="3" y="12" font-size="11" font-weight="800" fill="currentColor">B</text></svg>',
    };
    for (const t of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      icons[t] = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><text x="2" y="12" font-size="10" font-weight="700" fill="currentColor">${t.toUpperCase()}</text></svg>`;
    }
    return icons[tag] || '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="3" y="4" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.5"/></svg>';
  }

  _getElementLabel(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'body') return 'body';
    if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'span', 'a', 'button', 'li', 'label', 'td', 'th'].includes(tag)) {
      const text = el.textContent?.trim();
      if (text) return text.length > 28 ? text.slice(0, 28) + '\u2026' : text;
    }
    if (tag === 'img') {
      const alt = el.getAttribute('alt');
      if (alt) return alt.length > 28 ? alt.slice(0, 28) + '\u2026' : alt;
      const src = el.getAttribute('src') || '';
      const name = src.split('/').pop();
      if (name) return name.length > 28 ? name.slice(0, 28) + '\u2026' : name;
    }
    if (tag === 'input') {
      const type = el.getAttribute('type') || 'text';
      const ph = el.getAttribute('placeholder');
      return ph ? `${type}: ${ph}` : type;
    }
    const cls = el.className && typeof el.className === 'string'
      ? el.className.split(' ').filter(Boolean)[0] : '';
    if (cls) return `.${cls}`;
    if (el.id) return `#${el.id}`;
    return tag;
  }

  _buildElementTree(container, element, depth) {
    if (element.nodeType !== 1) return;
    const tag = element.tagName.toLowerCase();
    if (['script', 'style', 'link', 'meta', 'head', 'noscript', 'br'].includes(tag)) return;

    const children = Array.from(element.children).filter(
      c => !['script', 'style', 'link', 'meta', 'noscript'].includes(c.tagName.toLowerCase())
    );
    const hasChildren = children.length > 0;
    const elId = this._getElementTreeId(element);
    const isCollapsed = this._collapsedElements.has(elId);
    const isSelected = element === this.selectedElement;

    const row = h('div', {
      className: `el-row${isSelected ? ' selected' : ''}`,
    });
    row.style.paddingLeft = `${6 + depth * 14}px`;

    // Chevron
    const chevron = h('span', { className: `el-chevron${hasChildren ? '' : ' empty'}` });
    if (hasChildren) {
      chevron.innerHTML = isCollapsed
        ? '<svg width="8" height="8" viewBox="0 0 8 8"><path d="M2 1.5l3 2.5-3 2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>'
        : '<svg width="8" height="8" viewBox="0 0 8 8"><path d="M1.5 2l2.5 3-2.5 3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" fill="none" transform="rotate(90 4 4)"/></svg>';
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isCollapsed) this._collapsedElements.delete(elId);
        else this._collapsedElements.add(elId);
        this.refreshRightPanel();
      });
    }
    row.appendChild(chevron);

    // Icon
    const icon = h('span', { className: 'el-icon' });
    icon.innerHTML = this._getElementIcon(tag);
    row.appendChild(icon);

    // Label
    row.appendChild(h('span', { className: 'el-label' }, this._getElementLabel(element)));

    // Tag type (subtle)
    if (tag !== 'body') {
      row.appendChild(h('span', { className: 'el-type' }, tag));
    }

    // Click to select
    row.addEventListener('click', () => {
      this.selectElement(element);
      element.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
    });

    // Hover: highlight in canvas
    row.addEventListener('mouseenter', () => {
      if (this._currentTool !== 'navigate') this.showHover(element);
    });
    row.addEventListener('mouseleave', () => this.clearHover());

    container.appendChild(row);

    if (hasChildren && !isCollapsed) {
      for (const child of children) {
        this._buildElementTree(container, child, depth + 1);
      }
    }
  }

  _getElementTreeId(el) {
    const parts = [];
    let node = el;
    while (node && node !== node.ownerDocument?.documentElement) {
      const parent = node.parentElement;
      if (parent) {
        const idx = Array.from(parent.children).indexOf(node);
        parts.unshift(idx);
      }
      node = parent;
    }
    return parts.join('-');
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
      });
      if (o.svg) btn.innerHTML = o.l; else btn.textContent = o.l;
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
    const al = (d) => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">${d}</svg>`;
    b.appendChild(this._tog([
      { l: al('<line x1="2" y1="3.5" x2="12" y2="3.5"/><line x1="2" y1="7" x2="9" y2="7"/><line x1="2" y1="10.5" x2="11" y2="10.5"/>'), v: 'left', svg: true },
      { l: al('<line x1="2" y1="3.5" x2="12" y2="3.5"/><line x1="3.5" y1="7" x2="10.5" y2="7"/><line x1="2.5" y1="10.5" x2="11.5" y2="10.5"/>'), v: 'center', svg: true },
      { l: al('<line x1="2" y1="3.5" x2="12" y2="3.5"/><line x1="5" y1="7" x2="12" y2="7"/><line x1="3" y1="10.5" x2="12" y2="10.5"/>'), v: 'right', svg: true },
      { l: al('<line x1="2" y1="3.5" x2="12" y2="3.5"/><line x1="2" y1="7" x2="12" y2="7"/><line x1="2" y1="10.5" x2="12" y2="10.5"/>'), v: 'justify', svg: true },
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

    // Re-inject data-wia-id attributes for override CSS selectors
    this._restoreWiaIds(doc);
  }

  // Re-apply data-wia-id attributes that wia-overrides.css targets
  _restoreWiaIds(doc) {
    if (!doc) return;
    try {
      for (const sheet of doc.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        const href = sheet.href || '';
        if (!href.includes('wia-overrides')) continue;
        for (const rule of rules) {
          if (rule.type !== 1) continue;
          const match = rule.selectorText?.match(/\[data-wia-id="([^"]+)"\]/);
          if (!match) continue;
          const wiaId = match[1];
          // Already has this attribute somewhere? skip
          if (doc.querySelector(`[data-wia-id="${wiaId}"]`)) continue;
          // Try to find the element by the rest of the selector (without the wia-id part)
          // If we can't, the override is orphaned — it won't apply but that's ok
        }
      }
    } catch {}
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
    this.refreshRightPanel(true);
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

  refreshRightPanel(scrollToSelected) {
    const oldTree = this.panelRight.querySelector('.el-tree');
    const prevScroll = oldTree ? oldTree.scrollTop : 0;

    const parent = this.panelRight.parentElement;
    const newPanel = this.renderRightPanel();
    parent.replaceChild(newPanel, this.panelRight);
    this.panelRight = newPanel;

    const newTree = this.panelRight.querySelector('.el-tree');
    if (newTree) {
      if (scrollToSelected) {
        requestAnimationFrame(() => {
          const sel = newTree.querySelector('.el-row.selected');
          if (sel) sel.scrollIntoView({ block: 'nearest' });
        });
      } else {
        newTree.scrollTop = prevScroll;
      }
    }
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
    const originalText = element.textContent;

    element.contentEditable = true;
    element.focus();
    element.style.outline = 'none';

    const finish = async () => {
      element.contentEditable = false;
      element.removeEventListener('blur', finish);
      element.removeEventListener('keydown', onKey);

      const newText = element.textContent;
      if (newText === originalText) return;

      // Try direct file replacement first (zero tokens, instant)
      const files = this.files.filter(f =>
        ['html', 'jsx', 'tsx', 'js', 'ts', 'vue', 'svelte'].includes(f.type)
      );
      let replaced = false;
      for (const file of files) {
        try {
          await api.post('/api/writeback/text-replace', {
            filePath: file.path,
            oldText: originalText,
            newText: newText,
          });
          replaced = true;
          this._showQuickFeedback(`Text updated in ${file.relativePath}`);
          break;
        } catch {
          continue;
        }
      }

      // Fallback to AI if direct replacement failed
      if (!replaced) {
        if (this.devServer) {
          this._showQuickFeedback('Direct edit failed — sending to AI...');
          const desc = this._describeElement(element);
          this.sendChatMessage(`Change the text of ${desc} from "${originalText.slice(0, 60)}" to "${newText.slice(0, 200)}"`);
        } else {
          this._showQuickFeedback('Text not found in source files');
        }
      }
    };

    const onKey = (e) => {
      if (e.key === 'Escape') {
        element.textContent = originalText;
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

  _updateModeBtn() {
    const icons = {
      auto: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M13 2l-2 2 2 2" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
      ask: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z" stroke="currentColor" stroke-width="2"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="17" r=".5" fill="currentColor"/></svg>',
      plan: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 12h8M8 8h8M8 16h4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    };
    const labels = { auto: 'Edit automatically', ask: 'Ask before edits', plan: 'Plan mode' };
    const cls = this._chatEditMode === 'plan' ? ' chat-mode-btn--plan' : '';
    this._chatModeBtn.className = 'chat-mode-btn' + cls;
    this._chatModeBtn.innerHTML = `${icons[this._chatEditMode]}<span>${labels[this._chatEditMode]}</span>`;
  }

  _updateAttachPreview() {
    if (!this._chatAttachedFiles.length) {
      this._chatAttachPreview.style.display = 'none';
      return;
    }
    this._chatAttachPreview.style.display = 'flex';
    this._chatAttachPreview.innerHTML = this._chatAttachedFiles
      .map((f, i) =>
        `<span class="chat-attach-chip">${f.name}<button data-idx="${i}">&times;</button></span>`
      ).join('');
    this._chatAttachPreview.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('click', () => {
        this._chatAttachedFiles.splice(parseInt(btn.dataset.idx), 1);
        this._updateAttachPreview();
      });
    });
  }

  _updateCostDisplay(cost) {
    if (!this._chatContextLabel) return;
    this._sessionCost = (this._sessionCost || 0) + cost;
    const display = this._sessionCost < 0.01
      ? `$${this._sessionCost.toFixed(4)}`
      : `$${this._sessionCost.toFixed(2)}`;
    this._chatContextLabel.querySelector('span').textContent = display;
  }

  // Simple markdown renderer — no external deps
  _renderMarkdown(text) {
    if (!text) return '';
    const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

    // Extract code blocks first to protect them
    const codeBlocks = [];
    let safe = text.replace(/```(\w*)\s*\n([\s\S]*?)```/g, (_m, _lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push(`<pre class="chat-code-block"><button class="chat-copy-btn" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button><code>${esc(code.replace(/\n$/, ''))}</code></pre>`);
      return `\n%%CODEBLOCK_${idx}%%\n`;
    });

    // Split into blocks by double newlines
    const blocks = safe.split(/\n{2,}/);
    const out = [];

    for (const block of blocks) {
      const trimmed = block.trim();
      if (!trimmed) continue;

      // Code block placeholder
      const cbMatch = trimmed.match(/^%%CODEBLOCK_(\d+)%%$/);
      if (cbMatch) {
        out.push(codeBlocks[parseInt(cbMatch[1])]);
        continue;
      }

      // Headings
      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        out.push(`<h${level} class="chat-heading chat-h${level}">${this._inlineMarkdown(esc(headingMatch[2]))}</h${level}>`);
        continue;
      }

      // List block (- or 1.)
      const lines = trimmed.split('\n');
      if (lines[0].match(/^\s*[-*]\s/) || lines[0].match(/^\s*\d+\.\s/)) {
        const isOrdered = !!lines[0].match(/^\s*\d+\.\s/);
        const tag = isOrdered ? 'ol' : 'ul';
        const items = lines
          .filter(l => l.trim())
          .map(l => {
            const content = l.replace(/^\s*[-*]\s+/, '').replace(/^\s*\d+\.\s+/, '');
            return `<li>${this._inlineMarkdown(esc(content))}</li>`;
          })
          .join('');
        out.push(`<${tag} class="chat-list">${items}</${tag}>`);
        continue;
      }

      // Regular paragraph
      const escaped = esc(trimmed);
      const withBr = escaped.replace(/\n/g, '<br>');
      out.push(`<p>${this._inlineMarkdown(withBr)}</p>`);
    }

    return out.join('');
  }

  _inlineMarkdown(html) {
    // Inline code
    html = html.replace(/`([^`\n]+)`/g, '<code class="chat-code-inline">$1</code>');
    // Markdown links [text](url) — file links open in editor
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text, href) => {
      // Detect file paths (relative, no protocol)
      if (!href.match(/^https?:\/\//) && (href.match(/\.\w+/) || href.includes('/'))) {
        const line = href.match(/#L(\d+)/)?.[1] || '';
        const cleanPath = href.replace(/#L\d+.*$/, '');
        return `<a class="chat-file-link" data-path="${cleanPath}" data-line="${line}" title="${cleanPath}">${text}</a>`;
      }
      return `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
    });
    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
    return html;
  }

  // Chat with AI — SSE streaming with fallback
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
      context.selectedElement = this._buildElementContext(this.selectedElement);
    }

    // Load current file contents for context
    for (const file of this.files.filter(f => f.type === 'html' || f.type === 'css')) {
      try {
        const data = await api.get(`/api/files/read?path=${encodeURIComponent(file.path)}`);
        context.fileContents[file.relativePath] = data.content;
      } catch {}
    }

    // Create AI message container for streaming
    const aiMsg = h('div', { className: 'chat-message chat-message-ai' });
    this.chatMessages.appendChild(aiMsg);

    const scrollToBottom = () => {
      this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
    };

    // Thinking loader with rotating words + morphing icon
    const thinkingWords = ['Thinking...', 'Reasoning...', 'Analyzing...', 'Working...', 'Coding...', 'Vibing...'];
    let thinkingIdx = 0;
    const thinkingEl = document.createElement('div');
    thinkingEl.className = 'chat-thinking-loader';
    // SVG sparkle with real path morphing (5-petal flower like VS Code)
    const svgNS = 'http://www.w3.org/2000/svg';
    const sparkleSvg = document.createElementNS(svgNS, 'svg');
    sparkleSvg.setAttribute('class', 'chat-sparkle-svg');
    sparkleSvg.setAttribute('width', '16');
    sparkleSvg.setAttribute('height', '16');
    sparkleSvg.setAttribute('viewBox', '0 0 32 32');
    sparkleSvg.setAttribute('fill', 'currentColor');
    const sparklePath = document.createElementNS(svgNS, 'path');
    sparklePath.setAttribute('class', 'chat-sparkle-path');
    sparkleSvg.appendChild(sparklePath);

    // 3-phase morph: dot → rounded flower → pointed star → dot (like VS Code)
    const cx = 16, cy = 16, petalCount = 5;
    const buildFlower = (outerR, bulge, innerR) => {
      let d = '';
      for (let i = 0; i < petalCount; i++) {
        const angle = (Math.PI * 2 * i) / petalCount - Math.PI / 2;
        const nextAngle = (Math.PI * 2 * (i + 1)) / petalCount - Math.PI / 2;
        const midAngle = (angle + nextAngle) / 2;
        const tipX = cx + Math.cos(angle) * outerR;
        const tipY = cy + Math.sin(angle) * outerR;
        const valleyX = cx + Math.cos(midAngle) * innerR;
        const valleyY = cy + Math.sin(midAngle) * innerR;
        const cp1x = cx + Math.cos(angle + 0.35) * bulge;
        const cp1y = cy + Math.sin(angle + 0.35) * bulge;
        const cp2x = cx + Math.cos(midAngle - 0.35) * bulge;
        const cp2y = cy + Math.sin(midAngle - 0.35) * bulge;
        if (i === 0) d += `M${tipX.toFixed(1)},${tipY.toFixed(1)}`;
        d += ` C${cp1x.toFixed(1)},${cp1y.toFixed(1)} ${cp2x.toFixed(1)},${cp2y.toFixed(1)} ${valleyX.toFixed(1)},${valleyY.toFixed(1)}`;
        const nTipX = cx + Math.cos(nextAngle) * outerR;
        const nTipY = cy + Math.sin(nextAngle) * outerR;
        const cp3x = cx + Math.cos(midAngle + 0.35) * bulge;
        const cp3y = cy + Math.sin(midAngle + 0.35) * bulge;
        const cp4x = cx + Math.cos(nextAngle - 0.35) * bulge;
        const cp4y = cy + Math.sin(nextAngle - 0.35) * bulge;
        d += ` C${cp3x.toFixed(1)},${cp3y.toFixed(1)} ${cp4x.toFixed(1)},${cp4y.toFixed(1)} ${nTipX.toFixed(1)},${nTipY.toFixed(1)}`;
      }
      return d + 'Z';
    };
    const buildDot = (r) => `M${cx-r},${cy} a${r},${r} 0 1,0 ${r*2},0 a${r},${r} 0 1,0 -${r*2},0Z`;

    // Phase 0: dot → flower (grow + round petals)
    // Phase 1: flower → star (petals sharpen)
    // Phase 2: star → dot (shrink back)
    let bloomT = 0;
    const bloomSpeed = 0.014;
    const steps = 4; // fewer steps = more brutal jumps between shapes
    const morphInterval = setInterval(() => {
      bloomT = (bloomT + bloomSpeed) % 1;

      let phase, t;
      if (bloomT < 0.33) {
        phase = 0; t = bloomT / 0.33;
      } else if (bloomT < 0.66) {
        phase = 1; t = (bloomT - 0.33) / 0.33;
      } else {
        phase = 2; t = (bloomT - 0.66) / 0.34;
      }
      // Stepped/quantized easing — retro saccadé effect
      const ease = Math.floor(t * steps) / steps;

      let path;
      if (phase === 0) {
        // Dot → pointed star
        if (ease < 0.3) {
          path = buildDot(4);
        } else {
          const p = (ease - 0.3) / 0.7;
          path = buildFlower(5 + p * 6, 3 + p * 2, 2 + p * 1);
        }
      } else if (phase === 1) {
        // Pointed star → rounded flower (smaller)
        path = buildFlower(11, 5 + ease * 6, 3 + ease * 4);
      } else {
        // Rounded flower → dot
        if (ease < 0.7) {
          const p = ease / 0.7;
          path = buildFlower(11 - p * 6, 11 - p * 8, 7 - p * 5);
        } else {
          path = buildDot(4);
        }
      }
      sparklePath.setAttribute('d', path);
    }, 30);

    sparklePath.setAttribute('d', buildDot(4));
    const wordSpan = document.createElement('span');
    wordSpan.className = 'chat-thinking-word';
    wordSpan.textContent = thinkingWords[0];
    thinkingEl.appendChild(sparkleSvg);
    thinkingEl.appendChild(wordSpan);
    aiMsg.appendChild(thinkingEl);
    scrollToBottom();

    // Text scramble effect — letters replaced randomly one by one
    const scrambleChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
    let scrambleRAF = null;
    const scrambleTo = (target) => {
      const len = Math.max(wordSpan.textContent.length, target.length);
      const resolved = new Array(len).fill(false);
      const current = (wordSpan.textContent + ' '.repeat(len)).slice(0, len).split('');
      let resolvedCount = 0;
      const tick = () => {
        // Each frame, randomly resolve 1-2 unresolved chars or scramble them
        for (let i = 0; i < len; i++) {
          if (resolved[i]) continue;
          if (Math.random() < 0.08) {
            // Resolve this character
            current[i] = i < target.length ? target[i] : '';
            resolved[i] = true;
            resolvedCount++;
          } else {
            // Random scramble
            current[i] = scrambleChars[Math.floor(Math.random() * scrambleChars.length)];
          }
        }
        wordSpan.textContent = current.join('').trim();
        if (resolvedCount < len) {
          scrambleRAF = requestAnimationFrame(tick);
        } else {
          wordSpan.textContent = target;
        }
      };
      if (scrambleRAF) cancelAnimationFrame(scrambleRAF);
      scrambleRAF = requestAnimationFrame(tick);
    };

    const wordInterval = setInterval(() => {
      thinkingIdx = (thinkingIdx + 1) % thinkingWords.length;
      scrambleTo(thinkingWords[thinkingIdx]);
    }, 2500);

    const removeThinking = () => {
      clearInterval(wordInterval);
      clearInterval(morphInterval);
      if (scrambleRAF) cancelAnimationFrame(scrambleRAF);
      if (thinkingEl.parentNode) thinkingEl.remove();
    };

    // Move thinking loader to bottom of aiMsg (keeps it visible while tools stream)
    const moveThinkingToBottom = () => {
      if (thinkingEl.parentNode) aiMsg.appendChild(thinkingEl);
    };

    try {
      // Attempt SSE streaming via SDK endpoint
      const response = await fetch('/api/ai/sdk/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: text, context, projectPath: this.projectPath, sessionId: this._chatSessionId, editMode: this._chatEditMode }),
      });

      if (!response.ok) {
        removeThinking();
        await this._sendChatFallback(text, context, aiMsg);
        scrollToBottom();
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let textAccumulator = '';
      let textDiv = null;
      let cursorSpan = null;
      let thinkingRemoved = false;

      const ensureThinkingRemoved = () => {
        if (!thinkingRemoved) {
          removeThinking();
          thinkingRemoved = true;
        }
      };

      // Add streaming cursor
      const ensureTextDiv = () => {
        if (!textDiv) {
          textDiv = document.createElement('div');
          textDiv.className = 'chat-text';
          // If there's a tool group before, attach text as last timeline item with a dot
          const lastGroup = aiMsg.querySelector('.chat-tool-group:last-of-type');
          const lastChild = aiMsg.lastElementChild;
          if (lastGroup && (lastChild === lastGroup || lastChild?.classList.contains('chat-thinking-loader'))) {
            const textRow = document.createElement('div');
            textRow.className = 'chat-tool-use chat-tool-use--response';
            textRow.innerHTML = '<span class="chat-tool-dot chat-tool-dot--response"></span>';
            textRow.appendChild(textDiv);
            lastGroup.appendChild(textRow);
            updateGroupLine(lastGroup);
          } else {
            aiMsg.appendChild(textDiv);
          }
        }
        return textDiv;
      };

      const updateCursor = () => {
        if (cursorSpan) cursorSpan.remove();
        cursorSpan = document.createElement('span');
        cursorSpan.className = 'chat-cursor';
        const td = ensureTextDiv();
        td.appendChild(cursorSpan);
      };

      const removeCursor = () => {
        if (cursorSpan) {
          cursorSpan.remove();
          cursorSpan = null;
        }
      };

      // Recalculate the vertical line height for a tool group
      const updateGroupLine = (group) => {
        if (!group) return;
        requestAnimationFrame(() => {
          const dots = group.querySelectorAll('.chat-tool-dot');
          if (dots.length < 2) { group.style.setProperty('--line-h', '0px'); return; }
          const first = dots[0];
          const last = dots[dots.length - 1];
          const firstCenter = first.getBoundingClientRect().top + first.offsetHeight / 2;
          const lastCenter = last.getBoundingClientRect().top + last.offsetHeight / 2;
          group.style.setProperty('--line-h', `${lastCenter - firstCenter}px`);
        });
      };

      scrollToBottom();

      const toolTypeMap = {
        Read: 'read', View: 'read',
        Edit: 'edit', Replace: 'edit',
        Write: 'write',
        Glob: 'search', Grep: 'search', Search: 'search',
        Bash: 'bash', Agent: 'agent',
      };
      let lastToolEl = null; // Track the last tool element for tool_result pairing

      // Read stream
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const lines = sseBuffer.split('\n');
        // Keep the last potentially incomplete line in buffer
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;

          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            continue;
          }

          // Close current thinking dropdown when switching to another event type
          const closeThinking = () => {
            const td = aiMsg.querySelector('.chat-thinking:last-of-type');
            if (td) td._closed = true;
          };

          if (data.type === 'text') {
            closeThinking();
            moveThinkingToBottom();
            textAccumulator += data.content || '';
            const td = ensureTextDiv();
            removeCursor();
            td.innerHTML = this._renderMarkdown(textAccumulator);
            updateCursor();
            moveThinkingToBottom();
            scrollToBottom();
          } else if (data.type === 'tool_use') {
            closeThinking();
            moveThinkingToBottom();
            // Finalize current text block before tool use
            if (textDiv && textAccumulator) {
              removeCursor();
              textDiv.innerHTML = this._renderMarkdown(textAccumulator);
              textDiv = null;
              textAccumulator = '';
            }

            const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const toolName = data.tool || data.name || '';
            const toolBase = toolName.split('/').pop().split('.').shift();
            const dotType = toolTypeMap[toolBase] || toolTypeMap[toolName] || 'search';
            const input = data.input || {};

            // Get or create tool group (connected dots with vertical line)
            const allGroups = aiMsg.querySelectorAll('.chat-tool-group');
            let toolGroup = allGroups.length ? allGroups[allGroups.length - 1] : null;
            let shouldBreak = !toolGroup;
            if (toolGroup) {
              let sib = toolGroup.nextElementSibling;
              while (sib) {
                if (!sib.classList.contains('chat-thinking-loader') && !sib.classList.contains('chat-thinking')) { shouldBreak = true; break; }
                sib = sib.nextElementSibling;
              }
            }
            if (shouldBreak) {
              toolGroup = document.createElement('div');
              toolGroup.className = 'chat-tool-group';
              aiMsg.appendChild(toolGroup);
            }

            const toolEl = document.createElement('div');
            toolEl.className = 'chat-tool-use';
            const contentWrap = document.createElement('div');
            contentWrap.className = 'chat-tool-content';

            // ── Bash: code block with IN label ──
            if (toolBase === 'Bash' || toolName === 'Bash') {
              const cmd = input.command || '';
              contentWrap.innerHTML = `<div class="chat-tool-header"><span class="chat-tool-name">Bash</span></div>`;
              const inBlock = document.createElement('div');
              inBlock.className = 'chat-tool-io';
              inBlock.innerHTML =
                `<span class="chat-io-label">IN</span>` +
                `<pre class="chat-code-block"><button class="chat-copy-btn" data-copy="${esc(cmd).replace(/"/g, '&quot;')}" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button><code>${esc(cmd)}</code></pre>`;
              contentWrap.appendChild(inBlock);

            // ── Agent: header + prompt ──
            } else if (toolBase === 'Agent' || toolName === 'Agent') {
              const desc = input.description || input.prompt?.slice(0, 60) || 'Sub-agent';
              const prompt = input.prompt || '';
              contentWrap.innerHTML = `<div class="chat-tool-header"><span class="chat-tool-name">Agent:</span> <span class="chat-tool-path">${esc(desc)}</span></div>`;
              if (prompt) {
                const inBlock = document.createElement('div');
                inBlock.className = 'chat-tool-io';
                const truncated = prompt.length > 300 ? prompt.slice(0, 300) + '...' : prompt;
                inBlock.innerHTML =
                  `<span class="chat-io-label">IN</span>` +
                  `<pre class="chat-code-block"><button class="chat-copy-btn" data-copy="${esc(prompt).replace(/"/g, '&quot;')}" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button><code>${esc(truncated)}</code></pre>`;
                contentWrap.appendChild(inBlock);
              }

            // ── Edit: diff view ──
            } else if (toolBase === 'Edit' || toolName === 'Edit') {
              const actualPath = input.file_path || input.path || '';
              const shortPath = actualPath ? actualPath.split('/').pop() : '';
              contentWrap.innerHTML = `<div class="chat-tool-header"><span class="chat-tool-name">Edit</span> <span class="chat-tool-path">${esc(shortPath)}</span></div>`;

              if (input.old_string || input.new_string) {
                const oldStr = input.old_string || '';
                const newStr = input.new_string || '';
                const oldLines = oldStr ? oldStr.split('\n') : [];
                const newLines = newStr ? newStr.split('\n') : [];
                const added = newLines.filter(l => !oldLines.includes(l)).length;
                const removed = oldLines.filter(l => !newLines.includes(l)).length;

                let summary = '';
                if (removed && added) summary = `${removed} removed, ${added} added`;
                else if (removed) summary = `Removed ${removed} line${removed > 1 ? 's' : ''}`;
                else if (added) summary = `Added ${added} line${added > 1 ? 's' : ''}`;
                else summary = 'Changed';

                const diffEl = document.createElement('details');
                diffEl.className = 'chat-tool-diff';
                let diffHTML = `<summary>${summary}</summary><div class="chat-diff-content">`;
                for (const line of oldLines) {
                  if (!newLines.includes(line)) {
                    diffHTML += `<div class="chat-diff-removed">${esc(line)}</div>`;
                  } else {
                    diffHTML += `<div class="chat-diff-ctx">${esc(line)}</div>`;
                  }
                }
                for (const line of newLines) {
                  if (!oldLines.includes(line)) {
                    diffHTML += `<div class="chat-diff-added">${esc(line)}</div>`;
                  }
                }
                diffHTML += '</div>';
                diffEl.innerHTML = diffHTML;
                contentWrap.appendChild(diffEl);
              }

            // ── Write: code preview ──
            } else if (toolBase === 'Write' || toolName === 'Write') {
              const actualPath = input.file_path || input.path || '';
              const shortPath = actualPath ? actualPath.split('/').pop() : '';
              contentWrap.innerHTML = `<div class="chat-tool-header"><span class="chat-tool-name">Write</span> <span class="chat-tool-path">${esc(shortPath)}</span></div>`;
              const content = input.content || '';
              if (content) {
                const previewEl = document.createElement('details');
                previewEl.className = 'chat-tool-code-preview';
                const previewLines = content.split('\n').length;
                previewEl.innerHTML =
                  `<summary>${previewLines} line${previewLines > 1 ? 's' : ''}</summary>` +
                  `<pre class="chat-code-block"><button class="chat-copy-btn" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button><code>${esc(content.length > 500 ? content.slice(0, 500) + '\n...' : content)}</code></pre>`;
                contentWrap.appendChild(previewEl);
              }

            // ── Default: Read, Grep, Glob, etc. ──
            } else {
              const actualPath = input.file_path || input.path || data.file_path || data.path || '';
              const shortPath = actualPath ? actualPath.split('/').pop() : '';
              let lineInfo = '';
              if (input.offset || input.limit) {
                const start = input.offset || 1;
                const end = input.limit ? start + input.limit - 1 : '';
                lineInfo = end ? ` (lines ${start}-${end})` : ` (line ${start})`;
              }
              let toolLabel = shortPath + lineInfo;
              let detail = '';
              if (toolBase === 'Grep' || toolName === 'Grep') {
                toolLabel = input.pattern ? `"${input.pattern}"` : '';
                detail = shortPath ? `in ${shortPath}` : '';
              } else if (toolBase === 'Glob' || toolName === 'Glob') {
                toolLabel = input.pattern || shortPath || '';
              }
              contentWrap.innerHTML =
                `<div class="chat-tool-header"><span class="chat-tool-name">${esc(toolBase || toolName)}</span>` +
                `<span class="chat-tool-path">${esc(toolLabel)}</span></div>`;
              if (detail) {
                const detailEl = document.createElement('div');
                detailEl.className = 'chat-tool-detail';
                const detailText = detail.length > 120 ? detail.slice(0, 120) + '...' : detail;
                detailEl.innerHTML = `<span class="chat-detail-text">${esc(detailText)}</span><button class="chat-copy-btn chat-copy-btn--inline" data-copy="${esc(detail).replace(/"/g,'&quot;')}" title="Copy"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>`;
                contentWrap.appendChild(detailEl);
              }
            }

            toolEl.innerHTML = `<span class="chat-tool-dot chat-tool-dot--${dotType}"></span>`;
            toolEl.appendChild(contentWrap);
            toolGroup.appendChild(toolEl);
            lastToolEl = toolEl;

            updateGroupLine(toolGroup);

            moveThinkingToBottom();
            scrollToBottom();
          } else if (data.type === 'tool_result') {
            // Append output to the last tool element (Bash OUT, Agent result, etc.)
            if (lastToolEl) {
              const resultContent = data.content || '';
              if (resultContent.trim()) {
                const wrap = lastToolEl.querySelector('.chat-tool-content');
                if (wrap) {
                  const escR = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                  const outBlock = document.createElement('div');
                  outBlock.className = 'chat-tool-io';
                  const truncated = resultContent.length > 800 ? resultContent.slice(0, 800) + '\n...' : resultContent;
                  outBlock.innerHTML =
                    `<span class="chat-io-label">OUT</span>` +
                    `<pre class="chat-code-block chat-code-block--out"><button class="chat-copy-btn" title="Copy"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button><code>${escR(truncated)}</code></pre>`;
                  wrap.appendChild(outBlock);
                  scrollToBottom();
                }
              }
            }
          } else if (data.type === 'thinking') {
            moveThinkingToBottom();
            // Accumulate thinking chunks into a single dropdown
            let thinkDetails = aiMsg.querySelector('.chat-thinking:last-of-type');
            if (!thinkDetails || thinkDetails._closed) {
              thinkDetails = document.createElement('details');
              thinkDetails.className = 'chat-thinking';
              const summary = document.createElement('summary');
              summary.className = 'chat-thinking-header';
              summary.innerHTML = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M6 4l4 4-4 4"/></svg>Thinking`;
              const content = document.createElement('div');
              content.className = 'chat-thinking-content';
              thinkDetails.appendChild(summary);
              thinkDetails.appendChild(content);
              // Insert thinking inside current tool group to keep timeline continuous
              const currentGroup = aiMsg.querySelector('.chat-tool-group:last-of-type');
              if (currentGroup && !currentGroup.querySelector('.chat-tool-use--response')) {
                currentGroup.appendChild(thinkDetails);
              } else {
                aiMsg.appendChild(thinkDetails);
              }
            }
            const thinkContent = thinkDetails.querySelector('.chat-thinking-content');
            thinkContent.textContent += data.content || '';
            scrollToBottom();
          } else if (data.type === 'changes_applied') {
            // Auto mode — changes already written by CLI, just show confirmation
            const appliedEl = h('div', { className: 'chat-changes-applied' },
              `${(data.changes || []).length} fichier(s) modifie(s)`,
            );
            aiMsg.appendChild(appliedEl);
            scrollToBottom();
          } else if (data.type === 'changes_pending') {
            const actions = h('div', { className: 'chat-actions' },
              h('button', {
                className: 'chat-btn-accept',
                onClick: () => this._acceptChanges(actions),
              }, 'Accept'),
              h('button', {
                className: 'chat-btn-reject',
                onClick: () => this._rejectChanges(actions),
              }, 'Reject'),
            );
            aiMsg.appendChild(actions);
            scrollToBottom();
          } else if (data.type === 'done') {
            ensureThinkingRemoved();
            removeCursor();
            if (data.sessionId) this._chatSessionId = data.sessionId;
            if (data.cost != null) this._updateCostDisplay(data.cost);
            scrollToBottom();
          } else if (data.type === 'error') {
            ensureThinkingRemoved();
            removeCursor();
            const errDiv = document.createElement('div');
            errDiv.className = 'chat-error';
            const errText = data.error || data.content || data.message || 'An error occurred';
            console.error('[Chat Error]', data.errorCode, errText);
            // Show clean message for known errors
            if (data.errorCode === 'rate_limit' || errText.includes('already in use')) {
              errDiv.textContent = 'Limite API atteinte — reessayez plus tard.';
            } else if (data.errorCode === 'auth') {
              errDiv.textContent = 'Claude CLI non authentifie. Lancez `claude auth login`.';
            } else {
              errDiv.textContent = errText;
            }
            aiMsg.appendChild(errDiv);
            scrollToBottom();
          }
          // type: 'tool_result' — skip silently
        }
      }

      // Cleanup: ensure cursor + thinking removed when stream ends
      removeThinking();
      removeCursor();

      // If we got text but stream ended without 'done' event, finalize
      if (textDiv && textAccumulator) {
        textDiv.innerHTML = this._renderMarkdown(textAccumulator);
      }
    } catch (err) {
      // Network error or stream failure — fallback
      removeThinking();
      console.warn('SSE streaming failed, falling back:', err.message);
      aiMsg.innerHTML = '';
      await this._sendChatFallback(text, context, aiMsg);
    }

    scrollToBottom();
  }

  // Fallback: non-streaming AI chat
  async _sendChatFallback(text, context, aiMsg) {
    aiMsg.innerHTML = '<div class="chat-loader"><div class="chat-loader-dot"></div></div><span>Thinking...</span>';
    aiMsg.classList.add('chat-loading');

    try {
      const result = await api.post('/api/ai/chat', {
        prompt: text,
        context,
        projectPath: this.projectPath,
      });

      aiMsg.classList.remove('chat-loading');
      aiMsg.innerHTML = '';

      const textDiv = document.createElement('div');
      textDiv.className = 'chat-text';
      textDiv.innerHTML = this._renderMarkdown(result.response || '');
      aiMsg.appendChild(textDiv);

      if (result.changes && result.changes.length > 0) {
        const actions = h('div', { className: 'chat-actions' },
          h('button', {
            className: 'chat-btn-accept',
            onClick: () => this._acceptChanges(actions),
          }, 'Accept'),
          h('button', {
            className: 'chat-btn-reject',
            onClick: () => this._rejectChanges(actions),
          }, 'Reject'),
        );
        aiMsg.appendChild(actions);
      }
    } catch (err) {
      aiMsg.classList.remove('chat-loading');
      aiMsg.innerHTML = '';
      aiMsg.textContent = `Error: ${err.message}`;
    }
  }

  async _acceptChanges(actionsEl) {
    try {
      const res = await api.post('/api/ai/sdk/accept', {
        projectPath: this.projectPath,
        sessionId: this._chatSessionId,
      });
      if (res.accepted) {
        actionsEl.innerHTML = '';
        actionsEl.className = 'chat-changes-applied';
        actionsEl.textContent = 'Changes accepted';
      }
    } catch (err) {
      console.error('Accept failed:', err);
      actionsEl.innerHTML = '';
      actionsEl.className = 'chat-changes-applied';
      actionsEl.textContent = 'Error: ' + err.message;
    }
    // Canvas will auto-refresh via file watcher
  }

  async _rejectChanges(actionsEl) {
    try {
      await api.post('/api/ai/sdk/reject', {
        projectPath: this.projectPath,
        sessionId: this._chatSessionId,
      });
    } catch (err) {
      console.error('Reject failed:', err);
    }
    actionsEl.innerHTML = '';
    actionsEl.className = 'chat-changes-applied';
    actionsEl.textContent = 'Changes rejected';
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
      // 1b. Check if this property is actually inherited/caused by a parent
      const doc = this.iframe?.contentDocument;
      const INHERITABLE = new Set([
        'color', 'font-family', 'font-size', 'font-weight', 'font-style',
        'line-height', 'text-align', 'text-transform', 'letter-spacing',
        'word-spacing', 'white-space', 'visibility', 'cursor', 'direction',
      ]);
      if (doc && INHERITABLE.has(cssProp)) {
        const inherited = this._traceInheritedStyle(element, cssProp, doc);
        if (inherited && inherited.file) {
          // The style comes from a parent — edit the parent's rule instead
          filePath = inherited.file;
          selector = inherited.selector;
          // Skip to the api.post below
        }
      }

      // 2. Fallback: scoped selector + dedicated override file
      if (!filePath) {
        const baseSelector = this._buildScopedSelector(element);
        // Boost specificity so overrides always win over source CSS
        // :where(body):not(#_) adds (1,0,1) without changing what it targets
        // This beats most real-world selectors (.parent .child = 0,2,0)
        selector = `:where(body):not(#_) ${baseSelector}`;
        const overrideFile = await this._ensureOverrideCSS();
        if (!overrideFile) return;
        filePath = overrideFile;
      }
    }

    // Resolve raw value to design token if possible
    const tokenValue = this._resolveToToken(cssProp, value);
    const finalValue = tokenValue || value;

    try {
      await api.post('/api/writeback/css', {
        filePath,
        selector,
        prop: cssProp,
        value: finalValue,
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

  // ── Rich element context for AI chat ──────────────────────────────────────
  _buildElementContext(element) {
    const doc = this.iframe?.contentDocument;
    const tag = element.tagName?.toLowerCase() || '';
    const classes = (typeof element.className === 'string' ? element.className : '').split(/\s+/).filter(Boolean);
    const id = element.id || '';

    // Build selector
    const selector = id ? `${tag}#${id}` : classes.length ? `${tag}.${classes.join('.')}` : tag;

    // Source file
    const sourceFile = this.activePage?.relativePath || null;

    // Computed styles — only the ones useful for visual editing
    const TRACKED = [
      'display', 'flex-direction', 'justify-content', 'align-items', 'flex-wrap', 'gap',
      'width', 'height', 'max-width', 'min-height',
      'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
      'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
      'font-family', 'font-size', 'font-weight', 'line-height', 'text-align', 'color',
      'background-color', 'border', 'border-radius', 'opacity',
      'position', 'top', 'right', 'bottom', 'left', 'z-index',
      'overflow', 'box-sizing',
    ];
    const INHERITABLE = new Set([
      'color', 'font-family', 'font-size', 'font-weight', 'font-style',
      'line-height', 'text-align', 'text-transform', 'letter-spacing',
      'word-spacing', 'white-space', 'visibility', 'cursor', 'direction',
    ]);

    const styles = {};
    if (doc) {
      const computed = getComputedStyle(element);
      const ownRules = this._collectMatchingRules(element, doc);

      for (const prop of TRACKED) {
        const val = computed.getPropertyValue(prop).trim();
        if (!val) continue;

        const own = ownRules.get(prop);
        if (own) {
          // Property is set directly on this element via a CSS rule
          styles[prop] = { value: own.rawValue || val, source: 'own', file: own.file, selector: own.selector };
        } else if (INHERITABLE.has(prop)) {
          // Check if inherited from a parent
          const inherited = this._traceInheritedStyle(element, prop, doc);
          if (inherited) {
            styles[prop] = { value: val, source: 'inherited', from: inherited.selector, file: inherited.file };
          } else {
            styles[prop] = { value: val, source: 'default' };
          }
        } else {
          styles[prop] = { value: val, source: 'default' };
        }
      }
    }

    // Parent context (layout info)
    let parentCtx = null;
    const parent = element.parentElement;
    if (parent && parent !== doc?.body && parent !== doc?.documentElement) {
      const pTag = parent.tagName?.toLowerCase() || '';
      const pClasses = (typeof parent.className === 'string' ? parent.className : '').split(/\s+/).filter(Boolean);
      const pId = parent.id || '';
      const pSel = pId ? `${pTag}#${pId}` : pClasses.length ? `${pTag}.${pClasses[0]}` : pTag;
      const pComp = getComputedStyle(parent);
      parentCtx = {
        selector: pSel,
        display: pComp.display,
        flexDirection: pComp.flexDirection,
        justifyContent: pComp.justifyContent,
        alignItems: pComp.alignItems,
        gap: pComp.gap,
        paddingTop: pComp.paddingTop,
        paddingRight: pComp.paddingRight,
        paddingBottom: pComp.paddingBottom,
        paddingLeft: pComp.paddingLeft,
      };
    }

    // CSS custom properties in use on this element
    const customProps = {};
    if (doc) {
      const ownRules = this._collectMatchingRules(element, doc);
      for (const [, info] of ownRules) {
        if (info.rawValue?.includes('var(--')) {
          const matches = info.rawValue.match(/var\(--[^)]+\)/g);
          if (matches) {
            for (const m of matches) {
              const varName = m.slice(4, -1); // --foo-bar
              const resolved = getComputedStyle(doc.documentElement).getPropertyValue(varName).trim();
              customProps[varName] = resolved;
            }
          }
        }
      }
    }

    return {
      tag,
      selector,
      classes: classes.join(' '),
      id,
      sourceFile,
      html: element.outerHTML?.slice(0, 1500),
      styles,
      parent: parentCtx,
      customProperties: Object.keys(customProps).length ? customProps : undefined,
    };
  }

  // Collect all CSS rules matching an element → Map<prop, { selector, file, rawValue }>
  _collectMatchingRules(element, doc) {
    const map = new Map();
    try {
      for (const sheet of doc.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }
        const filePath = this._resolveSheetPath(sheet);
        for (const rule of rules) {
          if (rule.type !== 1) continue;
          try { if (!element.matches(rule.selectorText)) continue; } catch { continue; }
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            map.set(prop, {
              selector: rule.selectorText,
              file: filePath,
              rawValue: rule.style.getPropertyValue(prop).trim(),
            });
          }
        }
      }
    } catch {}
    return map;
  }

  // Walk up the DOM to find where an inheritable property is defined
  _traceInheritedStyle(element, prop, doc) {
    let current = element.parentElement;
    while (current && current !== doc.body && current !== doc.documentElement) {
      const rules = this._collectMatchingRules(current, doc);
      if (rules.has(prop)) {
        const info = rules.get(prop);
        const tag = current.tagName?.toLowerCase() || '';
        const cls = (typeof current.className === 'string' ? current.className : '').split(/\s+/).filter(Boolean);
        const id = current.id;
        return {
          selector: id ? `${tag}#${id}` : cls.length ? `${tag}.${cls[0]}` : tag,
          file: info.file,
          rawValue: info.rawValue,
        };
      }
      current = current.parentElement;
    }
    return null;
  }

  // ── Design token resolution ─────────────────────────────────────────────

  // Scan all CSS custom properties in the project → Map<normalizedValue, [{variable, rawValue, resolvedValue}]>
  _scanDesignTokens() {
    const doc = this.iframe?.contentDocument;
    if (!doc) return;

    this._designTokens = new Map();
    this._tokenScanTime = Date.now();

    // Canvas for color normalization
    if (!this._colorCanvas) {
      this._colorCanvas = document.createElement('canvas');
      this._colorCanvas.width = 1;
      this._colorCanvas.height = 1;
      this._colorCtx = this._colorCanvas.getContext('2d');
    }

    const computed = getComputedStyle(doc.documentElement);

    try {
      for (const sheet of doc.styleSheets) {
        let rules;
        try { rules = sheet.cssRules; } catch { continue; }

        for (const rule of rules) {
          if (rule.type !== 1) continue;
          for (let i = 0; i < rule.style.length; i++) {
            const prop = rule.style[i];
            if (!prop.startsWith('--')) continue;

            const rawValue = rule.style.getPropertyValue(prop).trim();
            const resolvedValue = computed.getPropertyValue(prop).trim();
            const normalized = this._normalizeTokenValue(resolvedValue);

            if (!this._designTokens.has(normalized)) {
              this._designTokens.set(normalized, []);
            }
            this._designTokens.get(normalized).push({
              variable: prop,
              rawValue,
              resolvedValue,
              selector: rule.selectorText,
            });
          }
        }
      }
    } catch (e) {
      console.warn('Design token scan failed:', e);
    }
  }

  // Normalize a CSS value for token matching
  _normalizeTokenValue(value) {
    if (!value) return '';
    // Try to normalize as color
    const asColor = this._normalizeColor(value);
    if (asColor) return asColor;
    // Trim whitespace for other values
    return value.trim().toLowerCase();
  }

  // Normalize any CSS color to lowercase 6-digit hex (returns null if not a color)
  _normalizeColor(value) {
    if (!value || value === 'transparent' || value === 'inherit' || value === 'initial') return null;
    try {
      const ctx = this._colorCtx;
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = '#000000'; // reset
      ctx.fillStyle = value;
      const set = ctx.fillStyle;
      // If fillStyle didn't change from reset, it's not a valid color
      // (unless value was actually black)
      if (set === '#000000' && value.trim().toLowerCase() !== '#000000' && value.trim().toLowerCase() !== 'black'
        && value.trim().toLowerCase() !== '#000' && !value.trim().toLowerCase().startsWith('rgb(0')) {
        return null;
      }
      // ctx.fillStyle returns #rrggbb or rgba() for alpha colors
      if (set.startsWith('#')) return set.toLowerCase();
      // Handle rgba
      if (set.startsWith('rgb')) {
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Resolve a raw CSS value to a design token if one matches
  _resolveToToken(prop, rawValue) {
    // Rescan tokens periodically (every 30s) or if not scanned yet
    if (!this._designTokens || (Date.now() - (this._tokenScanTime || 0)) > 30000) {
      this._scanDesignTokens();
    }
    if (!this._designTokens?.size) return null;

    const normalized = this._normalizeTokenValue(rawValue);
    if (!normalized) return null;

    const tokens = this._designTokens.get(normalized);
    if (!tokens?.length) return null;

    // Rank: prefer tokens whose name relates to the property
    const hints = {
      'color': ['text', 'color', 'fg', 'foreground'],
      'background-color': ['bg', 'background', 'surface', 'fill'],
      'background': ['bg', 'background', 'surface'],
      'border-color': ['border', 'stroke', 'outline'],
      'gap': ['space', 'gap'],
      'padding-top': ['space', 'padding', 'pad'],
      'padding-right': ['space', 'padding', 'pad'],
      'padding-bottom': ['space', 'padding', 'pad'],
      'padding-left': ['space', 'padding', 'pad'],
      'margin-top': ['space', 'margin'],
      'margin-right': ['space', 'margin'],
      'margin-bottom': ['space', 'margin'],
      'margin-left': ['space', 'margin'],
      'border-radius': ['radius', 'round', 'corner'],
      'font-family': ['font', 'family', 'typeface'],
      'font-size': ['font-size', 'text-size', 'size'],
    };

    const propHints = hints[prop] || [];
    const ranked = [...tokens].sort((a, b) => {
      const aMatch = propHints.some(h => a.variable.toLowerCase().includes(h)) ? 1 : 0;
      const bMatch = propHints.some(h => b.variable.toLowerCase().includes(h)) ? 1 : 0;
      return bMatch - aMatch;
    });

    return `var(${ranked[0].variable})`;
  }

  // ── Scoped selector + override file ──────────────────────────────────────

  // Build a scoped CSS selector — never bare tag names
  _buildScopedSelector(element) {
    const doc = this.iframe?.contentDocument;
    if (!doc) return element.tagName.toLowerCase();

    // 1. Element has an id → use it
    if (element.id) return `#${element.id}`;

    const tag = element.tagName.toLowerCase();
    const classes = (typeof element.className === 'string' ? element.className : '')
      .split(/\s+/).filter(Boolean);

    // 2. Element has a unique class
    for (const cls of classes) {
      try {
        if (doc.querySelectorAll(`.${cls}`).length === 1) return `.${cls}`;
      } catch { continue; }
    }

    // 3. Element has a non-unique class → scope with nearest unique ancestor
    if (classes.length > 0) {
      const ancestor = this._findUniqueAncestor(element, doc);
      if (ancestor) return `${ancestor} .${classes[0]}`;
      // No unique ancestor — use direct child combinator path
      const path = this._buildChildPath(element, doc);
      if (path) return path;
      return `.${classes[0]}`;
    }

    // 4. No class at all → add data-wia-id attribute
    const wiaId = 'wia-' + Math.random().toString(36).slice(2, 8);
    element.setAttribute('data-wia-id', wiaId);
    return `[data-wia-id="${wiaId}"]`;
  }

  // Find nearest ancestor with a unique id or class
  _findUniqueAncestor(element, doc) {
    let current = element.parentElement;
    while (current && current !== doc.body && current !== doc.documentElement) {
      if (current.id) return `#${current.id}`;
      const cls = (typeof current.className === 'string' ? current.className : '')
        .split(/\s+/).filter(Boolean);
      for (const c of cls) {
        try {
          if (doc.querySelectorAll(`.${c}`).length === 1) return `.${c}`;
        } catch { continue; }
      }
      current = current.parentElement;
    }
    return null;
  }

  // Build a child-combinator path from unique ancestor: .parent > :nth-child(n)
  _buildChildPath(element, doc) {
    const parts = [];
    let current = element;
    let depth = 0;
    while (current && current !== doc.body && depth < 4) {
      const parent = current.parentElement;
      if (!parent) break;
      // Find nth-child index
      const siblings = Array.from(parent.children);
      const idx = siblings.indexOf(current) + 1;
      parts.unshift(`:nth-child(${idx})`);
      // Check if parent has a unique selector
      if (parent.id) { parts.unshift(`#${parent.id}`); return parts.join(' > '); }
      const cls = (typeof parent.className === 'string' ? parent.className : '')
        .split(/\s+/).filter(Boolean);
      for (const c of cls) {
        try {
          if (doc.querySelectorAll(`.${c}`).length === 1) {
            parts.unshift(`.${c}`);
            return parts.join(' > ');
          }
        } catch { continue; }
      }
      current = parent;
      depth++;
    }
    return null;
  }

  // Ensure wia-overrides.css exists and is linked — returns absolute path
  async _ensureOverrideCSS() {
    if (this._overrideCSSPath) return this._overrideCSSPath;
    try {
      const data = await api.post('/api/writeback/ensure-override-css', {
        projectDir: this.projectPath,
        htmlFile: this.activePage?.path || null,
        isFramework: !!this.devServer,
      });
      this._overrideCSSPath = data.path;
      // Inject into iframe if not already present
      const doc = this.iframe?.contentDocument;
      if (doc && !doc.querySelector('link[href*="wia-overrides"]')) {
        const link = doc.createElement('link');
        link.rel = 'stylesheet';
        link.href = data.relativePath || 'wia-overrides.css';
        doc.head.appendChild(link);
      }
      return this._overrideCSSPath;
    } catch (err) {
      console.error('Failed to ensure override CSS:', err);
      return null;
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
    // Framework projects: route through AI to modify source files
    if (this.devServer) {
      if (this._requireAIForFramework('Add element')) return;
      const selCtx = this.selectedElement ? this._describeElement(this.selectedElement) : 'the end of the main component body';
      let html = `<${item.tag}`;
      if (item.attrs) for (const [k, v] of Object.entries(item.attrs)) html += v === true ? ` ${k}` : ` ${k}="${v}"`;
      if (item.selfClosing) { html += ' />'; }
      else {
        html += '>';
        if (item.children) for (const c of item.children) html += `<${c.tag}>${c.text || ''}</${c.tag}>`;
        else if (item.text) html += item.text;
        html += `</${item.tag}>`;
      }
      this.sendChatMessage(`Add this element inside ${selCtx}:\n${html}`);
      this._closeAddPanel();
      return;
    }

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

    this._closeAddPanel();
  }

  _closeAddPanel() {
    if (this._addPanel) {
      this._addPanel.remove();
      this._addPanel = null;
      this._toolAdd.classList.remove('active');
    }
  }

  // Describe an element briefly for AI prompts
  _describeElement(el) {
    const tag = el.tagName?.toLowerCase() || '';
    const id = el.id ? `#${el.id}` : '';
    const cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(Boolean);
    const clsStr = cls.length ? `.${cls[0]}` : '';
    const text = el.textContent?.trim().slice(0, 40);
    const desc = `${tag}${id}${clsStr}`;
    return text ? `${desc} ("${text}")` : desc;
  }

  // Check if framework project can perform DOM ops (needs AI connected)
  _requireAIForFramework(action) {
    if (!this.devServer) return false; // static project — no AI needed
    if (this._aiConnected) return false; // AI connected — good to go
    // Framework project without AI — block and explain
    this._showQuickFeedback(`${action} requires Claude — connect in the chat panel below`);
    // Scroll chat panel into view / flash it
    const chatHeader = this.el.querySelector('.chat-header');
    if (chatHeader) {
      chatHeader.classList.add('flash');
      setTimeout(() => chatHeader.classList.remove('flash'), 1500);
    }
    return true; // blocked
  }

  // Ephemeral feedback message near the canvas
  _showQuickFeedback(msg) {
    const existing = this.el.querySelector('.wia-quick-feedback');
    if (existing) existing.remove();

    const el = h('div', { className: 'wia-quick-feedback' }, msg);
    this.el.querySelector('.canvas-wrapper')?.appendChild(el);
    setTimeout(() => el.remove(), 2500);
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
      isFramework: !!this.devServer,
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
    // Framework projects: use public/ dir and route through AI
    if (this.devServer) {
      if (this._requireAIForFramework('Insert media')) return;
      const mediaPath = relativePath.startsWith('/') ? relativePath : `/${relativePath}`;
      const sel = this.selectedElement;
      const tag = type === 'video' ? `<video src="${mediaPath}" controls style={{ maxWidth: '100%' }} />` : `<img src="${mediaPath}" alt="" style={{ maxWidth: '100%' }} />`;
      if (sel) {
        const desc = this._describeElement(sel);
        if (sel.tagName === 'IMG' && type === 'image') {
          this.sendChatMessage(`Change the src of ${desc} to "${mediaPath}"`);
        } else {
          this.sendChatMessage(`Add ${tag} inside ${desc}`);
        }
      } else {
        this.sendChatMessage(`Add ${tag} to the main component`);
      }
      return;
    }

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

  async _ensureCodeEditor() {
    if (this._cmEditor) return;
    const { CodeEditor } = await import('../components/code-editor.js');
    this._cmEditor = new CodeEditor(this._cmContainer, {
      onSave: () => this._saveCurrentCodeFile(),
      onChange: () => {
        this._codeModified = true;
        this._updateCodeTab();
      },
    });
  }

  _renderBreadcrumb(filePath) {
    this._codeBreadcrumb.innerHTML = '';
    if (!filePath) return;
    const rel = filePath.replace(this.projectPath + '/', '');
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const sep = h('span', { className: 'code-breadcrumb-sep' });
        sep.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        this._codeBreadcrumb.appendChild(sep);
      }
      this._codeBreadcrumb.appendChild(
        h('span', { className: 'code-breadcrumb-seg' }, parts[i])
      );
    }
  }

  _openFileFromChat(relativePath, line) {
    // Resolve relative path to absolute
    const absPath = relativePath.startsWith('/') ? relativePath : this.projectPath + '/' + relativePath;
    this._openCodeFile(absPath);
    if (line && this._cmEditor) {
      // Scroll to line after content loads
      setTimeout(() => {
        if (this._cmEditor.scrollToLine) this._cmEditor.scrollToLine(line);
      }, 200);
    }
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
        await this._ensureCodeEditor();
        this._cmEditor.setContent(data.content || '', filePath);
        this._renderBreadcrumb(filePath);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
      }
    }
    if (lastErr) {
      console.error('[code-editor] Failed to load file:', url, lastErr);
      await this._ensureCodeEditor();
      this._cmEditor.setContent(`// Error loading file: ${lastErr.message}\n// Path: ${filePath}`, filePath);
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
        if (this._cmEditor) this._cmEditor.setContent('', null);
        this._codeBreadcrumb.innerHTML = '';
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
        content: this._cmEditor?.getContent() || '',
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

    // Helper to refresh status + current tab in-place
    const refreshPanel = async () => {
      try {
        status = await api.get(q('/api/git/status'));
      } catch { /* keep old status */ }
      renderSyncBar();
      await renderTab(activeTab);
    };

    const renderTab = async (tab) => {
      activeTab = tab;
      tabs.querySelectorAll('.git-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      tabContent.innerHTML = '';

      if (tab === 'changes') {
        await this._renderGitChanges(tabContent, status, dir, refreshPanel);
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

    // Remote info bar (display only — commit & push handles sync)
    let syncBarEl = null;
    const renderSyncBar = () => {
      if (syncBarEl) syncBarEl.remove();
      if (!status.remote) return;
      const repoName = status.remote.replace('https://github.com/', '').replace('.git', '');
      syncBarEl = h('div', { className: 'git-sync-bar' },
        h('div', { className: 'git-sync-info' }, repoName),
      );
      panel.appendChild(syncBarEl);
    };
    renderSyncBar();

    // Render initial tab
    renderTab('changes');
  }

  async _renderGitChanges(container, status, dir, refreshPanel) {
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
    const hasRemote = !!status.remote;
    const commitInput = h('textarea', {
      className: 'git-commit-input',
      placeholder: 'Commit message...',
      rows: '2',
    });

    const statusMsg = h('div', { className: 'git-status-msg' });
    const btnLabel = hasRemote ? 'Commit & Push' : 'Commit';
    const commitBtn = h('button', {
      className: 'git-btn git-btn-primary',
      onClick: async () => {
        const msg = commitInput.value.trim();
        if (!msg) { statusMsg.textContent = 'Enter a commit message'; return; }
        commitBtn.disabled = true;
        try {
          // Auto-pull if behind remote
          if (hasRemote && status.behind > 0) {
            commitBtn.textContent = 'Syncing...';
            await api.post('/api/git/pull', { dir });
          }

          // Commit
          commitBtn.textContent = 'Committing...';
          const result = await api.post('/api/git/commit', { dir, message: msg });

          // Auto-push if remote exists
          if (hasRemote) {
            commitBtn.textContent = 'Pushing...';
            await api.post('/api/git/push', { dir });
          }

          // Success
          commitSection.innerHTML = '';
          commitSection.appendChild(h('div', { className: 'git-commit-actions' },
            h('div', { className: 'git-status-msg' }, hasRemote ? `Committed & pushed ${result.commit}` : `Committed ${result.commit}`),
          ));
          setTimeout(() => refreshPanel(), 600);
        } catch (err) {
          statusMsg.textContent = err.message;
          commitBtn.disabled = false;
          commitBtn.textContent = btnLabel;
        }
      },
    }, btnLabel);

    const commitSection = h('div', { className: 'git-commit-section' },
      commitInput,
      h('div', { className: 'git-commit-actions' },
        statusMsg,
        commitBtn,
      ),
    );
    container.appendChild(commitSection);

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

  // ── Supabase Panel ──

  async showSupabasePanel() {
    const dir = this.projectPath;
    const q = (p) => `${p}${p.includes('?') ? '&' : '?'}dir=${encodeURIComponent(dir)}`;

    // Overlay
    const overlay = h('div', { className: 'sb-overlay' });
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    const onKey = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);

    const panel = h('div', { className: 'sb-panel' });

    // Header
    panel.appendChild(h('div', { className: 'sb-header' },
      h('div', { className: 'sb-header-left' },
        h('svg', { innerHTML: '<path d="M63.7 110.3c-2.6 3.3-8.1.7-7.8-3.6l3.3-44.4H104c4.8 0 7.4 5.6 4.3 9.2L63.7 110.3Z" fill="currentColor" opacity="0.7"/><path d="M45.3 2.7c2.6-3.3 8.1-.7 7.8 3.6l-1.7 44.4H5c-4.8 0-7.4-5.6-4.3-9.2L45.3 2.7Z" fill="currentColor"/>', width: '14', height: '14', viewBox: '0 0 109 113', fill: 'none', style: 'flex-shrink:0' }),
        h('span', { className: 'sb-header-title' }, 'Supabase'),
      ),
      h('button', { className: 'sb-close', onClick: () => overlay.remove() }, '\u2715'),
    ));

    const loadingEl = h('div', { className: 'sb-loading' }, 'Loading...');
    panel.appendChild(loadingEl);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // Fetch auth + link status
    let authInfo, linkInfo;
    try {
      [authInfo, linkInfo] = await Promise.all([
        api.get('/api/supabase/auth'),
        api.get(q('/api/supabase/link')),
      ]);
    } catch (err) {
      loadingEl.textContent = 'Failed to connect';
      return;
    }

    loadingEl.remove();

    if (!authInfo.authenticated) {
      this._renderSbAuth(panel, overlay);
      return;
    }

    if (!linkInfo.linked) {
      await this._renderSbProjectPicker(panel, overlay, dir);
      return;
    }

    // Linked — show tabs
    await this._renderSbLinked(panel, overlay, dir, linkInfo);
  }

  _renderSbAuth(panel, overlay) {
    const section = h('div', { className: 'sb-auth-section' });
    section.appendChild(h('div', { className: 'sb-section-title' }, 'Connect to Supabase'));
    section.appendChild(h('div', { className: 'sb-hint' }, 'Enter your Personal Access Token from Supabase Dashboard > Account > Access Tokens.'));

    const tokenInput = h('input', {
      className: 'sb-input',
      type: 'password',
      placeholder: 'sbp_...',
    });
    const statusMsg = h('div', { className: 'sb-status-msg' });

    section.appendChild(tokenInput);
    section.appendChild(h('div', { className: 'sb-actions' },
      statusMsg,
      h('button', {
        className: 'sb-btn sb-btn-primary',
        onClick: async (e) => {
          const token = tokenInput.value.trim();
          if (!token) return;
          e.target.disabled = true;
          e.target.textContent = 'Connecting...';
          try {
            await api.post('/api/supabase/auth', { token });
            overlay.remove();
            this.showSupabasePanel();
          } catch (err) {
            statusMsg.textContent = err.message || 'Invalid token';
            e.target.disabled = false;
            e.target.textContent = 'Connect';
          }
        },
      }, 'Connect'),
    ));

    panel.appendChild(section);
  }

  async _renderSbProjectPicker(panel, overlay, dir) {
    const section = h('div', { className: 'sb-auth-section' });
    section.appendChild(h('div', { className: 'sb-section-title' }, 'Link a project'));
    section.appendChild(h('div', { className: 'sb-hint' }, 'Select a Supabase project to link to this workspace.'));

    const statusMsg = h('div', { className: 'sb-status-msg' });
    const listEl = h('div', { className: 'sb-project-list' });

    try {
      const projects = await api.get('/api/supabase/projects');
      if (projects.length === 0) {
        listEl.appendChild(h('div', { className: 'sb-empty' }, 'No projects found'));
      } else {
        for (const p of projects) {
          const statusDot = p.status === 'ACTIVE_HEALTHY' ? 'active' : 'inactive';
          const item = h('div', {
            className: 'sb-project-item',
            onClick: async () => {
              item.classList.add('loading');
              try {
                await api.post('/api/supabase/link', {
                  dir,
                  projectRef: p.ref,
                  projectName: p.name,
                });
                overlay.remove();
                this.showSupabasePanel();
              } catch (err) {
                statusMsg.textContent = err.message;
                item.classList.remove('loading');
              }
            },
          },
            h('div', { className: `sb-project-dot ${statusDot}` }),
            h('div', { className: 'sb-project-info' },
              h('div', { className: 'sb-project-name' }, p.name),
              h('div', { className: 'sb-project-meta' }, `${p.region} · ${p.ref}`),
            ),
          );
          listEl.appendChild(item);
        }
      }
    } catch (err) {
      listEl.appendChild(h('div', { className: 'sb-empty' }, 'Failed to load projects'));
    }

    section.appendChild(listEl);
    section.appendChild(statusMsg);

    // Sign out option
    section.appendChild(h('div', { className: 'sb-footer' },
      h('button', {
        className: 'sb-btn sb-btn-secondary',
        onClick: async () => {
          await api.del('/api/supabase/auth');
          overlay.remove();
          this.showSupabasePanel();
        },
      }, 'Sign out'),
    ));

    panel.appendChild(section);
  }

  async _renderSbLinked(panel, overlay, dir, linkInfo) {
    // Project info bar
    panel.appendChild(h('div', { className: 'sb-project-bar' },
      h('div', { className: 'sb-project-dot active' }),
      h('span', { className: 'sb-project-bar-name' }, linkInfo.projectName || linkInfo.projectRef),
      h('span', { className: 'sb-project-bar-ref' }, linkInfo.projectRef),
    ));

    // Tabs
    const tabContent = h('div', { className: 'sb-tab-content' });
    let activeTab = 'schema';

    const renderTab = async (tab) => {
      activeTab = tab;
      tabs.querySelectorAll('.sb-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
      tabContent.innerHTML = '';

      if (tab === 'schema') {
        await this._renderSbSchema(tabContent, dir);
      } else if (tab === 'actions') {
        await this._renderSbActions(tabContent, dir, linkInfo);
      } else if (tab === 'settings') {
        this._renderSbSettings(tabContent, dir, linkInfo, overlay);
      }
    };

    const tabs = h('div', { className: 'sb-tabs' },
      h('div', { className: 'sb-tab active', dataset: { tab: 'schema' }, onClick: () => renderTab('schema') }, 'Schema'),
      h('div', { className: 'sb-tab', dataset: { tab: 'actions' }, onClick: () => renderTab('actions') }, 'Actions'),
      h('div', { className: 'sb-tab', dataset: { tab: 'settings' }, onClick: () => renderTab('settings') }, 'Settings'),
    );
    panel.appendChild(tabs);
    panel.appendChild(tabContent);

    renderTab('schema');
  }

  async _renderSbSchema(container, dir) {
    const loadingEl = h('div', { className: 'sb-loading' }, 'Loading schema...');
    container.appendChild(loadingEl);

    try {
      const data = await api.get(`/api/supabase/schema?dir=${encodeURIComponent(dir)}`);
      loadingEl.remove();

      if (!data.tables || data.tables.length === 0) {
        container.appendChild(h('div', { className: 'sb-empty' }, 'No tables in public schema'));
        return;
      }

      for (const table of data.tables) {
        const tableEl = h('div', { className: 'sb-table' });
        const header = h('div', {
          className: 'sb-table-header',
          onClick: () => {
            tableEl.classList.toggle('collapsed');
          },
        },
          h('span', { className: 'sb-table-chevron' }, '\u25B6'),
          h('span', { className: 'sb-table-name' }, table.name),
          h('span', { className: 'sb-table-count' }, `${table.columns.length} cols`),
        );
        tableEl.appendChild(header);

        const cols = h('div', { className: 'sb-table-columns' });
        for (const col of table.columns) {
          cols.appendChild(h('div', { className: 'sb-column' },
            h('span', { className: 'sb-column-name' }, col.name),
            h('span', { className: 'sb-column-type' }, col.type),
            col.nullable ? h('span', { className: 'sb-column-nullable' }, '?') : null,
          ));
        }
        tableEl.appendChild(cols);
        container.appendChild(tableEl);
      }
    } catch (err) {
      loadingEl.textContent = err.message || 'Failed to load schema';
    }
  }

  async _renderSbActions(container, dir, linkInfo) {
    // Push migrations
    container.appendChild(h('div', { className: 'sb-section-title' }, 'Database'));

    const migStatus = h('div', { className: 'sb-status-msg' });
    container.appendChild(h('div', { className: 'sb-action-row' },
      h('div', { className: 'sb-action-info' },
        h('div', { className: 'sb-action-name' }, 'Push migrations'),
        h('div', { className: 'sb-action-desc' }, 'Run supabase/migrations/*.sql on the remote database'),
      ),
      h('button', {
        className: 'sb-btn sb-btn-primary',
        onClick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Pushing...';
          try {
            const result = await api.post('/api/supabase/migrations/push', { dir });
            const failed = result.results?.filter(r => r.status === 'error') || [];
            if (failed.length > 0) {
              migStatus.textContent = `${result.applied} applied, ${failed.length} failed: ${failed[0].error}`;
            } else {
              migStatus.textContent = `${result.applied} migration${result.applied !== 1 ? 's' : ''} applied`;
            }
          } catch (err) {
            migStatus.textContent = err.message;
          }
          e.target.disabled = false;
          e.target.textContent = 'Push';
        },
      }, 'Push'),
    ));
    container.appendChild(migStatus);

    // Generate types
    container.appendChild(h('div', { className: 'sb-section-title' }, 'Types'));

    const typeStatus = h('div', { className: 'sb-status-msg' });
    container.appendChild(h('div', { className: 'sb-action-row' },
      h('div', { className: 'sb-action-info' },
        h('div', { className: 'sb-action-name' }, 'Generate TypeScript types'),
        h('div', { className: 'sb-action-desc' }, 'Create src/types/supabase.ts from your database schema'),
      ),
      h('button', {
        className: 'sb-btn sb-btn-primary',
        onClick: async (e) => {
          e.target.disabled = true;
          e.target.textContent = 'Generating...';
          try {
            const result = await api.post('/api/supabase/types/write', { dir });
            typeStatus.textContent = `Written to ${result.path}`;
          } catch (err) {
            typeStatus.textContent = err.message;
          }
          e.target.disabled = false;
          e.target.textContent = 'Generate';
        },
      }, 'Generate'),
    ));
    container.appendChild(typeStatus);

    // Deploy functions
    container.appendChild(h('div', { className: 'sb-section-title' }, 'Edge Functions'));

    const fnStatus = h('div', { className: 'sb-status-msg' });
    const fnList = h('div', { className: 'sb-fn-list' });

    // Check if supabase/functions/ exists
    try {
      const files = await api.get(`/api/files/list?path=${encodeURIComponent(dir + '/supabase/functions')}`);
      if (files && files.length > 0) {
        const dirs = files.filter(f => f.type === 'directory');
        for (const fn of dirs) {
          fnList.appendChild(h('div', { className: 'sb-action-row' },
            h('div', { className: 'sb-action-info' },
              h('div', { className: 'sb-action-name' }, fn.name),
            ),
            h('button', {
              className: 'sb-btn sb-btn-secondary',
              onClick: async (e) => {
                e.target.disabled = true;
                e.target.textContent = 'Deploying...';
                try {
                  await api.post('/api/supabase/functions/deploy', { dir, slug: fn.name });
                  fnStatus.textContent = `Deployed ${fn.name}`;
                } catch (err) {
                  fnStatus.textContent = err.message;
                }
                e.target.disabled = false;
                e.target.textContent = 'Deploy';
              },
            }, 'Deploy'),
          ));
        }
      } else {
        fnList.appendChild(h('div', { className: 'sb-hint' }, 'No functions in supabase/functions/'));
      }
    } catch {
      fnList.appendChild(h('div', { className: 'sb-hint' }, 'No supabase/functions/ directory'));
    }

    container.appendChild(fnList);
    container.appendChild(fnStatus);
  }

  _renderSbSettings(container, dir, linkInfo, overlay) {
    // Project info
    container.appendChild(h('div', { className: 'sb-section-title' }, 'Linked project'));
    container.appendChild(h('div', { className: 'sb-auth-section' },
      h('div', { className: 'sb-setting-row' },
        h('span', { className: 'sb-setting-label' }, 'Project'),
        h('span', { className: 'sb-setting-value' }, linkInfo.projectName),
      ),
      h('div', { className: 'sb-setting-row' },
        h('span', { className: 'sb-setting-label' }, 'Ref'),
        h('span', { className: 'sb-setting-value mono' }, linkInfo.projectRef),
      ),
      h('div', { className: 'sb-setting-row' },
        h('span', { className: 'sb-setting-label' }, 'URL'),
        h('span', { className: 'sb-setting-value mono' }, linkInfo.url),
      ),
    ));

    // Unlink
    const statusMsg = h('div', { className: 'sb-status-msg' });
    container.appendChild(h('div', { className: 'sb-auth-section' },
      h('div', { className: 'sb-actions' },
        h('button', {
          className: 'sb-btn sb-btn-secondary',
          onClick: async () => {
            await api.del('/api/supabase/link', { dir });
            overlay.remove();
            this.showSupabasePanel();
          },
        }, 'Unlink project'),
        h('button', {
          className: 'sb-btn sb-btn-secondary',
          onClick: async () => {
            await api.del('/api/supabase/auth');
            overlay.remove();
            this.showSupabasePanel();
          },
        }, 'Sign out'),
      ),
      statusMsg,
    ));
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

    if (this.devServer) {
      if (this._requireAIForFramework('Duplicate')) return;
      const desc = this._describeElement(this.selectedElement);
      this.sendChatMessage(`Duplicate the element ${desc} (add an identical copy right after it in the source)`);
      return;
    }

    const clone = this.selectedElement.cloneNode(true);
    this.selectedElement.parentNode.insertBefore(clone, this.selectedElement.nextSibling);
    this.selectElement(clone);
  }

  deleteSelected() {
    if (!this.selectedElement) return;

    if (this.devServer) {
      if (this._requireAIForFramework('Delete')) return;
      const desc = this._describeElement(this.selectedElement);
      this.sendChatMessage(`Remove the element ${desc} from the source code`);
      this.selectedElement = null;
      this.overlay.innerHTML = '';
      this.refreshRightPanel();
      return;
    }

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
          console.log('[terminal] ready:', msg);
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
