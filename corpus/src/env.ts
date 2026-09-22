/**
 * Environment keys that must not be inherited by a hosted session.
 *
 * A pty inherits `process.env` by default. On Windows that includes entries
 * shaped `(=C:=C:\path)` -- not valid identifiers to hand a child process --
 * and on every platform it can carry secrets the operator never intended to
 * pass through. Filtering to well-formed identifier keys keeps both out.
 */
export function sanitizeEnv(base: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Platform default shell, used when no command is given. */
export function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: process.env['COMSPEC'] ?? 'powershell.exe', args: [] };
  }
  return { command: process.env['SHELL'] ?? '/bin/sh', args: [] };
}
