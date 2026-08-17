/**
 * Settings, in two halves (T17). A `HostSettings` is the nine answers about one machine — where it
 * is, who we are on it, how a session starts there, where the last upload went. Everything else is
 * the app's, one answer for all hosts: the type size, the schemes, the tmux comforts. Everything
 * here is non-secret: the seed and the pinned host keys live in SecureStore instead (T5).
 *
 * A module-level singleton read through `useSyncExternalStore` rather than a context, so a
 * non-React caller (the SSH session, the tmux side-channel) reads the same settings without a
 * provider having to be in scope.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
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

/**
 * One machine. Every field here is an answer about *it* rather than about the app, which is why
 * they travel together and why `endpoint`, `validate`, `startupLine`, `pollSession` and `usesTmux`
 * all take one of these: none of them has ever read a global field.
 */
export type HostSettings = {
  /** Stable identity, from `Crypto.randomUUID()` — not derived from `endpoint()`, which is
   *  `host:port` and changes under the user's fingers while they type it, and not an index, which
   *  a delete would shift out from under `activeHostId`. */
  id: string;
  host: string;
  port: number;
  username: string;
  /** How the shell that comes up is turned into a session — see `START_MODES`. */
  startMode: StartMode;
  /** `attach` mode's target. `null` = the most recent session, which is what the mode means before
   *  anyone has chosen. */
  attachSession: string | null;
  /** What *this* host was running at the last connect — the list Setup offers. Cached because Setup
   *  is where the choice is made and there is no connection there to ask over; refreshed on every
   *  connect, so it is one session behind at worst, and the line falls back either way. Per host
   *  since T17, which also fixes it: one global cache showed the previous machine's sessions in the
   *  attach picker the moment the host field changed. */
  knownSessions: string[];
  /** `custom` mode's line, sent once the shell is up. `null` means send nothing. */
  startupCommand: string | null;
  /** Where the destination-upload sheet (§4.6) opens next time; `null` = `$HOME`. Written on every
   *  "Save here". Not a secret — it is a directory name on the user's own machine, and it only
   *  exists on that machine, which is why it is the host's and not the app's. */
  lastUploadDir: string | null;
};

export type Settings = {
  /** Never empty: `decode` always yields at least one, and `removeHost` puts a blank one back. */
  hosts: HostSettings[];
  /** Which of `hosts` Setup is editing and a connect uses. Always the id of a member — see
   *  `getHost`, which falls back rather than returning nothing. */
  activeHostId: string;
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
  /** T15's gate: Face ID / fingerprint / passcode before `connect()` opens anything. Global and
   *  not per-host — it guards the app on this phone, not one machine, and a per-host answer would
   *  mean the second host could be reached without the question the first one asked. Off by
   *  default: an app that demands a face before it has ever connected is not the first run anyone
   *  wants. */
  requireAuth: boolean;
};

/** A host nobody has typed into yet. `id` is not here because every host gets its own. */
export const HOST_DEFAULTS: Omit<HostSettings, 'id'> = {
  host: '',
  port: 22,
  username: '',
  startMode: 'session',
  attachSession: null,
  knownSessions: [],
  startupCommand: null,
  lastUploadDir: null,
};

/** The app's half. `hosts`/`activeHostId` are not defaulted here because a default host would need
 *  an id, and `decode` is the one place that makes them — see `decode({})`, which is the whole of
 *  "first run". */
export const DEFAULTS: Omit<Settings, 'hosts' | 'activeHostId'> = {
  fontSize: 13,
  followSystem: true,
  theme: DEFAULT_DARK,
  themeDark: DEFAULT_DARK,
  themeLight: DEFAULT_LIGHT,
  tmuxExtras: true,
  requireAuth: false,
};

const str = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback);
const num = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/** One host out of whatever shape a blob offers. Also the migration: a pre-T17 blob kept these
 *  nine fields at the top level, so running the same readers over the *whole* blob rebuilds the
 *  host it described, with a fresh id. */
export function decodeHost(raw: unknown): HostSettings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const startupCommand = typeof o.startupCommand === 'string' ? o.startupCommand : null;
  return {
    id: typeof o.id === 'string' && o.id !== '' ? o.id : Crypto.randomUUID(),
    host: str(o.host, HOST_DEFAULTS.host),
    port: num(o.port, HOST_DEFAULTS.port),
    username: str(o.username, HOST_DEFAULTS.username),
    // Settings written before the modes existed carry the old free-text line, and that line is
    // exactly what `custom` means — so it keeps working without the user being asked anything.
    startMode: START_MODES.includes(o.startMode as StartMode)
      ? (o.startMode as StartMode)
      : startupCommand !== null
        ? 'custom'
        : HOST_DEFAULTS.startMode,
    attachSession: typeof o.attachSession === 'string' ? o.attachSession : null,
    knownSessions: Array.isArray(o.knownSessions)
      ? o.knownSessions.filter((name): name is string => typeof name === 'string')
      : [],
    startupCommand,
    lastUploadDir: typeof o.lastUploadDir === 'string' ? o.lastUploadDir : null,
  };
}

/** Forward-tolerant: an unknown, missing or wrong-typed field takes its default rather than
 *  throwing away the whole blob, so settings written by another build still load. */
export function decode(raw: unknown): Settings {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  // The T17 migration, and it is one `if` rather than a new `STORAGE_KEY`: no `hosts` array means
  // either a blob from before the split — whose nine per-host fields are at the top level, where
  // `decodeHost` reads them — or nothing stored at all, which `decodeHost({})` answers with a blank
  // host. One code path, and an upgrade keeps the host the user already had.
  const hosts = (Array.isArray(o.hosts) ? o.hosts : []).map(decodeHost);
  if (hosts.length === 0) hosts.push(decodeHost(o));
  return {
    hosts,
    // A pointer at a host that is not there is worse than no pointer: `getHost` would fall back on
    // every read and the user would edit a row that never highlights.
    activeHostId: hosts.some((h) => h.id === o.activeHostId)
      ? (o.activeHostId as string)
      : hosts[0].id,
    fontSize: clampFontSize(num(o.fontSize, DEFAULTS.fontSize)),
    // Settings written before the switch existed carry one field, whose `'auto'` is exactly what
    // the switch now means — so an upgrade keeps the appearance the user had without asking.
    followSystem:
      typeof o.followSystem === 'boolean' ? o.followSystem : !isThemeName(o.theme),
    theme: isThemeName(o.theme) ? o.theme : DEFAULTS.theme,
    themeDark: isThemeName(o.themeDark) ? o.themeDark : DEFAULTS.themeDark,
    themeLight: isThemeName(o.themeLight) ? o.themeLight : DEFAULTS.themeLight,
    tmuxExtras: typeof o.tmuxExtras === 'boolean' ? o.tmuxExtras : DEFAULTS.tmuxExtras,
    requireAuth: typeof o.requireAuth === 'boolean' ? o.requireAuth : DEFAULTS.requireAuth,
  };
}

/* --- what a connect actually sends (§4.1, §4.9) --- */

/** The line the session types into the fresh shell, or `null` for none. One line that fish, bash
 *  and zsh parse identically — `&&`/`||`, `2>/dev/null` and a bare word are the common ground the
 *  tmux side-channel's commands already stand on. */
/**
 * Which session the poll should ask about, or `null` when we cannot know. `session` mode always
 * makes or attaches ours; `attach` mode knows it only once the user has picked one (a null pick
 * means "the most recent", which has no name to give). A `custom` line may or may not be tmux at
 * all, and `shell` never is.
 */
export function pollSession(s: HostSettings): string | null {
  if (s.startMode === 'session') return SESSION_NAME;
  if (s.startMode === 'attach') return s.attachSession;
  return null;
}

export function startupLine(s: HostSettings): string | null {
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
export function usesTmux(s: HostSettings): boolean {
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
export function validate(s: HostSettings): string | null {
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
export function endpoint(s: HostSettings): string {
  return `${s.host}:${s.port}`;
}

/* --- the store --- */

/** Through `decode` rather than an object literal, so the invariant "there is always a host, and
 *  `activeHostId` names it" holds from the first read, before hydration has had a chance to run. */
let current: Settings = decode({});
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

/* --- the active host (T17) --- */

/** The host every connect, every pin and every window command is about. The fallback is belt and
 *  braces — `decode`, `removeHost` and `selectHost` all keep `activeHostId` pointing at a member —
 *  but it means no caller ever has to handle "no host", which is not a state the app has. */
export function getHost(): HostSettings {
  return current.hosts.find((h) => h.id === current.activeHostId) ?? current.hosts[0];
}

export function useHost(): HostSettings {
  return useSyncExternalStore(subscribe, getHost, getHost);
}

/** Edits the active host. The id is not patchable: it is the row's identity, not one of its
 *  answers. */
export function updateHost(patch: Partial<Omit<HostSettings, 'id'>>): HostSettings {
  const next = { ...getHost(), ...patch };
  updateSettings({ hosts: current.hosts.map((h) => (h.id === next.id ? next : h)) });
  return next;
}

export function selectHost(id: string): void {
  if (current.hosts.some((h) => h.id === id)) updateSettings({ activeHostId: id });
}

/** A new blank row, selected — the user tapped "Add host" to type into it. */
export function addHost(): HostSettings {
  const host = decodeHost({});
  updateSettings({ hosts: [...current.hosts, host], activeHostId: host.id });
  return host;
}

/** Deleting the last host leaves a blank one rather than an empty list: "no host at all" is a state
 *  Setup would have to draw an empty version of, and the blank row is what a fresh install shows
 *  anyway. The pinned key is the caller's to offer (see Setup's confirm) — it lives in SecureStore
 *  under the endpoint, which this module does not touch. */
export function removeHost(id: string): void {
  const hosts = current.hosts.filter((h) => h.id !== id);
  if (hosts.length === 0) hosts.push(decodeHost({}));
  updateSettings({
    hosts,
    activeHostId: hosts.some((h) => h.id === current.activeHostId)
      ? current.activeHostId
      : hosts[0].id,
  });
}
