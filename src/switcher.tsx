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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextStyle,
} from 'react-native';
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

import { highlightLine, parseAnsi, spanColor, type SpanLine } from '@/ansi-spans';
import { SEARCH_DEBOUNCE_MS, normalizeQuery, type SearchHit } from '@/search-model';
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
import { capturePane, listWindows, searchPane } from '@/tmux';
import { POLL_MS, type TmuxWindow } from '@/tmux-model';
import { MONO, MONO_BOLD, type Theme } from '@/theme';

/** One captured pane, with the column count it was captured at — the two travel together because
 *  the type size is derived from the columns, and pairing a fresh capture with a stale width (or
 *  the other way round) is a reflow the user sees as the card rewriting itself. */
export type Snap = { lines: SpanLine[]; cols: number };

export type Card = { win: TmuxWindow; snap: Snap | null };

/** More than a card can show at any legal font size — parse output is truncated here so a
 *  50k-line scrollback capture never becomes 50k <Text> nodes. */
const MAX_LINES = 44;

/** The inset between the card's border and its snapshot, at design width. It is part of the type
 *  size, not just the padding: fitting `cols` columns to the card's OUTER width overflows the box
 *  they are actually drawn in by both insets, and RN wraps the overflow — so every line long
 *  enough to matter came back folded in the grid and straight in the terminal (device). */
const SHOT_PAD = 5;

/**
 * The switcher's data: the window list (kept warm while `enabled`, so the first zoom-out knows
 * which slot is active before the grid has ever opened) and the colour snapshots, refreshed on
 * a ~2s beat while `live` — the same cadence as T9's poll, for the same reason: fresh enough to
 * watch a build scroll by, cheap enough to leave running. `setCards` is exported for the
 * screen's optimistic updates (a killed window leaves the grid before tmux confirms).
 *
 * A snapshot is a snapshot: once a window has one it keeps it until a newer one replaces it, and
 * a replacement never lands while `frozen` — during the zoom or a page slide, that is. Both rules
 * exist for the same reason (user, 2026-08-10): a card whose content appears, then reflows a beat
 * later, then reflows again when dismissing the keyboard resizes the panes underneath, reads as
 * the grid tripping over itself on the way in. Frozen updates are held and applied whole the
 * moment nothing is moving.
 */
export function useSwitcherCards(enabled: boolean, live: boolean, frozen: boolean) {
  const [cards, setCards] = useState<Card[]>([]);
  const seq = useRef(0);
  /** What the cards show, and what landed while frozen and is waiting its turn — both keyed by
   *  window id, so a list-only refresh, a reorder, or a window that died mid-capture all keep
   *  whatever that window last showed. */
  const shown = useRef(new Map<string, Snap>());
  const pending = useRef(new Map<string, Snap>());
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  /** Read at the moment a freeze lifts: `live` still true there means the grid is what the
   *  transition landed in. */
  const liveRef = useRef(live);
  liveRef.current = live;

  const refresh = useCallback(async (withSnapshots: boolean) => {
    // Newest-started refresh wins: a poll's listWindows can start before a move-window lands on
    // the host and resolve after the post-move re-list, snapping the grid back to the stale
    // order for a beat (T10.9). Anything superseded mid-flight drops its result.
    const mine = ++seq.current;
    try {
      const wins = await listWindows();
      if (seq.current !== mine) return;
      if (withSnapshots) {
        const caps = await Promise.all(
          wins.map((win) =>
            capturePane(win.index)
              .then((text) => ({ lines: parseAnsi(text).slice(0, MAX_LINES), cols: win.width }))
              .catch(() => null), // window died between list and capture: it keeps its last snapshot
          ),
        );
        if (seq.current !== mine) return;
        const into = frozenRef.current ? pending.current : shown.current;
        caps.forEach((snap, i) => {
          if (snap === null) return;
          // The active window's card is the one the zoom flies into, and the terminal surface
          // covers exactly that slot for the whole flight — so its content can be replaced now,
          // unseen, and the crossfade at the end lands on the pane the terminal was showing
          // rather than on whatever the card held before. Every other card is in plain sight.
          (wins[i].active ? shown.current : into).set(wins[i].id, snap);
        });
      }
      // A window that is gone takes its snapshot with it — tmux ids never come back, so anything
      // still keyed by one is memory a long session would only accumulate.
      const alive = new Set(wins.map((win) => win.id));
      for (const id of shown.current.keys()) if (!alive.has(id)) shown.current.delete(id);
      setCards(wins.map((win) => ({ win, snap: shown.current.get(win.id) ?? null })));
    } catch (error) {
      console.log('[switcher] refresh failed:', error);
    }
  }, []);

  // Nothing is moving any more: whatever landed mid-transition becomes what the cards show —
  // unless what it stopped moving into is the open grid. That instant IS the landing, and a
  // content swap on that frame is the same jolt as one during the flight. The cards keep what
  // they have and the live beat updates them a moment later, clear of any motion. Unfreezing
  // the other way (back to the terminal, or out of a page slide) has no grid on screen to
  // disturb, so the queue is spent there.
  useEffect(() => {
    if (frozen || pending.current.size === 0) return;
    if (liveRef.current) {
      pending.current.clear();
      return;
    }
    for (const [id, snap] of pending.current) shown.current.set(id, snap);
    pending.current.clear();
    setCards((prev) => prev.map((c) => ({ ...c, snap: shown.current.get(c.win.id) ?? c.snap })));
  }, [frozen]);

  // Snapshots from the moment tabs become reachable, not from the moment the grid opens: the
  // first swipe-up and the first bar swipe both want content that is already there (T14A).
  useEffect(() => {
    if (enabled) void refresh(true);
  }, [enabled, refresh]);

  useEffect(() => {
    if (!live) return;
    void refresh(true);
    const timer = setInterval(() => void refresh(true), POLL_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  return { cards, setCards, refresh };
}

/* --- T14: the scrollback half of the search --- */

/**
 * One host-side grep per window per settled keystroke (§T14: the scrollback cannot come to the
 * phone). Answers land as `win.id → SearchHit | null`; a window not in the map hasn't answered
 * yet. Stale answers are kept until the next settle replaces them — dropping them on every
 * keystroke would blink the whole grid empty for a debounce beat.
 */
export function useScrollbackSearch(query: string, cards: Card[], active: boolean) {
  const [byId, setById] = useState<Record<string, SearchHit | null>>({});
  const seq = useRef(0);
  const latest = useRef(cards);
  latest.current = cards;
  // Re-fire when the window set changes (a new window while armed gets its grep too).
  const ids = cards.map((c) => c.win.id).join(',');

  useEffect(() => {
    const q = normalizeQuery(query);
    if (!active || q === '') {
      seq.current++;
      setById({});
      return;
    }
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      const wins = latest.current.map((c) => c.win);
      void Promise.all(wins.map((w) => searchPane(w.index, q).catch(() => null))).then((hits) => {
        if (seq.current !== mine) return;
        console.log('[search] grep settled:', q, hits.filter(Boolean).length, 'of', wins.length);
        setById(Object.fromEntries(wins.map((w, i) => [w.id, hits[i]])));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, active, ids]);

  return byId;
}

/* --- the grid --- */

export type SwitcherProps = {
  theme: Theme;
  stageW: number;
  /** Already narrowed by the screen while the search is armed. */
  cards: Card[];
  /** The unfiltered count — the "N of M Tabs" label's M. */
  total: number;
  /** T14's shared search state: the raw string as typed, and the scrollback answers per window.
   *  Empty query = disarmed; this grid and the terminal's search bar edit the same string. */
  query: string;
  hits: Record<string, SearchHit | null>;
  onQuery: (q: string) => void;
  onClearSearch: () => void;
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
  /** A filtered grid isn't the real order — reorder is off while a query is armed (§T14). */
  const filtered = normalizeQuery(props.query) !== '';
  const nq = normalizeQuery(props.query);

  /** Local order during (and just after) a drag: `null` = props order is the truth. */
  const [dragOrder, setDragOrder] = useState<Card[] | null>(null);
  const orderRef = useRef<Card[]>([]);
  const [dragId, setDragId] = useState<string | null>(null);
  const dragIdRef = useRef<string | null>(null);
  const preDrag = useRef<TmuxWindow[]>([]);
  const startPos = useRef(0);

  const display = dragOrder ?? cards;
  orderRef.current = display;

  const dragStart = (id: string, pos: number) => {
    preDrag.current = display.map((c) => c.win);
    startPos.current = pos;
    setDragOrder(display);
    dragIdRef.current = id;
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
    dragIdRef.current = null;
    setDragId(null);
    const endPos = orderRef.current.findIndex((c) => c.win.id === id);
    const args = reorderArgs(preDrag.current, startPos.current, endPos);
    if (args === null) {
      setDragOrder(null);
      return;
    }
    console.log('[switcher] reorder', JSON.stringify(args));
    // Optimistic order holds until the screen has moved and re-listed — then props are truth.
    // If the NEXT drag already lifted by then, leave its dragOrder alone: clearing it mid-drag
    // kills that drag's reorders (dragMove bails on null) — its own drop will clear.
    void props.onMove(args).finally(() => {
      if (dragIdRef.current === null) setDragOrder(null);
    });
  };

  const dragPos = dragId === null ? -1 : display.findIndex((c) => c.win.id === dragId);
  const top = gridTop(stageW);

  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.scrim }]}>
      {/* T14: the search field. Same string as the terminal view's bar; the ✕ disarms both. */}
      <View style={styles.searchWrap}>
        <View style={[styles.searchField, { backgroundColor: theme.surface }]}>
          <SymbolView
            name="magnifyingglass"
            size={14}
            tintColor={theme.muted}
            //  is the Nerd Font magnifier, already bundled — the Android face of the icon.
            fallback={
              <Text style={{ color: theme.muted, fontSize: 13, fontFamily: MONO }}>{''}</Text>
            }
          />
          <TextInput
            value={props.query}
            onChangeText={props.onQuery}
            placeholder="Search windows and output"
            placeholderTextColor={theme.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            style={[styles.searchInput, { color: theme.foreground }]}
          />
          {props.query !== '' && (
            <Pressable
              onPress={props.onClearSearch}
              hitSlop={10}
              style={[styles.searchClear, { backgroundColor: theme.muted }]}>
              <Text style={[styles.searchClearGlyph, { color: theme.scrim }]}>✕</Text>
            </Pressable>
          )}
        </View>
      </View>
      <View style={{ height: top }} />
      {filtered && display.length === 0 && (
        <View style={styles.noHits} pointerEvents="none">
          <Text style={[styles.noHitsLead, { color: theme.muted }]}>No window contains</Text>
          <Text style={[styles.noHitsQuery, { color: theme.foreground }]}>“{props.query.trim()}”</Text>
        </View>
      )}
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
        {/* Children in a FIXED order (by window id), position purely via `slot`: if the child
            list re-sorted with the grid order, a reorder would make React reinsert the native
            views, and iOS cancels the touches of a reinserted subtree — which strands an active
            drag mid-gesture with no finalize (T10.9's stuck lift). */}
        {display
          .map((card, pos) => ({ card, pos }))
          .sort((a, b) => (a.card.win.id < b.card.win.id ? -1 : 1))
          .map(({ card, pos }) => (
            <WindowCard
              key={card.win.id}
              theme={theme}
              card={card}
              hit={props.hits[card.win.id]}
              query={nq}
              slot={slotFrame(pos, stageW)}
              stageW={stageW}
              dragged={dragId === card.win.id}
              // The unkillable-last-window rule counts every window, not the narrowed grid: a
              // search filtered to one card must still let that window close (§T14).
              closable={props.total > 1}
              reorderable={!filtered}
              interactive={interactive}
              onTap={() => props.onSelect(pos, card.win)}
              onKill={() => props.onKill(card.win)}
              onDragStart={() => dragStart(card.win.id, pos)}
              onDragMove={(x, y) => dragMove(card.win.id, x, y)}
              onDragEnd={() => dragEnd(card.win.id)}
            />
          ))}
      </ScrollView>

      {/* The bottom bar. iOS (§4.5): + circle | "N Tabs" | Done ✓. Android (§4.10, design §5c):
          Done as a text button | Roboto count | the 56dp FAB the container transform births
          from — same handlers, Material chrome. */}
      <View style={styles.bar}>
        {Platform.OS === 'android' ? (
          <>
            <Pressable
              onPress={interactive ? props.onDone : undefined}
              style={({ pressed }) => [
                styles.doneText,
                pressed && { backgroundColor: `${theme.accent}24` }, // the prototype's 14% accent wash
              ]}>
              <Text style={[styles.doneLabel, { color: theme.accent }]}>Done</Text>
            </Pressable>
            <Text style={[styles.countAndroid, { color: theme.muted }]}>
              {filtered
                ? `${display.length} of ${props.total} tabs`
                : `${display.length} ${display.length === 1 ? 'tab' : 'tabs'}`}
            </Text>
            <Pressable
              onPress={interactive ? props.onNew : undefined}
              style={({ pressed }) => [
                styles.fab,
                { backgroundColor: theme.accent },
                pressed && styles.pressed,
              ]}>
              <Text style={[styles.fabGlyph, { color: theme.background }]}>+</Text>
            </Pressable>
          </>
        ) : (
          <>
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
          {filtered
            ? `${display.length} of ${props.total} Tabs`
            : `${display.length} ${display.length === 1 ? 'Tab' : 'Tabs'}`}
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
          </>
        )}
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
  hit,
  query,
  slot,
  stageW,
  dragged,
  closable,
  reorderable,
  interactive,
  onTap,
  onKill,
  onDragStart,
  onDragMove,
  onDragEnd,
}: {
  theme: Theme;
  card: Card;
  /** T14: the scrollback answer for this window — its context replaces the live snapshot while
   *  armed, so the card shows the first occurrence instead of the pane's bottom. */
  hit: SearchHit | null | undefined;
  /** Normalized query; '' = search disarmed. */
  query: string;
  slot: Frame;
  stageW: number;
  dragged: boolean;
  /** False for the last remaining window — it is unkillable (no ✕, swipe rubber-bands). */
  closable: boolean;
  /** False while the grid is filtered — a narrowed grid isn't the real order (§T14). */
  reorderable: boolean;
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
  // Plain ref, not a shared value: every gesture callback runs on JS (`runOnJS(true)`), and a
  // JS write to a shared value flushes to the UI thread asynchronously — the first onUpdate of
  // a new drag could read the PREVIOUS drag's base and teleport the card to its old slot
  // (T10.9). JS-only memory cannot lose that race.
  const base = useRef({ x: slot.x, y: slot.y });
  const swipeX = useSharedValue(0);
  const swipeT0 = useSharedValue(0);
  const lift = useSharedValue(0);

  useEffect(() => {
    if (dragged) return;
    x.value = withSpring(slot.x, SPRING);
    y.value = withSpring(slot.y, SPRING);
  }, [slot.x, slot.y, dragged, x, y]);

  // The gesture is built ONCE (useMemo): the ~2s snapshot poll re-renders every card, and a
  // gesture object recreated mid-drag makes RNGH swap the native handler under the active
  // gesture — its update stream dies with no finalize, stranding a lifted card (T10.9's stuck
  // lift). Everything that changes across renders reaches the callbacks through `live`.
  const live = useRef({ slot, closable, onTap, onKill, onDragStart, onDragMove, onDragEnd });
  live.current = { slot, closable, onTap, onKill, onDragStart, onDragMove, onDragEnd };
  // Stable trampoline for the swipe worklet: worklets can't read a JS ref, runOnJS can hop to it.
  const killNow = useCallback(() => live.current.onKill(), []);
  // The swipe worklet needs `closable` on the UI thread — mirror it into a shared value.
  const closableSV = useSharedValue(closable ? 1 : 0);
  useEffect(() => {
    closableSV.value = closable ? 1 : 0;
  }, [closable, closableSV]);
  const touchDown = useRef(false);
  const started = useRef(false);

  const gesture = useMemo(() => {
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
        if (closableSV.value && shouldClose(swipeX.value, Date.now() - swipeT0.value, stageW)) {
          swipeX.value = withTiming(-stageW, { duration: 200 }, () => runOnJS(killNow)());
        } else {
          swipeX.value = withSpring(0, SPRING);
        }
      });

    // Long-press lifts, then the same finger drags to reorder (§4.5). JS drives the reorder
    // decisions — targetSlot runs against React state — so the whole pan runs on JS.
    //
    // The native activateAfterLongPress timer keeps the hold snappy (a JS-timer manual
    // activation only applies on the NEXT touch event, so a still hold never lifts). Its
    // failure mode — the timer maturing a touch iOS already cancelled into a drag with no
    // finger, stranding the card mid-lift (T10.9) — is closed by `touchDown`: touch state
    // tracked on the JS queue, and a ghost activation skips every side effect. The handler
    // recovers by itself on the next touch.
    const drag = Gesture.Pan()
      .enabled(interactive && reorderable)
      .runOnJS(true)
      .activateAfterLongPress(300)
      .onTouchesDown(() => {
        touchDown.current = true;
      })
      .onStart((e) => {
        if (!touchDown.current) return; // ghost activation: the touch was already cancelled
        started.current = true;
        // Whatever translation RNGH accumulated before activation must not land on the card as
        // a first-update jump.
        base.current = { x: x.value - e.translationX, y: y.value - e.translationY };
        lift.value = withSpring(1, SPRING);
        live.current.onDragStart();
      })
      .onUpdate((e) => {
        if (!started.current) return;
        x.value = base.current.x + e.translationX;
        y.value = base.current.y + e.translationY;
        live.current.onDragMove(x.value, y.value);
      })
      .onTouchesUp(() => {
        touchDown.current = false;
      })
      .onTouchesCancelled((_e, mgr) => {
        touchDown.current = false;
        mgr.fail();
      })
      .onFinalize(() => {
        // A pan that lost the race (swipe/tap won) or failed pre-hold finalizes too — running
        // the drop for a drag that never lifted issues a phantom reorder from stale drag state.
        if (!started.current) return;
        started.current = false;
        lift.value = withSpring(0, SPRING);
        live.current.onDragEnd(); // the slot-change effect springs the card home
      });

    // One tap gesture decides select vs ✕ by where it landed: a Pressable under an RNGH Tap can
    // double-fire, and a second kill-window against a renumbered index is not a no-op.
    const tap = Gesture.Tap()
      .enabled(interactive)
      .maxDuration(300)
      .runOnJS(true)
      .onEnd((e, success) => {
        if (!success) return;
        if (live.current.closable && e.x > live.current.slot.w - 34 && e.y < 34)
          live.current.onKill();
        else live.current.onTap(); // §7: no haptic on tab select
      });

    return Gesture.Race(drag, swipe, tap);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shared values and refs are stable;
    // interactive/stageW/reorderable only change while no gesture can be active (zoom
    // transitions, rotation, typing in the search field).
  }, [interactive, stageW, reorderable]);

  // zIndex is deliberately NOT animated: a UI-thread zIndex flip (the lift spring settling
  // ~400ms after a drop) can re-sort the native siblings, and iOS cancels the in-flight touches
  // of re-sorted views — which is exactly when an eager re-grab is mid-hold (T10.9). React
  // drives it from `dragged` instead, so it changes only at commit time.
  // ponytail: the dropping card cedes the top layer at release rather than at spring-settle; if
  // the brief crossing of springing cards ever reads wrong, give the drop its own settle state.
  const style = useAnimatedStyle(() => ({
    transform: [
      { translateX: x.value + swipeX.value },
      { translateY: y.value },
      { scale: 1 + 0.06 * lift.value },
      { rotate: `${2 * lift.value}deg` },
    ],
    opacity: swipeOpacity(swipeX.value, stageW),
    shadowOpacity: 0.55 * lift.value,
  }));

  const ring = dragged
    ? { borderWidth: 2, borderColor: theme.accentAlternate } // mauve in every flavour's role map
    : card.win.active
      ? { borderWidth: 2, borderColor: theme.accent }
      : { borderWidth: 1, borderColor: theme.border };

  // Fitted to the box the text is drawn in — the card less both insets — and to the columns the
  // snapshot was captured at rather than the window's current width: the two agree except across
  // a resize, and there the live width would re-size type that is still the old capture's.
  const fontSize = snapshotFontSize(slot.w - 2 * SHOT_PAD * u, card.snap?.cols ?? card.win.width);
  const directory = card.win.path.split('/').filter(Boolean).pop() ?? '/';

  // T14: with a scrollback hit, the card shows the grep's context block instead of the live
  // snapshot — the hit sits ~40% down the block (search-model's -B/-A split), which is the
  // prototype's scroll-to-first-occurrence without scroll machinery. Either content gets the
  // highlight surgery; `highlightLine` returns miss lines untouched, so unmatched cards (a
  // name-only match) re-use every node.
  const shownLines = useMemo(() => {
    const lines = hit ? parseAnsi(hit.lines.join('\n')) : (card.snap?.lines ?? null);
    if (lines === null || query === '') return lines;
    return lines.map((line) => highlightLine(line, query));
  }, [hit, card.snap, query]);

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View
        entering={FadeIn.duration(200)}
        exiting={FadeOut.duration(160)}
        style={[
          styles.card,
          { position: 'absolute', left: 0, top: 0, width: slot.w, zIndex: dragged ? 10 : 1 },
          style,
        ]}>
        <View
          style={[
            styles.shot,
            ring,
            {
              height: slot.h,
              borderRadius: 14 * u,
              backgroundColor: theme.background,
              padding: SHOT_PAD * u,
            },
          ]}>
          <Snapshot lines={shownLines} theme={theme} fontSize={fontSize} />
          {/* visual only — the card's tap gesture owns the hit (see `tap` above) */}
          {closable && (
            <View style={[styles.close, { backgroundColor: theme.foreground }]}>
              <Text style={[styles.closeGlyph, { color: theme.background }]}>✕</Text>
            </View>
          )}
        </View>
        <HlText
          text={card.win.name}
          query={query}
          theme={theme}
          style={[styles.name, { color: card.win.active ? theme.accent : theme.foreground }]}
        />
        <HlText
          text={directory}
          query={query}
          theme={theme}
          style={[styles.sub, { color: theme.muted }]}
        />
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
    <View>
      {lines.map((line, i) => (
        // One <Text> per captured line, clipped, never wrapped. A pane line is already as wide as
        // the pane — the emulator wrapped anything longer before it was ever captured — so a line
        // that does not fit here is this renderer disagreeing with the emulator about how wide a
        // character is, and it does: a Nerd Font icon the terminal clamps into one cell draws at
        // its own advance in RN, and half a cell of overflow on a full-width line came back as
        // `pr` and `t` alone on a line of their own (device). A terminal viewport clips; it does
        // not reflow. `clip`, not the default `tail`, so nothing spends a cell on an ellipsis.
        <Text
          key={i}
          numberOfLines={1}
          ellipsizeMode="clip"
          allowFontScaling={false}
          style={{
            fontFamily: MONO,
            fontSize,
            lineHeight: fontSize * 1.4,
            color: theme.foreground,
          }}>
          {/* A blank line is an empty span list (ansi-spans), and an empty <Text> is a zero-high
              one — which would pull every line after it up and slide the snapshot out of step
              with the pane it copies. A space holds the row open. */}
          {line.length === 0 && ' '}
          {line.map((span, j) => (
            <Text
              key={j}
              style={{
                // A search hit paints over the span's own colours (T14) — dark ink on the
                // warning yellow, whichever way round the flavour runs.
                color: span.hl
                  ? theme.isDark
                    ? theme.scrim
                    : theme.foreground
                  : (spanColor(span.fg, theme.ansi) ?? theme.foreground),
                backgroundColor: span.hl
                  ? theme.warning
                  : (spanColor(span.bg, theme.ansi) ?? undefined),
                fontFamily: span.bold ? MONO_BOLD : MONO,
              }}>
              {span.text}
            </Text>
          ))}
        </Text>
      ))}
    </View>
  );
}

/** A one-line label with T14's highlight on every occurrence — the card's name and directory,
 *  so a metadata-only match still shows where it matched. */
function HlText({
  text,
  query,
  theme,
  style,
}: {
  text: string;
  query: string;
  theme: Theme;
  style: StyleProp<TextStyle>;
}) {
  const lo = text.toLowerCase();
  if (query === '' || !lo.includes(query)) {
    return (
      <Text numberOfLines={1} style={style}>
        {text}
      </Text>
    );
  }
  const parts: { t: string; hl: boolean }[] = [];
  let i = 0;
  for (let j = lo.indexOf(query); j >= 0; j = lo.indexOf(query, i)) {
    if (j > i) parts.push({ t: text.slice(i, j), hl: false });
    parts.push({ t: text.slice(j, j + query.length), hl: true });
    i = j + query.length;
  }
  if (i < text.length) parts.push({ t: text.slice(i), hl: false });
  return (
    <Text numberOfLines={1} style={style}>
      {parts.map((p, k) => (
        <Text
          key={k}
          style={
            p.hl && {
              backgroundColor: theme.warning,
              color: theme.isDark ? theme.scrim : theme.foreground,
            }
          }>
          {p.t}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  grid: { flex: 1 },
  // T14's search field: 40pt + 12pt gap = switcher-model's SEARCH_BAR_H, which the zoom aim
  // adds. iOS is the prototype's 13pt radius; Android takes Material's 16dp (§5d: buttons 16).
  searchWrap: { paddingHorizontal: 20, paddingBottom: 12 },
  searchField: {
    height: 40,
    borderRadius: Platform.OS === 'android' ? 16 : 13,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
  },
  // Android chrome text is Roboto by setting no fontFamily (T7A's finding, zero code).
  searchInput: { flex: 1, fontSize: 14, paddingVertical: 0 },
  searchClear: {
    width: 19,
    height: 19,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearGlyph: { fontSize: 9, fontWeight: '700' },
  noHits: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  noHitsLead: { fontSize: 15 },
  noHitsQuery: { fontFamily: MONO, fontSize: 14 },
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
    ...Platform.select({
      android: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 14 },
      default: { paddingHorizontal: 34, paddingTop: 5, paddingBottom: 10 },
    }),
  },
  circle: { width: 49, height: 49, borderRadius: 25, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6, transform: [{ scale: 0.94 }] },
  count: { fontFamily: MONO, fontSize: 14 },
  // Android chrome text is Roboto by setting no fontFamily (T7A's finding, zero code).
  countAndroid: { fontSize: 14, fontWeight: '500' },
  doneText: { height: 40, paddingHorizontal: 16, borderRadius: 20, justifyContent: 'center' },
  doneLabel: { fontSize: 14, fontWeight: '500' },
  // 12dp corner per the working prototype (the §5c still shows 18 — the prototype wins, same
  // tie-break T7A used). Elevation is the Material shadow; iOS never renders this branch.
  fab: { width: 56, height: 56, borderRadius: 12, alignItems: 'center', justifyContent: 'center', elevation: 6 },
  fabGlyph: { fontSize: 30, lineHeight: 34 },
  name: { textAlign: 'center', fontFamily: MONO, fontSize: 12, marginTop: 7 },
  sub: { textAlign: 'center', fontFamily: MONO, fontSize: 10, marginTop: 2 },
});
