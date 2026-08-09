/**
 * The tab switcher (§4.5): a full-screen 2-column card grid over crust, one live colour
 * snapshot card per tmux window. Tap selects, ✕ or a leftward fling closes (rightward
 * rubber-bands), a long-press lifts the card into a drag-reorder with a dashed target slot,
 * + births a new terminal, Done ✓ returns. Every threshold and curve is the prototype's,
 * via `src/switcher-model.ts` (tested); this file renders and executes.
 *
 * The zoom transition itself — the terminal scaling into/out of a card slot — is NOT here: it
 * belongs to the screen (`src/app/terminal.tsx`), which owns the live terminal surface this
 * grid sits behind.
 */

import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  runOnJS,
} from 'react-native-reanimated';

import { parseAnsi, spanColor, type SpanLine } from '@/ansi-spans';
import {
  gridHeight,
  gridTop,
  reorder,
  reorderArgs,
  shouldClose,
  slotFrame,
  snapshotFontSize,
  swipeOffset,
  swipeOpacity,
  targetSlot,
  type Frame,
} from '@/switcher-model';
import { capturePane, listWindows } from '@/tmux';
import { POLL_MS, type TmuxWindow } from '@/tmux-model';
import { MONO, MONO_BOLD, type Theme } from '@/theme';

export type Card = { win: TmuxWindow; lines: SpanLine[] | null };

/** More than a card can show at any legal font size — parse output is truncated here so a
 *  50k-line scrollback capture never becomes 50k <Text> nodes. */
const MAX_LINES = 44;

/**
 * The switcher's data: the window list (kept warm while `enabled`, so the first zoom-out knows
 * which slot is active before the grid has ever opened) and the colour snapshots, refreshed on
 * a ~2s beat while `live` — the same cadence as T9's poll, for the same reason: fresh enough to
 * watch a build scroll by, cheap enough to leave running. `setCards` is exported for the
 * screen's optimistic updates (a killed window leaves the grid before tmux confirms).
 */
export function useSwitcherCards(enabled: boolean, live: boolean) {
  const [cards, setCards] = useState<Card[]>([]);

  const refresh = useCallback(async (withSnapshots: boolean) => {
    try {
      const wins = await listWindows();
      if (!withSnapshots) {
        setCards((prev) =>
          wins.map((win) => ({ win, lines: prev.find((c) => c.win.id === win.id)?.lines ?? null })),
        );
        return;
      }
      const caps = await Promise.all(
        wins.map((win) =>
          capturePane(win.index)
            .then((text) => parseAnsi(text).slice(0, MAX_LINES))
            .catch(() => null), // window died between list and capture: blank card, next beat fixes it
        ),
      );
      setCards(wins.map((win, i) => ({ win, lines: caps[i] })));
    } catch (error) {
      console.log('[switcher] refresh failed:', error);
    }
  }, []);

  useEffect(() => {
    if (enabled) void refresh(false);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!live) return;
    void refresh(true);
    const timer = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  return { cards, setCards, refresh };
}

/* --- the grid --- */

export type SwitcherProps = {
  theme: Theme;
  stageW: number;
  cards: Card[];
  /** Gestures live only while the grid is fully open — not during the zoom transitions. */
  interactive: boolean;
  onSelect: (pos: number, win: TmuxWindow) => void;
  onKill: (win: TmuxWindow) => void;
  onNew: () => void;
  onDone: () => void;
  /** A drop that moved something: tmux indices from `reorderArgs`. The screen runs
   *  `moveWindow` and re-lists; the returned promise tells the grid when to trust props again. */
  onMove: (args: { from: number; to: number }) => Promise<void>;
  /** The grid's scroll offset, so the screen can aim the zoom at a card's on-screen slot. */
  onScrollY: (y: number) => void;
};

/** The reorder spring — the prototype's overshooting cubic-bezier(0.3,1.3,0.45,1), near enough. */
const SPRING = { damping: 16, stiffness: 220, mass: 1 };

export default function Switcher(props: SwitcherProps) {
  const { theme, stageW, cards, interactive } = props;

  /** Local order during (and just after) a drag: `null` = props order is the truth. */
  const [dragOrder, setDragOrder] = useState<Card[] | null>(null);
  const orderRef = useRef<Card[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const preDrag = useRef<TmuxWindow[]>([]);
  const startPos = useRef(0);

  const display = dragOrder ?? cards;
  orderRef.current = display;

  const dragStart = (id: string, pos: number) => {
    preDrag.current = display.map((c) => c.win);
    startPos.current = pos;
    setDragOrder(display);
    setDragId(id);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); // the lift; select stays silent (§7)
  };

  const dragMove = (id: string, x: number, y: number) => {
    setDragOrder((prev) => {
      if (prev === null) return prev;
      const from = prev.findIndex((c) => c.win.id === id);
      const to = targetSlot(x, y, stageW, prev.length);
      return to === from || from < 0 ? prev : reorder(prev, from, to);
    });
  };

  const dragEnd = (id: string) => {
    setDragId(null);
    const endPos = orderRef.current.findIndex((c) => c.win.id === id);
    const args = reorderArgs(preDrag.current, startPos.current, endPos);
    if (args === null) {
      setDragOrder(null);
      return;
    }
    console.log('[switcher] reorder', JSON.stringify(args));
    // Optimistic order holds until the screen has moved and re-listed — then props are truth.
    void props.onMove(args).finally(() => setDragOrder(null));
  };

  const dragPos = dragId === null ? -1 : display.findIndex((c) => c.win.id === dragId);
  const top = gridTop(stageW);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}>
      <View style={{ height: top }} />
      <ScrollView
        style={styles.grid}
        scrollEnabled={interactive && dragId === null}
        onScroll={(e) => props.onScrollY(e.nativeEvent.contentOffset.y)}
        scrollEventThrottle={16}
        contentContainerStyle={{ height: gridHeight(display.length, stageW) }}>
        {dragPos >= 0 && (
          <View
            style={[
              styles.placeholder,
              { borderColor: theme.border },
              frameStyle(slotFrame(dragPos, stageW)),
            ]}
          />
        )}
        {display.map((card, pos) => (
          <WindowCard
            key={card.win.id}
            theme={theme}
            card={card}
            slot={slotFrame(pos, stageW)}
            stageW={stageW}
            dragged={dragId === card.win.id}
            interactive={interactive}
            onTap={() => props.onSelect(pos, card.win)}
            onKill={() => props.onKill(card.win)}
            onDragStart={() => dragStart(card.win.id, pos)}
            onDragMove={(x, y) => dragMove(card.win.id, x, y)}
            onDragEnd={() => dragEnd(card.win.id)}
          />
        ))}
      </ScrollView>

      {/* the bottom bar: + | "N Tabs" | Done ✓ */}
      <View style={styles.bar}>
        <Pressable
          onPress={interactive ? props.onNew : undefined}
          style={({ pressed }) => [
            styles.circle,
            { backgroundColor: theme.surface },
            pressed && styles.pressed,
          ]}>
          <SymbolView
            name="plus"
            size={20}
            tintColor={theme.foreground}
            fallback={<Text style={{ color: theme.foreground, fontSize: 22 }}>+</Text>}
          />
        </Pressable>
        <Text style={[styles.count, { color: theme.foreground }]}>
          {display.length} {display.length === 1 ? 'Tab' : 'Tabs'}
        </Text>
        <Pressable
          onPress={interactive ? props.onDone : undefined}
          style={({ pressed }) => [
            styles.circle,
            { backgroundColor: theme.accent },
            pressed && styles.pressed,
          ]}>
          <SymbolView
            name="checkmark"
            size={18}
            tintColor={theme.onAccent}
            fallback={<Text style={{ color: theme.onAccent, fontSize: 18 }}>✓</Text>}
          />
        </Pressable>
      </View>
    </View>
  );
}

function frameStyle(f: Frame) {
  return { left: 0, top: 0, width: f.w, height: f.h, transform: [{ translateX: f.x }, { translateY: f.y }] };
}

/* --- one card --- */

function WindowCard({
  theme,
  card,
  slot,
  stageW,
  dragged,
  interactive,
  onTap,
  onKill,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  theme: Theme;
  card: Card;
  slot: Frame;
  stageW: number;
  dragged: boolean;
  interactive: boolean;
  onTap: () => void;
  onKill: () => void;
  onDragStart: () => void;
  onDragMove: (x: number, y: number) => void;
  onDragEnd: () => void;
}) {
  const u = stageW / 402;
  // The card's position is a transform, always: reorder springs it between slots, a drag rides
  // the finger from wherever the spring last put it, and the drop springs to the final slot.
  const x = useSharedValue(slot.x);
  const y = useSharedValue(slot.y);
  const baseX = useSharedValue(slot.x);
  const baseY = useSharedValue(slot.y);
  const swipeX = useSharedValue(0);
  const swipeT0 = useSharedValue(0);
  const lift = useSharedValue(0);

  useEffect(() => {
    if (dragged) return;
    x.value = withSpring(slot.x, SPRING);
    y.value = withSpring(slot.y, SPRING);
  }, [slot.x, slot.y, dragged, x, y]);

  // Swipe-to-close: horizontal only, left rides the finger, right rubber-bands (§4.5).
  const swipe = Gesture.Pan()
    .enabled(interactive)
    .activeOffsetX([-10, 10])
    .failOffsetY([-10, 10])
    .onStart(() => {
      swipeT0.value = Date.now();
    })
    .onUpdate((e) => {
      swipeX.value = swipeOffset(e.translationX);
    })
    .onEnd(() => {
      if (shouldClose(swipeX.value, Date.now() - swipeT0.value, stageW)) {
        swipeX.value = withTiming(-stageW, { duration: 200 }, () => runOnJS(onKill)());
      } else {
        swipeX.value = withSpring(0, SPRING);
      }
    });

  // Long-press lifts, then the same finger drags to reorder (§4.5). JS drives the reorder
  // decisions — targetSlot runs against React state — so the whole pan runs on JS.
  const drag = Gesture.Pan()
    .enabled(interactive)
    .runOnJS(true)
    .activateAfterLongPress(300)
    .onStart(() => {
      baseX.value = x.value;
      baseY.value = y.value;
      lift.value = withSpring(1, SPRING);
      onDragStart();
    })
    .onUpdate((e) => {
      x.value = baseX.value + e.translationX;
      y.value = baseY.value + e.translationY;
      onDragMove(x.value, y.value);
    })
    .onFinalize(() => {
      lift.value = withSpring(0, SPRING);
      onDragEnd(); // the slot-change effect springs the card home
    });

  // One tap gesture decides select vs ✕ by where it landed: a Pressable under an RNGH Tap can
  // double-fire, and a second kill-window against a renumbered index is not a no-op.
  const tap = Gesture.Tap()
    .enabled(interactive)
    .maxDuration(300)
    .runOnJS(true)
    .onEnd((e, success) => {
      if (!success) return;
      if (e.x > slot.w - 34 && e.y < 34) onKill();
      else onTap(); // §7: no haptic on tab select
    });

  const gesture = Gesture.Race(drag, swipe, tap);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value + swipeX.value },
      { translateY: y.value },
      { scale: 1 + 0.06 * lift.value },
      { rotate: `${2 * lift.value}deg` },
    ],
    opacity: swipeOpacity(swipeX.value, stageW),
    zIndex: lift.value > 0 ? 10 : 1,
    shadowOpacity: 0.55 * lift.value,
  }));

  const ring = dragged
    ? { borderWidth: 2, borderColor: theme.accentAlternate } // mauve in every flavour's role map
    : card.win.active
      ? { borderWidth: 2, borderColor: theme.accent }
      : { borderWidth: 1, borderColor: theme.border };

  const fontSize = snapshotFontSize(slot.w, card.win.width);
  const directory = card.win.path.split('/').filter(Boolean).pop() ?? '/';

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(160)}
        style={[styles.card, { position: 'absolute', left: 0, top: 0, width: slot.w }, style]}>
        <View
          style={[
            styles.shot,
            ring,
            { height: slot.h, borderRadius: 14 * u, backgroundColor: theme.background, padding: 5 * u },
          ]}>
          <Snapshot lines={card.lines} theme={theme} fontSize={fontSize} />
          {/* visual only — the card's tap gesture owns the hit (see `tap` above) */}
          <View style={[styles.close, { backgroundColor: theme.foreground }]}>
            <Text style={[styles.closeGlyph, { color: theme.background }]}>✕</Text>
          </View>
        </View>
        <Text
          numberOfLines={1}
          style={[styles.name, { color: card.win.active ? theme.accent : theme.foreground }]}>
          {card.win.name}
        </Text>
        <Text numberOfLines={1} style={[styles.sub, { color: theme.muted }]}>
          {directory}
        </Text>
      </Animated.View>
    </GestureDetector>
  );
}

/** The mini terminal: ANSI spans as nested <Text> runs in JBMono at whatever size fits the
 *  pane's true column count. `null` lines = no capture yet — the card is just its background.
 *  Exported for T11's neighbour page cards, which are the same rendering at page size. */
export function Snapshot({
  lines,
  theme,
  fontSize,
}: {
  lines: SpanLine[] | null;
  theme: Theme;
  fontSize: number;
}) {
  if (lines === null) return null;
  return (
    <Text
      allowFontScaling={false}
      style={{ fontFamily: MONO, fontSize, lineHeight: fontSize * 1.4, color: theme.foreground }}>
      {lines.map((line, i) => (
        <Text key={i}>
          {line.map((span, j) => (
            <Text
              key={j}
              style={{
                color: spanColor(span.fg, theme.ansi) ?? theme.foreground,
                backgroundColor: spanColor(span.bg, theme.ansi) ?? undefined,
                fontFamily: span.bold ? MONO_BOLD : MONO,
              }}>
              {span.text}
            </Text>
          ))}
          {i < lines.length - 1 ? '\n' : null}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  grid: { flex: 1 },
  placeholder: {
    position: 'absolute',
    borderRadius: 14,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(127,132,156,0.08)',
  },
  card: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 18 },
    shadowRadius: 30,
    shadowOpacity: 0,
  },
  shot: { overflow: 'hidden' },
  close: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: 0.88,
  },
  closeGlyph: { fontSize: 10, fontWeight: '700' },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 34,
    paddingTop: 5,
    paddingBottom: 10,
  },
  circle: { width: 49, height: 49, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6, transform: [{ scale: 0.94 }] },
  count: { fontFamily: MONO, fontSize: 14 },
  name: { textAlign: 'center', fontFamily: MONO, fontSize: 12, marginTop: 7 },
  sub: { textAlign: 'center', fontFamily: MONO, fontSize: 10, marginTop: 2 },
});
