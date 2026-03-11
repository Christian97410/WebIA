import { EditorView, keymap, lineNumbers, highlightActiveLineGutter,
  highlightSpecialChars, drawSelection, highlightActiveLine,
  rectangularSelection, crosshairCursor, dropCursor } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput,
  bracketMatching, foldGutter, foldKeymap, indentUnit } from '@codemirror/language';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { oneDark } from '@codemirror/theme-one-dark';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { xml } from '@codemirror/lang-xml';

export class CodeEditor {
  constructor(parentEl, { onSave, onChange }) {
    this._onSave = onSave;
    this._onChange = onChange;
    this._langCompartment = new Compartment();

    const state = EditorState.create({
      doc: '',
      extensions: this._extensions(),
    });

    this.view = new EditorView({ state, parent: parentEl });
  }

  _extensions() {
    return [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      foldGutter(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      indentUnit.of('  '),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      rectangularSelection(),
      crosshairCursor(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      oneDark,
      this._langCompartment.of([]),
      keymap.of([
        { key: 'Mod-s', run: () => { this._onSave?.(); return true; } },
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      EditorView.updateListener.of(update => {
        if (update.docChanged) this._onChange?.();
      }),
      EditorView.theme({
        '&': { height: '100%' },
        '.cm-scroller': {
          fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', monospace",
          fontSize: '13px',
          lineHeight: '1.6',
        },
        '.cm-gutters': {
          background: '#1e1e1e',
          border: 'none',
          color: '#858585',
        },
        '.cm-activeLineGutter': {
          color: '#c6c6c6',
          background: 'transparent',
        },
        '.cm-content': {
          padding: '4px 0',
        },
        '.cm-line': {
          padding: '0 16px 0 4px',
        },
        '&.cm-focused': {
          outline: 'none',
        },
        '.cm-cursor': {
          borderLeftColor: '#aeafad',
        },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': {
          background: '#264f78 !important',
        },
        '.cm-foldGutter .cm-gutterElement': {
          padding: '0 4px',
          cursor: 'pointer',
        },
      }),
    ];
  }

  setContent(text, filePath) {
    // Swap document content
    this.view.dispatch({
      changes: { from: 0, to: this.view.state.doc.length, insert: text || '' },
    });
    // Swap language
    const lang = this._detectLanguage(filePath);
    this.view.dispatch({
      effects: this._langCompartment.reconfigure(lang),
    });
    // Scroll to top
    this.view.dispatch({ selection: { anchor: 0 }, scrollIntoView: true });
  }

  getContent() {
    return this.view.state.doc.toString();
  }

  focus() {
    this.view.focus();
  }

  destroy() {
    this.view.destroy();
  }

  _detectLanguage(filePath) {
    const ext = filePath?.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'html': case 'htm': return html();
      case 'css': case 'scss': case 'less': return css();
      case 'js': case 'mjs': case 'cjs': return javascript();
      case 'jsx': return javascript({ jsx: true });
      case 'ts': case 'mts': case 'cts': return javascript({ typescript: true });
      case 'tsx': return javascript({ jsx: true, typescript: true });
      case 'json': return json();
      case 'svg': case 'xml': return xml();
      default: return [];
    }
  }
}
