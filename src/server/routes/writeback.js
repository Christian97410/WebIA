import { Router } from 'express';
import { readFile, writeFile } from 'fs/promises';
import postcss from 'postcss';
import { parseCSS, parseHTML, updateCSSProperty, updateHTMLText } from '../source-map.js';

export function createWritebackRouter() {
  const router = Router();

  // Update a CSS property in a file
  router.post('/css', async (req, res) => {
    try {
      const { filePath, selector, prop, value, mediaQuery } = req.body;
      if (!filePath || !selector || !prop || value === undefined) {
        return res.status(400).json({ error: 'filePath, selector, prop, and value are required' });
      }

      const content = await readFile(filePath, 'utf-8');

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

      await writeFile(filePath, updated, 'utf-8');

      res.json({ ok: true, path: filePath });
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

      const content = await readFile(filePath, 'utf-8');
      const updated = updateHTMLText(content, startOffset, endOffset, null, newText);
      await writeFile(filePath, updated, 'utf-8');

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

  return router;
}
