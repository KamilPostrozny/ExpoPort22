/**
 * The download browse sheet: the upload destination browser turned around — the same live SFTP
 * listing, breadcrumb and travel, but files are the action. Tapping a directory descends, tapping
 * a file fetches it (the screen owns the fetch and the failure alert, exactly as it owns the
 * upload's SFTP write). The sheet closes only on a successful pick, so a failed download leaves
 * the browser where it was.
 *
 * Built the same way as `src/upload-sheet.tsx` for the reasons written there: a transparent Modal
 * with our own reanimated slide on both platforms, no system sheet, no branch. It carries none of
 * that sheet's keyboard machinery, because there is no text field — the keyboard never raises.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { RemoteEntry } from '../modules/expo-ssh/src/ExpoSSH.types';
import ExpoSSH from '../modules/expo-ssh/src/ExpoSSHModule';
import { GRABBER, SHEET_RADIUS, SPACE } from '@/style';
import { MONO, SANS, SANS_SEMIBOLD, type Theme } from '@/theme';
import { breadcrumb, formatSize, joinPath, parentPath, sortEntries } from '@/upload-model';

export type DownloadSheetProps = {
  theme: Theme;
  /** The header's right caption — the host being downloaded from. */
  host: string;
  onCancel: () => void;
  /** The choice: an existing directory and a filename. Resolves `true` when the fetch succeeded;
   *  the sheet dismisses only on `true`. */
  onPick: (dir: string, filename: string) => Promise<boolean>;
};

const ANDROID = Platform.OS === 'android';

/** Same slide as the two other sheets: the window's own height is the one travel guaranteed to
 *  clear a sheet of any height, and the app's sheets move alike. */
const TRAVEL = Dimensions.get('window').height;
const SLIDE = { duration: 340, easing: Easing.bezier(0.32, 0.72, 0.3, 1) };

export default function DownloadSheet(props: DownloadSheetProps) {
  const { theme } = props;
  const insets = useSafeAreaInsets();
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [picking, setPicking] = useState(false);
  /** How far the sheet is pushed off the bottom; the scrim's opacity is read back off it, so the
   *  dimming rides the slide instead of blinking on. Both platforms, one slide. */
  const ty = useSharedValue(TRAVEL);
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - ty.value / TRAVEL }));
  useEffect(() => {
    ty.value = withTiming(0, SLIDE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // SFTP has no notion of `~`, so the start directory is `$HOME` resolved once through `pwd` on an
  // exec channel — the upload sheet resolves its remembered directory the same way, and a
  // download starts fresh rather than reusing an upload's destination.
  useEffect(() => {
    let stale = false;
    (async () => {
      const home = (await ExpoSSH.exec('pwd', 4096)).trim();
      if (!stale) setDir(home);
    })().catch((error) => console.log('[download] sheet could not resolve a start dir:', error));
    return () => {
      stale = true;
    };
  }, []);

  // Every directory change lists fresh — the listing is never cached, like the upload browser's.
  useEffect(() => {
    if (dir === null) return;
    let stale = false;
    setEntries(null);
    ExpoSSH.listDirectory(dir)
      .then((listing) => {
        if (!stale) setEntries(sortEntries(listing));
      })
      .catch((error) => {
        console.log('[download] listDirectory failed:', dir, error);
        if (!stale) setEntries([]);
      });
    return () => {
      stale = true;
    };
  }, [dir]);

  /** The pick: the fetch is the screen's (it owns the alert), the sheet only keeps itself open
   *  while it runs and dismisses when it succeeds — a failed download leaves the browser where it
   *  was. `picking` is the inert state: one fetch at a time, rows dead for its duration. */
  const pick = async (name: string) => {
    setPicking(true);
    try {
      const ok = await props.onPick(dir!, name);
      if (ok) close();
    } finally {
      setPicking(false);
    }
  };

  const row = (entry: RemoteEntry) => (
    <Pressable
      key={entry.name}
      disabled={picking}
      onPress={() =>
        entry.isDirectory ? setDir(joinPath(dir!, entry.name)) : void pick(entry.name)
      }
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.border },
        pressed && { backgroundColor: theme.surface },
      ]}>
      <Text style={[styles.rowIcon, { color: entry.isDirectory ? theme.accent : theme.foreground }]}>
        {entry.isDirectory ? '\uf07b' : '\uf15b' /* Nerd Font folder / file */}
      </Text>
      <Text numberOfLines={1} style={[styles.rowName, { color: theme.foreground }]}>
        {entry.name}
      </Text>
      {!entry.isDirectory && (
        <Text style={[styles.rowSize, { color: theme.placeholder }]}>{formatSize(entry.size)}</Text>
      )}
      {entry.isDirectory && <Text style={[styles.chevron, { color: theme.placeholder }]}>›</Text>}
    </Pressable>
  );

  /** Every dismiss goes through here, as in the upload sheet: the caller is told when the slide
   *  lands, not on the press, so the sheet never unmounts mid-slide. */
  const close = () => {
    ty.value = withTiming(TRAVEL, SLIDE, (done) => {
      if (done) runOnJS(props.onCancel)();
    });
  };

  // Category (2), hardware affordance: Android's system back button. Same ladder as the upload
  // sheet — up one directory first, dismiss only from the top.
  const systemBack = () => {
    if (ANDROID && dir !== null && dir !== '/') setDir(parentPath(dir));
    else close();
  };

  return (
    <Modal
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={systemBack}
      visible>
      {/* The dim over the terminal, opacity tied to the slide; tapping it dismisses. */}
      <Animated.View
        style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }, scrimStyle]}>
        <Pressable style={styles.fill} onPress={close} />
      </Animated.View>
      <Animated.View style={[styles.fill, { paddingTop: insets.top + SPACE.sm }]} pointerEvents="box-none">
        <View
          style={[
            styles.sheet,
            { backgroundColor: theme.panel, paddingBottom: insets.bottom + 12 },
          ]}>
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: theme.border }]} />
          </View>
          <View style={styles.header}>
            <Pressable onPress={close} hitSlop={10}>
              <Text style={[styles.headerSide, { color: theme.accent }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.headerTitle, { color: theme.foreground }]}>Download from…</Text>
            <Text style={[styles.headerSide, { color: theme.muted }]} numberOfLines={1}>
              {props.host}
            </Text>
          </View>

          <View style={styles.crumbs}>
            {dir !== null &&
              breadcrumb(dir).map((segment, i, all) => (
                <Text
                  key={i}
                  numberOfLines={1}
                  style={[
                    styles.crumb,
                    {
                      color:
                        i === 0 ? theme.accent : i === all.length - 1 ? theme.foreground : theme.muted,
                    },
                  ]}>
                  {i > 1 && <Text style={{ color: theme.placeholder }}>{'› '}</Text>}
                  {segment}
                </Text>
              ))}
          </View>

          <View style={[styles.listing, { borderTopColor: theme.border }]}>
            {entries === null ? (
              <ActivityIndicator style={styles.spinner} color={theme.accent} />
            ) : (
              <FlatList
                data={entries}
                keyExtractor={(entry) => entry.name}
                renderItem={({ item }) => row(item)}
                ListHeaderComponent={
                  dir !== null && dir !== '/' ? (
                    <Pressable
                      disabled={picking}
                      onPress={() => setDir(parentPath(dir))}
                      style={({ pressed }) => [
                        styles.row,
                        { borderBottomColor: theme.border },
                        pressed && { backgroundColor: theme.surface },
                      ]}>
                      <Text style={[styles.rowIcon, { color: theme.accent }]}>{'\uf07b'}</Text>
                      <Text style={[styles.rowName, { color: theme.foreground }]}>..</Text>
                    </Pressable>
                  ) : null
                }
              />
            )}
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  /* The sheet's own numbers, as in the upload sheet: `SHEET_RADIUS` corners, the app's one sheet
     shadow, clipped. `overflow` is load-bearing: it cuts the FlatList's top rows to the corner. */
  sheet: {
    flex: 1,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    overflow: 'hidden',
    boxShadow: '0 -12px 40px rgba(0,0,0,0.45)',
  },
  grabberRow: { alignItems: 'center', paddingTop: 8, paddingBottom: 2 },
  grabber: GRABBER,
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE.wide,
    paddingTop: 6,
    paddingBottom: 10,
  },
  headerSide: { fontFamily: SANS, includeFontPadding: false, fontSize: 15, maxWidth: 110 },
  headerTitle: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: 15 },
  crumbs: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: SPACE.wide,
    paddingBottom: 10,
    flexWrap: 'nowrap',
    overflow: 'hidden',
  },
  crumb: { fontFamily: MONO, includeFontPadding: false, fontSize: 11.5, flexShrink: 1 },
  listing: { flex: 1, borderTopWidth: StyleSheet.hairlineWidth },
  spinner: { marginTop: 40 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    paddingHorizontal: SPACE.wide,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowIcon: { fontFamily: MONO, includeFontPadding: false, fontSize: 15, width: 20 },
  rowName: { flex: 1, fontFamily: MONO, includeFontPadding: false, fontSize: 14.5 },
  rowSize: { fontFamily: SANS, includeFontPadding: false, fontSize: 11 },
  // The bundled mono has U+203A; without naming it the glyph falls through to whatever face each
  // platform picks for it, and the two builds draw a different chevron.
  chevron: { fontFamily: MONO, includeFontPadding: false, fontSize: 16 },
});
