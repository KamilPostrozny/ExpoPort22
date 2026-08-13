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

const native = requireNativeModule<ExpoSSHModule>('ExpoSSH');

/**
 * Set false to go quiet. Worth doing before profiling anything on the scroll path: `onShellData`
 * fires per channel read, so a `less` page or a `htop` refresh is hundreds of console lines, and
 * Metro's transport is slow enough to be the thing you end up measuring.
 */
const LOG = true;

const TAP_OUT = new Set(['addListener', 'removeListener', 'removeAllListeners', 'emit']);

/**
 * An argument as the log should carry it. A base64 upload is the whole file: logging one verbatim
 * put tens of megabytes through Metro's socket, which answered `RangeError: Max payload size
 * exceeded`, killed HMR and took the log with it — exactly while a large upload was the thing
 * being debugged (T13/T8.14). Keystrokes and paths are short and pass through untouched.
 */
function brief(arg: unknown): unknown {
  if (typeof arg !== 'string' || arg.length <= 120) return arg;
  return `${arg.slice(0, 60)}… (${arg.length} chars)`;
}

/**
 * Every call, its arguments, and how it settled — into the Metro console.
 *
 * A proxy rather than a hand-written wrapper per method so a function added to the native module
 * is logged without anyone remembering to wire it up.
 */
function logged(module: ExpoSSHModule): ExpoSSHModule {
  if (!LOG) return module;
  return new Proxy(module, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== 'function' || typeof property !== 'string' || TAP_OUT.has(property)) {
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (...args: unknown[]) => {
        console.log(`[ssh] ${property}`, ...args.map(brief));
        const result = value.apply(target, args);
        if (!(result instanceof Promise)) return result;
        return result.then(
          (resolved) => {
            // Through `brief` like the arguments: a capture-pane result is multi-KB of ANSI,
            // ten of them arrive per poll, and each console.log serializes through Metro ON the
            // JS thread — which the perf monitor showed pinned at 19-30fps while the UI ran 60,
            // making every gesture TRANSITION (row mount, slide start, settle) land 50-150ms
            // late: the "2-3 states instead of an animation" (2026-08-13).
            console.log(`[ssh] ${property} ->`, brief(resolved));
            return resolved;
          },
          (error) => {
            console.log(`[ssh] ${property} failed:`, error);
            throw error;
          },
        );
      };
    },
  });
}

if (LOG) {
  native.addListener('onHostKey', (event) => console.log('[ssh] onHostKey', event));
  // Decoded, because base64 tells you nothing at a glance, then JSON-quoted so an escape
  // sequence prints as \u001b[2J instead of repainting the terminal you are reading.
  native.addListener('onShellData', ({ data }) =>
    // Decoded then briefed — a redraw burst is tens of KB, and logging it whole is JS-thread
    // time taken from the gestures (see `->` above).
    console.log('[ssh] onShellData', brief(JSON.stringify(atob(data)))),
  );
  native.addListener('onShellClose', () => console.log('[ssh] onShellClose'));
}

export default logged(native);
