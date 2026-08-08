export type HostKeyEvent = {
  /** The host key in SSH wire format, base64. This is what gets pinned, byte for byte. */
  key: string;
  /** `SHA256:…`, the half of the OpenSSH line worth showing a human. */
  fingerprint: string;
};

export type ShellDataEvent = {
  /** PTY output, base64. Bytes rather than a string: a read can split a UTF-8 sequence. */
  data: string;
};

export type RemoteEntry = {
  name: string;
  isDirectory: boolean;
  size: number;
};

export type ExpoSSHModuleEvents = {
  /** Fired mid-handshake. `connect()` stays pending until `verifyHostKey()` answers. */
  onHostKey: (event: HostKeyEvent) => void;
  onShellData: (event: ShellDataEvent) => void;
  /** The PTY channel ended — remote hangup, or our own `disconnect()`. */
  onShellClose: () => void;
};
