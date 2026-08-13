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

import type { ThemeName } from '@/theme';
import { DEFAULT_DARK, DEFAULT_LIGHT, isThemeName } from '@/theme';
import { shellQuote } from '@/tmux-model';

const STORAGE_KEY = 'port22.settings.v1';

export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;

/**
 * How a session starts (§4.1). The three tmux answers are one command each — `new-session -A` is
 * already "attach if it exists, create if it does not", so a separate "create" mode would be the
 * same line with a worse failure. What they differ in is *which* session:
 *
 * - `session` — a session of our own, always `port22`. The default: it is the phone's, so its size
 *   and its background colour are the phone's too. Not a name to type — one name means the second
 *   connect of the day finds the first one's session without anyone remembering a spelling.
 * - `attach`  — one the host is already running: `attachSession` if the user has picked one in
 *   §4.8's list, else the most recent. Falls back to creating `port22` when the pick is gone.
 * - `custom`  — the user's own line, unread by us (this was the only mode before).
 * - `shell`   — no tmux at all.
 *
 * Both tmux modes detach the other clients (`-D` / `attach -d`), and that is not tidiness: a
 * second client on the same session pins the pane to the *other* terminal's answers. tmux serves a
 * pane's `OSC 11` background query from one attached client, so a fish attaching from the phone
 * keeps the desktop's dark palette — measured, 2026-08-12 — and window size is shared the same way.
 */
export const START_MODES = ['shell', 'session', 'attach', 'custom'] as const;
export type StartMode = (typeof START_MODES)[number];

/** The session the `session` mode attaches to or creates, and the `attach` mode's fallback. */
export const SESSION_NAME = 'port22';

export type Settings = {
  host: string;
  port: number;
  username: string;
  /** How the shell that comes up is turned into a session — see `START_MODES`. */
  startMode: StartMode;
  /** `attach` mode's target. `null` = the most recent session, which is what the mode means before
   *  anyone has chosen. */
  attachSession: string | null;
  /** What the host was running at the last connect — the list Setup offers. Cached because Setup
   *  is where the choice is made and there is no connection there to ask over; refreshed on every
   *  connect, so it is one session behind at worst, and the line falls back either way. */
  knownSessions: string[];
  /** `custom` mode's line, sent once the shell is up. `null` means send nothing. */
  startupCommand: string | null;
  fontSize: number;
  /**
   * Two ways to answer the appearance question, and the first one decides which of the other
   * fields is live. Following the system means picking twice — a scheme for dark, a scheme for
   * light — because most schemes exist in only one cut, so "Gruvbox" is not an answer the system
   * can flip. Not following means one scheme out of all of them, and the system is ignored.
   *
   * All three are kept while only one is read, so turning the switch back on returns the pair the
   * user had rather than a default.
   */
  followSystem: boolean;
  theme: ThemeName;
  themeDark: ThemeName;
  themeLight: ThemeName;
  /** The second half of the pushed conf (§4.5): the comforts, as against the options a feature of
   *  ours stops working without. On by default, and opt-out rather than opt-in because they are
   *  what the app feels like when it is set up right. What they are is in `generateConf`. */
  tmuxExtras: boolean;
  /** Where the destination-upload sheet (§4.6) opens next time; `null` = `$HOME`. Written on every
   *  "Save here". Not a secret — it is a directory name on the user's own machine. */
  lastUploadDir: string | null;
};

export const DEFAULTS: Settings = {
  host: '',
  port: 22,
  username: '',
  startMode: 'session',
  attachSession: null,
  knownSessions: [],
  startupCommand: null,
  fontSize: 13,
  followSystem: true,
  theme: DEFAULT_DARK,
  themeDark: DEFAULT_DARK,
  themeLight: DEFAULT_LIGHT,
  tmuxExtras: true,
  lastUploadDir: null,
};

/** Forward-tolerant: an unknown, missing or wrong-typed field takes its default rather than
 *  throwing away the whole blob, so settings written by another build still load. */
export function decode(raw: unknown): Settings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
  const num = (v: unknown, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  const startupCommand = typeof o.startupCommand === 'string' ? o.startupCommand : null;
  return {
    host: str(o.host, DEFAULTS.host),
    port: num(o.port, DEFAULTS.port),
    username: str(o.username, DEFAULTS.username),
    // Settings written before the modes existed carry the old free-text line, and that line is
    // exactly what `custom` means — so it keeps working without the user being asked anything.
    startMode: START_MODES.includes(o.startMode as StartMode)
      ? (o.startMode as StartMode)
      : startupCommand !== null
        ? 'custom'
        : DEFAULTS.startMode,
    attachSession: typeof o.attachSession === 'string' ? o.attachSession : null,
    knownSessions: Array.isArray(o.knownSessions)
      ? o.knownSessions.filter((name): name is string => typeof name === 'string')
      : [],
    startupCommand,
    fontSize: clampFontSize(num(o.fontSize, DEFAULTS.fontSize)),
    // Settings written before the switch existed carry one field, whose `'auto'` is exactly what
    // the switch now means — so an upgrade keeps the appearance the user had without asking.
    followSystem:
      typeof o.followSystem === 'boolean' ? o.followSystem : !isThemeName(o.theme),
    theme: isThemeName(o.theme) ? o.theme : DEFAULTS.theme,
    themeDark: isThemeName(o.themeDark) ? o.themeDark : DEFAULTS.themeDark,
    themeLight: isThemeName(o.themeLight) ? o.themeLight : DEFAULTS.themeLight,
    tmuxExtras: typeof o.tmuxExtras === 'boolean' ? o.tmuxExtras : DEFAULTS.tmuxExtras,
    lastUploadDir: typeof o.lastUploadDir === 'string' ? o.lastUploadDir : null,
  };
}

/* --- what a connect actually sends (§4.1, §4.9) --- */

/** The line the session types into the fresh shell, or `null` for none. One line that fish, bash
 *  and zsh parse identically — `&&`/`||`, `2>/dev/null` and a bare word are the common ground the
 *  tmux side-channel's commands already stand on. */
export function startupLine(s: Settings): string | null {
  const create = `tmux new-session -A -D -s ${SESSION_NAME}`;
  switch (s.startMode) {
    case 'shell':
      return null;
    case 'session':
      return create;
    // The pick can be gone by morning — the user closed it, or the host rebooted — so the fallback
    // is the same session the other mode would have made, rather than a failed line and a bare
    // prompt. `-d` on the attach only: nothing else can be on a session we are creating.
    case 'attach':
      return s.attachSession === null
        ? `tmux attach -d 2>/dev/null || ${create}`
        : `tmux attach -d -t ${shellQuote(s.attachSession)} 2>/dev/null || ${create}`;
    case 'custom':
      return s.startupCommand === null || s.startupCommand.trim() === '' ? null : s.startupCommand;
  }
}

/**
 * Whether this session is a tmux one, and so whether the conf gets pushed (§4.5). Not a toggle any
 * more: the features the conf buys — a notch of wheel, a yank on the pasteboard, the switcher —
 * are the tmux modes' own, so choosing tmux is choosing them. `custom` is read rather than asked
 * about, because a line the user wrote already says whether it starts tmux.
 */
export function usesTmux(s: Settings): boolean {
  if (s.startMode === 'session' || s.startMode === 'attach') return true;
  return s.startMode === 'custom' && /\btmux\b/.test(s.startupCommand ?? '');
}

/** Which of the three theme fields is live, given what the system is currently showing. */
export function themeNameFor(s: Settings, systemIsDark: boolean): ThemeName {
  if (!s.followSystem) return s.theme;
  return systemIsDark ? s.themeDark : s.themeLight;
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
