/**
 * The context band (§4.4), redesigned 2026-08-16 to the "Accessory" approach recommended in
 * docs/ribbon-redesign.md §7 — the ribbon rotated 90°.
 *
 * One 52pt band pinned at the screen's `popBase`, immediately above the key bar. At rest it is a
 * 44pt identity chip flush to the trailing edge — glyph, process name, live clock. Tap it and the
 * band unrolls leftward into a horizontal row of 44pt caps, so the 13-item agent recipe has the
 * same footprint as the 3-cap running one, forever. Nothing is ever reserved: the layer is
 * absolute and never enters `paneInsets`, so the terminal's rows do not rewrap.
 *
 * What the old 5pt breathing tab got wrong, measured (redesign §1): the caption on
 * `surface@0.62` over bright output read 1.76:1 and the red destructive label 1.69:1 (need 4.5);
 * the capsule body sat at 1.17:1 against a dark pane; the tab itself was APCA Lc ~15, which is
 * the threshold for "treat as invisible"; and the discovery cue was an infinite opacity+scaleY
 * pulse — blink plus zoom, the two least detectable motion families (Bartram, Ware & Calvert
 * 2003), on a 5pt COLOUR target, and a WCAG 2.2.2 failure besides. So: no glass, no blur, no
 * alpha ground. The plate is opaque `theme.panel`, which makes every contrast figure a constant
 * (12.13:1 on Mocha) whatever the terminal is printing, and the only edge that meets arbitrary
 * content is a two-colour C40 perimeter — no single role colour can work, because the terminal
 * draws in the same theme and can always land on itself at 1.00:1.
 *
 * The screen owns the state (`src/ribbon-model.ts` decides, `RIBBON_MIN_RUN_MS` gates) and
 * executes the caps; this file draws, ticks the clock, arms the two-tap quit, and reads the
 * open gesture.
 */

import { SymbolView } from 'expo-symbols';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { Key, rgba } from '@/keybar';
import { formatElapsed } from '@/ribbon-model';
import { RECIPES, type Cap, type RecipeId } from '@/ribbon-recipes';
import { MONO, MONO_BOLD, type Theme } from '@/theme';

const ANDROID = Platform.OS === 'android';
/** Horizontal travel that counts as the open swipe (the prototype's 28). */
const SWIPE_PX = 28;
/** How long the two-tap quit stays armed (the prototype's 2800). */
const ARM_MS = 2800;
/** The band, and the row of 44pt controls inside its 1pt perimeter. */
const BAND_H = 52;
const ROW_H = 44;
/** The scroll gutters the ‹ › live in, when there is anything to scroll to. */
const CHEV_W = 14;
/**
 * The C40 perimeter (https://www.w3.org/WAI/WCAG22/Techniques/css/C40): two adjacent strokes of
 * opposite neutrals, so whatever the pane is drawing, one of them clears 3:1 against it — the
 * pair bottoms out at ≈4.2:1 around relative luminance 0.165, where they cross. Deliberately
 * OUTSIDE the theme's gamut: `border`, `scrim` and `foreground` can each land on themselves.
 */
const EDGE_DARK = 'rgba(0,0,0,0.75)';
// ponytail: the light half is a HAIRLINE at 0.45, not 1pt at 0.9. At 3x the specced value drew a
// 3px near-white ring — louder than any text on a dark theme, and it read as a debug border
// (user, 2026-08-16, device screenshot). That trades the C40 floor at the worst-case crossover
// luminance (a mid grey pane) for a surface that does not shout; the dark stroke still carries
// bright content, and the opaque plate carries most of the separation on its own. Put the alpha
// back to 0.9 if a real mid-grey background ever proves unreadable.
const EDGE_LIGHT = 'rgba(255,255,255,0.45)';
/** Android's bar docks 8pt from the edge; iOS lets the trailing edge do the aiming (Parhi). */
const EDGE_INSET = ANDROID ? 8 : 0;
/** The house slide easing (settings sheet, name pills). */
const EASE = Easing.bezier(0.32, 0.72, 0.3, 1);

export type RibbonAccessoryProps = {
  theme: Theme;
  recipe: { id: RecipeId; proc: string };
  /** The instance's first-detection clock ms — the chip clock's zero. */
  startedAt: number;
  /** §4.6: an upload in flight — the attach cap tints accent and goes inert. */
  busy: boolean;
  /** Distance from the parent layer's bottom to the band's foot: the screen's `popBase`, which
   *  already folds in the keyboard and the chord strip. The band owns no second geometry — that
   *  is what keeps it from desyncing off its own keyboard subscription. */
  bottom: number;
  /** `stage.w` and the terminal's own side pad: together, the open band's width. */
  width: number;
  padH: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCap: (cap: Cap) => void;
};

export function RibbonAccessory(props: RibbonAccessoryProps) {
  const { theme, recipe, busy, bottom, open, onOpenChange } = props;
  const data = RECIPES[recipe.id];
  const bandW = Math.max(160, props.width - props.padH);
  const reduceMotion = useReducedMotion();

  // The chip's clock: re-render once a second while a live process is being timed.
  const [, setBeat] = useState(0);
  useEffect(() => {
    if (!data.pulse) return;
    const timer = setInterval(() => setBeat((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [data.pulse]);

  /** The resting silhouette is the chip's own width — measured, because the process name is not
   *  ours to predict. The default is the running recipe's typical width, so the first frame is
   *  the right size rather than a sliver that grows. */
  const [chipW, setChipW] = useState(132);
  const [overflows, setOverflows] = useState(false);
  const contentW = useRef(0);
  const viewW = useRef(0);

  /* --- motion. Everything here is finite: the shipped design's infinite breath is a WCAG 2.2.2
     (Pause, Stop, Hide, Level A) failure for content the user never started. --- */

  const w = useSharedValue(chipW + 8);
  const wasOpen = useRef(open);
  useEffect(() => {
    const target = open ? bandW : chipW + 8;
    // Only the open/close transition animates. A width that merely got measured, or a rotation,
    // jumps — animating those reads as the band twitching on its own.
    const animate = wasOpen.current !== open && !reduceMotion;
    wasOpen.current = open;
    w.value = animate ? withTiming(target, { duration: open ? 260 : 200, easing: EASE }) : target;
  }, [open, chipW, bandW, reduceMotion, w]);

  const caps = useSharedValue(0);
  useEffect(() => {
    caps.value = open
      ? withDelay(reduceMotion ? 0 : 80, withTiming(1, { duration: 140, easing: Easing.out(Easing.quad) }))
      : withTiming(0, { duration: 100 });
  }, [open, reduceMotion, caps]);

  // The make-aware cue, played exactly once per recipe: three cycles of a 2.5pt lateral
  // oscillation, then still forever. Slow linear oscillation is the best detection/irritation
  // compromise in the literature; the axis is horizontal because the pane's own transients
  // (scrolling text) are vertical, so this is orthogonal to the masking signal.
  const nudge = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) {
      nudge.value = 0;
      return;
    }
    nudge.value = withRepeat(
      withSequence(
        withTiming(-2.5, { duration: 525, easing: Easing.inOut(Easing.sin) }),
        withTiming(0, { duration: 525, easing: Easing.inOut(Easing.sin) }),
      ),
      3,
      false,
    );
  }, [recipe.id, reduceMotion, nudge]);

  const clipStyle = useAnimatedStyle(() => ({
    width: w.value,
    transform: [{ translateX: nudge.value }],
  }));
  const capsStyle = useAnimatedStyle(() => ({ opacity: caps.value }));

  // The chevrons say "there is more" without a JS re-render per scroll frame — the JS thread
  // stalls 40-300ms under SSH load, so the scroll offset stays on the UI thread.
  const sx = useSharedValue(0);
  const maxX = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler((e) => {
    sx.value = e.contentOffset.x;
  });
  const leftChevron = useAnimatedStyle(() => ({
    opacity: withTiming(sx.value > 2 ? 1 : 0, { duration: 120 }),
  }));
  const rightChevron = useAnimatedStyle(() => ({
    opacity: withTiming(sx.value < maxX.value - 2 ? 1 : 0, { duration: 120 }),
  }));

  /** Whether the caps overflow is MEASURED, not counted: four of six recipes then install no
   *  scroll recogniser at all, on every device rather than on the ones a cap count guessed. */
  const overflowed = useRef(false);
  const measure = () => {
    maxX.value = Math.max(0, contentW.current - viewW.current);
    const over = contentW.current > viewW.current + 1;
    if (over === overflowed.current) return;
    overflowed.current = over;
    console.log(
      `[ribbon] band ${contentW.current.toFixed(0)}/${viewW.current.toFixed(0)} scroll=${over}`,
    );
    setOverflows(over);
  };

  /* --- the two-tap quit (prototype `rbQuit`) --- */

  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => clearTimeout(armTimer.current ?? undefined), []);

  const tap = (c: Cap) => {
    props.onCap(c);
    if (c.arm === true && !armed) {
      setArmed(true);
      clearTimeout(armTimer.current ?? undefined);
      armTimer.current = setTimeout(() => setArmed(false), ARM_MS);
      return; // still open — the cap now reads "tap again"
    }
    // Any other cap disarms without firing the armed one (HIG Alerts' Cancel-button rule).
    if (armed) setArmed(false);
    // A search cap raises the keyboard and the band rides up with `popBase`: it stays open, so
    // the follow-up cap (`n`, next hit) is one tap away on the keyboard's top edge.
    if (c.focus === true) return;
    onOpenChange(false);
  };

  // Self-appearing chrome is invisible to VoiceOver unless it says so, and must not steal focus
  // from whatever is being read.
  useEffect(() => {
    AccessibilityInfo.announceForAccessibility(`${recipe.proc} actions available`);
  }, [recipe.id, recipe.proc]);

  // The leftward swipe still opens the band on iOS — fluent, already learned, and never the only
  // route. Not on Android: the back gesture owns both edges, exclusion is capped at 200dp and
  // refused at the bottom, and RNGH will not arbitrate against system edge gestures (#833).
  // Closing has no swipe: the caps' own horizontal scroll is the better claimant of that axis.
  const swipeOpen = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!ANDROID && !open)
        .runOnJS(true)
        .activeOffsetX(-12)
        .failOffsetX(12)
        .failOffsetY([-12, 12])
        .onEnd((e) => {
          if (e.translationX < -SWIPE_PX) onOpenChange(true);
        }),
    [open, onOpenChange],
  );

  const meta = data.pulse
    ? ` · ${formatElapsed(Date.now() - props.startedAt)}`
    : recipe.id === 'suspended'
      ? ' · stopped'
      : null;

  const renderCap = (c: Cap, i: number) => {
    const arm = c.arm === true && armed;
    const danger = c.danger === true || arm;
    const attachBusy = busy && c.action === 'attach';
    const caption = arm ? 'tap again' : c.caption;
    // Captions are `foreground` at 0.78 over a known opaque ground, never `theme.muted`: muted is
    // mix(bg, fg, 0.78) on the 22 generated schemes and lands at 2.96:1 on Solarized Dark.
    const ink = attachBusy ? theme.background : danger ? theme.danger : theme.foreground;
    const captionInk = attachBusy
      ? theme.background
      : danger
        ? theme.danger
        : rgba(theme.foreground, 0.78);
    return (
      <Key
        key={i}
        disabled={attachBusy}
        onPress={() => tap(c)}
        accessibilityLabel={`${danger ? 'Destructive: ' : ''}${arm ? 'Confirm quit' : (c.caption ?? c.label ?? '')}`}
        accessibilityHint={arm ? 'Tap again to confirm' : `Sends ${c.label}`}
        style={[
          styles.cap,
          {
            backgroundColor: attachBusy
              ? theme.accent // §4.6: the inert tint IS the upload progress UI
              : danger
                ? rgba(theme.danger, arm ? 0.2 : 0.18)
                : theme.surface,
            borderColor: danger ? rgba(theme.danger, arm ? 0.9 : 0.55) : 'transparent',
          },
        ]}>
        <View style={styles.capKeyRow}>
          {danger && (
            // Colour is never the only signal (WCAG 1.4.1) — and the bold weight below is what
            // rescues Latte's #d20f39, which is 4.46:1 on the plate: it fails the 4.5 floor at a
            // regular weight and passes the 3:1 one at 14pt bold.
            <SymbolView
              name="exclamationmark.triangle.fill"
              size={10}
              tintColor={theme.danger}
              fallback={<Text style={[styles.capWarn, { color: theme.danger }]}>!</Text>}
            />
          )}
          <Text
            numberOfLines={1}
            maxFontSizeMultiplier={1.3}
            style={[styles.capKey, danger && styles.capKeyDanger, { color: ink }]}>
            {c.label}
          </Text>
        </View>
        {caption !== undefined && (
          <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={[styles.capCaption, { color: captionInk }]}>
            {caption}
          </Text>
        )}
      </Key>
    );
  };

  return (
    <>
      {/* The dismiss catcher stops at the band's TOP edge, so unlike the old full-screen scrim
          the key bar stays live while the band is open — combining a cap with Ctrl/Esc/Tab was
          impossible before, and the first tap on any of them only closed the panel. */}
      {open && (
        <Pressable
          accessible={false}
          style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: bottom + BAND_H }}
          onPress={() => onOpenChange(false)}
        />
      )}
      <GestureDetector gesture={swipeOpen}>
        <Animated.View
          entering={(reduceMotion ? FadeIn : FadeInDown).duration(180)}
          // 180 out as well as in: a 140 exit against a 180 entry read as the ribbon blinking
          // out while the arrival glided (aae62fe, 2026-08-11).
          exiting={(reduceMotion ? FadeOut : FadeOutDown).duration(180)}
          style={[
            styles.clip,
            { bottom, borderColor: EDGE_DARK },
            ANDROID && styles.androidShadow,
            clipStyle,
          ]}>
          {/* Fixed width, so the plate's own layout never re-resolves while the clip animates. */}
          <View style={[styles.plate, { width: bandW, backgroundColor: theme.panel }]}>
            <Animated.View
              // The chevrons live in GUTTERS, not on top of the caps. Overlaying them sliced
              // `COMMANDS` and `/clear` mid-word, which reads as a rendering bug rather than as
              // "there is more" (user, 2026-08-16). Inset the scroll viewport instead: content is
              // clipped by its own edge, immediately beside the arrow.
              style={[styles.capsRegion, { paddingHorizontal: overflows ? CHEV_W : 0 }, capsStyle]}
              pointerEvents={open ? 'auto' : 'none'}>
              <Animated.ScrollView
                horizontal
                directionalLockEnabled
                showsHorizontalScrollIndicator={false}
                scrollEnabled={overflows}
                scrollEventThrottle={16}
                onScroll={onScroll}
                onLayout={(e) => {
                  viewW.current = e.nativeEvent.layout.width;
                  measure();
                }}
                onContentSizeChange={(cw) => {
                  contentW.current = cw;
                  measure();
                }}
                // flex-end is load-bearing: when the caps fit they sit hard against the chip,
                // i.e. nearest the thumb. When they overflow, flexGrow is inert and the row
                // starts at x = 0, which is where the scroll rests.
                contentContainerStyle={styles.capsRow}>
                {data.caps.map(renderCap)}
              </Animated.ScrollView>
              {overflows && (
                <>
                  <Animated.View pointerEvents="none" style={[styles.chevron, { left: 0 }, leftChevron]}>
                    <Text style={[styles.chevronText, { color: rgba(theme.foreground, 0.6) }]}>‹</Text>
                  </Animated.View>
                  <Animated.View pointerEvents="none" style={[styles.chevron, { right: 0 }, rightChevron]}>
                    <Text style={[styles.chevronText, { color: rgba(theme.foreground, 0.6) }]}>›</Text>
                  </Animated.View>
                </>
              )}
            </Animated.View>
            <View style={[styles.divider, { backgroundColor: theme.border }]} />
            {/* The one always-present control: the same object at two sizes, Dynamic-Island
                style — tap to unroll, tap to roll back up. */}
            <Pressable
              onLayout={(e) => setChipW(e.nativeEvent.layout.width)}
              onPress={() => onOpenChange(!open)}
              hitSlop={{ top: 10, bottom: 10, left: 6, right: EDGE_INSET + 8 }}
              accessibilityRole="button"
              accessibilityLabel={`${recipe.proc} actions`}
              accessibilityHint={open ? 'Hides the actions' : `Shows the actions for ${recipe.proc}`}
              accessibilityState={{ expanded: open }}
              style={({ pressed }) => [
                styles.chip,
                { backgroundColor: theme.surface },
                pressed && { opacity: 0.5 },
              ]}>
              <SymbolView
                name={data.sf}
                size={15}
                tintColor={theme.dots[data.dot]}
                fallback={
                  <Text style={[styles.mark, { color: theme.dots[data.dot] }]}>{data.mark}</Text>
                }
              />
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={1.3}
                style={[styles.chipName, { color: theme.foreground }]}>
                {recipe.proc}
              </Text>
              {meta !== null && (
                <Text
                  maxFontSizeMultiplier={1.3}
                  style={[styles.chipMeta, { color: rgba(theme.foreground, 0.78) }]}>
                  {meta}
                </Text>
              )}
            </Pressable>
          </View>
          {/* The inner half of the C40 pair, over the plate's outermost point. */}
          <View pointerEvents="none" style={[styles.innerStroke, { borderColor: EDGE_LIGHT }]} />
        </Animated.View>
      </GestureDetector>
    </>
  );
}

const styles = StyleSheet.create({
  /** Square right corners hard against the trailing edge — the edge does the aiming, and the
   *  visible left end is what unrolls. */
  clip: {
    position: 'absolute',
    right: EDGE_INSET,
    height: BAND_H,
    overflow: 'hidden',
    alignItems: 'flex-end',
    borderTopLeftRadius: 26,
    borderBottomLeftRadius: 26,
    borderWidth: 1,
    borderRightWidth: 0,
  },
  // iOS gets no shadow: on a rounded overlay it draws as a RECTANGLE here (user, 2026-08-12) —
  // the C40 perimeter carries the figure/ground separation alone.
  androidShadow: { boxShadow: '0 2px 6px rgba(0,0,0,0.5)' },
  innerStroke: {
    position: 'absolute',
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderRightWidth: 0,
    borderTopLeftRadius: 25,
    borderBottomLeftRadius: 25,
  },
  /** Opaque. No Glass, no BlurView, no rgba(surface, 0.62) — that is the whole redesign in one
   *  line, and it is also why Reduce Transparency is a no-op here and why Android (where
   *  expo-blur cannot cross the WebView's window boundary) gets the same thing iOS does. */
  plate: {
    height: BAND_H - 2,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
  },
  capsRegion: { flex: 1, height: ROW_H, overflow: 'hidden' },
  capsRow: {
    flexGrow: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
    paddingHorizontal: 2,
  },
  chevron: {
    position: 'absolute',
    top: 0,
    width: CHEV_W,
    height: ROW_H,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chevronText: { fontFamily: MONO, fontSize: 13 },
  divider: { width: 1, height: 28, marginHorizontal: 6, opacity: 0.6 },

  cap: {
    height: ROW_H,
    minWidth: 52,
    paddingHorizontal: 10,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  capKeyRow: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  capKey: { fontFamily: MONO, fontSize: 14, fontWeight: '500', lineHeight: 17 },
  capKeyDanger: { fontFamily: MONO_BOLD },
  capCaption: { fontSize: 10, lineHeight: 12 },
  capWarn: { fontFamily: MONO_BOLD, fontSize: 10 },

  chip: {
    height: ROW_H,
    maxWidth: 172,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 10,
    paddingRight: 12,
  },
  mark: { fontFamily: MONO_BOLD, fontSize: 13 },
  chipName: { fontFamily: MONO, fontSize: 12, maxWidth: 96 },
  // Tabular figures, or the clock jitters every second as the digits change width.
  chipMeta: { fontFamily: MONO, fontSize: 12, fontVariant: ['tabular-nums'] },
});
