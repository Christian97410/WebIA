import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// GUI apps (Tauri sidecar) don't inherit the user's shell PATH.
// Resolve it once at startup by trying multiple strategies.
let _shellPath;
export function getShellPath() {
  if (_shellPath) return _shellPath;

  const shells = [
    process.env.SHELL,
    '/bin/zsh',   // macOS default
    '/bin/bash',
  ].filter(Boolean);

  // Strategy 1: ask a real login shell for its PATH
  for (const shell of shells) {
    try {
      const resolved = execSync(
        `${shell} -ilc "printenv PATH"`,
        { encoding: 'utf-8', timeout: 5000, env: { ...process.env, HOME: process.env.HOME || homedir() } },
      ).trim();
      if (resolved && resolved.includes('/bin')) {
        _shellPath = resolved;
        return _shellPath;
      }
    } catch { /* try next */ }
  }

  // Strategy 2: parse /etc/paths + /etc/paths.d/* (macOS standard)
  if (process.platform === 'darwin') {
    try {
      const parts = [];
      try { parts.push(...readFileSync('/etc/paths', 'utf-8').split('\n').filter(Boolean)); } catch {}
      try {
        for (const f of readdirSync('/etc/paths.d')) {
          parts.push(...readFileSync(join('/etc/paths.d', f), 'utf-8').split('\n').filter(Boolean));
        }
      } catch {}
      if (parts.length > 0) {
        _shellPath = parts.join(':');
        return _shellPath;
      }
    } catch {}
  }

  _shellPath = process.env.PATH || '';
  return _shellPath;
}

export function shellEnv(extra = {}) {
  return { ...process.env, PATH: getShellPath(), ...extra };
}

/**
 * Resolve an executable name to its absolute path using the enhanced PATH.
 * Returns the absolute path if found, or the original name as fallback.
 */
import { existsSync } from 'fs';
export function resolveCmd(name) {
  for (const dir of getShellPath().split(':')) {
    const full = join(dir, name);
    if (existsSync(full)) return full;
  }
  return name;
}
