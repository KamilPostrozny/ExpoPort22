/**
 * The clipboard slots store (§4.4/§4.7): last three OSC 52 yanks plus the phone-pasteboard entry,
 * pinnable. A module singleton read through `useSyncExternalStore`, like `settings` — the OSC 52
 * path, the Paste key and the popover are three unrelated callers of one list.
 *
 * Yanks are session-transient. Pins persist in SecureStore, not AsyncStorage — a pinned slot is
 * as likely as not a token or a password (§4.4). The decisions live in `src/clipboard-model.ts`,
 * tested; this file holds state and talks to the pasteboard.
 */

import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import { useSyncExternalStore } from 'react';

import {
  decodePins,
  push,
  serializePins,
  togglePin as togglePinModel,
  type Slot,
} from '@/clipboard-model';

export type { Slot };

const PINS_KEY = 'port22.clipboardpins.v1';

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type ClipboardState = {
  /** Newest first; pins interleaved where recency put them. The pasteboard entry is not here. */
  slots: Slot[];
  /** What the phone pasteboard held when the popover last opened; `null` until then or if empty. */
  pasteboard: Slot | null;
};

let state: ClipboardState = { slots: [], pasteboard: null };

const listeners = new Set<() => void>();

function set(next: ClipboardState) {
  state = next;
  console.log('[clipboard]', state.slots.length, 'slots,', state.slots.filter((s) => s.pinned).length, 'pinned');
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getClipboard(): ClipboardState {
  return state;
}

export function useClipboard(): ClipboardState {
  return useSyncExternalStore(subscribe, getClipboard, getClipboard);
}

/** Restore pinned slots at launch, alongside `hydrateSettings`. */
export async function hydratePins(): Promise<void> {
  try {
    const pins = decodePins(await SecureStore.getItemAsync(PINS_KEY, STORE_OPTIONS));
    if (pins.length > 0) set({ ...state, slots: [...state.slots, ...pins] });
  } catch {
    // An unreadable pin blob is an empty pin list; the next pin change overwrites it.
  }
}

function persistPins() {
  SecureStore.setItemAsync(PINS_KEY, serializePins(state.slots), STORE_OPTIONS).catch(() => {
    // A failed write costs the pins on next launch and nothing else.
  });
}

/** The OSC 52 path (§4.7): every yank also lands here, newest on top. */
export function pushYank(text: string): void {
  set({ ...state, slots: push(state.slots, { text, source: 'yank', at: Date.now(), pinned: false }) });
}

/** Quick-attach pushes the path it typed, so it can be pasted again later (design's slot 2). */
export function pushUploadPath(path: string): void {
  set({ ...state, slots: push(state.slots, { text: path, source: 'upload', at: Date.now(), pinned: false }) });
}

export function togglePin(index: number): void {
  set({ ...state, slots: togglePinModel(state.slots, index) });
  persistPins();
}

/** Pinning the pasteboard row copies it into the slots as a pinned entry — "phone pasteboard ·
 *  pinned", exactly the design's third row. */
export function pinPasteboard(): void {
  if (state.pasteboard === null) return;
  set({ ...state, slots: push(state.slots, { ...state.pasteboard, pinned: true }) });
  persistPins();
}

/** Called when the popover opens — the one accepted moment the iOS paste banner may fire (§4.4). */
export async function refreshPasteboard(): Promise<void> {
  const text = await Clipboard.getStringAsync().catch(() => '');
  set({
    ...state,
    pasteboard: text === '' ? null : { text, source: 'pasteboard', at: Date.now(), pinned: false },
  });
}

/** What the Paste key types on a plain tap: the top slot, or the phone pasteboard when there are
 *  no slots yet. Reading the pasteboard here fires the iOS banner, same as the popover would. */
export async function topSlotText(): Promise<string | null> {
  if (state.slots.length > 0) return state.slots[0].text;
  const text = await Clipboard.getStringAsync().catch(() => '');
  return text === '' ? null : text;
}
