/**
 * The Settings quick sheet (§4.8), per the prototype: grabber, swipe-dismiss, no Done button —
 * over the live terminal, so a theme tap restyles the session behind it while it is still up.
 * Sections: APPEARANCE (the follow-the-system switch and the font-size stepper, then the theme
 * lists the switch decides between), TMUX (the comfort-settings opt-out, on a tmux session only),
 * SESSION (Disconnect in accent, Forget host key in red behind a confirm).
 *
 * The switch comes before the lists rather than sitting inside them because it changes what the
 * lists *are*: following the system asks for two answers, one per appearance, and most schemes
 * ship only one cut — so the alternative, one list with a leading "Auto" row, would be asking the
 * system to flip between a light Gruvbox that does not exist and the dark one that does.
 *
 * What is deliberately NOT here: host, port, username, startup command — those live on the Setup
 * screen only, and §4.8 hides them while connected. The prototype's "All settings" row led to a
 * full-screen surface whose contents are exactly that Setup form plus options this app does not
 * have (PLAN §6 settled against a key catalogue and recipe editor), so the row has no destination
 * and is omitted rather than wired to nothing.
 *
 * Construction: an RN Modal (transparent, so the terminal stays visible) with our own slide —
 * reanimated drives the translate, one RNGH pan is the swipe-dismiss, and the release decision is
 * `sheetShouldDismiss` in input-model, tested. No new dependency; T8's `pageSheet` Modal was ruled
 * out because the system sheet detaches from the screen edge and brings a system grabber that
 * dismisses without telling reanimated.
 */

import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import {
  Alert,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { sheetShouldDismiss } from '@/input-model';
import { forgetPinnedHostKey } from '@/session';
import {
  clampFontSize,
  endpoint,
  getSettings,
  updateSettings,
  useSettings,
  usesTmux,
} from '@/settings';
import {
  ALL_THEMES,
  DARK_THEMES,
  LIGHT_THEMES,
  MONO,
  type Theme,
  type ThemeName,
} from '@/theme';

/** How far offscreen the sheet starts and returns to — comfortably past its own height. */
const TRAVEL = 620;
/** Design §5d: Material sheets corner at 28; everything else here — mantle ground, surface0 cards
 *  at 16, the 36×5 overlay grabber — is what the Android frames already show, through the same
 *  theme roles, so the radius is the whole Android skin. */
const SHEET_RADIUS = Platform.OS === 'android' ? 28 : 24;
const SLIDE = { duration: 340, easing: Easing.bezier(0.32, 0.72, 0.3, 1) };
/** How far down the sheet counts as "the grabber" for a drag: `paddingTop` 8 + the 5pt bar + its
 *  12pt padding is 25, rounded up to a thumb. Generous on purpose — it laps a little over the
 *  APPEARANCE header, where a downward drag has nothing else to mean. */
const GRABBER_ZONE = 40;

/** The prototype's cross-flavour neutrals (overlay-grey at fixed alpha, same literal on all four
 *  flavours — the same family the key bar uses). */
const HAIRLINE = 'rgba(127,132,156,0.3)';
const STEPPER_TINT = 'rgba(127,132,156,0.25)';

/** The swatch strip's six chips, in the prototype's order — now ANSI slots rather than Catppuccin
 *  names, because those six are the one thing every scheme is guaranteed to have. */
const SWATCHES = [1, 2, 3, 4, 5, 6];

export default function SettingsSheet({
  theme,
  onClose,
  onDisconnect,
}: {
  theme: Theme;
  /** The sheet has already slid out when this fires. */
  onClose: () => void;
  onDisconnect: () => void;
}) {
  const settings = useSettings();
  const insets = useSafeAreaInsets();
  const ty = useSharedValue(TRAVEL);
  const scrollRef = useRef<ScrollView>(null);
  /** The theme lists make the sheet taller than the screen, so it scrolls — and a scroll and a
   *  swipe-dismiss are the same finger. Inside the list, the sheet only rides the finger from the
   *  top; below that the list keeps the gesture, or a flick through the themes would throw the
   *  sheet off the screen. */
  const atTop = useRef(true);
  /** Whether this drag began on the grabber, which always dismisses however the list is scrolled.
   *  Gating the grabber on `atTop` too is what made the sheet feel stuck (user, 2026-08-14: "hard
   *  time swiping them down… either the app lagging or it's hard to close them") — with
   *  twenty-six rows the list is almost never at the top, so the one handle whose entire job is
   *  dismissing was the one place dismissing did not work. */
  const fromGrabber = useRef(false);
  useEffect(() => {
    ty.value = withTiming(0, SLIDE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackTop = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    atTop.current = e.nativeEvent.contentOffset.y <= 0;
  };

  const close = () => {
    ty.value = withTiming(TRAVEL, SLIDE, (done) => {
      if (done) runOnJS(onClose)();
    });
  };

  // The swipe-dismiss (§4.8): the sheet rides the finger down (never up past rest), and the
  // release decision — distance or flick — is input-model's, tested.
  const pan = Gesture.Pan()
    .runOnJS(true)
    // RNGH types the argument as a component ref; a ScrollView ref is what it actually wants, and
    // without this the pan wins the arbitration outright and the list never scrolls.
    .simultaneousWithExternalGesture(scrollRef as unknown as React.RefObject<React.ComponentType>)
    .onBegin((e) => {
      fromGrabber.current = e.y < GRABBER_ZONE;
    })
    .onUpdate((e) => {
      if (fromGrabber.current || atTop.current) ty.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      const rides = fromGrabber.current || atTop.current;
      if (rides && sheetShouldDismiss(e.translationY, e.velocityY)) close();
      else ty.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.cubic) });
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - ty.value / TRAVEL }));

  /** §4.8: restyles the live session, no reconnect. */
  const pickTheme = (field: 'theme' | 'themeDark' | 'themeLight', name: ThemeName) => {
    console.log(`[settings] ${field} →`, name);
    updateSettings({ [field]: name });
  };

  const toggleFollow = (on: boolean) => {
    console.log('[settings] followSystem →', on);
    updateSettings({ followSystem: on });
  };

  const stepFont = (delta: number) => {
    const next = clampFontSize(getSettings().fontSize + delta);
    if (next === settings.fontSize) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('[settings] fontSize →', next);
    updateSettings({ fontSize: next }); // applied live through the terminal's fontSize prop
  };

  const toggleExtras = (on: boolean) => {
    console.log('[settings] tmuxExtras →', on);
    updateSettings({ tmuxExtras: on });
    // No push here: `source-file` can add lines to a running server, never take them back, so a
    // toggle that acted now would only ever act in one direction. The next connect pushes the
    // file the toggle asks for, and that one is honest both ways.
  };

  const forget = () =>
    Alert.alert(
      'Forget this host key?',
      `The next connection to ${endpoint(settings)} will ask you to trust a key again — and if ` +
        'something is answering in the machine’s place, that is the key you would be trusting.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget',
          style: 'destructive',
          onPress: () => {
            console.log('[settings] host key forgotten');
            void forgetPinnedHostKey();
          },
        },
      ],
    );

  const check = (
    <SymbolView
      name="checkmark"
      size={15}
      tintColor={theme.accent}
      fallback={<Text style={{ fontSize: 14, fontWeight: '700', color: theme.accent }}>✓</Text>}
    />
  );

  const themeList = (
    title: string,
    list: Theme[],
    field: 'theme' | 'themeDark' | 'themeLight',
  ) => (
    <>
      <Text style={[styles.header, styles.headerGap, { color: theme.muted }]}>{title}</Text>
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        {list.map((t, i) => (
          <Pressable
            key={t.name}
            onPress={() => pickTheme(field, t.name)}
            style={({ pressed }) => [
              styles.row,
              i > 0 && styles.rowLine,
              pressed && { backgroundColor: STEPPER_TINT },
            ]}>
            <Text style={[styles.label, { color: theme.foreground }]} numberOfLines={1}>
              {t.label}
            </Text>
            {/* The scheme's own background under its own six hues: the row is a sample of the
                terminal it would produce, which is the only thing a name like "Kanagawa" is not. */}
            <View style={[styles.swatch, { backgroundColor: t.background }]}>
              {SWATCHES.map((slot) => (
                <View key={slot} style={[styles.chip, { backgroundColor: t.ansi[slot] }]} />
              ))}
            </View>
            <View style={styles.checkSlot}>{settings[field] === t.name && check}</View>
          </Pressable>
        ))}
      </View>
    </>
  );

  return (
    <Modal transparent statusBarTranslucent animationType="none" onRequestClose={close}>
      {/* RNGH needs its own root inside a Modal's native window. */}
      <GestureHandlerRootView style={styles.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]}>
          <Pressable style={styles.fill} onPress={close} />
        </Animated.View>

        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              styles.sheet,
              { backgroundColor: theme.panel, paddingBottom: insets.bottom + 8 },
              sheetStyle,
            ]}>
            {/* the grabber — tap or swipe, there is no Done */}
            <Pressable onPress={close} style={styles.grabberZone}>
              <View style={[styles.grabber, { backgroundColor: theme.border }]} />
            </Pressable>

            <ScrollView
              ref={scrollRef}
              style={styles.scroll}
              bounces={false}
              showsVerticalScrollIndicator={false}
              scrollEventThrottle={16}
              // All three, not just `onScroll`: a fling that coasts to rest fires its last
              // `onScroll` before the list settles, and a stale "not at the top" is exactly the
              // state where the drag-to-dismiss goes dead again.
              onScroll={trackTop}
              onScrollEndDrag={trackTop}
              onMomentumScrollEnd={trackTop}>
              <Text style={[styles.header, { color: theme.muted }]}>APPEARANCE</Text>
              <View style={[styles.card, { backgroundColor: theme.surface }]}>
                <View style={styles.row}>
                  <Text style={[styles.label, { color: theme.foreground }]}>Follow system</Text>
                  <Switch
                    value={settings.followSystem}
                    onValueChange={toggleFollow}
                    trackColor={{ true: theme.accent }}
                  />
                </View>
                <View style={[styles.row, styles.rowLine]}>
                  <Text style={[styles.label, { color: theme.foreground }]}>Font size</Text>
                  <Text style={[styles.value, { color: theme.muted }]}>{settings.fontSize} pt</Text>
                  <View style={styles.stepper}>
                    <Pressable
                      onPress={() => stepFont(-1)}
                      style={({ pressed }) => [styles.stepKey, pressed && { opacity: 0.5 }]}>
                      <Text style={[styles.stepGlyph, { color: theme.foreground }]}>−</Text>
                    </Pressable>
                    <View style={styles.stepDivider} />
                    <Pressable
                      onPress={() => stepFont(1)}
                      style={({ pressed }) => [styles.stepKey, pressed && { opacity: 0.5 }]}>
                      <Text style={[styles.stepGlyph, { color: theme.foreground }]}>+</Text>
                    </Pressable>
                  </View>
                </View>
              </View>

              {settings.followSystem ? (
                <>
                  {themeList('WHEN THE SYSTEM IS DARK', DARK_THEMES, 'themeDark')}
                  {themeList('WHEN THE SYSTEM IS LIGHT', LIGHT_THEMES, 'themeLight')}
                </>
              ) : (
                themeList('THEME', ALL_THEMES, 'theme')
              )}

              {/* Only on a tmux session: on any other the toggle governs nothing, and a row that
                  explains why it is inert is worse than no row. */}
              {usesTmux(settings) && (
                <>
                  <Text style={[styles.header, styles.headerGap, { color: theme.muted }]}>
                    TMUX
                  </Text>
                  <View style={[styles.card, styles.row, { backgroundColor: theme.surface }]}>
                    <Text style={[styles.label, { color: theme.foreground }]}>Comfort settings</Text>
                    <Switch
                      value={settings.tmuxExtras}
                      onValueChange={toggleExtras}
                      trackColor={{ true: theme.accent }}
                    />
                  </View>
                  <Text style={[styles.note, { color: theme.placeholder }]}>
                    Colours, no status bar, deeper scrollback. Applies on the next connect.
                  </Text>
                </>
              )}

              <Text style={[styles.header, styles.headerGap, { color: theme.muted }]}>SESSION</Text>
              <View style={[styles.card, { backgroundColor: theme.surface }]}>
                <Pressable
                  onPress={onDisconnect}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && { backgroundColor: STEPPER_TINT },
                  ]}>
                  <Text style={[styles.label, { color: theme.accent }]}>Disconnect</Text>
                </Pressable>
                <Pressable
                  onPress={forget}
                  style={({ pressed }) => [
                    styles.actionRow,
                    styles.rowLine,
                    pressed && { backgroundColor: STEPPER_TINT },
                  ]}>
                  <Text style={[styles.label, { color: theme.danger }]}>Forget host key</Text>
                </Pressable>
              </View>
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  scrim: { backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingHorizontal: 20,
    paddingTop: 8,
    // Twenty-six theme rows are taller than any phone, so the sheet stops short of the status bar
    // and the list inside it scrolls.
    maxHeight: '88%',
    boxShadow: '0 -12px 40px rgba(0,0,0,0.45)',
  },
  scroll: { flexShrink: 1 },
  grabberZone: { alignItems: 'center', paddingBottom: 12 },
  grabber: { width: 36, height: 5, borderRadius: 3 },
  header: {
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 0.6,
    paddingHorizontal: 16,
    paddingBottom: 7,
  },
  headerGap: { paddingTop: 14 },
  card: { borderRadius: 16, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: HAIRLINE },
  label: { flex: 1, fontSize: 15 },
  value: { fontFamily: MONO, fontSize: 13, marginRight: 12 },
  swatch: { flexDirection: 'row', gap: 3, borderRadius: 6, padding: 3, marginRight: 12 },
  chip: { width: 9, height: 13, borderRadius: 2.5 },
  checkSlot: { width: 18, alignItems: 'flex-end' },
  stepper: {
    flexDirection: 'row',
    borderRadius: 9,
    overflow: 'hidden',
    backgroundColor: STEPPER_TINT,
  },
  stepKey: { width: 38, height: 30, alignItems: 'center', justifyContent: 'center' },
  stepGlyph: { fontSize: 20, lineHeight: 24 },
  stepDivider: { width: 1, backgroundColor: 'rgba(127,132,156,0.4)' },
  note: { fontSize: 11.5, lineHeight: 15, paddingHorizontal: 16, paddingTop: 6 },
  actionRow: { paddingHorizontal: 16, paddingVertical: 12 },
});
