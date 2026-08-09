/**
 * The context ribbon (§4.4): a recipe-driven glass pill above the bar — dot, process label, and
 * the recipe's caps. Rendered into KeyBar's ribbon slot by the screen, which owns the state
 * (`src/ribbon-model.ts` decides everything) and executes the caps; this file draws, ticks the
 * running timer, pulses the dot, and reads the two gestures the pill itself owns: tap to
 * expand/collapse a TUI recipe, swipe down to dismiss the instance. Geometry is the prototype's:
 * 19pt pill corners, 7pt dot, 36pt caps at 14pt radius, ~52pt cap width with 8.5pt captions (§3).
 */

import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown,
  FadeOutDown,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Glass } from '@/keybar';
import { formatElapsed } from '@/ribbon-model';
import { RECIPES, type Cap, type RecipeId } from '@/ribbon-recipes';
import { MONO, type Theme } from '@/theme';

/** Downward travel on the pill that dismisses the ribbon (the prototype's 34). */
const DISMISS_PX = 34;

const CAP_TINT = 'rgba(127,132,156,0.18)';

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

export type RibbonProps = {
  theme: Theme;
  recipe: { id: RecipeId; proc: string };
  /** The instance's first-detection clock ms — the running timer's zero. */
  startedAt: number;
  /** TUI recipes only; running/suspended/agent ignore it and always show their caps. */
  expanded: boolean;
  /** §4.6: an upload in flight — the attach cap tints accent and goes inert. */
  busy: boolean;
  onToggle: () => void;
  onDismiss: () => void;
  onCap: (cap: Cap) => void;
};

export default function Ribbon(props: RibbonProps) {
  const { theme, recipe, busy } = props;
  const data = RECIPES[recipe.id];
  const open = props.expanded || !data.collapsible;
  const running = recipe.id === 'running';

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

  // Swipe the ribbon down → dismissed for this process instance (§4.4). Downward-only
  // activation, so cap taps and the expand tap never lose to the pan.
  const dismiss = Gesture.Pan()
    .runOnJS(true)
    .activeOffsetY(12)
    .failOffsetY(-12)
    .failOffsetX([-12, 12])
    .onEnd((e) => {
      if (e.translationY > DISMISS_PX) props.onDismiss();
    });

  const cap = (c: Cap, i: number) => {
    const attachBusy = busy && c.action === 'attach';
    return (
      <Pressable
        key={i}
        disabled={attachBusy}
        onPress={() => props.onCap(c)}
        style={({ pressed }) => [
          styles.cap,
          c.wide ? styles.capWide : styles.capColumn,
          {
            backgroundColor: c.danger ? rgba(theme.danger, 0.14) : CAP_TINT,
            borderWidth: c.danger ? 0.5 : 0,
            borderColor: rgba(theme.danger, 0.4),
          },
          attachBusy && { backgroundColor: rgba(theme.accent, 0.5) }, // inert tint = the progress UI
          pressed && { opacity: 0.5, transform: [{ scale: 0.95 }] },
        ]}>
        <Text style={[c.wide ? styles.capWideLabel : styles.capLabel, { color: c.danger ? theme.danger : theme.foreground }]}>
          {c.label}
        </Text>
        <Text
          style={[
            c.wide ? styles.capWideCaption : styles.capCaption,
            { color: c.wide ? theme.foreground : c.danger ? theme.danger : theme.muted },
          ]}>
          {c.caption}
        </Text>
      </Pressable>
    );
  };

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      style={styles.wrap}>
      <GestureDetector gesture={dismiss}>
        <Glass theme={theme} radius={19}>
          <Pressable
            disabled={!data.collapsible}
            onPress={props.onToggle}
            style={[styles.pill, open ? styles.pillOpen : styles.pillClosed]}>
            <Animated.View
              style={[styles.dot, { backgroundColor: theme.palette[data.dot] }, dotStyle]}
            />
            <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
            {open ? (
              data.caps.map(cap)
            ) : (
              <Text style={[styles.chevron, { color: theme.placeholder }]}>⌃</Text>
            )}
          </Pressable>
        </Glass>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingTop: 2, paddingBottom: 8, paddingHorizontal: 20 },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  pillClosed: { paddingVertical: 8, paddingHorizontal: 13 },
  pillOpen: { paddingVertical: 5, paddingLeft: 13, paddingRight: 7 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  label: { fontFamily: MONO, fontSize: 11, paddingRight: 5 },
  chevron: { fontSize: 11, fontWeight: '600', marginTop: -3 },

  cap: { height: 36, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  capColumn: { flexDirection: 'column', gap: 1, minWidth: 52, paddingHorizontal: 6 },
  capWide: { flexDirection: 'row', gap: 5, paddingHorizontal: 11 },
  capLabel: { fontFamily: MONO, fontSize: 13, fontWeight: '500' },
  capCaption: { fontSize: 8.5 },
  capWideLabel: { fontFamily: MONO, fontSize: 14, fontWeight: '500' },
  capWideCaption: { fontSize: 12.5, fontWeight: '500' },
});
