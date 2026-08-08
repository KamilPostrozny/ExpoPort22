/**
 * The device's one ed25519 identity. The 32-byte seed is generated here and never leaves
 * SecureStore — `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps it out of iCloud and off a restored phone.
 * The public half is re-derived on load rather than stored, so there is one source of truth.
 */

import { ed25519 } from '@noble/curves/ed25519.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

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
  const publicKey = ed25519.getPublicKey(fromBase64(seedBase64));
  return { seedBase64, publicKeyLine: `${KEY_TYPE} ${toBase64(publicKeyBlob(publicKey))} ${comment}` };
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

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
