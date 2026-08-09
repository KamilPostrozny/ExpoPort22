/**
 * Uploads (§4.6), the glue: pickers in, SFTP out, and the two flows — quick-attach (T11's agent
 * ribbon cap calls `quickAttach`) and the destination browser (the sheet drives `sendFile`).
 * Decisions live in `src/upload-model.ts`, tested; failure wording is §4.6's: "Could not send the
 * file", nothing typed, nothing left behind (best-effort — no cleanup machinery).
 *
 * Package check (AGENTS.md): expo-image-picker covers Photo-or-video *and* Camera
 * (`launchCameraAsync` is the system camera UI), so expo-camera stays out — a whole camera screen
 * of our own is exactly what §4.6 does not ask for. expo-document-picker covers Files; neither
 * returns bytes on native, so expo-file-system's `File` reads the picked URI as base64 — whole
 * file in memory, size unguarded, per §7.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';
import { useSyncExternalStore } from 'react';

import ExpoSSH from '../modules/expo-ssh/src/ExpoSSHModule';
import { pushUploadPath } from '@/clipboard';
import { send } from '@/session';
import { QUICK_DIR, joinPath, stampName } from '@/upload-model';

export type UploadKind = 'files' | 'photo' | 'camera';

export type PickedFile = {
  /** The picker's filename; `null` when it has none (camera captures often do not). */
  name: string | null;
  base64: string;
};

/* --- the busy flag: §4.4's whole progress UI (⋯ circle tints accent and goes inert) --- */

let busy = false;
const listeners = new Set<() => void>();

function setBusy(next: boolean) {
  busy = next;
  for (const listener of listeners) listener();
}

export function useUploadBusy(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => busy,
    () => busy,
  );
}

/* --- pickers --- */

/** One of the three ⋯ sources (or the ribbon cap's). Resolves `null` on cancel — which is not a
 *  failure and shows nothing. */
export async function pick(kind: UploadKind): Promise<PickedFile | null> {
  if (kind === 'files') {
    const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    if (result.canceled) return null;
    const asset = result.assets[0];
    return { name: asset.name ?? null, base64: await new File(asset.uri).base64() };
  }
  if (kind === 'camera') {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) return null; // iOS already said why; a second alert teaches nothing
    const result = await ImagePicker.launchCameraAsync({ quality: 1 });
    if (result.canceled) return null;
    const asset = result.assets[0];
    return { name: asset.fileName ?? null, base64: await new File(asset.uri).base64() };
  }
  // 'photo' — the system photo picker needs no permission on iOS (PHPicker).
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images', 'videos'],
    quality: 1,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  return { name: asset.fileName ?? null, base64: await new File(asset.uri).base64() };
}

/* --- the shared send --- */

/** SFTP write with the busy flag around it and §4.6's failure behaviour: resolves `false` on
 *  failure after showing the one alert — nothing typed, nothing visible beyond it. */
export async function sendFile(
  base64: string,
  path: string,
  directories: string[] = [],
): Promise<boolean> {
  setBusy(true);
  try {
    await ExpoSSH.upload(base64, path, directories);
    return true;
  } catch (error) {
    console.log('[upload] failed:', path, error);
    Alert.alert('Could not send the file');
    return false;
  } finally {
    setBusy(false);
  }
}

/**
 * Quick attach (§4.6, agent ribbon cap only — T11 wires the cap): picker → `/tmp/port22/` under a
 * UTC-stamp name (mkdir 0700 on demand, same-second overwrite accepted) → the remote path plus one
 * trailing space typed into the session. Never a Return; never anything on failure or cancel.
 *
 * Resolves with the typed path, or `null` when the picker was cancelled or the send failed (the
 * failure alert has already been shown).
 */
export async function quickAttach(kind: UploadKind = 'files'): Promise<string | null> {
  const picked = await pick(kind);
  if (picked === null) return null;
  const path = joinPath(QUICK_DIR, stampName(new Date(), picked.name));
  if (!(await sendFile(picked.base64, path, [QUICK_DIR]))) return null;
  send(`${path} `); // typed, never executed — the trailing space is the whole gesture
  pushUploadPath(path);
  console.log('[upload] quick-attach typed', path);
  return path;
}
