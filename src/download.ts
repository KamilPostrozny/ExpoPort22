/**
 * Download — the other half of §4.6. The app used to be "never downloads" (PLAN.md kept the file
 * browser out of v1 scope); the user brought it forward, and there was no prior spec for it, so
 * this is new design: the ⋯ menu's DOWNLOAD section opens the browse sheet
 * (`src/download-sheet.tsx`), the sheet chooses, and this file fetches.
 *
 * SFTP read → cache file → the system share sheet, which is where the file actually goes (Save to
 * Files / AirDrop on iOS, Save to Download / share on Android — the user's call, in the platform's
 * own UI, so the two builds match by construction rather than by a branch).
 *
 * Package check (AGENTS.md): `expo-sharing` is the Expo SDK module for the share sheet on both
 * platforms (tier 1), so nothing is hand-rolled. `expo-file-system`'s `File` writes base64 — the
 * same class `src/upload.ts` reads with.
 *
 * Failure wording mirrors §4.6's: "Could not send the file" → "Could not download the file" — one
 * alert, nothing typed, the sheet stays open so the pick can be retried.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Alert } from 'react-native';

import ExpoSSH from '../modules/expo-ssh/src/ExpoSSHModule';
import { joinPath } from '@/upload-model';
import { setUploadBusy } from '@/upload';

const CACHE_DIR = 'port22';

/** Fetch `name` from `dir` on the host into the cache, then hand it to the system share sheet.
 *  Resolves `false` after the one alert on failure — the caller's sheet stays open. */
export async function fetchFile(dir: string, name: string): Promise<boolean> {
  const path = joinPath(dir, name);
  setUploadBusy(true);
  try {
    const base64 = await ExpoSSH.download(path);
    new Directory(Paths.cache, CACHE_DIR).create({ idempotent: true });
    const file = new File(Paths.cache, CACHE_DIR, name);
    file.write(base64, { encoding: 'base64' });
    if (!(await Sharing.isAvailableAsync())) throw new Error('no share sheet on this platform');
    await Sharing.shareAsync(file.uri, { dialogTitle: name });
    return true;
  } catch (error) {
    console.log('[download] failed:', path, error);
    Alert.alert('Could not download the file');
    return false;
  } finally {
    setUploadBusy(false);
  }
}
