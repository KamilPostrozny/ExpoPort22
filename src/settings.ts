/**
 * One host, because that is the whole product. Everything here is non-secret: the seed and the
 * pinned host keys live in SecureStore instead (T5).
 *
 * A module-level singleton read through `useSyncExternalStore` rather than a context, so a
 * non-React caller (the SSH session, the tmux side-channel) reads the same settings without a
 * provider having to be in scope.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSyncExternalStore } from 'react';

import type { ThemeChoice } from '@/theme';
import { THEME_CHOICES } from '@/theme';

const STORAGE_KEY = 'port22.settings.v1';

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

export type Settings = {
  host: string;
  port: number;
  username: string;
  /** Sent as a line once the shell is up; `null` means send nothing. */
  startupCommand: string | null;
  fontSize: number;
  theme: ThemeChoice;
  /** Push `port22.conf` to the host on connect. On by default — without it the wheel moves five
   *  lines a notch and a yank never reaches the pasteboard. Off is for a shared tmux server, where
   *  `set -g` and `bind` would reach a desktop client on the same server too. */
  configureTmux: boolean;
  /** Where the destination-upload sheet (§4.6) opens next time; `null` = `$HOME`. Written on every
   *  "Save here". Not a secret — it is a directory name on the user's own machine. */
  lastUploadDir: string | null;
};

export const DEFAULTS: Settings = {
  host: '',
  port: 22,
  username: '',
  startupCommand: null,
  fontSize: 13,
  theme: 'auto',
  configureTmux: true,
  lastUploadDir: null,
};

/** Forward-tolerant: an unknown, missing or wrong-typed field takes its default rather than
 *  throwing away the whole blob, so settings written by another build still load. */
export function decode(raw: unknown): Settings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    host: str(o.host, DEFAULTS.host),
    port: num(o.port, DEFAULTS.port),
    username: str(o.username, DEFAULTS.username),
    startupCommand: typeof o.startupCommand === 'string' ? o.startupCommand : null,
    fontSize: clampFontSize(num(o.fontSize, DEFAULTS.fontSize)),
    theme: THEME_CHOICES.includes(o.theme as ThemeChoice)
      ? (o.theme as ThemeChoice)
      : DEFAULTS.theme,
    configureTmux:
      typeof o.configureTmux === 'boolean' ? o.configureTmux : DEFAULTS.configureTmux,
    lastUploadDir: typeof o.lastUploadDir === 'string' ? o.lastUploadDir : null,
  };
}

export function clampFontSize(size: number): number {
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

/** Plain English, and the only wording the setup screen shows. `null` = ready to connect. */
export function validate(s: Settings): string | null {
  if (s.host.trim() === '') return 'Host cannot be empty.';
  if (!Number.isInteger(s.port) || s.port < 1 || s.port > 65535) {
    return 'Port must be between 1 and 65535.';
  }
  if (s.username === '' || /\s/.test(s.username)) {
    return 'Username cannot be empty or contain spaces.';
  }
  return null;
}

/** The key a host key is pinned under. */
export function endpoint(s: Settings): string {
  return `${s.host}:${s.port}`;
}

/* --- the store --- */

let current: Settings = DEFAULTS;
let hydrated = false;
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Read the persisted blob once, at launch, before the first screen renders. */
export async function hydrateSettings(): Promise<Settings> {
  if (hydrated) return current;
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw !== null) current = decode(JSON.parse(raw));
  } catch {
    // Unreadable or unparseable: the defaults are a working app, and overwriting the bad blob on
    // the next change is better than refusing to launch.
  }
  hydrated = true;
  emit();
  return current;
}

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = { ...current, ...patch };
  emit();
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current)).catch(() => {
    // A failed write costs the user their last change on next launch and nothing else; there is no
    // recovery worth showing a message for.
  });
  return current;
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings, getSettings);
}
