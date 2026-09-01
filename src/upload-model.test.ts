/** `bun test` — the upload decisions (§4.6), all pure: the filename sanitiser, the quick-attach
 *  name (date injected — no `Date.now()` here), destination-path arithmetic and breadcrumbs, the
 *  listing order, and the size column. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  QUICK_DIR,
  breadcrumb,
  extensionOf,
  formatSize,
  joinPath,
  parentPath,
  sanitizeFilename,
  sortEntries,
  stampName,
  stripDataUri,
  utcStamp,
} from '@/upload-model';

/* --- the sanitiser --- */

test('spaces become dashes', () => {
  expect(sanitizeFilename('my holiday photo.jpg')).toBe('my-holiday-photo.jpg');
});

test('path separators cannot smuggle a directory in', () => {
  expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
  expect(sanitizeFilename('a\\b\\evil.sh')).toBe('evil.sh');
});

test('unicode letters survive', () => {
  expect(sanitizeFilename('zdjęcie z gór.png')).toBe('zdjęcie-z-gór.png');
});

test('leading dots come off — an upload never silently becomes a hidden file', () => {
  expect(sanitizeFilename('.env')).toBe('env');
  expect(sanitizeFilename('...profile')).toBe('profile');
});

test('control characters are stripped', () => {
  expect(sanitizeFilename('a\u0000b\u001fc\u007fd.txt')).toBe('abcd.txt');
});

test('nothing left means the fallback name', () => {
  expect(sanitizeFilename('')).toBe('file');
  expect(sanitizeFilename('...')).toBe('file');
  expect(sanitizeFilename('dir/')).toBe('file');
});

/* --- generated names --- */

const date = new Date('2026-08-08T13:58:02.500Z');

test('the UTC stamp is to the second', () => {
  expect(utcStamp(date)).toBe('20260808T135802');
});

test('quick-attach name keeps the extension, lowercased', () => {
  expect(stampName(date, 'IMG_0231.JPEG')).toBe('20260808T135802.jpeg');
  expect(stampName(date, 'notes with spaces.txt')).toBe('20260808T135802.txt');
});

test('no extension, no dot', () => {
  expect(stampName(date, 'Makefile')).toBe('20260808T135802');
  expect(stampName(date, null)).toBe('20260808T135802');
});

/* --- destination paths --- */

test('join and parent are inverses down to root', () => {
  expect(joinPath('/srv/deploy', 'uploads')).toBe('/srv/deploy/uploads');
  expect(joinPath('/', 'srv')).toBe('/srv');
  expect(parentPath('/srv/deploy')).toBe('/srv');
  expect(parentPath('/srv')).toBe('/');
  expect(parentPath('/')).toBe('/');
});

test('breadcrumb segments', () => {
  expect(breadcrumb('/srv/deploy/uploads')).toEqual(['/', 'srv', 'deploy', 'uploads']);
  expect(breadcrumb('/')).toEqual(['/']);
});

test('the quick dir is where §4.6 says', () => {
  expect(joinPath(QUICK_DIR, stampName(date, 'a.jpg'))).toBe('/tmp/port22/20260808T135802.jpg');
});

/* --- the listing --- */

test('directories first, then names', () => {
  const sorted = sortEntries([
    { name: 'nginx.conf', isDirectory: false, size: 3000 },
    { name: 'releases', isDirectory: true, size: 0 },
    { name: 'bundle.tar.gz', isDirectory: false, size: 14_000_000 },
    { name: 'incoming', isDirectory: true, size: 0 },
  ]);
  expect(sorted.map((e) => e.name)).toEqual(['incoming', 'releases', 'bundle.tar.gz', 'nginx.conf']);
});

test('the dot entries SFTP returns are dropped — the sheet draws its own up row', () => {
  const sorted = sortEntries([
    { name: '..', isDirectory: true, size: 0 },
    { name: 'releases', isDirectory: true, size: 0 },
    { name: '.', isDirectory: true, size: 0 },
    { name: '.bashrc', isDirectory: false, size: 300 }, // a real dotfile still belongs
  ]);
  expect(sorted.map((e) => e.name)).toEqual(['releases', '.bashrc']);
});

test('sizes read like the design', () => {
  expect(formatSize(820)).toBe('820 B');
  expect(formatSize(3 * 1024)).toBe('3 KB');
  expect(formatSize(14 * 1024 * 1024)).toBe('14 MB');
});

test('a pasted image arrives as a data URI and uploads as bare base64', () => {
  expect(stripDataUri('data:image/png;base64,iVBORw0K')).toBe('iVBORw0K');
  expect(stripDataUri('iVBORw0K')).toBe('iVBORw0K');
});
