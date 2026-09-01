/**
 * Uploads (§4.6), the pure half: filename sanitising, the quick-attach name, destination-path
 * arithmetic for the browser sheet, and the listing order. The glue in `src/upload.ts` and the
 * sheet in `src/upload-sheet.tsx` execute; nothing here touches a picker or a socket.
 */

import type { RemoteEntry } from '../modules/expo-ssh/src/ExpoSSH.types';

/** Where quick-attach drops files. mkdir'd 0700 on demand (the native `upload` does the chain). */
export const QUICK_DIR = '/tmp/port22';

/**
 * A picker filename made safe as one remote path segment: path separators and control characters
 * out, whitespace to `-` (a destination upload never touches a shell, but a quick-attach path is
 * typed into one), leading dots off so an upload cannot silently become a hidden file. Unicode
 * letters stay — they are valid filenames and mangling them helps nobody.
 */
export function sanitizeFilename(name: string): string {
  const base = name.split('/').pop()!.split('\\').pop()!;
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^\.+/, '');
  return cleaned === '' ? 'file' : cleaned;
}

/** The extension a generated name keeps, lowercased; '' when there is none worth keeping. */
export function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1].toLowerCase() : '';
}

/** The payload out of a `data:image/png;base64,…` URI — `expo-clipboard` hands the image back as
 *  one, the SFTP write wants the base64 alone. A bare base64 string passes through unchanged. */
export function stripDataUri(data: string): string {
  return data.replace(/^data:[^,]*,/, '');
}

/** `20260808T135802` — UTC to the second. Two captures in the same second overwrite, which §4.6
 *  accepts by name. */
export function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .slice(0, 15);
}

/** The quick-attach (and camera-default) name: stamp plus the original's extension, if any. */
export function stampName(date: Date, originalName: string | null): string {
  const ext = originalName ? extensionOf(sanitizeFilename(originalName)) : '';
  return utcStamp(date) + (ext ? `.${ext}` : '');
}

/* --- destination-path arithmetic (absolute paths; the sheet resolves `$HOME` once via `pwd`) --- */

export function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

export function parentPath(dir: string): string {
  if (dir === '/') return '/';
  const cut = dir.lastIndexOf('/');
  return cut <= 0 ? '/' : dir.slice(0, cut);
}

/** `/srv/deploy` → `['/', 'srv', 'deploy']`, the breadcrumb's segments in order. */
export function breadcrumb(dir: string): string[] {
  return ['/', ...dir.split('/').filter((segment) => segment !== '')];
}

/** Directories first, then names — the design's listing order, and what makes a collision with
 *  the chosen filename visible before it happens. */
export function sortEntries(entries: RemoteEntry[]): RemoteEntry[] {
  // SFTP hands back `.` and `..`; the sheet draws its own "up" row, so listing them gives three
  // navigation rows, one of which walks into the directory it is already in (T13/T8.8).
  return entries
    .filter((entry) => entry.name !== '.' && entry.name !== '..')
    .sort((a, b) =>
      a.isDirectory !== b.isDirectory ? (a.isDirectory ? -1 : 1) : a.name.localeCompare(b.name),
    );
}

/** The listing's size column: `3 KB`, `14 MB` — one significant unit, like the design. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, '') : Math.round(value)} ${units[unit]}`;
}
