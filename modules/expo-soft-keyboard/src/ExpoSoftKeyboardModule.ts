import { NativeModule, requireOptionalNativeModule } from 'expo';

declare class ExpoSoftKeyboardModule extends NativeModule {
  /** Raises the IME over the terminal webview once its page has an editable element focused. */
  show(): Promise<void>;
}

/** Android only — `null` on iOS, where WebKit raises the keyboard from the page's own focus. */
export default requireOptionalNativeModule<ExpoSoftKeyboardModule>('ExpoSoftKeyboard');
