import path from 'path';

/**
 * Resolve a user-supplied filename inside a trusted base directory,
 * blocking path traversal (`..`), nested separators (`/`, `\`), and null bytes.
 * Returns null if invalid.
 */
export function resolveSafeFilePath(baseDir: string, filename: string | null | undefined): string | null {
  if (!filename || typeof filename !== 'string') return null;
  if (filename.includes('\0') || filename.includes('/') || filename.includes('\\')) return null;

  const baseName = path.basename(filename);
  if (baseName !== filename || baseName === '.' || baseName === '..') return null;

  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, baseName);

  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    return null;
  }

  return resolvedTarget;
}

/**
 * Escape untrusted text before interpolating into HTML responses (prevents reflected XSS).
 */
export function escapeHtml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
