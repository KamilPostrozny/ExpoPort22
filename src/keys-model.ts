/**
 * The decisions behind the key screen (T16), pure so `bun test` can hold them and so both
 * platforms make them identically: what a pasted key IS before any native parser is handed it, and
 * what appending the public line to a host's `authorized_keys` has to do.
 *
 * Why the classification is here rather than in Swift and Kotlin: the two natives must refuse in
 * the same words, and the only way to guarantee that without writing the same prose twice is to
 * decide before the crossing. The OpenSSH v1 container states its cipher and its key type in the
 * clear — the encrypted part is only the private half — so "is this ed25519", "is this OpenSSH v1"
 * and "does it need a passphrase" are all answerable here, with `atob` and no crypto at all. What
 * the natives are for is the one thing this cannot do: bcrypt-pbkdf and AES-CTR.
 */

import { fromBase64 } from '@/base64';
import { shellQuote } from '@/tmux-model';

const HEADER = '-----BEGIN OPENSSH PRIVATE KEY-----';
const FOOTER = '-----END OPENSSH PRIVATE KEY-----';
/** The container's own first field, NUL included — `ssh-keygen`'s v1 magic. */
const MAGIC = 'openssh-key-v1\0';
const ED25519 = 'ssh-ed25519';

/* --- what the paste screen says when it says no (§4.1's plain English) --- */

/**
 * PEM, PKCS#8 and PuTTY are refused on both platforms even though sshj reads all three: Citadel's
 * reader takes the OpenSSH v1 container only, iOS is the spec, and a key that imports on one phone
 * and not the other is worse than one sentence naming the one-command fix.
 */
export const NOT_OPENSSH =
  'Port22 reads OpenSSH keys — the kind that starts “-----BEGIN OPENSSH PRIVATE KEY-----”. An ' +
  'older PEM, PKCS#8 or PuTTY key converts in one command: ssh-keygen -p -f <key>. Nothing here ' +
  'has changed.';

/** Ours, not the platform's: an RSA private key has no 32-byte seed, so accepting one means a
 *  second shape at rest, a second `connect` path and a second auth method on both natives. */
export function notEd25519(type: string): string {
  return (
    `Port22 uses ed25519 keys, and this one is ${type}. Make one with ssh-keygen -t ed25519, or ` +
    'tap Generate to make one here — either way the new line has to reach the host. Nothing here ' +
    'has changed.'
  );
}

export const NEEDS_PASSPHRASE =
  'This key is protected by a passphrase. Type it in the field above and try again. Nothing here ' +
  'has changed.';

/** Everything the native reader can fail at, in one sentence: a wrong passphrase is the likely
 *  one, and a truncated or hand-edited body is the other. */
export const UNREADABLE =
  'That key could not be opened. If it has a passphrase, check it and try again. Nothing here has ' +
  'changed.';

/* --- reading the container --- */

export type KeyInspection =
  /** Worth handing to the native reader. `encrypted` decides whether a passphrase is required. */
  | { ok: true; encrypted: boolean }
  /** Refused here, in these words, on both platforms. */
  | { ok: false; problem: string };

/**
 * `uint32 length` then that many bytes — the one encoding the container is built out of, and the
 * same one `keys.ts` writes forwards for the public line.
 */
function readString(bytes: Uint8Array, at: number): { value: Uint8Array; next: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(at);
  const start = at + 4;
  if (start + length > bytes.length) throw new RangeError('truncated');
  return { value: bytes.subarray(start, start + length), next: start + length };
}

const ascii = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/**
 * `openssh-key-v1\0`, then `string ciphername`, `string kdfname`, `string kdfoptions`,
 * `uint32 nkeys`, `string publickey` — whose own first field is the key type. Nothing after that
 * is read, and nothing after that is readable anyway when the key is encrypted.
 */
export function inspectOpenSSHKey(text: string): KeyInspection {
  const trimmed = text.trim();
  if (!trimmed.startsWith(HEADER) || !trimmed.endsWith(FOOTER)) return refuse(NOT_OPENSSH);
  const body = trimmed.slice(HEADER.length, trimmed.length - FOOTER.length).replace(/\s+/g, '');
  try {
    const bytes = fromBase64(body);
    if (ascii(bytes.subarray(0, MAGIC.length)) !== MAGIC) return refuse(NOT_OPENSSH);
    const cipher = readString(bytes, MAGIC.length);
    const kdf = readString(bytes, cipher.next);
    const options = readString(bytes, kdf.next);
    const publicKey = readString(bytes, options.next + 4); // + the uint32 key count
    const type = ascii(readString(publicKey.value, 0).value);
    if (type !== ED25519) return refuse(notEd25519(type));
    return { ok: true, encrypted: ascii(cipher.value) !== 'none' };
  } catch {
    // A body that is not base64, or lengths that run off the end: not a container we can read, and
    // the sentence that names the conversion is still the useful thing to say.
    return refuse(NOT_OPENSSH);
  }
}

function refuse(problem: string): KeyInspection {
  return { ok: false, problem };
}

/* --- putting the public line on the host --- */

/** Step one of the upload. `2>/dev/null` so a host with no `~/.ssh` answers nothing rather than a
 *  message we would have to parse around; the exec seam throws on `cat`'s exit 1 either way, and
 *  the caller reads that as "no file yet". */
export const READ_AUTHORIZED_KEYS = 'cat ~/.ssh/authorized_keys 2>/dev/null';

/** What the append chain prints when every link of it ran. Checked instead of the exit status:
 *  the status belongs to the last command in the chain, and `echo` succeeds for its own reasons. */
export const APPEND_OK = 'PORT22_OK';

export type AppendPlan =
  /** The key is already in the file — the second Upload of the same key adds nothing. */
  | { present: true }
  | { present: false; command: string };

/** Type and blob, without the comment: the comment is a label the user may change on either side,
 *  and a key that differs only in its comment is the same key in the same file twice. */
function body(line: string): string {
  const [type = '', blob = ''] = line.trim().split(/\s+/);
  return `${type} ${blob}`;
}

/**
 * Step two, decided in JS off the file we just read.
 *
 * The leading newline is the whole reason this is a function: a file that does not end in one
 * would otherwise have the new key glued onto the end of somebody else's line, which is the
 * failure mode of every hand-written `>>` on the internet — and it locks the user out of the
 * key that was already there, not just the new one.
 *
 * `&&` throughout, so a failed `mkdir` cannot reach the append and a failed append cannot reach
 * the chmod; `printf '%s\n'` rather than `echo`, whose escape handling differs between shells;
 * and no `{ …; }`, which fish does not have. Every token parses the same in fish, bash and zsh.
 */
export function appendPlan(existing: string, line: string): AppendPlan {
  const wanted = body(line);
  const present = existing
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .some((l) => body(l) === wanted);
  if (present) return { present: true };
  // An empty file (or none at all) needs no leading newline; one that ends mid-line does.
  const format = existing === '' || existing.endsWith('\n') ? '%s\\n' : '\\n%s\\n';
  return {
    present: false,
    command:
      'mkdir -p ~/.ssh && chmod 700 ~/.ssh && ' +
      `printf '${format}' ${shellQuote(line.trim())} >> ~/.ssh/authorized_keys && ` +
      `chmod 600 ~/.ssh/authorized_keys && echo ${APPEND_OK}`,
  };
}
