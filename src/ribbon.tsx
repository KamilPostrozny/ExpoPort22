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
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
  type SharedValue,
} from 'react-native-reanimated';

import { PILL_MIN, pillCont, pillDist, pillOpacity, pillWidthFrac } from '@/barswipe-model';
import { BAR_RADIUS, GLASS_BORDER_W, Glass } from '@/keybar';
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
  /** T11's bar-swipe morph inputs — the same the name pills read. While `live` the glass
   *  squeezes and fades in LOCKSTEP with the outgoing pill (and regrows on a cancel); its
   *  mount/unmount animations use the same curve, so a ribbon appearing at a hop's settle or on
   *  a poll beat moves exactly like everything else on the bar (user, 2026-08-11).
   *
   *  `pos` is the swipe's BASE — the window it started on — and `index` is which window THIS
   *  ribbon belongs to; a ghost's differ. They are two arguments in the pill's morph for a
   *  reason (`pillDist(i, pillCont(pos, …))`), and folding them into one anchored every ghost to
   *  the wrong side of the bar (user, 2026-08-11, held mid-swipe). */
  swipe?: {
    pos: number;
    index: number;
    x: SharedValue<number>;
    pitch: number;
    live: boolean;
    /** The hop's settle, which `live` deliberately does NOT cover: the keys land with the slide
     *  while the overlay waits out the host's redraw. The morph is over by then, but the ribbon
     *  the settle mounts or drops is still the hop's — see the mount/unmount gate below. */
    settling?: boolean;
  } | null;
  onToggle: () => void;
  onDismiss: () => void;
  onCap: (cap: Cap) => void;
};

/** The pill morph's span in time: it plays out over 0.7 of a page pitch (`pillMorph`'s
 *  saturation) at the release slide's ~1.15pt/ms — ≈260ms on a 402pt stage. The ribbon's
 *  mount/unmount play the same curve over the same time. */
const MORPH_MS = 260;

const ribbonIn = (values: EntryAnimationsValues) => {
  'worklet';
  return {
    initialValues: { width: values.targetWidth * PILL_MIN, opacity: 0 },
    animations: {
      width: withTiming(values.targetWidth, { duration: MORPH_MS, easing: Easing.out(Easing.quad) }),
      opacity: withTiming(1, { duration: MORPH_MS }),
    },
  };
};

const ribbonOut = (values: ExitAnimationsValues) => {
  'worklet';
  return {
    initialValues: { width: values.currentWidth, opacity: 1 },
    animations: {
      width: withTiming(values.currentWidth * PILL_MIN, {
        duration: MORPH_MS,
        easing: Easing.out(Easing.quad),
      }),
      opacity: withTiming(0, { duration: MORPH_MS }),
    },
  };
};

export default function Ribbon(props: RibbonProps) {
  const { theme, recipe, busy } = props;
  const data = RECIPES[recipe.id];
  const open = props.expanded || !data.collapsible;
  const running = recipe.id === 'running';

  // The drag morph: the same distance→width/opacity the outgoing name pill runs, so the two
  // move as one — and a cancelled swipe regrows the ribbon for free. The shared value is
  // destructured OUT of the prop before the worklet captures it (like the pills do): captured
  // nested in the object it never registered as a dependency, and the style computed once at
  // full width instead of riding the finger (user, 2026-08-11, screenshots).
  const swipe = props.swipe ?? null;
  const swipeLive = swipe?.live ?? false;
  const swipePos = swipe?.pos ?? 0;
  const swipeIndex = swipe?.index ?? 0;
  const swipeX = swipe?.x ?? null;
  const swipePitch = swipe?.pitch ?? 0;
  const [glassW, setGlassW] = useState(0);
  const dragStyle = useAnimatedStyle(() => {
    if (!swipeLive || swipeX === null)
      // A ghost — one whose window is not the current one — is never visible at rest, and it has
      // to say so HERE and not only in the wrapper that hides it: the wrapper is a React style
      // and this is a UI-thread one, so on the frame the swipe begins the wrapper can uncover a
      // ghost this worklet has not dimmed yet (user, 2026-08-11: a flash on the fish window at
      // the start of the move).
      return {
        width: 'auto' as const,
        opacity: swipeIndex === swipePos ? 1 : 0,
        transform: [{ translateX: 0 }],
      };
    const cont = pillCont(swipePos, swipeX.value, swipePitch);
    const d = pillDist(swipeIndex, cont);
    // Mid-swipe and not measured yet — a ribbon mounts unmeasured on both sides of a hop: the
    // ghost of the window being left (until then it was the real ribbon, and excluded), and the
    // real ribbon of the window being entered. Distance does not need the measurement, only the
    // squeeze does, so the fade still knows what to do: the one a window away stays gone instead
    // of flashing back over the bar it just left, and the one that has ARRIVED (d = 0) shows at
    // its natural width instead of blinking out until its layout lands (user, 2026-08-11, both
    // directions of the hop).
    if (glassW <= 0)
      return { width: 'auto' as const, opacity: pillOpacity(d), transform: [{ translateX: 0 }] };
    // `glassW` is the CONTENT box; the capsule is that plus its hairline either side, which is
    // what `width: 'auto'` renders and therefore what the morph has to start and end on.
    const natural = glassW + GLASS_BORDER_W * 2;
    const w = natural * pillWidthFrac(d);
    // The pill's ANCHOR, which is the half that was missing: the widths matched frame for frame
    // while the ribbon squeezed about its own centre and the pill squeezed toward the edge its
    // page leaves through — same size, wrong place (user, 2026-08-11, held mid-swipe). The pill
    // gets there with `alignItems` inside its slot; the ribbon has no slot, so it shifts by the
    // half-width the squeeze freed instead. A numeric transform also survives the UI thread,
    // which an animated `alignItems` on this view did not — it stuck at the value of the frame
    // the swipe started on, anchoring the ribbon to the wrong side for the whole drag.
    const slack = (natural - w) / 2;
    return {
      width: w,
      opacity: pillOpacity(d),
      transform: [{ translateX: swipeIndex < cont ? -slack : slack }],
    };
  }, [swipeLive, swipePos, swipeIndex, swipeX, swipePitch, glassW]);

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
    <View style={styles.wrap}>
      {/* The animated width lives on the GLASS, exactly like a name pill: the capsule itself
          narrows, corners and all, with the content centred inside and clipped evenly. A clip
          box over a fixed glass read as a left-anchored wipe instead (user, 2026-08-11). */}
      <GestureDetector gesture={dismiss}>
        <Animated.View
          // Neither mount nor unmount animates while a swipe owns the glass: the drag morph has
          // already squeezed the outgoing one invisible (the builder's ghost would flash it back
          // at full opacity), and the incoming one has been growing in as a ghost since the
          // finger moved — replaying `ribbonIn` at the settle would restart it from a capsule.
          //
          // The settle is exactly when the swap happens (`pendingRibbon` is applied under the
          // overlay), and it is the one moment `live` is already false — so gating on `live`
          // alone played both animations on every ribboned↔bare hop: the flash at the settle
          // (user, 2026-08-12). `ribbonOut` is the louder half, because it forces opacity back
          // to 1 on a ribbon the drag had already faded to nothing.
          entering={swipe?.live || swipe?.settling ? undefined : ribbonIn}
          exiting={swipe?.live || swipe?.settling ? undefined : ribbonOut}
          style={dragStyle}>
          {/* The bar's corner, not a ribbon-specific one: the prototype's 19 read as a different
              shape sitting right above the name pill's 24.5 (user, 2026-08-11). */}
          <Glass theme={theme} radius={BAR_RADIUS} style={styles.glassCentre}>
            {/* Natural width, measured for the morph and LOCKED while one is live, so the
                squeeze clips the row instead of re-laying its caps out. */}
            <View
              style={swipe?.live && glassW > 0 ? { width: glassW, alignItems: 'center' } : undefined}
              onLayout={(e) => setGlassW(e.nativeEvent.layout.width)}>
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
            </View>
          </Glass>
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

/** The ribbon's own top padding — the same bargain the key bar's makes with the terminal above
 *  it (see `BAR_PAD_TOP`): when a ribbon is up, it is the ribbon's gap the eye adds to the
 *  terminal's, not the bar's. */
export const RIBBON_PAD_TOP = 2;

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingTop: RIBBON_PAD_TOP, paddingBottom: 8, paddingHorizontal: 20 },
  /** Centres the width-locked content row inside the narrowing glass, so the clip is even. */
  glassCentre: { alignItems: 'center' },
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
