import { execSync } from 'child_process';
import { homedir } from 'os';

// GUI apps (Tauri) don't inherit the user's shell PATH.
// Resolve it once at startup by asking the default shell.
let _shellPath;
export function getShellPath() {
  if (_shellPath) return _shellPath;
  try {
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'cmd' : '/bin/sh');
    const flag = process.platform === 'win32' ? '/c echo %PATH%' : '-ilc "echo \\$PATH"';
    const resolved = execSync(`${shell} ${flag}`, { encoding: 'utf-8', timeout: 5000 }).trim();
    if (resolved) {
      _shellPath = resolved;
      return _shellPath;
    }
  } catch { /* fall through */ }
  _shellPath = process.env.PATH || '';
  return _shellPath;
}

export function shellEnv(extra = {}) {
  return { ...process.env, PATH: getShellPath(), ...extra };
}
