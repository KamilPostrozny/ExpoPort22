/**
 * TOFU host-key pinning (§4.1). The host's public key is remembered the first time the user says
 * to, and after that a different key is a hard refusal — not a prompt, because a prompt is exactly
 * what an attacker in the middle needs the user to tap through.
 *
 * SecureStore rather than AsyncStorage: a pin is the whole of this app's transport security, and
 * `WHEN_UNLOCKED_THIS_DEVICE_ONLY` keeps it off a restored phone, where it would be a pin the user
 * never made. The value stored is the key blob itself, byte for byte — the fingerprint is only for
 * showing a human, and comparing display strings is comparing a summary.
 */

import * as SecureStore from 'expo-secure-store';

import { toBase64 } from '@/base64';

const PREFIX = 'port22.hostkey.v1.';

const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

export type HostKeyVerdict =
  /** Pinned, and this is it. */
  | 'trust'
  /** Nothing pinned for this endpoint yet — first contact, so ask the user. */
  | 'ask'
  /** Pinned, and this is *not* it. */
  | 'mismatch';

export function hostKeyVerdict(pinned: string | null, offered: string): HostKeyVerdict {
  if (pinned === null) return 'ask';
  return pinned === offered ? 'trust' : 'mismatch';
}

/** SecureStore keys are `[A-Za-z0-9._-]` only and an endpoint carries colons, so base64url the
 *  whole thing rather than substituting characters: a substitution maps two endpoints onto one key
 *  often enough to matter when the thing behind the key is "which host am I allowed to trust". */
function storeKey(endpoint: string): string {
  const encoded = toBase64(new TextEncoder().encode(endpoint));
  return PREFIX + encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function pinnedHostKey(endpoint: string): Promise<string | null> {
  return SecureStore.getItemAsync(storeKey(endpoint), STORE_OPTIONS);
}

export function pinHostKey(endpoint: string, key: string): Promise<void> {
  return SecureStore.setItemAsync(storeKey(endpoint), key, STORE_OPTIONS);
}

/** The only way out of a mismatch (§4.1), and it is confirm-gated wherever it is offered. */
export function forgetHostKey(endpoint: string): Promise<void> {
  return SecureStore.deleteItemAsync(storeKey(endpoint), STORE_OPTIONS);
}
