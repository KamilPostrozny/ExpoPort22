import { NativeModule, requireNativeModule } from 'expo';

import { ExpoSSHModuleEvents, RemoteEntry } from './ExpoSSH.types';

declare class ExpoSSHModule extends NativeModule<ExpoSSHModuleEvents> {
  /**
   * Opens the connection and authenticates with the ed25519 seed (32 bytes, base64).
   *
   * Emits `onHostKey` during the handshake and does not settle until `verifyHostKey()` answers;
   * rejecting the key rejects this promise.
   */
  connect(host: string, port: number, username: string, seedBase64: string): Promise<void>;
  /** Answers the pending `onHostKey`. */
  verifyHostKey(accept: boolean): Promise<void>;
  disconnect(): Promise<void>;
  /** A round trip, not a socket flag — the only test a half-open TCP cannot fake. */
  isAlive(timeoutMs: number): Promise<boolean>;

  /** Opens the single PTY. Output arrives as `onShellData` until `onShellClose`. */
  startShell(cols: number, rows: number, term: string): Promise<void>;
  send(text: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;

  /** One command on its own exec channel — never the attached PTY, which would echo it. */
  exec(command: string, limit: number): Promise<string>;

  /** `directories` is the mkdir chain for `path`, shallowest first: SFTP mkdir has no `-p`. */
  upload(dataBase64: string, path: string, directories: string[]): Promise<void>;
  listDirectory(path: string): Promise<RemoteEntry[]>;
}

export default requireNativeModule<ExpoSSHModule>('ExpoSSH');
