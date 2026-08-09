/**
 * Clipboard slots (§4.4/§4.7), the pure half: the ring of recent OSC 52 yanks, pinning, and the
 * provenance labels the popover shows. The store in `src/clipboard.ts` executes; the design's
 * wording ("tmux yank · 2 min ago", "phone pasteboard · pinned") is the contract here.
 *
 * Slots are session-transient except pins, which `src/clipboard.ts` persists in SecureStore —
 * a pinned slot may well be a token or a password, which is exactly why AsyncStorage is out.
 */

export type SlotSource = 'yank' | 'upload' | 'pasteboard';

export type Slot = {
  text: string;
  source: SlotSource;
  /** Epoch ms when it arrived. */
  at: number;
  pinned: boolean;
};

/** The "last 3 yanks" of §4.7. Pinned slots do not count against it. */
export const MAX_UNPINNED = 3;

/** Newest first, pins survive, unpinned beyond the newest three drop. */
export function trim(slots: Slot[]): Slot[] {
  let unpinned = 0;
  return slots.filter((slot) => slot.pinned || ++unpinned <= MAX_UNPINNED);
}

/** A new slot lands on top; whatever that rotates out goes. */
export function push(slots: Slot[], slot: Slot): Slot[] {
  return trim([slot, ...slots]);
}

/** Flip a pin. Unpinning re-applies the cap, so a slot already beyond the newest three drops on
 *  the spot — which is what "unpin" means once newer yanks have passed it. */
export function togglePin(slots: Slot[], index: number): Slot[] {
  return trim(slots.map((slot, i) => (i === index ? { ...slot, pinned: !slot.pinned } : slot)));
}

const SOURCE_LABEL: Record<SlotSource, string> = {
  yank: 'tmux yank',
  upload: 'upload path',
  pasteboard: 'phone pasteboard',
};

export function relativeTime(at: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/** The popover's second line. A pin replaces the age — the design says "· pinned", and an age on
 *  a slot that will never rotate out answers a question nobody asked. */
export function provenance(slot: Slot, now: number): string {
  return `${SOURCE_LABEL[slot.source]} · ${slot.pinned ? 'pinned' : relativeTime(slot.at, now)}`;
}

/* --- pin persistence (SecureStore holds one JSON string) --- */

export function serializePins(slots: Slot[]): string {
  return JSON.stringify(slots.filter((slot) => slot.pinned));
}

/** Forward-tolerant like the settings decode: a bad blob is an empty pin list, not a crash. */
export function decodePins(raw: string | null): Slot[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry): Slot[] => {
      const o = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
      if (typeof o.text !== 'string' || o.text === '') return [];
      return [
        {
          text: o.text,
          source: o.source === 'upload' || o.source === 'pasteboard' ? o.source : 'yank',
          at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
          pinned: true,
        },
      ];
    });
  } catch {
    return [];
  }
}
