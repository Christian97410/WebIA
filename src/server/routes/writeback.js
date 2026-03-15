import { Router } from 'express';
import { readFile, writeFile, access } from 'fs/promises';
import { join } from 'path';
import postcss from 'postcss';
import { parseCSS, parseHTML, updateCSSProperty, updateHTMLText } from '../source-map.js';
import { validateFilePath } from '../path-guard.js';

export function createWritebackRouter() {
  const router = Router();

  // Update a CSS property in a file
  router.post('/css', async (req, res) => {
    try {
      const { filePath, selector, prop, value, mediaQuery } = req.body;
      if (!filePath || !selector || !prop || value === undefined) {
        return res.status(400).json({ error: 'filePath, selector, prop, and value are required' });
      }

      const safePath = validateFilePath(req, res, filePath);
      if (!safePath) return;
      const content = await readFile(safePath, 'utf-8');

      // Never rewrite framework entry-point CSS files (Tailwind, PostCSS layers)
      // PostCSS can corrupt @tailwind directives, destroying all utility styles
      if (content.includes('@tailwind')) {
        return res.status(400).json({ error: 'Cannot write to Tailwind entry file. Use a separate CSS file.' });
      }

      const updated = updateCSSProperty(content, filePath, selector, prop, value, mediaQuery || null);

      // Validate the result before writing — never corrupt the file
      try {
        postcss.parse(updated, { from: filePath });
      } catch (parseErr) {
        return res.status(500).json({ error: `Writeback would produce invalid CSS, aborting: ${parseErr.message}` });
      }

      await writeFile(safePath, updated, 'utf-8');

      res.json({ ok: true, path: safePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update text content in an HTML file
  router.post('/html-text', async (req, res) => {
    try {
      const { filePath, startOffset, endOffset, newText } = req.body;
      if (!filePath || startOffset === undefined || endOffset === undefined || newText === undefined) {
        return res.status(400).json({ error: 'filePath, startOffset, endOffset, and newText are required' });
      }

      const safePath = validateFilePath(req, res, filePath);
      if (!safePath) return;
      const content = await readFile(safePath, 'utf-8');
      const updated = updateHTMLText(content, startOffset, endOffset, null, newText);
      await writeFile(safePath, updated, 'utf-8');

      res.json({ ok: true, path: filePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get parsed CSS rules for a file
  router.get('/css-rules', async (req, res) => {
    try {
      const filePath = req.query.file;
      if (!filePath) return res.status(400).json({ error: 'file query parameter required' });

      const { rules } = await parseCSS(filePath);
      res.json({ rules });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get parsed HTML elements for a file
  router.get('/html-elements', async (req, res) => {
    try {
      const filePath = req.query.file;
      if (!filePath) return res.status(400).json({ error: 'file query parameter required' });

      const { elements } = await parseHTML(filePath);
      res.json({ elements });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Simple text replacement in any source file (for direct text edits)
  router.post('/text-replace', async (req, res) => {
    try {
      const { filePath, oldText, newText } = req.body;
      if (!filePath || oldText === undefined || newText === undefined) {
        return res.status(400).json({ error: 'filePath, oldText, and newText required' });
      }

      const safePath = validateFilePath(req, res, filePath);
      if (!safePath) return;
      const content = await readFile(safePath, 'utf-8');

      if (!content.includes(oldText)) {
        return res.status(404).json({ error: 'Text not found in file', searched: oldText.slice(0, 60) });
      }

      // Replace first occurrence only
      const updated = content.replace(oldText, newText);
      await writeFile(safePath, updated, 'utf-8');

      res.json({ ok: true, path: safePath });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Inject a Google Font <link> into an HTML file's <head>
  router.post('/inject-font', async (req, res) => {
    try {
      const { filePath, href, fontName } = req.body;
      if (!filePath || !href) return res.status(400).json({ error: 'filePath and href required' });

      let content = await readFile(filePath, 'utf-8');

      // Check if already present
      if (content.includes(href) || content.includes(fontName.replace(/\s+/g, '+'))) {
        return res.json({ ok: true, alreadyPresent: true });
      }

      // Insert before </head>
      const headClose = content.indexOf('</head>');
      if (headClose === -1) return res.status(400).json({ error: 'No </head> tag found' });

      const preconnect = content.includes('fonts.googleapis.com') ? '' :
        `  <link rel="preconnect" href="https://fonts.googleapis.com">\n  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n`;
      const link = `  <link href="${href}" rel="stylesheet">\n`;

      content = content.slice(0, headClose) + preconnect + link + content.slice(headClose);
      await writeFile(filePath, content, 'utf-8');

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Inject a Google Font @import into a CSS file (for framework projects)
  router.post('/inject-font-css', async (req, res) => {
    try {
      const { filePath, href, fontName } = req.body;
      if (!filePath || !href) return res.status(400).json({ error: 'filePath and href required' });

      let content = await readFile(filePath, 'utf-8');

      // Check if already present
      if (content.includes(fontName.replace(/\s+/g, '+'))) {
        return res.json({ ok: true, alreadyPresent: true });
      }

      // Add @import at the top of the CSS file
      const importLine = `@import url('${href}');\n`;
      content = importLine + content;
      await writeFile(filePath, content, 'utf-8');

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Create or find wia-overrides.css and inject import into the project
  router.post('/ensure-override-css', async (req, res) => {
    try {
      const { projectDir, htmlFile, isFramework } = req.body;
      if (!projectDir) return res.status(400).json({ error: 'projectDir required' });

      const overrideFileName = 'wia-overrides.css';
      // Framework: place in src/ alongside other CSS; Static: project root
      const overridePath = isFramework
        ? join(projectDir, 'src', overrideFileName)
        : join(projectDir, overrideFileName);
      const relativePath = isFramework ? `src/${overrideFileName}` : overrideFileName;

      // Create the file if it doesn't exist
      try {
        await access(overridePath);
      } catch {
        // Ensure src/ dir exists for framework projects
        if (isFramework) {
          const { mkdir } = await import('fs/promises');
          await mkdir(join(projectDir, 'src'), { recursive: true });
        }
        await writeFile(overridePath, '/* WebIA visual editor overrides — do not edit manually */\n', 'utf-8');
      }

      let importInjected = false;
      if (isFramework) {
        // Framework projects: inject import into entry CSS or JS/TS file
        importInjected = await _injectFrameworkImport(projectDir, overrideFileName);
      } else if (htmlFile) {
        // Static projects: inject <link> into the HTML <head>
        try {
          let html = await readFile(htmlFile, 'utf-8');
          if (!html.includes(overrideFileName)) {
            const headClose = html.indexOf('</head>');
            if (headClose !== -1) {
              const link = `  <link rel="stylesheet" href="${overrideFileName}">\n`;
              html = html.slice(0, headClose) + link + html.slice(headClose);
              await writeFile(htmlFile, html, 'utf-8');
            }
          }
        } catch (err) {
          console.warn('Could not inject override link into HTML:', err.message);
        }
      }

      res.json({ ok: true, path: overridePath, relativePath, importInjected });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Inject import './wia-overrides.css' into a framework project's entry file
  // Returns true if injection succeeded, false if no entry file was found
  async function _injectFrameworkImport(projectDir, overrideFileName) {
    const { dirname, relative } = await import('path');

    // Try entry files in priority order (with and without src/ prefix)
    const candidates = [
      // Next.js App Router
      'src/app/layout.tsx', 'src/app/layout.jsx', 'src/app/layout.js',
      'app/layout.tsx', 'app/layout.jsx', 'app/layout.js',
      // Next.js Pages Router
      'src/pages/_app.tsx', 'src/pages/_app.jsx', 'src/pages/_app.js',
      'pages/_app.tsx', 'pages/_app.jsx', 'pages/_app.js',
      // Vite / CRA / generic React
      'src/main.tsx', 'src/main.jsx', 'src/main.js',
      'src/index.tsx', 'src/index.jsx', 'src/index.js',
      'src/App.tsx', 'src/App.jsx', 'src/App.js',
      // CSS entry files (use @import instead)
      'src/app/globals.css', 'app/globals.css',
      'src/index.css', 'src/App.css',
      'src/styles/globals.css', 'styles/globals.css',
    ];

    // The override file is at src/wia-overrides.css
    const overridePath = join(projectDir, 'src', overrideFileName);

    for (const candidate of candidates) {
      const filePath = join(projectDir, candidate);
      try {
        let content = await readFile(filePath, 'utf-8');
        if (content.includes(overrideFileName)) return; // already imported

        // Compute relative path from entry file to override file
        const entryDir = dirname(filePath);
        let relPath = relative(entryDir, overridePath).replace(/\\/g, '/');
        if (!relPath.startsWith('.')) relPath = './' + relPath;

        const isCSSFile = candidate.endsWith('.css');
        const line = isCSSFile ? `@import '${relPath}';` : `import '${relPath}';`;

        if (isCSSFile) {
          // Add @import at the top (after other @imports)
          const lastImportIdx = content.lastIndexOf('@import');
          if (lastImportIdx !== -1) {
            const lineEnd = content.indexOf('\n', lastImportIdx);
            content = content.slice(0, lineEnd + 1) + line + '\n' + content.slice(lineEnd + 1);
          } else {
            content = line + '\n' + content;
          }
        } else {
          // Add import after last import statement
          const lines = content.split('\n');
          let lastImportLine = -1;
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/^import\s/)) lastImportLine = i;
          }
          lines.splice(lastImportLine + 1, 0, line);
          content = lines.join('\n');
        }

        await writeFile(filePath, content, 'utf-8');
        return true; // done
      } catch {
        continue; // file doesn't exist, try next
      }
    }
    // No entry file found — client will fall back to AI with precise instructions
    return false;
  }

  return router;
}
