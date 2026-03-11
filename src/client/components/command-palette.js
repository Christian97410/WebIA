import { h } from '../utils/dom.js';

/**
 * Command palette component (Linear / Raycast style).
 * Vanilla JS, dark theme, uses project CSS variables.
 */
export class CommandPalette {
  /**
   * @param {{ onSelect?: (item) => void }} options
   */
  constructor({ onSelect } = {}) {
    this._onSelect = onSelect || (() => {});
    this._items = [];
    this._filtered = [];
    this._activeIndex = 0;
    this._visible = false;

    this._buildDOM();
    this._attachEvents();
  }

  get el() {
    return this._root;
  }

  /** @param {Array<{id, label, shortcut?, section?, action}>} items */
  setItems(items) {
    this._items = items;
    this._applyFilter();
  }

  open() {
    this._visible = true;
    this._root.style.display = 'flex';
    this._input.value = '';
    this._activeIndex = 0;
    this._applyFilter();
    requestAnimationFrame(() => {
      this._root.style.opacity = '1';
      this._input.focus();
    });
  }

  close() {
    this._visible = false;
    this._root.style.opacity = '0';
    setTimeout(() => {
      if (!this._visible) this._root.style.display = 'none';
    }, 120);
  }

  // -- DOM construction --

  _buildDOM() {
    this._input = h('input', {
      type: 'text',
      placeholder: 'Type a command\u2026',
      spellcheck: 'false',
      autocomplete: 'off',
    });
    Object.assign(this._input.style, {
      width: '100%',
      padding: '12px 16px',
      background: 'transparent',
      border: 'none',
      borderBottom: '1px solid var(--border)',
      color: 'var(--text-primary)',
      fontSize: '14px',
      outline: 'none',
      fontFamily: 'inherit',
      boxSizing: 'border-box',
    });

    this._list = h('div');
    Object.assign(this._list.style, {
      maxHeight: '320px',
      overflowY: 'auto',
      padding: '6px 0',
    });

    this._panel = h('div', {}, this._input, this._list);
    Object.assign(this._panel.style, {
      width: '520px',
      maxWidth: 'calc(100vw - 40px)',
      background: 'var(--bg-surface)',
      border: '1px solid var(--border)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
      position: 'relative',
    });

    this._root = h('div', {}, this._panel);
    Object.assign(this._root.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      opacity: '0',
      zIndex: '9000',
      background: 'rgba(0, 0, 0, 0.45)',
      transition: 'opacity var(--transition-fast)',
      // center the panel
      justifyContent: 'center',
      alignItems: 'flex-start',
      paddingTop: '20vh',
    });
    // display toggled between 'none' and 'flex' via open()/close()
  }

  _attachEvents() {
    // Close on backdrop click
    this._root.addEventListener('mousedown', (e) => {
      if (e.target === this._root) this.close();
    });

    this._input.addEventListener('input', () => {
      this._activeIndex = 0;
      this._applyFilter();
    });

    this._input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        this._activeIndex = Math.min(this._activeIndex + 1, this._filtered.length - 1);
        this._renderList();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        this._activeIndex = Math.max(this._activeIndex - 1, 0);
        this._renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const item = this._filtered[this._activeIndex];
        if (item) this._selectItem(item);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
  }

  _selectItem(item) {
    this.close();
    if (item.action) item.action();
    this._onSelect(item);
  }

  // -- filtering & rendering --

  _applyFilter() {
    const query = (this._input?.value || '').toLowerCase().trim();

    if (!query) {
      this._filtered = [...this._items];
    } else {
      this._filtered = this._items.filter((item) => this._fuzzyMatch(item.label, query));
      // Sort: exact prefix first, then fuzzy
      this._filtered.sort((a, b) => {
        const aPrefix = a.label.toLowerCase().startsWith(query) ? 0 : 1;
        const bPrefix = b.label.toLowerCase().startsWith(query) ? 0 : 1;
        return aPrefix - bPrefix;
      });
    }

    if (this._activeIndex >= this._filtered.length) {
      this._activeIndex = Math.max(0, this._filtered.length - 1);
    }

    this._renderList();
  }

  _fuzzyMatch(label, query) {
    const lower = label.toLowerCase();
    let qi = 0;
    for (let i = 0; i < lower.length && qi < query.length; i++) {
      if (lower[i] === query[qi]) qi++;
    }
    return qi === query.length;
  }

  _renderList() {
    this._list.innerHTML = '';
    let currentSection = null;

    for (let i = 0; i < this._filtered.length; i++) {
      const item = this._filtered[i];

      // Section header
      if (item.section && item.section !== currentSection) {
        currentSection = item.section;
        const header = h('div', {}, currentSection);
        Object.assign(header.style, {
          padding: '8px 16px 4px',
          fontSize: '11px',
          fontWeight: '500',
          color: 'var(--text-tertiary)',
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          userSelect: 'none',
        });
        this._list.appendChild(header);
      }

      const row = this._buildRow(item, i === this._activeIndex);
      this._list.appendChild(row);
    }

    // Scroll active into view
    const activeEl = this._list.querySelector('[data-active="true"]');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  _buildRow(item, isActive) {
    const label = h('span', {}, item.label);
    Object.assign(label.style, {
      flex: '1',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });

    const children = [label];

    if (item.shortcut) {
      const shortcutEl = h('span', {}, this._formatShortcut(item.shortcut));
      Object.assign(shortcutEl.style, {
        fontSize: '12px',
        color: 'var(--text-tertiary)',
        flexShrink: '0',
        marginLeft: '16px',
      });
      children.push(shortcutEl);
    }

    const row = h('div', {}, ...children);
    row.dataset.active = isActive;

    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      padding: '8px 16px',
      fontSize: '13px',
      color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
      background: isActive ? 'var(--bg-hover)' : 'transparent',
      cursor: 'pointer',
      transition: 'background var(--transition-fast), color var(--transition-fast)',
      borderRadius: '0',
      userSelect: 'none',
    });

    row.addEventListener('mouseenter', () => {
      const idx = this._filtered.indexOf(item);
      if (idx !== -1) {
        this._activeIndex = idx;
        this._renderList();
      }
    });

    row.addEventListener('click', (e) => {
      e.stopPropagation();
      this._selectItem(item);
    });

    return row;
  }

  _formatShortcut(shortcut) {
    return shortcut
      .split('+')
      .map((k) => {
        const map = {
          cmd: '\u2318',
          shift: '\u21E7',
          alt: '\u2325',
          ctrl: '\u2303',
          enter: '\u21B5',
          backspace: '\u232B',
          delete: '\u2326',
          escape: 'Esc',
        };
        return map[k.toLowerCase()] || k.toUpperCase();
      })
      .join('');
  }

}
