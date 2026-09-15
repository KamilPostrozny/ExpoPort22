import { NativeModule, requireNativeModule } from 'expo';

/** One raw physical key the OS would have swallowed — see `src/hwkeys-model.ts` for what they
 *  become. The module emits only the keys the 1×1 field does not meaningfully consume (its
 *  pass-through rule); plain printables, Enter, Backspace and Space never arrive here. */
export type HwKeyEvent = {
  platform: 'ios' | 'android';
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

export default requireNativeModule<ExpoHwKeysModule>('ExpoHwKeys');
