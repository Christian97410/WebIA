import { readFile } from 'fs/promises';
import { parse } from 'parse5';
import postcss from 'postcss';
import { join, dirname } from 'path';

/**
 * Parse an HTML file and return a map of element paths to source locations.
 * Each element gets a data-wia-id attribute for tracking.
 */
export async function parseHTML(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const ast = parse(content, { sourceCodeLocationInfo: true });
  const elements = [];

  function walk(node, path = []) {
    if (node.nodeName && node.nodeName !== '#document' && node.nodeName !== '#text' && node.nodeName !== '#comment') {
      const loc = node.sourceCodeLocation;
      if (loc) {
        elements.push({
          tag: node.nodeName,
          id: node.attrs?.find(a => a.name === 'id')?.value || null,
          classes: node.attrs?.find(a => a.name === 'class')?.value || '',
          path: [...path, node.nodeName],
          startLine: loc.startLine,
          startCol: loc.startCol,
          endLine: loc.endLine,
          endCol: loc.endCol,
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          file: filePath,
        });
      }
    }

    if (node.childNodes) {
      let childIndex = 0;
      for (const child of node.childNodes) {
        if (child.nodeName && child.nodeName !== '#text' && child.nodeName !== '#comment') {
          walk(child, [...path, `${child.nodeName}[${childIndex}]`]);
          childIndex++;
        }
      }
    }
  }

  walk(ast);
  return { elements, content };
}

/**
 * Parse a CSS file and return structured rules with source locations.
 */
export async function parseCSS(filePath) {
  const content = await readFile(filePath, 'utf-8');
  const root = postcss.parse(content, { from: filePath });
  const rules = [];

  root.walkRules((rule) => {
    const declarations = [];
    rule.walkDecls((decl) => {
      declarations.push({
        prop: decl.prop,
        value: decl.value,
        important: decl.important || false,
        line: decl.source?.start?.line,
        column: decl.source?.start?.column,
      });
    });

    rules.push({
      selector: rule.selector,
      declarations,
      line: rule.source?.start?.line,
      endLine: rule.source?.end?.line,
      file: filePath,
      // Media query parent
      media: rule.parent?.type === 'atrule' && rule.parent?.name === 'media'
        ? rule.parent.params
        : null,
    });
  });

  return { rules, content };
}

/**
 * Find all CSS rules that match a given element (by tag, class, id).
 */
export function findMatchingRules(element, cssRules) {
  const matches = [];
  const classes = (element.classes || '').split(/\s+/).filter(Boolean);
  const id = element.id;
  const tag = element.tag;

  for (const rule of cssRules) {
    const selector = rule.selector;

    // Simple matching (covers most cases)
    if (selector === tag) { matches.push(rule); continue; }
    if (id && selector === `#${id}`) { matches.push(rule); continue; }
    for (const cls of classes) {
      if (selector === `.${cls}` || selector.includes(`.${cls}`) ||
          selector === `${tag}.${cls}`) {
        matches.push(rule);
        break;
      }
    }
  }

  return matches;
}

/**
 * Update a CSS property value in a CSS file content string.
 * Returns the modified content.
 */
export function updateCSSProperty(cssContent, filePath, selector, prop, newValue, mediaQuery = null) {
  let root;
  try {
    root = postcss.parse(cssContent, { from: filePath });
  } catch (err) {
    // CSS is already broken — try to recover by fixing common issues
    let fixed = cssContent
      .replace(/;\s*}/g, '}')           // remove stray ; before }
      .replace(/}\s*}/g, '}')           // remove double }
      .replace(/\n;\n/g, '\n');         // remove stray ;
    try {
      root = postcss.parse(fixed, { from: filePath });
    } catch {
      // Still broken — return content unchanged to avoid making it worse
      throw new Error(`CSS parse error in ${filePath}: ${err.message}. Fix the file manually.`);
    }
  }
  let found = false;

  const updateInContext = (context) => {
    context.walkRules((rule) => {
      if (rule.selector === selector) {
        rule.walkDecls(prop, (decl) => {
          // Don't overwrite var(--*) with a raw value that's equivalent
          // The client should already resolve tokens, but guard here too
          if (decl.value.startsWith('var(--') && !newValue.startsWith('var(')) {
            // Keep the variable reference if the new value is raw
            // The client _resolveToToken should have caught this,
            // but if it didn't, preserve the variable
            found = true;
            return;
          }
          decl.value = newValue;
          found = true;
        });

        // Property doesn't exist yet, add it
        if (!found) {
          rule.append({ prop, value: newValue });
          found = true;
        }
      }
    });
  };

  if (mediaQuery) {
    // Find or create the media query
    let targetMedia = null;
    root.walkAtRules('media', (atRule) => {
      if (atRule.params.trim() === mediaQuery.trim()) {
        targetMedia = atRule;
      }
    });

    if (targetMedia) {
      updateInContext(targetMedia);
    } else {
      // Create new media query with rule
      const newMedia = postcss.atRule({ name: 'media', params: mediaQuery });
      const newRule = postcss.rule({ selector });
      newRule.append({ prop, value: newValue });
      newMedia.append(newRule);
      root.append(newMedia);
      found = true;
    }
  } else {
    updateInContext(root);

    // Selector doesn't exist, create it
    if (!found) {
      const newRule = postcss.rule({ selector });
      newRule.append({ prop, value: newValue });
      root.append(newRule);
      found = true;
    }
  }

  return root.toString();
}

/**
 * Update text content in an HTML file.
 * Uses startOffset/endOffset from parse5 to do precise replacements.
 */
export function updateHTMLText(htmlContent, startOffset, endOffset, element, newText) {
  // Find the text node within the element's tags
  const elementHTML = htmlContent.slice(startOffset, endOffset);

  // Find content between > and </
  const openTagEnd = elementHTML.indexOf('>');
  const closeTagStart = elementHTML.lastIndexOf('</');

  if (openTagEnd === -1 || closeTagStart === -1) return htmlContent;

  const before = htmlContent.slice(0, startOffset + openTagEnd + 1);
  const after = htmlContent.slice(startOffset + closeTagStart);

  return before + newText + after;
}
