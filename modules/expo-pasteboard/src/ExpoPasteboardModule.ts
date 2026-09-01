import { NativeModule, requireNativeModule } from 'expo';

/** A copied file's bytes, ready for the SFTP write. */
export type PasteboardFile = {
  /** The name the copying app gave it, with an extension where the platform knows one. */
  name: string;
  base64: string;
};

declare class ExpoPasteboardModule extends NativeModule {
  /** The copied file's name, or `null` when the pasteboard holds no file. Costs no paste banner. */
  peek(): Promise<string | null>;
  /** The copied file, or `null`. The read that shows the iOS paste banner. */
  read(): Promise<PasteboardFile | null>;
}

export default requireNativeModule<ExpoPasteboardModule>('ExpoPasteboard');
