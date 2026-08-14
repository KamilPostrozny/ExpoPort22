/**
 * The edge handle (§4.4, redesigned 2026-08: the design's "handle floats over output — two
 * states, closed and open, and zero vertical cost"). Closed, it is a 5pt colour tab hugging the
 * terminal's right edge above the bar — the recipe's identity colour, breathing while the
 * process is live. Tap or swipe it left and the panel opens: the process label, then the
 * recipe's caps as a right-aligned vertical column of glass capsules, then a stub that is the
 * handle again. Tap the terminal, pick a cap, or swipe the panel right to close. Nothing here
 * ever resizes the terminal — which is the whole point of the redesign; the old in-bar pill
 * traded ~3 rows and needed a settle overlay to hide the refit.
 *
 * The screen owns the state (`src/ribbon-model.ts` decides everything) and executes the caps;
 * this file draws, ticks the running timer, pulses the handle, arms the two-tap quit, and reads
 * the open/close gestures. Geometry is the iOS prototype's: 46×64 touch target on a 5×46 tab,
 * 40pt caps at 21pt radius, 14pt mono keys with 12.5pt captions, 7pt gaps.
 */

import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Glass } from '@/keybar';
import { formatElapsed } from '@/ribbon-model';
import { RECIPES, type Cap, type RecipeId } from '@/ribbon-recipes';
import { MONO, withAlpha as rgba, type Theme } from '@/theme';

/** Horizontal travel that counts as the open/close swipe (the prototype's 28). */
const SWIPE_PX = 28;
/** How long the two-tap quit stays armed (the prototype's 2800). */
const ARM_MS = 2800;

/* --- the closed handle --- */

export type RibbonHandleProps = {
  theme: Theme;
  recipe: { id: RecipeId; proc: string };
  /** Distance from the parent layer's bottom to the tab (the screen's `popBase`). */
  bottom: number;
  onOpen: () => void;
};

export function RibbonHandle({ theme, recipe, bottom, onOpen }: RibbonHandleProps) {
  const data = RECIPES[recipe.id];

  // The breath (prototype `p22edge`): opacity and height together, only while the process is
  // live — a stopped job or a TUI sitting there earns a still handle.
  const breath = useSharedValue(1);
  useEffect(() => {
    breath.value = data.pulse
      ? withRepeat(withSequence(withTiming(0, { duration: 950 }), withTiming(1, { duration: 950 })), -1)
      : 1;
  }, [data.pulse, breath]);
  const breathStyle = useAnimatedStyle(() =>
    data.pulse
      ? { opacity: 0.95 - 0.5 * (1 - breath.value), transform: [{ scaleY: 1 - 0.16 * (1 - breath.value) }] }
      : { opacity: 0.9, transform: [{ scaleY: 1 }] },
  );

  // Tap opens; so does a leftward swipe — the tab sits on the edge the panel slides in from.
  const swipeOpen = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX(-12)
    .failOffsetX(12)
    .failOffsetY([-12, 12])
    .onEnd((e) => {
      if (e.translationX < -SWIPE_PX) onOpen();
    });

  return (
    <GestureDetector gesture={swipeOpen}>
      <Pressable onPress={onOpen} style={[styles.handleTouch, { bottom }]}>
        <Animated.View
          style={[styles.handleTab, { backgroundColor: theme.dots[data.dot] }, breathStyle]}
        />
      </Pressable>
    </GestureDetector>
  );
}

/* --- the open panel --- */

export type RibbonPanelProps = {
  theme: Theme;
  recipe: { id: RecipeId; proc: string };
  /** The instance's first-detection clock ms — the running timer's zero. */
  startedAt: number;
  /** §4.6: an upload in flight — the attach cap tints accent and goes inert. */
  busy: boolean;
  /** Distance from the parent layer's bottom to the panel's foot (the screen's `popBase`). */
  bottom: number;
  /** The caps column's ceiling — the panel scrolls past it rather than growing under the
   *  status bar (prototype `rbCapsSty`). */
  maxCapsHeight: number;
  onCap: (cap: Cap) => void;
  onClose: () => void;
};

export function RibbonPanel(props: RibbonPanelProps) {
  const { theme, recipe, busy } = props;
  const data = RECIPES[recipe.id];
  const running = recipe.id === 'running';
  const dotColor = theme.dots[data.dot];

  // The running timer: re-render once a second while the label carries elapsed time.
  const [, setBeat] = useState(0);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // The pulsing dot (prototype `p22pulse`): only the running recipe breathes.
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = running
      ? withRepeat(withSequence(withTiming(0.35, { duration: 800 }), withTiming(1, { duration: 800 })), -1)
      : 1;
  }, [running, pulse]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  const label = running
    ? `${recipe.proc} · ${formatElapsed(Date.now() - props.startedAt)}`
    : recipe.id === 'suspended'
      ? `${recipe.proc} · stopped`
      : recipe.proc;

  // The two-tap quit (prototype `rbQuit`): the first tap fires and re-labels the cap
  // "tap again"; un-tapped it disarms itself, and only the second tap closes the panel.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(armTimer.current ?? undefined), []);

  const tap = (c: Cap) => {
    props.onCap(c);
    if (c.arm && !armed) {
      setArmed(true);
      clearTimeout(armTimer.current ?? undefined);
      armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
      return; // still open — the cap now reads "tap again"
    }
    props.onClose();
  };

  // Swipe the column right → closed, the mirror of the handle's open swipe.
  const swipeClose = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetX(12)
    .failOffsetX(-12)
    .failOffsetY([-12, 12])
    .onEnd((e) => {
      if (e.translationX > SWIPE_PX) props.onClose();
    });

  const cap = (c: Cap, i: number) => {
    if (c.header !== undefined)
      return (
        <Text
          key={i}
          // The prototype's text-shadow (`0 1px 3px crust@0.9`) — a header floats bare over
          // whatever the pane is showing, and the shadow is what keeps it legible there.
          style={[
            styles.header,
            { color: theme.muted, textShadowColor: rgba(theme.scrim, 0.9) },
          ]}>
          {c.header}
        </Text>
      );
    const arm = c.arm === true && armed;
    const danger = c.danger === true || arm;
    const attachBusy = busy && c.action === 'attach';
    const caption = arm ? 'tap again' : c.caption;
    return (
      <Glass
        key={i}
        theme={theme}
        radius={21}
        style={danger ? { borderColor: rgba(theme.danger, arm ? 0.85 : 0.42) } : null}>
        {/* The bar's glass tint is tuned for the card's quiet bottom band; these caps float
            over a wall of text, so they take the prototype's own ground — surface0 at ~0.7
            over the blur (`hexA(f.s0, 0.72)`), which is what keeps a cap readable on top of
            a full CLAUDE.md (user, 2026-08-12, screenshot). */}
        <View style={[StyleSheet.absoluteFill, { backgroundColor: rgba(theme.surface, 0.62) }]} />
        {danger && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: rgba(theme.danger, 0.16) }]} />
        )}
        <Pressable
          disabled={attachBusy}
          onPress={() => tap(c)}
          style={({ pressed }) => [
            styles.cap,
            attachBusy && { backgroundColor: rgba(theme.accent, 0.5) }, // inert tint = the progress UI
            pressed && { opacity: 0.5 },
          ]}>
          <Text style={[styles.capKey, { color: danger ? theme.danger : theme.foreground }]}>
            {c.label}
          </Text>
          {caption !== undefined && (
            <Text style={[styles.capCaption, { color: danger ? theme.danger : theme.muted }]}>
              {caption}
            </Text>
          )}
        </Pressable>
      </Glass>
    );
  };

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* The scrim is invisible and eats exactly one tap — "tap the terminal to close". */}
      <Pressable style={StyleSheet.absoluteFill} onPress={props.onClose} />
      <GestureDetector gesture={swipeClose}>
        <View style={[styles.column, { bottom: props.bottom + 2 }]}>
          {/* The label needs its own ground: bare over a busy pane, an 11pt muted name simply
              vanished (user, 2026-08-12, dark-mode screenshot) — so it rides the same glass
              the caps do, one size down. */}
          <Glass theme={theme} radius={14}>
            <View
              style={[StyleSheet.absoluteFill, { backgroundColor: rgba(theme.surface, 0.62) }]}
            />
            <View style={styles.labelRow}>
              <Animated.View style={[styles.dot, { backgroundColor: dotColor }, dotStyle]} />
              <Text style={[styles.label, { color: theme.foreground }]}>{label}</Text>
            </View>
          </Glass>
          <ScrollView
            style={{ maxHeight: props.maxCapsHeight }}
            contentContainerStyle={styles.caps}
            showsVerticalScrollIndicator={false}>
            {data.caps.map(cap)}
          </ScrollView>
          {/* The handle again, at the column's foot — tap to close, same as it opened. */}
          <Pressable onPress={props.onClose} hitSlop={12}>
            <View style={[styles.stub, { backgroundColor: dotColor }]} />
          </Pressable>
        </View>
      </GestureDetector>
    </View>
  );
}

const styles = StyleSheet.create({
  /** 46×64 of touch target on 5pt of ink — an edge tab any thumb can find blind. */
  handleTouch: {
    position: 'absolute',
    right: 0,
    width: 46,
    height: 64,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
  handleTab: { width: 5, height: 46, borderTopLeftRadius: 4, borderBottomLeftRadius: 4 },

  column: { position: 'absolute', right: 14, alignItems: 'flex-end', gap: 7 },
  // No drop shadow, deliberately: on iOS a shadow on the glass's transparent outer view draws
  // as a RECTANGLE around the capsule (user, 2026-08-12, screenshot) — the bar's glass skips
  // it for the same reason. The surface0 ground carries the separation alone.
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 28,
    paddingHorizontal: 12,
  },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { fontFamily: MONO, fontSize: 11 },
  caps: { alignItems: 'flex-end', gap: 7, paddingRight: 1 },
  header: {
    fontSize: 9.5,
    fontWeight: '600',
    letterSpacing: 0.7,
    paddingTop: 6,
    paddingRight: 10,
    paddingBottom: 1,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  cap: {
    height: 40,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 15,
  },
  capKey: { fontFamily: MONO, fontSize: 14, fontWeight: '500' },
  capCaption: { fontSize: 12.5 },
  stub: {
    width: 5,
    height: 46,
    borderRadius: 4,
    marginTop: 2,
    marginRight: 4,
  },
});
