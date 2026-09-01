/**
 * The Settings quick sheet (§4.8), per the prototype: grabber, swipe-dismiss, no Done button —
 * over the live terminal, so a theme tap restyles the session behind it while it is still up.
 * Sections: APPEARANCE (`AppearanceCard`, which Setup shows too), TMUX (the comfort-settings
 * opt-out, on a tmux session only), SESSION (Disconnect in accent, Forget host key in red behind a
 * confirm).
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

import { useEffect, useRef } from 'react';
import {
  Alert,
  Dimensions,
  Modal,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
// The ScrollView is RNGH's, not React Native's, and that is the whole reason the drag works:
// `simultaneousWithExternalGesture` resolves a ref by reading the handler tag RNGH puts on its own
// wrapped components. Handed a plain RN ScrollView it silently relates the pan to nothing, the
// native scroll view swallows every touch inside the list, and only the grabber — which sits
// outside it — can still dismiss (user, 2026-08-14: "only grabbing by handle allow to dismiss").
import {
  Gesture,
  GestureDetector,
  GestureHandlerRootView,
  ScrollView,
} from 'react-native-gesture-handler';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import AppearanceCard, { switchColors } from '@/appearance';
import { sheetShouldDismiss } from '@/input-model';
import { forgetPinnedHostKey } from '@/session';
import { endpoint, updateSettings, useSettings, usesTmux } from '@/settings';
import {
  GRABBER,
  leading,
  RADIUS,
  SECTION_HEADER,
  SHEET_RADIUS,
  SPACE,
  TEXT,
} from '@/style';
import { SANS, type Theme } from '@/theme';

/** How far offscreen the sheet starts and returns to. The window's own height, because that is the
 *  one number guaranteed to clear the sheet: it is capped at 88% of the screen, and the old fixed
 *  620 was shorter than the theme lists made it — so the dismiss animated to 620, stopped with a
 *  strip of sheet still showing, and only vanished when the Modal unmounted underneath it (user,
 *  2026-08-14: "settings briefly stop at the bottom and then hide"). */
const TRAVEL = Dimensions.get('window').height;
const SLIDE = { duration: 340, easing: Easing.bezier(0.32, 0.72, 0.3, 1) };
/** How far down the sheet counts as "the grabber" for a drag: `paddingTop` 8 + the 5pt bar + its
 *  12pt padding is 25, rounded up to a thumb. Generous on purpose — it laps a little over the
 *  APPEARANCE header, where a downward drag has nothing else to mean. */
const GRABBER_ZONE = 40;

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
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);
  /** The theme lists make the sheet taller than the screen, so it scrolls — and a scroll and a
   *  swipe-dismiss are the same finger. Inside the list, the sheet only rides the finger from the
   *  top; below that the list keeps the gesture, or a flick through the themes would throw the
   *  sheet off the screen. */
  const atTop = useSharedValue(true);
  /** Whether this drag began on the grabber, which always dismisses however the list is scrolled.
   *  Gating the grabber on `atTop` too is what made the sheet feel stuck (user, 2026-08-14: "hard
   *  time swiping them down… either the app lagging or it's hard to close them") — with
   *  twenty-six rows the list is almost never at the top, so the one handle whose entire job is
   *  dismissing was the one place dismissing did not work. */
  const fromGrabber = useSharedValue(false);
  useEffect(() => {
    ty.value = withTiming(0, SLIDE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const trackTop = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    atTop.value = e.nativeEvent.contentOffset.y <= 0;
  };

  const close = () => {
    ty.value = withTiming(TRAVEL, SLIDE, (done) => {
      if (done) runOnJS(onClose)();
    });
  };

  // The swipe-dismiss (§4.8): the sheet rides the finger down (never up past rest), and the
  // release decision — distance or flick — is input-model's, tested.
  // Deliberately NOT `.runOnJS(true)`: this sheet sits over a live session that is still pumping
  // bytes, so a callback stream on the RN JS thread would queue behind exactly the work that is
  // busiest while the finger is down. Everything the drag needs is a shared value, so the whole
  // gesture stays on the UI thread and hops to JS once, on the release that actually dismisses.
  const pan = Gesture.Pan()
    // Without this the pan wins the arbitration outright and the list never scrolls. The cast is a
    // typing gap, not a runtime one — RNGH's own ScrollView ref is not assignable to RNGH's own
    // parameter type, and the wrapped component does carry the handler tag this reads.
    .simultaneousWithExternalGesture(scrollRef as unknown as React.RefObject<React.ComponentType>)
    .onBegin((e) => {
      fromGrabber.value = e.y < GRABBER_ZONE;
    })
    .onUpdate((e) => {
      if (fromGrabber.value || atTop.value) ty.value = Math.max(0, e.translationY);
    })
    .onEnd((e) => {
      const rides = fromGrabber.value || atTop.value;
      if (rides && sheetShouldDismiss(e.translationY, e.velocityY)) runOnJS(close)();
      else ty.value = withTiming(0, { duration: 220, easing: Easing.out(Easing.cubic) });
    });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: ty.value }] }));
  const scrimStyle = useAnimatedStyle(() => ({ opacity: 1 - ty.value / TRAVEL }));

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

  return (
    <Modal transparent statusBarTranslucent animationType="none" onRequestClose={close}>
      {/* RNGH needs its own root inside a Modal's native window. */}
      <GestureHandlerRootView style={styles.fill}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }, scrimStyle]}>
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
              <AppearanceCard theme={theme} card={theme.surface} />

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
                      {...switchColors(theme)}
                    />
                  </View>
                  <Text style={[styles.note, { color: theme.placeholder }]}>
                    Colours, no status bar, deeper scrollback. Applies on the next connect.
                  </Text>
                </>
              )}

              <Text style={[styles.header, styles.headerGap, { color: theme.muted }]}>SESSION</Text>
              <View style={[styles.card, styles.cardGap, { backgroundColor: theme.surface }]}>
                <Pressable
                  onPress={onDisconnect}
                  style={({ pressed }) => [
                    styles.actionRow,
                    pressed && { backgroundColor: theme.surface },
                  ]}>
                  <Text style={[styles.label, { color: theme.accent }]}>Disconnect</Text>
                </Pressable>
                <Pressable
                  onPress={forget}
                  style={({ pressed }) => [
                    styles.actionRow,
                    styles.rowLine,
                    { borderTopColor: theme.border },
                    pressed && { backgroundColor: theme.surface },
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
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    // `SHEET_RADIUS` — the same top corner the upload sheet's hand-built Android shell draws, and
    // the same one iOS's pageSheet presents there.
    borderTopLeftRadius: SHEET_RADIUS,
    borderTopRightRadius: SHEET_RADIUS,
    paddingHorizontal: SPACE.wide,
    // The 8 that opens GRABBER_ZONE's 8 + 5 + 12.
    paddingTop: 8,
    // Twenty-six theme rows are taller than any phone, so the sheet stops short of the status bar
    // and the list inside it scrolls.
    maxHeight: '88%',
    boxShadow: '0 -12px 40px rgba(0,0,0,0.45)',
  },
  scroll: { flexShrink: 1 },
  // The 12 that closes GRABBER_ZONE's 8 + 5 + 12.
  grabberZone: { alignItems: 'center', paddingBottom: 12 },
  grabber: GRABBER,
  header: { ...SECTION_HEADER, paddingHorizontal: SPACE.gutter, paddingBottom: 7 },
  headerGap: { paddingTop: 14 },
  card: { borderRadius: RADIUS.card, overflow: 'hidden' },
  /** The gap under the note of the card above it, so two cards in one section do not touch. */
  cardGap: { marginTop: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // The row's own padding computes to about 33; this lifts it to the 44pt tap target.
    minHeight: 44,
    paddingHorizontal: SPACE.gutter,
    paddingVertical: 7,
  },
  /** The rule's colour is `theme.border`, passed at each call site: a fixed overlay grey is the
   *  wrong grey on most of twenty-six schemes, and invisible on some. */
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth },
  label: { flex: 1, fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.label },
  note: {
    fontFamily: SANS,
    includeFontPadding: false,
    fontSize: TEXT.caption,
    lineHeight: leading(TEXT.caption),
    paddingHorizontal: SPACE.gutter,
    paddingTop: 6,
  },
  actionRow: { paddingHorizontal: SPACE.gutter, paddingVertical: SPACE.md },
});
