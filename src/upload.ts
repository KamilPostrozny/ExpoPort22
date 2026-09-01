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

import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from 'react-native';
import { useSyncExternalStore } from 'react';

import ExpoPasteboard from '../modules/expo-pasteboard/src/ExpoPasteboardModule';
import ExpoSSH from '../modules/expo-ssh/src/ExpoSSHModule';
import { send } from '@/session';
import { QUICK_DIR, joinPath, stampName, stripDataUri } from '@/upload-model';

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
  try {
    return await pickOrThrow(kind);
  } catch (error) {
    // The picker can fail after the choice is made — a video the photo library cannot export
    // (`PHPhotosErrorDomain error 3164`, seen on device, T13/T8.14), a document provider that
    // goes away mid-read. Both callers fire this from a press handler, so an escaping rejection
    // is an unhandled one: a red box in dev, silence in production. §4.6's contract is one alert
    // and nothing else, which is what a failed *read* deserves as much as a failed send.
    console.log('[upload] picker failed:', error);
    Alert.alert('Could not read the file');
    return null;
  }
}

async function pickOrThrow(kind: UploadKind): Promise<PickedFile | null> {
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
  return picked === null ? null : attach(picked);
}

/**
 * Anything on the phone pasteboard that is not text (user, 2026-09-01): Paste had nothing to
 * *type*, so it typed nothing at all and the key looked dead. A photo or a PDF is a file, so it
 * takes the file route — the same quick-attach drop and the same typed path.
 *
 * Two readers, because a photo and a document sit on the pasteboard differently. `expo-clipboard`
 * hands an image back as bytes in a data URI and is asked first, so a copied photo keeps the name
 * and the PNG encoding it always had. Everything else — the PDF that started this — goes through
 * `expo-pasteboard`, our own module, for the reason written at the top of its Swift file: no
 * published package reads an arbitrary pasteboard item, and on iOS the file carries no URL to
 * chase either (`getUrlAsync()` measured `null` on device).
 *
 * Resolves `null` when the pasteboard holds neither — the same silence a cancelled picker gets.
 */
export async function pasteFile(): Promise<string | null> {
  const image = await Clipboard.getImageAsync({ format: 'png' }).catch(() => null);
  if (image !== null) return attach({ name: 'pasted.png', base64: stripDataUri(image.data) });

  const file = await ExpoPasteboard.read().catch((error: unknown) => {
    // A clip we cannot open: a `content://` whose grant died with the copying app, an item whose
    // provider has gone away. One alert, like any other unreadable pick.
    console.log('[upload] pasteboard file unreadable:', error);
    Alert.alert('Could not read the file');
    return null;
  });
  console.log('[upload] pasteboard file:', file?.name ?? null);
  return file === null ? null : attach({ name: file.name, base64: file.base64 });
}

/** Quick-attach's tail, shared with the pasted image: send, then type the path. */
async function attach(picked: PickedFile): Promise<string | null> {
  const path = joinPath(QUICK_DIR, stampName(new Date(), picked.name));
  if (!(await sendFile(picked.base64, path, [QUICK_DIR]))) return null;
  send(`${path} `); // typed, never executed — the trailing space is the whole gesture
  console.log('[upload] quick-attach typed', path);
  return path;
}
