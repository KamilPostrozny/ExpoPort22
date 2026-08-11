/**
 * The Settings quick sheet (§4.8), per the prototype: grabber, swipe-dismiss, no Done button —
 * over the live terminal, so a flavour tap restyles the session behind it while it is still up.
 * Sections: APPEARANCE (Auto + the four flavours with swatch rows and a check, the font-size
 * stepper), TMUX (the push's status and the comfort-settings opt-out), SESSION (Disconnect in
 * accent, Forget host key in red behind a confirm).
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
import { useEffect } from 'react';
import { Alert, Modal, Platform, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
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
import { useTmux } from '@/tmux';
import { deriveConfigStatus } from '@/tmux-model';
import { FLAVOURS, MONO, THEMES, type Theme, type ThemeChoice } from '@/theme';

/** How far offscreen the sheet starts and returns to — comfortably past its own height. */
const TRAVEL = 620;
/** Design §5d: Material sheets corner at 28; everything else here — mantle ground, surface0 cards
 *  at 16, the 36×5 overlay grabber — is what the Android frames already show, through the same
 *  theme roles, so the radius is the whole Android skin. */
const SHEET_RADIUS = Platform.OS === 'android' ? 28 : 24;
const SLIDE = { duration: 340, easing: Easing.bezier(0.32, 0.72, 0.3, 1) };

/** The prototype's cross-flavour neutrals (overlay-grey at fixed alpha, same literal on all four
 *  flavours — the same family the key bar uses). */
const HAIRLINE = 'rgba(127,132,156,0.3)';
const STEPPER_TINT = 'rgba(127,132,156,0.25)';

/** The swatch strip's six chips, in the prototype's order. Read from each flavour's own palette. */
const SWATCHES = ['red', 'green', 'yellow', 'blue', 'pink', 'teal'] as const;

/** Auto first (PLAN §4.8), then the prototype's flavour order. */
const CHOICES: ThemeChoice[] = ['auto', ...FLAVOURS];
const LABELS: Record<string, string> = {
  auto: 'Auto',
  latte: 'Latte',
  frappe: 'Frappé',
  macchiato: 'Macchiato',
  mocha: 'Mocha',
};

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
  const tmux = useTmux();
  const insets = useSafeAreaInsets();
  const ty = useSharedValue(TRAVEL);
  useEffect(() => {
    ty.value = withTiming(0, SLIDE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    ty.value = withTiming(TRAVEL, SLIDE, (done) => {
      if (done) runOnJS(onClose)();
    });
  };

  // The swipe-dismiss (§4.8): the sheet rides the finger down (never up past rest), and the
  // release decision — distance or flick — is input-model's, tested.
  const pan = Gesture.Pan()
    .runOnJS(true)
    .onUpdate((e) => {
      ty.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      if (sheetShouldDismiss(e.translationY, e.velocityY)) close();
      else ty.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.cubic) });
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - ty.value / TRAVEL }));

  const pickFlavour = (choice: ThemeChoice) => {
    console.log('[settings] theme →', choice);
    updateSettings({ theme: choice }); // §4.8: restyles the live session, no reconnect
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

  const status = deriveConfigStatus(usesTmux(settings), tmux.config);
  const check = (
    <SymbolView
      name="checkmark"
      size={15}
      tintColor={theme.accent}
      fallback={<Text style={{ fontSize: 14, fontWeight: '700', color: theme.accent }}>✓</Text>}
    />
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

            <Text style={[styles.header, { color: theme.muted }]}>APPEARANCE</Text>
            <View style={[styles.card, { backgroundColor: theme.surface }]}>
              {CHOICES.map((choice, i) => (
                <Pressable
                  key={choice}
                  onPress={() => pickFlavour(choice)}
                  style={({ pressed }) => [
                    styles.row,
                    i > 0 && styles.rowLine,
                    pressed && { backgroundColor: STEPPER_TINT },
                  ]}>
                  <Text style={[styles.label, { color: theme.foreground }]}>{LABELS[choice]}</Text>
                  {choice === 'auto' ? (
                    <Text style={[styles.value, { color: theme.muted }]}>follows system</Text>
                  ) : (
                    <View style={[styles.swatch, { backgroundColor: THEMES[choice].palette.base }]}>
                      {SWATCHES.map((slot) => (
                        <View
                          key={slot}
                          style={[styles.chip, { backgroundColor: THEMES[choice].palette[slot] }]}
                        />
                      ))}
                    </View>
                  )}
                  <View style={styles.checkSlot}>{settings.theme === choice && check}</View>
                </Pressable>
              ))}
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

            <Text style={[styles.header, styles.headerGap, { color: theme.muted }]}>TMUX</Text>
            <View style={[styles.card, { backgroundColor: theme.surface }]}>
              <View style={styles.row}>
                <Text style={[styles.label, { color: theme.foreground }]}>Configuration</Text>
                {/* the §4.5 status, folded from the start mode and the last push's read-back */}
                <Text style={[styles.value, { color: theme.muted }]}>
                  {status === 'not-applied' ? 'not applied' : status}
                </Text>
              </View>
              <View style={[styles.row, styles.rowLine]}>
                <Text style={[styles.label, { color: theme.foreground }]}>Comfort settings</Text>
                <Switch
                  value={settings.tmuxExtras}
                  onValueChange={toggleExtras}
                  trackColor={{ true: theme.accent }}
                />
              </View>
            </View>
            <Text style={[styles.note, { color: theme.placeholder }]}>
              {status === 'off'
                ? 'Not a tmux session.'
                : 'Colours, no status bar, deeper scrollback. Applies on the next connect.'}
            </Text>

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
    boxShadow: '0 -12px 40px rgba(0,0,0,0.45)',
  },
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
