import { useEffect, useRef } from 'react';
import { normalizeHwKey, routeHwKey, type HwRouteCtx } from '@/hwkeys-model';
import ExpoHwKeys from '../../modules/expo-hwkeys/src/ExpoHwKeysModule';

/**
 * The screen-facing half of the physical-keyboard seam (`modules/expo-hwkeys`).
 *
 * The mode tells the native side what to intercept — which only the app can decide, because it
 * is the one that knows when the terminal's field holds focus and the switcher is closed — and
 * every intercepted key comes back as one raw event that the model routes. The handlers are read
 * through refs, so the subscription is armed once per mode and never re-serialized on a render.
 */
export type HwKeysMode = 'off' | 'terminal' | 'switcher';

export type HwKeysHandlers = {
  /** PTY bytes for the key — the same bytes the key bar sends (the caller runs them through the
   *  bar's `track`, so line-length and dictation heuristics see them). */
  onBytes: (bytes: string) => void;
  /** Alt+1..9 / Alt+0 — select the tmux window with that number. */
  onWindowSelect: (number: number) => void;
  /** Alt+N — new tmux window. */
  onWindowNew: () => void;
  /** Alt+T — open the tab switcher. */
  onSwitcher: () => void;
  /** Cmd/Win+V — paste, the bar's own clipboard rules. */
  onPaste: () => void;
  /** Escape while the switcher is open — it closes. */
  onEscape: () => void;
};

export function useHwKeys(mode: HwKeysMode, ctx: HwRouteCtx, handlers: HwKeysHandlers): void {
  // The handlers are fresh closures every render; the subscription is not, so the refs carry the
  // latest into it. Updated in an effect, not in render: a key that arrives between the commit
  // and the effect would read the previous render's handlers, and a wrong byte is worse.
  const ctxRef = useRef(ctx);
  const handlersRef = useRef(handlers);
  const modeRef = useRef(mode);
  useEffect(() => {
    ctxRef.current = ctx;
    handlersRef.current = handlers;
    modeRef.current = mode;
  });

  useEffect(() => {
    // `null` off Apple (the native module is not built in there): no subscription, no mode call,
    // and the hardware keys take the app's pre-feature path — the field's own pipeline.
    console.log('[hwkeys] mode ->', mode, 'native:', ExpoHwKeys ? 'present' : 'missing');
    if (ExpoHwKeys === null) return;
    const hwKeys = ExpoHwKeys;
    hwKeys
      .setMode(mode)
      .then(() => console.log('[hwkeys] setMode ok', mode))
      .catch((error: unknown) => console.log('[hwkeys] setMode ERR', mode, String(error)));
    const sub = hwKeys.addListener('onKey', (raw) => {
      console.log('[hwkeys] raw', JSON.stringify(raw));
      const current = modeRef.current;
      if (current === 'off') return;
      if (current === 'switcher') {
        // The native side already filtered this mode to Escape alone.
        if (normalizeHwKey(raw).key === 'escape') handlersRef.current.onEscape();
        return;
      }
      const route = routeHwKey(normalizeHwKey(raw), ctxRef.current);
      switch (route.kind) {
        case 'bytes':
          handlersRef.current.onBytes(route.bytes);
          break;
        case 'window-select':
          handlersRef.current.onWindowSelect(route.number);
          break;
        case 'window-new':
          handlersRef.current.onWindowNew();
          break;
        case 'switcher':
          handlersRef.current.onSwitcher();
          break;
        case 'paste':
          handlersRef.current.onPaste();
          break;
        case 'ignore':
          break;
      }
    });
    const dbg = hwKeys.addListener('onKeyDebug', (info) => {
      console.log('[hwkeys:debug]', JSON.stringify(info));
    });
    return () => {
      sub.remove();
      dbg.remove();
      void hwKeys.setMode('off');
    };
  }, [mode]);
}
