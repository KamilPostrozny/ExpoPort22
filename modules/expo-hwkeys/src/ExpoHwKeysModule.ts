import { NativeModule, requireNativeModule } from 'expo';

/** One raw physical key the OS would have swallowed — see `src/hwkeys-model.ts` for what they
 *  become. The module emits only the keys the 1×1 field does not meaningfully consume (its
 *  pass-through rule); plain printables, Enter, Backspace and Space never arrive here. */
export type HwKeyEvent = {
  platform: 'ios';
  /** iOS `UIKeyboardHidUsage` raw value, Android `KeyEvent.KEYCODE_*`. */
  keyCode: number;
  character: string;
  baseCharacter: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  repeat: boolean;
};

export type ExpoHwKeysModuleEvents = {
  /** A key the field would have dropped or wandered — one per key-down, repeats included. */
  onKey: (event: HwKeyEvent) => void;
};

declare class ExpoHwKeysModule extends NativeModule<ExpoHwKeysModuleEvents> {
  /** `'off'` (the default) passes every key through untouched. `'terminal'` intercepts everything
   *  the field does not consume; `'switcher'` intercepts only Escape, so the search field keeps
   *  the rest. */
  setMode(mode: 'off' | 'terminal' | 'switcher'): Promise<void>;
}

/**
 * `null` where the module is not built in — the native side is Apple-only for now, so Android
 * resolves nothing and the app runs exactly as before the feature. `requireNativeModule` throws
 * (not returns null) for a missing module, and an uncaught throw at import time takes the whole
 * route down — measured on the pre-module iOS client, whose terminal route refused to render.
 */
let hwKeys: ExpoHwKeysModule | null = null;
try {
  hwKeys = requireNativeModule<ExpoHwKeysModule>('ExpoHwKeys');
} catch {
  hwKeys = null;
}
export default hwKeys;
