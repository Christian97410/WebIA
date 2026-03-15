/**
 * Keyboard shortcuts manager.
 * Shortcut format: "cmd+shift+z", "cmd+k", "escape", "delete", "backspace"
 * Uses metaKey on Mac for "cmd".
 */
export class ShortcutManager {
  constructor() {
    this._shortcuts = new Map();
    this._handler = (e) => this._onKeyDown(e);
    document.addEventListener('keydown', this._handler);
  }

  /**
   * @param {string} shortcut - e.g. "cmd+shift+z"
   * @param {Function} callback
   * @param {string} [description]
   */
  register(shortcut, callback, description = '') {
    const key = this._normalize(shortcut);
    this._shortcuts.set(key, { shortcut, callback, description });
  }

  unregister(shortcut) {
    this._shortcuts.delete(this._normalize(shortcut));
  }

  /** Returns array of { shortcut, description } for all registered shortcuts. */
  getAll() {
    return Array.from(this._shortcuts.values()).map(({ shortcut, description }) => ({
      shortcut,
      description,
    }));
  }

  destroy() {
    document.removeEventListener('keydown', this._handler);
    this._shortcuts.clear();
  }

  // -- internals --

  _normalize(shortcut) {
    return shortcut
      .toLowerCase()
      .split('+')
      .map(s => s.trim())
      .sort()
      .join('+');
  }

  _onKeyDown(e) {
    // Skip when focus is in an input, textarea (includes xterm), or contentEditable
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) {
      // Still allow cmd/ctrl combos (e.g. cmd+z for undo)
      if (!e.metaKey && !e.ctrlKey) return;
    }

    const parts = [];

    if (e.metaKey) parts.push('cmd');
    if (e.ctrlKey) parts.push('ctrl');
    if (e.shiftKey) parts.push('shift');
    if (e.altKey) parts.push('alt');

    const key = e.key.toLowerCase();

    // Map key names to our shortcut vocabulary
    const keyMap = {
      escape: 'escape',
      backspace: 'backspace',
      delete: 'delete',
      enter: 'enter',
      arrowup: 'arrowup',
      arrowdown: 'arrowdown',
      tab: 'tab',
    };

    const mapped = keyMap[key] || key;

    // Avoid adding modifier-only presses
    if (!['meta', 'control', 'shift', 'alt'].includes(key)) {
      parts.push(mapped);
    }

    const normalized = parts.sort().join('+');
    const entry = this._shortcuts.get(normalized);

    if (entry) {
      e.preventDefault();
      e.stopPropagation();
      entry.callback(e);
    }
  }
}
