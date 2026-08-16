/**
 * The destination browser sheet (§4.6, design 4d): a live SFTP listing — directories first, files
 * visible so a collision is visible before it happens — breadcrumb path, tap a directory to
 * descend, `..` to walk up, an editable SAVE AS field pre-filled with the sanitised source name,
 * and "Save here". Saving is silent: nothing is ever typed into the session from this flow.
 *
 * The sheet browses and chooses; the screen owns the actual upload (and the failure alert), so
 * the SFTP write and the busy tint live in one place for both flows. Paths are absolute — `$HOME`
 * is resolved once through `pwd` on an exec channel, because SFTP has no notion of `~` and the
 * breadcrumb needs real segments to walk.
 */

import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Dimensions,
  Keyboard,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
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
import { GRABBER, PRESSED, RADIUS, SHEET_RADIUS, SPACE, TEXT } from '@/style';
import { MONO, SANS, SANS_SEMIBOLD, type Theme } from '@/theme';
import {
  breadcrumb,
  formatSize,
  joinPath,
  parentPath,
  sanitizeFilename,
  sortEntries,
} from '@/upload-model';

export type UploadSheetProps = {
  theme: Theme;
  /** The header's right caption — the host being uploaded to. */
  host: string;
  /** The remembered last destination; `null` falls back to `$HOME`. */
  initialDir: string | null;
  /** Pre-fill for the SAVE AS field (already sanitised / camera-stamped by the caller). */
  suggestedName: string;
  onCancel: () => void;
  /** The choice: an existing directory and a filename. The caller uploads and remembers. */
  onSave: (dir: string, filename: string) => void;
};

/** Category (1), API that exists on one platform only: `presentationStyle="pageSheet"` is an iOS
 *  Modal mode; Android ignores it and would render edge-to-edge, so the sheet is hand-drawn there
 *  out of a transparent Modal. It must come out at the same corner radius, the same shadow, the
 *  same scrim and the same top gap as the iOS sheet. */
const ANDROID = Platform.OS === 'android';

/** The hand-built Android slide, in settings-sheet's numbers so the app's two sheets move alike:
 *  the window's own height is the one travel guaranteed to clear a sheet of any height, and the
 *  curve is the one that file measured against the system sheet. */
const TRAVEL = Dimensions.get('window').height;
const SLIDE = { duration: 340, easing: Easing.bezier(0.32, 0.72, 0.3, 1) };

export default function UploadSheet(props: UploadSheetProps) {
  const { theme } = props;
  const insets = useSafeAreaInsets();
  const [dir, setDir] = useState<string | null>(null);
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [name, setName] = useState(props.suggestedName);
  /**
   * The keyboard's height, as bottom padding for the sheet.
   *
   * `KeyboardAvoidingView` is the usual answer and it does not work here: it derives the overlap
   * from `onLayout`, whose y is parent-relative, and inside a `Modal` even `measureInWindow`
   * reports against the modal's own window — so the inset a pageSheet starts at is invisible from
   * in here, the lift comes out short, and the Save button stays under the keyboard
   * (measured on device, T13/T8.9). The sheet's bottom *is* the window's bottom, which makes the
   * keyboard's own height the exact padding needed, with nothing to measure.
   */
  const [keyboardPad, setKeyboardPad] = useState(0);
  /** How far the hand-built Android sheet is pushed off the bottom; the scrim's opacity is read
   *  back off it, so the dimming rides the slide instead of blinking on. Unread on iOS, where the
   *  system draws both the slide and the dim. */
  const ty = useSharedValue(TRAVEL);
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - ty.value / TRAVEL }));
  useEffect(() => {
    ty.value = withTiming(0, SLIDE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Category (1), API that exists on one platform only: Android has no `keyboardWill*` events at
  // all, so the `Did*` pair is the only source of the frame; without it `keyboardPad` stays 0 and
  // the Save button is unreachable behind Gboard. Only the timing differs — Android lifts after the
  // keyboard lands. Both arms feed the identical `height()` math into the same `keyboardPad`.
  // On iOS `WillChangeFrame` rather than Show/Hide because it is the one that also fires when the
  // keyboard resizes under a language switch or a floating-to-docked change.
  // Padding is needed on Android at all — where `src/app/terminal.tsx` deliberately adds none —
  // because a `statusBarTranslucent` Modal window does not adjustResize.
  useEffect(() => {
    const height = (frame: { screenY: number; height: number }) =>
      // A keyboard parked off-screen (hidden, or the hardware-keyboard bar) reports a screenY at
      // or past the window's bottom edge; only the part that actually overlaps is padding.
      Math.max(0, Dimensions.get('window').height - frame.screenY);
    const subs = [
      Keyboard.addListener(ANDROID ? 'keyboardDidShow' : 'keyboardWillChangeFrame', (e) =>
        setKeyboardPad(height(e.endCoordinates)),
      ),
      Keyboard.addListener(ANDROID ? 'keyboardDidHide' : 'keyboardWillHide', () =>
        setKeyboardPad(0),
      ),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, []);

  // Resolve where to start, then list. A remembered directory that no longer lists (deleted,
  // permission gone) falls back to $HOME rather than showing an error nobody can act on.
  useEffect(() => {
    let stale = false;
    (async () => {
      const home = async () => (await ExpoSSH.exec('pwd', 4096)).trim();
      let start = props.initialDir;
      if (start !== null) {
        try {
          await ExpoSSH.listDirectory(start);
        } catch {
          start = null;
        }
      }
      if (start === null) start = await home();
      if (!stale) setDir(start);
    })().catch((error) => console.log('[upload] sheet could not resolve a start dir:', error));
    return () => {
      stale = true;
    };
  }, [props.initialDir]);

  // Every directory change lists fresh — the listing is the collision warning, so it is never
  // cached.
  useEffect(() => {
    if (dir === null) return;
    let stale = false;
    setEntries(null);
    ExpoSSH.listDirectory(dir)
      .then((listing) => {
        if (!stale) setEntries(sortEntries(listing));
      })
      .catch((error) => {
        console.log('[upload] listDirectory failed:', dir, error);
        if (!stale) setEntries([]);
      });
    return () => {
      stale = true;
    };
  }, [dir]);

  const filename = sanitizeFilename(name);
  const collision = entries?.some((entry) => !entry.isDirectory && entry.name === filename) ?? false;

  const row = (entry: RemoteEntry) => (
    <Pressable
      key={entry.name}
      disabled={!entry.isDirectory}
      onPress={() => setDir(joinPath(dir!, entry.name))}
      style={({ pressed }) => [
        styles.row,
        { borderBottomColor: theme.border },
        pressed && { backgroundColor: theme.surface },
      ]}>
      <Text style={[styles.rowIcon, { color: entry.isDirectory ? theme.accent : theme.muted }]}>
        {entry.isDirectory ? '\uf07b' : '\uf15b' /* Nerd Font folder / file */}
      </Text>
      <Text
        numberOfLines={1}
        style={[
          styles.rowName,
          { color: entry.isDirectory ? theme.foreground : theme.muted },
          !entry.isDirectory && entry.name === filename && { color: theme.warning },
        ]}>
        {entry.name}
      </Text>
      {!entry.isDirectory && (
        <Text style={[styles.rowSize, { color: theme.placeholder }]}>{formatSize(entry.size)}</Text>
      )}
      {entry.isDirectory && <Text style={[styles.chevron, { color: theme.placeholder }]}>›</Text>}
    </Pressable>
  );

  /** Every dismiss goes through here. iOS's pageSheet animates its own way off the screen, so the
   *  caller may unmount immediately; the Android sheet is ours to move, and telling the caller on
   *  the press would unmount it mid-slide and snap it away. */
  const close = () => {
    if (!ANDROID) return props.onCancel();
    ty.value = withTiming(TRAVEL, SLIDE, (done) => {
      if (done) runOnJS(props.onCancel)();
    });
  };

  // Category (2), hardware affordance: Android has a system back button, and it walks the browser
  // up one directory first, dismissing only from the top ('/', where the `..` row also stops).
  // iOS reaches `onRequestClose` solely from the pageSheet pull-down, which has already dismissed
  // natively, so walking up a directory there would leave the component alive with a changed dir
  // while the OS tears the sheet down.
  const systemBack = () => {
    if (ANDROID && dir !== null && dir !== '/') setDir(parentPath(dir));
    else close();
  };

  return (
    <Modal
      // `slide` is the system's dismissal for a pageSheet; the Android arm animates itself, and a
      // system slide on top of ours would move the scrim with the sheet instead of fading it.
      animationType={ANDROID ? 'none' : 'slide'}
      presentationStyle={ANDROID ? undefined : 'pageSheet'}
      transparent={ANDROID}
      // Load-bearing on Android beyond the look: without it the Modal's window stops below the
      // status bar and the gap below is measured from the wrong origin.
      statusBarTranslucent
      onRequestClose={systemBack}
      visible>
      {/* The dim iOS's pageSheet puts over the terminal for free; the same layer, opacity tied to
          the slide, so the terminal is not sitting undimmed in the gap above the sheet. */}
      {ANDROID && (
        <Animated.View
          style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }, scrimStyle]}>
          <Pressable style={styles.fill} onPress={close} />
        </Animated.View>
      )}
      <Animated.View style={[styles.fill, ANDROID && sheetStyle]}>
        {/* The gap that keeps the sheet off the top of the screen — with no `presentationStyle`
            there is nothing to draw it on Android. Inert: the scrim behind it owns the dismiss,
            one tap target for the whole exposed strip.
            The 46 is UNVERIFIED: it came off the deleted Android frames, never off the iOS sheet.
            It stands only until someone measures the pageSheet's top edge on device and puts that
            number here — it is not a value anything chose. */}
        {ANDROID && <View style={{ height: insets.top + 46 }} />}
        {/* The SAVE AS field sits at the bottom of the sheet, so a raised keyboard covers both it
            and the Save button unless the content is lifted (found on device, T13/T8.9). */}
        <View
          style={[
            styles.sheet,
            ANDROID && styles.sheetAndroid,
            { backgroundColor: theme.panel, paddingBottom: keyboardPad },
          ]}>
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: theme.border }]} />
          </View>
          <View style={styles.header}>
            <Pressable onPress={close} hitSlop={10}>
              <Text style={[styles.headerSide, { color: theme.accent }]}>Cancel</Text>
            </Pressable>
            <Text style={[styles.headerTitle, { color: theme.foreground }]}>Upload to…</Text>
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

          <View
            style={[
              styles.footer,
              { backgroundColor: theme.panel, borderTopColor: theme.border },
              // Category (2), hardware affordance: Android's edge-to-edge puts the gesture pill
              // inside this Modal's own window, where iOS's pageSheet is already system-inset above
              // the home indicator; without this the Save button sits under the pill. The
              // `keyboardPad === 0` guard is required either way — with the keyboard up,
              // `insets.bottom` is already inside the keyboard's height and would double-count.
              ANDROID && keyboardPad === 0 && { paddingBottom: insets.bottom + 12 },
            ]}>
            <Text style={[styles.saveAs, { color: theme.muted }]}>
              SAVE AS{collision ? ' — replaces the existing file' : ''}
            </Text>
            <TextInput
              value={name}
              onChangeText={setName}
              autoCorrect={false}
              autoCapitalize="none"
              spellCheck={false}
              style={[
                styles.nameField,
                {
                  color: theme.foreground,
                  backgroundColor: theme.background,
                  borderColor: collision ? theme.warning : theme.accent,
                },
              ]}
            />
            <Pressable
              disabled={dir === null}
              onPress={() => props.onSave(dir!, filename)}
              style={({ pressed }) => [
                styles.save,
                { backgroundColor: theme.accent },
                (pressed || dir === null) && PRESSED,
              ]}>
              <Text style={[styles.saveLabel, { color: theme.onAccent }]}>Save here</Text>
              {dir !== null && (
                <Text style={[styles.savePath, { color: theme.onAccent }]} numberOfLines={1}>
                  {dir}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  sheet: { flex: 1 },
  /* Only Android draws its own sheet — iOS's pageSheet is drawn by the system — so this reproduces
     the iOS card: `SHEET_RADIUS` corners, the app's one sheet shadow, clipped. `overflow` is
     load-bearing: it is what cuts the FlatList's top rows to the corner. */
  sheetAndroid: {
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
  footer: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: SPACE.wide,
    paddingTop: 12,
    paddingBottom: 26,
    gap: 10,
  },
  saveAs: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: 10, letterSpacing: 0.6 },
  nameField: {
    height: 42,
    borderRadius: RADIUS.control,
    borderWidth: 1,
    paddingHorizontal: 12,
    // The box is a fixed height and centres its own text; RN's default vertical padding would
    // fight that, as it does in every other fixed-height field here. The prototype: padding:0 12px.
    paddingVertical: 0,
    fontFamily: MONO,
    includeFontPadding: false,
    fontSize: 14.5,
  },
  save: {
    height: 48,
    borderRadius: RADIUS.button,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingHorizontal: 16,
  },
  saveLabel: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: TEXT.button },
  savePath: { fontFamily: MONO, includeFontPadding: false, fontSize: 12, opacity: 0.65, flexShrink: 1 },
});
