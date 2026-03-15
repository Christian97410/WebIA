import { resolve, relative } from 'path';

/**
 * Path containment guard.
 * Ensures file operations stay within the user's project directory.
 * Prevents path traversal attacks (e.g. ../../src/server/...).
 */

// WebIA's own source directory — never allow access
// In SEA/CJS bundles, import.meta.dirname is undefined — fall back to process.argv[0] location
const _metaDir = typeof import.meta !== 'undefined' && import.meta.dirname;
const WIA_ROOT = _metaDir ? resolve(_metaDir, '../..') : resolve(process.argv[0], '..', '..');

/**
 * Validate that a file path is contained within the allowed project directory.
 * Blocks access to WebIA's own codebase and any path outside the project.
 *
 * @param {string} filePath - The path to validate
 * @param {string} projectDir - The project root directory
 * @returns {{ ok: boolean, error?: string, resolved?: string }}
 */
export function guardPath(filePath, projectDir) {
  if (!filePath || !projectDir) {
    return { ok: false, error: 'Missing file path or project directory' };
  }

  const resolvedFile = resolve(filePath);
  const resolvedProject = resolve(projectDir);

  // Block access to WebIA's own source code
  const relToWia = relative(WIA_ROOT, resolvedFile);
  if (!relToWia.startsWith('..') && !relToWia.startsWith('/')) {
    // The file is inside WebIA's own directory
    // Allow only if the project IS inside WebIA (e.g. test-project)
    const projectRelToWia = relative(WIA_ROOT, resolvedProject);
    if (projectRelToWia.startsWith('..') || projectRelToWia.startsWith('/')) {
      // Project is outside WebIA, but file is inside — block
      return { ok: false, error: 'Access denied: cannot access editor source files' };
    }
    // Project is inside WebIA (dev/test), allow only within the project subtree
  }

  // Ensure the file is within the project directory
  const relToProject = relative(resolvedProject, resolvedFile);
  if (relToProject.startsWith('..') || relToProject.startsWith('/')) {
    return { ok: false, error: 'Access denied: path is outside the project directory' };
  }

  return { ok: true, resolved: resolvedFile };
}

/**
 * Express middleware factory: attaches projectDir validation to req.
 * Expects `projectDir` in query, body, or a route-level default.
 */
export function pathGuardMiddleware(getProjectDir) {
  return (req, res, next) => {
    const projectDir = getProjectDir?.(req);
    if (projectDir) {
      req._projectDir = resolve(projectDir);
    }
    next();
  };
}

/**
 * Validate a file path against req._projectDir.
 * Returns the resolved path or sends a 403 response.
 */
export function validateFilePath(req, res, filePath) {
  const projectDir = req._projectDir;
  if (!projectDir) {
    // No project context — allow (e.g. browse endpoint)
    return resolve(filePath);
  }

  const result = guardPath(filePath, projectDir);
  if (!result.ok) {
    res.status(403).json({ error: result.error });
    return null;
  }
  return result.resolved;
}
