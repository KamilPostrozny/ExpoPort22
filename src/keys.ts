/**
 * The device's one ed25519 identity, and (T16) the three things the key screen can do to it:
 * replace it, import one, and put its public half on a host.
 *
 * The 32-byte seed is generated here and never leaves SecureStore —
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps it out of iCloud and off a restored phone. The public half
 * is re-derived on load rather than stored, so there is one source of truth: an imported key goes
 * through the same derivation as a generated one, which is why `importPrivateKey` hands back a seed
 * and nothing else.
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import ExpoSSH from '../modules/expo-ssh/src/ExpoSSHModule';
import { fromBase64, toBase64 } from '@/base64';
import {
  APPEND_OK,
  NEEDS_PASSPHRASE,
  READ_AUTHORIZED_KEYS,
  UNREADABLE,
  appendPlan,
  inspectOpenSSHKey,
} from '@/keys-model';
import { exec } from '@/tmux';

const SEED_KEY = 'port22.seed.v1';
const KEY_TYPE = 'ssh-ed25519';

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type KeyPair = {
  /** What `ExpoSSH.connect` wants. Never log it, never show it. */
  seedBase64: string;
  /** The `authorized_keys` line the user pastes by hand. */
  publicKeyLine: string;
};

export async function loadOrCreateKey(comment = 'port22'): Promise<KeyPair> {
  let seedBase64 = await SecureStore.getItemAsync(SEED_KEY, STORE_OPTIONS);
  if (seedBase64 === null) {
    seedBase64 = toBase64(Crypto.getRandomBytes(32));
    await SecureStore.setItemAsync(SEED_KEY, seedBase64, STORE_OPTIONS);
  }
  return deriveKey(seedBase64, comment);
}

/**
 * Seed → public line: the one derivation path, which every key comes through — loaded, generated
 * and imported alike.
 *
 * It is separate from the store so that a REPLACEMENT can derive before it writes. Everything that
 * can fail then fails while the old seed is still in place, which is what lets the screen say
 * "nothing has changed" and be telling the truth; the write is the last await in `regenerateKey`
 * and in `importKey`, so past it the replacement has happened and nothing after it may report
 * otherwise.
 */
async function deriveKey(seedBase64: string, comment = 'port22'): Promise<KeyPair> {
  // Imported here rather than at the top of the file. `keys.ts` is on the initial route's module
  // graph, and `@noble/curves/ed25519.js` evaluates the FROST, OPRF and ristretto255 constructions
  // at its own top level — none of which this app calls, and all of which survive tree shaking
  // (they are in the shipped bytecode). That is ~15ms of field arithmetic on the first-paint path
  // to serve the one call below, which is already async and happens after the screen is up.
  const { ed25519 } = await import('@noble/curves/ed25519.js');
  const publicKey = ed25519.getPublicKey(fromBase64(seedBase64));
  const publicKeyLine = `${KEY_TYPE} ${toBase64(publicKeyBlob(publicKey))} ${comment}`;
  // PLAN.md §7 says log freely; the seed is the one thing held back, and only because the public
  // half is what you ever need to read. Nothing enforces that — drop `seedBase64` in here if a
  // signature ever needs checking by hand.
  console.log('[keys]', publicKeyLine);
  return { seedBase64, publicKeyLine };
}

/**
 * `SHA256:…`, the half of the key line worth showing a human — the same format
 * `ExpoSSHModule.fingerprint` prints for host keys, over the same wire-format blob, so the two read
 * alike on screen. In JS rather than native because the key screen shows it with no connection up.
 *
 * It throws where the platform throws, and that is fine: it is the one part of a key that is pure
 * decoration, so the screen catches it and degrades the card (`NO_FINGERPRINT`) rather than letting
 * a digest take an action down with it.
 *
 * (`micro-key-producer/ssh.js` would hand this over along with a keygen — it is `@noble`'s author
 * and RN-clean — but it is generate-only, `expo-crypto` is already here, and this is four lines.)
 */
export async function fingerprint(publicKeyLine: string): Promise<string> {
  const blob = fromBase64(publicKeyLine.split(/\s+/)[1] ?? '');
  // The Uint8Array itself, NOT `blob.buffer`. expo-crypto's shipped `.d.ts` says `BufferSource`, so
  // both type-check, and the iOS converter really does take either — but the Android one is
  // `digest(algorithm, output: TypedArray, data: TypedArray)` (expo-crypto's `CryptoModule.kt`), and
  // a bare ArrayBuffer throws `Cannot convert '[object ArrayBuffer]' to a Kotlin type`. That threw
  // here on every call: the key screen read `reading…` forever, and worse, `fingerprint` was
  // awaited AFTER the seed was written and inside the same try, so Generate reported "Could not
  // write the new key" over a replacement that had already succeeded — a false failure on an
  // irreversible action (emulator, 2026-08-17). Both halves are fixed: the byte type here, and the
  // structure that let a digest speak for a write (see `regenerateKey` and the screen's `show`).
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, blob);
  return `SHA256:${toBase64(new Uint8Array(digest)).replace(/=+$/, '')}`;
}

/**
 * A brand-new identity in the same slot (T16). Destructive on purpose and confirm-gated by the
 * caller: the moment this returns, the old public line authenticates nowhere and the new one is on
 * no host yet.
 */
export async function regenerateKey(): Promise<KeyPair> {
  const seedBase64 = toBase64(Crypto.getRandomBytes(32));
  // Derive first, store second. It used to write and then read back, which put two awaits — the
  // noble import and the derivation — after the point of no return, and the screen then took a
  // third (the fingerprint) after that. When the third threw on Android, Generate reported "Could
  // not write the new key" over a replacement that had already succeeded: a false failure on an
  // action with no undo (emulator, 2026-08-17). With the write last, a throw out of here means the
  // old key is still the key, and that is the only thing the caller has to know.
  const key = await deriveKey(seedBase64);
  await SecureStore.setItemAsync(SEED_KEY, seedBase64, STORE_OPTIONS);
  return key;
}

export type ImportResult =
  | { key: KeyPair }
  /** A sentence for the screen, and nothing changed — every refusal is before the store is touched. */
  | { problem: string };

/**
 * An OpenSSH private key off the pasteboard or the field, stored as the seed it contains.
 *
 * The classification — container, key type, whether a passphrase is needed — happens in
 * `keys-model.ts` BEFORE the crossing, so both platforms refuse in the same words (and so the
 * refusals are testable off-device). The natives are asked only to do what JS cannot: bcrypt-pbkdf
 * and AES-CTR. Whatever they raise is one sentence, because at that point the only live causes are
 * a wrong passphrase and a body that has been edited.
 *
 * The passphrase is passed and dropped. It is never stored, and — see the paste screen, which says
 * so out loud — it no longer protects anything once the seed is at rest here.
 */
export async function importKey(text: string, passphrase: string): Promise<ImportResult> {
  const inspection = inspectOpenSSHKey(text);
  if (!inspection.ok) return { problem: inspection.problem };
  if (inspection.encrypted && passphrase === '') return { problem: NEEDS_PASSPHRASE };
  let seedBase64: string;
  try {
    seedBase64 = await ExpoSSH.importPrivateKey(text, passphrase === '' ? null : passphrase);
  } catch (error) {
    console.log('[keys] import failed:', error);
    return { problem: UNREADABLE };
  }
  // Same order as `regenerateKey`, and for the same reason: the store is touched only once the new
  // line is in hand, so every refusal AND every surprise is still "nothing here has changed".
  const key = await deriveKey(seedBase64);
  await SecureStore.setItemAsync(SEED_KEY, seedBase64, STORE_OPTIONS);
  return { key };
}

/**
 * The public line onto the host's `authorized_keys`, over the exec seam the live session already
 * has (§4.5's channel budget — `exec` is `run1`, a singleton like every other user action).
 *
 * Two calls with the decision in JS, not SFTP: `ExpoSSH.upload` writes a whole file, so an
 * `authorized_keys` with three other keys in it would be replaced by one, and neither native
 * exposes an append or a create mode — the 0700/0600 would need a chmod over exec regardless.
 *
 * The sentinel is what says it worked. The exit status belongs to the last link of the chain
 * (`echo`), which succeeds for its own reasons.
 */
export async function uploadPublicKey(publicKeyLine: string): Promise<{ ok: boolean; note: string }> {
  let existing = '';
  try {
    existing = await exec(READ_AUTHORIZED_KEYS);
  } catch {
    // `cat` on a missing file exits 1 and the exec seam throws — which is exactly "no file yet".
  }
  const plan = appendPlan(existing, publicKeyLine);
  if (plan.present) {
    return { ok: true, note: 'This key is already in ~/.ssh/authorized_keys. Nothing was added.' };
  }
  try {
    const answer = await exec(plan.command);
    if (!answer.includes(APPEND_OK)) {
      return {
        ok: false,
        note: 'The host did not confirm the write, so assume nothing was added. Check that ~/.ssh is writable.',
      };
    }
    return { ok: true, note: 'Added to ~/.ssh/authorized_keys on this host.' };
  } catch (error) {
    console.log('[keys] upload failed:', error);
    return { ok: false, note: 'The host refused the write. Nothing was added.' };
  }
}

/** `string("ssh-ed25519") + string(key)` — the wire encoding OpenSSH base64s into the key line. */
function publicKeyBlob(publicKey: Uint8Array): Uint8Array {
  const blob = new Uint8Array(4 + KEY_TYPE.length + 4 + publicKey.length);
  const view = new DataView(blob.buffer);
  view.setUint32(0, KEY_TYPE.length);
  for (let i = 0; i < KEY_TYPE.length; i++) blob[4 + i] = KEY_TYPE.charCodeAt(i);
  view.setUint32(4 + KEY_TYPE.length, publicKey.length);
  blob.set(publicKey, 8 + KEY_TYPE.length);
  return blob;
}

