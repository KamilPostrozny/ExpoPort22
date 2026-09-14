import { NativeModule, requireNativeModule } from 'expo';

/**
 * iOS: the terminal is a WKWebView, and a touch in its content makes WebKit's internal view
 * become first responder so key events route to the page — taking the keyboard with it, with no
 * blur and no `Keyboard.dismiss` (measured, iPhone 2026-09-14, the trace behind the re-aim in
 * `keybar.tsx`). Nothing the page or React Native does can stop it, so this module refuses the
 * become at the UIKit level while the bar's field holds the keys: a tap in the terminal stays a
 * click the pane gets, and the keys stay up. Android's focused EditText survives outside touches,
 * so there the flag is a no-op.
 */
declare class ExpoWebGuardModule extends NativeModule {
  /** While true, no view inside a WKWebView may become first responder (iOS). */
  setHold(hold: boolean): Promise<void>;
}

export default requireNativeModule<ExpoWebGuardModule>('ExpoWebGuard');
