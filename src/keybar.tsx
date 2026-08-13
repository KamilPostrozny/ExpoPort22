/**
 * The key bar (§4.4): ⋯ circle | glass pill Ctrl · Esc · Tab · Paste ‖ arrows | tabs circle,
 * with the chord strip and the popovers stacking above it. Geometry and glass follow
 * `docs/design/Port22-Prototype.dc.html` (the spec wherever PLAN prose disagrees): 49pt circles
 * and pill, 35pt keys at 18pt radius, 24pt side margins, 48pt chord caps with 8.5pt captions,
 * arrows popover at 22pt corners, menu at 26pt.
 *
 * The native `TextInput` here owns the keyboard (T4's device-proven decision): the webview never
 * takes focus, typing reaches the PTY through `sendBytes`, and touching the terminal blurs the
 * input natively — which is what lets a long-press selection proceed with the keyboard up. A plain
 * tap on the terminal asks for it back through `focusSignal`; the bar itself never raises it.
 *
 * Every decision (Ctrl machine, control bytes, nav sequences, input diff, swipe classification)
 * lives in `src/keybar-model.ts`, tested; this file renders and executes.
 *
 * Android (§4.10, design §5a + `Port22-Android-Prototype.dc.html`) keeps this exact geometry and
 * hands only the system layer to Material: no blur — an elevated `surface0` container — 16pt bar
 * corners, 12pt keys, 20pt popovers, 8pt side margins. (PLAN §3's "40pt buttons, 8–12pt radii,
 * mantle" line predates the Android design frames, which kept the 49pt bar; the design wins.)
 */

import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextInputSelectionChangeEventData,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown,
  FadeOutDown,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';

import {
  pillCont,
  pillDist,
  pillOpacity,
  pillWidthFrac,
} from '@/barswipe-model';
import {
  pinPasteboard,
  refreshPasteboard,
  togglePin,
  topSlotText,
  useClipboard,
  type Slot,
} from '@/clipboard';
import { provenance } from '@/clipboard-model';
import { filterDictation, trackLine } from '@/input-model';
import {
  CHORD_STRIP,
  afterChord,
  applyCtrl,
  barDismisses,
  barGrabbed,
  barLifts,
  controlByte,
  CARET_SETTLE_MS,
  CARET_STEP_MAX,
  caretKeys,
  ctrlTap,
  diffInput,
  navKey,
  pasteBytes,
  type CtrlMode,
  type NavKey,
} from '@/keybar-model';
import { MONO, type Theme } from '@/theme';

export type BarPopover = 'none' | 'menu' | 'arrows' | 'clipboard' | 'tabsHint';

export type KeyBarProps = {
  theme: Theme;
  /** Application cursor keys as last reported over the bridge (T6's `onModes`) — decides whether
   *  the arrows cluster sends CSI or SS3. */
  decckm: boolean;
  /** Bracketed paste as last reported over the same bridge — decides whether pasted text is
   *  wrapped in `ESC[200~ … ESC[201~` (see `pasteBytes`). */
  bracketedPaste: boolean;
  /** Everything a key emits, on its way to the PTY. */
  sendBytes: (bytes: string) => void;
  /** Which popover is up. Lifted to the screen, which renders the popovers and the outside-tap
   *  scrim in a layer over the terminal: RN cannot hit-test children drawn outside their
   *  parent's bounds, so a popover cannot float above the bar *from inside* the bar. */
  open: BarPopover;
  onOpenChange: (open: BarPopover) => void;
  /** The bar stack's height (chord strip included), remeasured on every change — the `popBase`
   *  the screen anchors popovers (and the edge handle) on. One number, one place. */
  onHeight: (height: number) => void;
  /** Bump to raise the keyboard — a tap on the terminal (§4.4's door to it), or the switcher
   *  closing back onto a terminal whose keys were up when it left (T10), the
   *  prototype's `kbShown: true` on return. A counter, not a boolean: every close counts. */
  focusSignal?: number;
  /** T9's derived "tabs available": tmux present AND conf applied (§4.5). False renders no tabs
   *  circle at all — no tmux (or a toggled-off config) is silence, not a message (§7). */
  showTabs: boolean;
  /** §4.6: an upload in flight. The ⋯ circle tints accent and goes inert — the whole progress
   *  UI. Both flows flip it (quick-attach included, via `useUploadBusy`). */
  sending?: boolean;
  /** T10: tabs circle tap opens the switcher. */
  onTabsTap?: () => void;
  /** T10: bar swipe ↑ is the drag into the switcher — the prototype's `zoomFollow` — whatever the
   *  keyboard is doing (user, 2026-08-11: the gesture is one thing, always). Fired per move with
   *  the pan's translation from the moment the held card lifts (`barLifts`), then once with 'end'
   *  on release; the screen turns dy into zoom progress and decides commit-or-spring-back. Only
   *  wired while `showTabs`. */
  onSwitcherDrag?: (phase: 'move' | 'end', dx: number, dy: number) => void;
  /** T11: bar swipe ↔ is the page-slide window hop. Raw gesture only — 'start' once when the pan
   *  leaves the slop, 'move' per frame with the pan's translation, 'end' on release. Fires whether
   *  or not the card has been lifted into the switcher: the two axes run together. The screen owns
   *  the model: rubber band, thresholds, commit, and the shared `x` the pages and the pills both
   *  ride (`src/barswipe-model.ts`). Unset = the axis is silence (no tmux). */
  onBarSwipe?: (phase: 'start' | 'move' | 'end', dx: number) => void;
  /** The tab-name pills that replace the bar keys during a page swipe (§4.4). `x` is the
   *  screen's page offset, `pitch` its page step — the pills derive the continuous position.
   *  Passed whenever tabs are reachable, NOT just mid-swipe: each pill is a BlurView, and
   *  mounting the set on the swipe's first frame was the hitch at the start of every swipe
   *  (user, 2026-08-11) — pre-mounted and hidden, `live` merely flips opacities. */
  pills?: {
    names: string[];
    pos: number;
    x: SharedValue<number>;
    pitch: number;
    live: boolean;
  } | null;
};

/* --- §3's glass recipe --- */

const GLASS_BORDER = 'rgba(255,255,255,0.12)';
/** The glass's hairline. */
const GLASS_BORDER_W = Platform.OS === 'android' ? 0 : 0.5;
/** The prototype's neutral key tint (overlay-grey at low alpha, same literal on all flavours). */
const KEY_TINT = 'rgba(127,132,156,0.16)';
const HAIRLINE = 'rgba(127,132,156,0.25)';

/* --- the Android skin's metrics (see the header): same sizes, Material corners --- */
const ANDROID = Platform.OS === 'android';
/** The 49pt circles and pill: iOS capsules, Android's 16pt Material corners. */
const BAR_RADIUS = ANDROID ? 16 : 24.5;
/** The 35pt keys inside the pill (and the arrows button). */
const KEY_RADIUS = ANDROID ? 12 : 18;
/** The bar row's side margins — Android's bar docks 8pt from the edges (design §5a). */
const SIDE_MARGIN = ANDROID ? 8 : 24;

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** One glass surface: blur, tint, border — §3's recipe. `blur(14px) saturate(160%)` maps onto
 *  BlurView's 0–100 intensity scale (≈40); the inset specular highlight has no RN equivalent, so
 *  the border carries the edge alone. Exported for the edge handle's caps — the same glass. */
export function Glass({
  theme,
  radius,
  style,
  children,
}: {
  theme: Theme;
  radius: number;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}) {
  // §4.10: no blur on Android — the design's "elevated tonal surface container" (`surface0` plus
  // a small shadow) takes the recipe's place, popover corners capped at the prototype's 20.
  if (ANDROID)
    return (
      <View
        style={[
          {
            borderRadius: Math.min(radius, 20),
            overflow: 'hidden',
            backgroundColor: theme.surface,
            boxShadow: '0 1px 3px rgba(0,0,0,0.45)',
          },
          style,
        ]}>
        {children}
      </View>
    );
  return (
    <View
      style={[
        {
          borderRadius: radius,
          overflow: 'hidden',
          borderWidth: GLASS_BORDER_W,
          borderColor: GLASS_BORDER,
        },
        style,
      ]}>
      <BlurView
        intensity={40}
        tint={theme.isDark ? 'dark' : 'light'}
        style={StyleSheet.absoluteFill}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.isDark ? 'rgba(205,214,244,0.08)' : 'rgba(255,255,255,0.55)' },
        ]}
      />
      {children}
    </View>
  );
}

/** The bar's own top padding (§3). Exported because the terminal above it subtracts this from its
 *  bottom inset: what the eye reads as the gap under the last line is the two of them added up,
 *  and it has to come to the same number as the gap at the sides (user, 2026-08-10). */
export const BAR_PAD_TOP = 5;

/** Every pressable on the bar: dim + shrink while touched, light haptic on the completed tap —
 *  NOT on touch-down, where a bar swipe starting over a key buzzed on every hop and broke the
 *  slide's fluidity; Safari's has none (user, 2026-08-11). A pan that wins the race never
 *  completes the press, so swipes are silent. */
function Key({
  onPress,
  onLongPress,
  delayLongPress,
  style,
  children,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      onPress={
        onPress &&
        (() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          onPress();
        })
      }
      onLongPress={onLongPress}
      delayLongPress={delayLongPress}
      style={({ pressed }) => [
        style,
        pressed && { opacity: 0.5, transform: [{ scale: 0.93 }] },
      ]}>
      {children}
    </Pressable>
  );
}

/**
 * §4.2 held-delete: iOS gates the delete key's auto-repeat on the first responder's `hasText`, and
 * the field empties as soon as the diff has eaten what was typed — long before the *line* is empty —
 * so the repeat died after a character or two. The reference app answers that question with an
 * always-true `hasText` (Port22's TerminalHostView.swift:226); RN's `RCTUITextField` is not ours to
 * subclass, so the field is kept permanently non-empty instead: it holds a pad nobody ever sees
 * (1×1, `opacity: 0`), each pad character a repeat eats diffs into one more DEL, and the pad is
 * topped back up before it runs out. Spaces, because iOS's delete accelerates to whole words once
 * it has been held a while, and a pad of spaces is one word per character — a pad of letters would
 * come off in one 500-DEL bite.
 */
const PAD = ' '.repeat(512);

export default function KeyBar(props: KeyBarProps) {
  const { theme, open, onOpenChange } = props;
  const input = useRef<TextInput>(null);
  /** What the (uncontrolled) TextInput last held — the other half of `diffInput`. */
  const typed = useRef(PAD);
  /** The field's text, set *only* to top the pad back up (see `PAD`); `undefined` the rest of the
   *  time, which leaves the field uncontrolled so ordinary typing never round-trips through
   *  React — the flip back is the effect below. */
  const [padWrite, setPadWrite] = useState<string | undefined>(undefined);
  /** Where the PTY's cursor stands, in field coordinates — everything up to here has been sent. */
  const caret = useRef(PAD.length);
  /** Where the field's caret stands right now, which during a drag runs ahead of `caret`. */
  const wanted = useRef(PAD.length);
  /** The pending settle (see `CARET_SETTLE_MS`), if the caret is mid-bounce. */
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    // The one render this cascades is the point: RN writes a `value` from its own layout effect
    // (TextInput.js:223, the only text write Fabric honours — `text` is not in the component's
    // `updateProps`), and letting go on the very next render is what keeps the field uncontrolled
    // for every keystroke that is not a top-up.
    if (padWrite !== undefined) {
      // The write puts the caret back at the end of the pad, and RN suppresses the selection event
      // for its own writes (`_comingFromJS`), so the anchor is re-set here rather than learnt —
      // and here rather than in `repad`, which runs a render too early to be true yet.
      caret.current = wanted.current = PAD.length;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
      setPadWrite(undefined);
    }
  }, [padWrite]);
  const repad = () => {
    typed.current = PAD; // ref first: a change event fired by the write diffs against it to nothing
    setPadWrite(PAD);
  };
  const [ctrl, setCtrl] = useState<CtrlMode>('off');
  const lastCtrlTap = useRef(0);
  /** The pill's measured width — the name-pill pitch (prototype: item + gap exactly fill it). */
  const [pillW, setPillW] = useState(0);

  // Something asked for the keyboard — a tap on the terminal, the switcher closing back onto keys
  // that were up (0 = never signalled, skip mount). Connecting is NOT one of them: the session
  // arrives with the terminal in full view, and the keys come up when they are asked for
  // (user, 2026-08-11).
  useEffect(() => {
    if (props.focusSignal) input.current?.focus();
  }, [props.focusSignal]);

  /** T12's dictation filter needs to know whether the line is empty, so everything the bar itself
   *  sends passes through this tracked seam. (The arrows popover bypasses it — escape sequences
   *  carry no line-length information anyway; see input-model's ceiling note.) */
  const lineLen = useRef(0);
  const track = (bytes: string) => {
    lineLen.current = trackLine(lineLen.current, bytes);
    props.sendBytes(bytes);
  };

  /**
   * The per-key seam: every typed key passes through here one at a time — chords apply, then the
   * bytes go out. T12's dictation filter sits one level up in `onChangeText`, where the whole
   * insert chunk is still visible — spacebar vs dictation is a chunk-size question, invisible per
   * key. Held-delete comes through the same diff, off the pad the field carries (see `PAD`).
   */
  const emitKey = (key: string) => {
    const applied = applyCtrl(ctrl, key);
    if (applied.mode !== ctrl) setCtrl(applied.mode);
    track(applied.out);
  };

  const onChangeText = (next: string) => {
    // §4.2: drop iOS dictation's prepended space at an empty line; a real spacebar (a single-char
    // insert) always passes. Decided on the whole diff, before it is split into keys.
    const bytes = filterDictation(lineLen.current, diffInput(typed.current, next));
    // The edit happened at the caret, so it moved by what the edit added or took away. iOS fires
    // `onChange` before `onSelectionChange` on a single-line field (RN leans on that ordering too:
    // RCTTextInputComponentView.mm:54), so keeping the anchor level here is what leaves that
    // handler seeing a zero delta for ordinary typing and a real one only for a hold-space drag.
    caret.current += next.length - typed.current.length;
    wanted.current = caret.current;
    typed.current = next;
    for (const key of bytes) emitKey(key); // string iteration = one code point per key
    // Top the pad up before a held delete runs it dry, and trim the typed tail before iOS starts
    // caring about the length — nothing reads the field back, so both are the same write.
    if (next.length < PAD.length / 2 || next.length > PAD.length + 500) repad();
  };

  /**
   * §4.2 hold-space: the held spacebar is iOS's trackpad, and it walks the caret without changing
   * a character of text — so this is the only event that reports it. The delta against the anchor
   * becomes arrows (`caretKeys`); an edit's own caret move was already levelled out in
   * `onChangeText`, so it reads as zero here. Sent past `track`, like the arrows popover: an
   * escape sequence carries no line-length information, and counting its bytes as typed would
   * poison the dictation heuristic.
   *
   * Rightward travel stops at the end of the field, which is the end of the line — the shell will
   * not go further either. Leftward it runs to the pad, far past any line; drag past column 0 and
   * the PTY's cursor simply stops while the field's keeps going, so the two are out of step until
   * the drag comes back. The eye closes that loop — the terminal's cursor is what the person is
   * watching — and a hidden field can offer no better anchor.
   */
  const onSelectionChange = (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) => {
    const { start, end } = e.nativeEvent.selection;
    // A range is a selection, not a caret: the system's, and nothing for the PTY to follow.
    if (start !== end) {
      caret.current = wanted.current = start;
      return;
    }
    const step = start - wanted.current;
    wanted.current = start;
    if (Math.abs(step) > CARET_STEP_MAX) {
      // A park, not travel — iOS pinning the caret to a document edge as the drag begins and ends.
      // Re-anchor on it and send nothing. Answering it by writing the caret back to the middle of
      // the pad was tried and is worse than useless: `setSelection` does not stick while the
      // floating cursor is live, iOS restored its own position at once, and every real
      // one-character step then arrived as a fresh 200-character jump against an anchor that no
      // longer matched the field (device log, T12).
      caret.current = start;
      if (settle.current) clearTimeout(settle.current);
      settle.current = undefined;
      return;
    }
    if (step === 0 || settle.current) return;
    settle.current = setTimeout(() => {
      settle.current = undefined;
      const delta = wanted.current - caret.current;
      caret.current = wanted.current;
      const keys = caretKeys(delta, props.decckm);
      if (!keys) return; // the bounce cancelled itself, which is the point
      // §7: the drag is invisible in every other log — no text changes, and the PTY's answer is
      // a cursor move buried in a screen repaint. This line is the only place it can be seen.
      console.log('[caret]', delta > 0 ? 'right' : 'left', Math.abs(delta), '→', wanted.current);
      props.sendBytes(keys);
    }, CARET_SETTLE_MS);
  };

  const sendChord = (letter: string) => {
    track(controlByte(letter)!);
    setCtrl(afterChord(ctrl));
  };

  const onCtrlTap = () => {
    const now = Date.now();
    setCtrl(ctrlTap(ctrl, now - (lastCtrlTap.current || -Infinity)));
    lastCtrlTap.current = now;
  };

  const onPaste = async () => {
    // The top clipboard slot (§4.4) — OSC 52 yanks and pins first, phone pasteboard as fallback.
    const text = await topSlotText();
    // Typed, never executed: no trailing newline of ours, and the bracketed-paste markers so the
    // newlines *inside* a multi-line yank are content rather than Return presses.
    if (text) track(pasteBytes(text, props.bracketedPaste));
  };

  const toggle = (which: Exclude<BarPopover, 'none'>) => {
    // §4.4: opening a popover closes the others — single-valued state does that by itself.
    // The ⋯ menu used to drop the keyboard on the way in, which the reference app never does:
    // its bar lives in the keyboard's own accessory window and its plus is a UIKit `Menu`, so
    // the keys stay up under it. Here it was covering for the popovers' anchor, which measured
    // from the screen's bottom edge rather than the keyboard's — with that fixed the menu fits
    // above the keys and the dismiss is just a keyboard that goes away for no reason the person
    // asked for (user, 2026-08-10). Every door the menu opens still puts the keyboard away for
    // itself: Settings in `openSettings`, the pickers by being system modals.
    onOpenChange(open === which ? 'none' : which);
  };

  // §4.4: long-press (~420ms) opens the clipboard popover; the popover reads the phone
  // pasteboard as it opens (the accepted moment for the iOS paste banner).
  const onPasteLongPress = () => onOpenChange('clipboard');

  // The bar swipe (§4.4) — one gesture holding the card, with both of Safari's axes live at the
  // same time rather than an axis chosen at 10pt and held to for the rest of the pan. Sideways is
  // T11's window hop, up is T10's switcher drag, down puts the keyboard away, and the first two
  // run TOGETHER: a card already pulled a little off the bar can still be swiped between windows,
  // and a swipe already running sideways can still be flicked up (user, 2026-08-12). Only the
  // release picks a winner, and the screen does that — it is the side that knows how far up the
  // card got. Keys never fire during a swipe: the pan activating cancels the childrens' touches.
  /** Past the slop: the page is under the finger and every frame is forwarded. */
  const held = useRef(false);
  /** The swipe became T10's switcher drag: every further move is forwarded as zoom progress. */
  const zooming = useRef(false);
  /** The keyboard has already been sent away by this pan — the test stays true as the finger
   *  travels further down, and dismissing every frame is a call per frame. */
  const dismissed = useRef(false);
  /** The pan's translation at the instant the card was grabbed. The grab costs `BAR_AXIS_SLOP` of
   *  travel, and the pan reports it from TOUCH-DOWN — so handing the page `e.translationX` made
   *  it open 10pt along instead of at zero: the card detached from the edge with a jump in the
   *  direction of the finger rather than growing out of it (user, 2026-08-11). The hop measures
   *  from here on, which also makes the commit and flick distances in `barswipe-model` mean the
   *  travel they say they do, the way the vertical gesture's already budget for this. The vertical
   *  tests keep the raw translation: the lift is measured from touch-down (its 24pt is the budget),
   *  and the zoom re-origins for itself at the frame it arms (the screen's `zoomFrom`). */
  const originX = useRef(0);
  const pan = Gesture.Pan()
    .runOnJS(true)
    .maxPointers(1)
    .onBegin(() => {
      held.current = false;
      zooming.current = false;
      dismissed.current = false;
    })
    .onUpdate((e) => {
      // The lift, asked every frame until it happens — from a standing start OR out of a swipe
      // already sideways. Where there is no switcher to lift into (no tmux) the gesture stays on
      // the ground, like the button.
      if (
        !zooming.current &&
        props.showTabs &&
        props.onSwitcherDrag &&
        barLifts(e.translationX, e.translationY, e.velocityX, e.velocityY)
      ) {
        zooming.current = true;
        // §7: the lift is a judgement call made from four numbers on a moving finger, and no other
        // log can show which of them decided it — a false lift and a real one look identical from
        // the switcher's side (device, 2026-08-12: every sideways hop was arming the zoom).
        console.log(
          `[barswipe] lift dx ${e.translationX.toFixed(0)} dy ${e.translationY.toFixed(0)} ` +
            `vx ${e.velocityX.toFixed(0)} vy ${e.velocityY.toFixed(0)}`,
        );
        Keyboard.dismiss(); // the prototype drops the keyboard the moment the grab lifts
      }
      if (zooming.current) {
        // The lift takes the vertical and nothing else. Its own horizontal drift is frozen at the
        // grab (`originX`) once the pages are carrying x, because two things moving the card at
        // once is a card travelling twice as far as the finger — but it stays live before the
        // grab, which is the ±10pt of tilt a straight pull up has always had.
        props.onSwitcherDrag?.('move', held.current ? originX.current : e.translationX, e.translationY);
      } else if (!dismissed.current && barDismisses(e.translationX, e.translationY)) {
        // Down puts the keys away and the swipe carries on: the page stays in hand, and a hop the
        // same finger decides a moment later is still one gesture.
        dismissed.current = true;
        Keyboard.dismiss();
      }
      // The horizontal, alive the WHOLE gesture — lifted or not. Safari's card can be swiped
      // between tabs while it is already off the bottom of the screen, and the swipe can start
      // at any point in the pull up (user, 2026-08-12); an axis that goes quiet the moment the
      // card leaves the bar is the deliberateness that was missing.
      if (!held.current) {
        if (!barGrabbed(e.translationX)) return;
        held.current = true;
        originX.current = e.translationX;
        props.onBarSwipe?.('start', 0);
        return;
      }
      props.onBarSwipe?.('move', e.translationX - originX.current);
    })
    // `onFinalize`, not `onEnd`: a pan can leave by being CANCELLED — another handler wins the
    // race, the view it is on unmounts — and that path never calls `onEnd`. The screen's zoom
    // phase is only ever left by this callback, so a miss leaves it stuck mid-drag: the terminal
    // behind a stage that takes no touches, which reads as the whole app freezing (user,
    // 2026-08-11). Finalize fires for every exit, successful or not.
    .onFinalize((e) => {
      // Both axes report, in this order, and the screen arbitrates: a release that commits to the
      // grid ends the page swipe itself (no hop), so the call below finds nothing live to decide.
      // The bar cannot make that call — the commit is a question about zoom progress, which lives
      // over there.
      if (zooming.current) {
        zooming.current = false;
        props.onSwitcherDrag?.('end', held.current ? originX.current : e.translationX, e.translationY);
      }
      if (held.current) {
        held.current = false;
        props.onBarSwipe?.('end', e.translationX - originX.current);
      }
    });

  const keyLabel = { color: theme.foreground, fontFamily: MONO, fontSize: 14 };

  const ctrlStyle: StyleProp<ViewStyle> =
    ctrl === 'armed'
      ? {
          backgroundColor: rgba(theme.accent, 0.5),
          borderWidth: 1,
          borderColor: rgba(theme.accent, 0.9),
        }
      : ctrl === 'locked'
        ? {
            backgroundColor: rgba(theme.accentAlternate, 0.5),
            borderWidth: 1,
            borderColor: rgba(theme.accentAlternate, 0.9),
            boxShadow: `0 0 0 2px ${theme.foreground}`, // the lock's halo
          }
        : null;

  return (
    <View onLayout={(e) => props.onHeight(e.nativeEvent.layout.height)}>
      {ctrl !== 'off' && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOutDown.duration(140)}
          style={styles.chordWrap}>
          <Glass theme={theme} radius={22} style={styles.chordPill}>
            {CHORD_STRIP.map(({ letter, caption }) => (
              <Key
                key={letter}
                onPress={() => sendChord(letter)}
                style={styles.cap}>
                <Text style={[styles.capLetter, { color: theme.foreground }]}>{letter}</Text>
                <Text style={[styles.capCaption, { color: theme.muted }]}>{caption}</Text>
              </Key>
            ))}
          </Glass>
        </Animated.View>
      )}

      <GestureDetector gesture={pan}>
        <View style={styles.row}>
          {/* §4.6: during an upload the circle tints accent and goes inert — the whole progress
              UI. The Pressable disables, so a tap during a send does nothing at all. */}
          <Key onPress={props.sending ? undefined : () => toggle('menu')} style={styles.circleSlot}>
            <Glass
              theme={theme}
              radius={BAR_RADIUS}
              style={styles.circle}>
              {/* §4.6's busy tint, drawn *over* the glass rather than under it. As the container's
                  backgroundColor it sat beneath Glass's blur and its light-mode white overlay,
                  which washed the accent out to a pale wash and left the glyph — painted in
                  `theme.background` for contrast against a saturated accent — nearly invisible in
                  Latte (seen on device, T13/T8.14). */}
              {props.sending && (
                <View
                  pointerEvents="none"
                  // Its own radius, not the parent's clip: an absolutely-filled child squares off
                  // the circle's edge on device even inside `overflow: 'hidden'` (T13/T8.14).
                  style={[
                    StyleSheet.absoluteFill,
                    { backgroundColor: theme.accent, borderRadius: BAR_RADIUS },
                  ]}
                />
              )}
              <SymbolView
                name="ellipsis"
                size={20}
                tintColor={props.sending ? theme.background : theme.foreground}
                fallback={
                  <Text
                    style={[
                      keyLabel,
                      { fontSize: 18 },
                      props.sending && { color: theme.background },
                    ]}>
                    ⋯
                  </Text>
                }
              />
            </Glass>
          </Key>

          {/* The middle slot. The keys live in one glass pill; during a bar swipe that WHOLE
              glass hides and each tab name is its own glass pill riding the strip — Safari's
              morph is the pill itself shrinking and growing, and scaling only the text inside a
              static glass read as no morph at all (user, 2026-08-11). */}
          <View style={styles.pill} onLayout={(e) => setPillW(e.nativeEvent.layout.width)}>
            <View
              style={[StyleSheet.absoluteFill, props.pills?.live && { opacity: 0 }]}
              pointerEvents={props.pills?.live ? 'none' : 'auto'}>
            <Glass theme={theme} radius={BAR_RADIUS} style={styles.pillGlass}>
            <View style={styles.keysRow}>
              <View style={styles.keysGroup}>
                <Key onPress={onCtrlTap} style={[styles.key, ctrlStyle]}>
                  <Text style={keyLabel}>Ctrl</Text>
                </Key>
                <Key onPress={() => track('\x1b')} style={styles.key}>
                  <Text style={keyLabel}>Esc</Text>
                </Key>
                <Key onPress={() => track('\x09')} style={styles.key}>
                  <Text style={keyLabel}>Tab</Text>
                </Key>
                <Key
                  onPress={onPaste}
                  onLongPress={onPasteLongPress}
                  delayLongPress={420}
                  style={styles.key}>
                  <Text style={keyLabel}>Paste</Text>
                </Key>
              </View>
              <View style={[styles.pillDivider, { backgroundColor: theme.border }]} />
              <Key
                onPress={() => toggle('arrows')}
                style={[
                  styles.arrowsButton,
                  open === 'arrows' && {
                    backgroundColor: rgba(theme.accent, 0.5),
                    borderWidth: 1,
                    borderColor: rgba(theme.accent, 0.9),
                  },
                ]}>
                <SymbolView
                  name="dpad"
                  size={20}
                  tintColor={theme.foreground}
                  fallback={<Text style={keyLabel}>✛</Text>}
                />
              </Key>
            </View>
            </Glass>
            </View>
            {/* §4.4: during a bar swipe the tab-name glass pills replace the keys. Mounted from
                the moment tabs are reachable — see the pills prop — visible only while live. */}
            {props.pills != null && pillW > 0 && (
              <View
                pointerEvents="none"
                style={[styles.namesWrap, !props.pills.live && { opacity: 0 }]}>
                <NameStrip theme={theme} pills={props.pills} width={pillW} />
              </View>
            )}
          </View>

          {/* The circle is always here, greyed when there is no tmux session behind it, and a tap
              then says why (user, 2026-08-12 — §7 wanted it absent, and a bar that changes shape
              with the host reads as the app losing a button rather than as a session without
              tabs). The geometry is one bar in both states, which is also what keeps the name
              pills' slot the same width everywhere. */}
          <Key
            onPress={props.showTabs ? props.onTabsTap : () => toggle('tabsHint')}
            style={styles.circleSlot}>
            <Glass
              theme={theme}
              radius={BAR_RADIUS}
              style={[styles.circle, !props.showTabs && styles.circleOff]}>
              <SymbolView
                name="square.on.square"
                size={24}
                tintColor={props.showTabs ? theme.foreground : theme.placeholder}
                fallback={
                  <Text style={[keyLabel, !props.showTabs && { color: theme.placeholder }]}>▣</Text>
                }
              />
            </Glass>
          </Key>
        </View>
      </GestureDetector>

      {/* The keyboard's owner. Invisible but real: iOS focuses it, every keystroke lands in
          `onChangeText`, and the diff against what it held last is what goes to the PTY. */}
      <TextInput
        ref={input}
        style={styles.input}
        onChangeText={onChangeText}
        onSelectionChange={onSelectionChange}
        onSubmitEditing={() => emitKey('\r')}
        // The pad (see `PAD`) seeds the field and is written back over it; nothing else sets the
        // text, so every repeat of a held delete arrives as an `onChangeText` the diff turns into
        // a DEL. There is no empty-field case left for an `onKeyPress` to cover.
        defaultValue={PAD}
        value={padWrite}
        submitBehavior="submit" // Return sends without blurring
        onBlur={repad}
        // A terminal wants nothing from the keyboard but keys.
        autoCorrect={false}
        autoCapitalize="none"
        spellCheck={false}
        autoComplete="off"
        caretHidden
        contextMenuHidden
        multiline={false}
        // iOS-only values, guarded: Android (T3's sibling task) falls back to its default layout.
        keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'default'}
        keyboardAppearance={theme.isDark ? 'dark' : 'light'} // iOS-only prop, ignored elsewhere
      />
    </View>
  );
}

/* --- the name pills (§4.4: they replace the keys during a bar swipe) --- */

function NameStrip({
  theme,
  pills,
  width,
}: {
  theme: Theme;
  pills: NonNullable<KeyBarProps['pills']>;
  width: number;
}) {
  // No translating strip: pills riding the page pitch crossed under the circles either side,
  // and the morph has to start and end BETWEEN the buttons (user, 2026-08-11, screenshot). All
  // pills stack in the one centred slot and morph in place — the sliding cards carry the
  // direction, the pill carries the name.
  return (
    <>
      {pills.names.map((name, i) => (
        <NamePill key={i} theme={theme} name={name} i={i} pills={pills} width={width} />
      ))}
    </>
  );
}

function NamePill({
  theme,
  name,
  i,
  pills,
  width,
}: {
  theme: Theme;
  name: string;
  i: number;
  pills: NonNullable<KeyBarProps['pills']>;
  width: number;
}) {
  const { pos, x, pitch } = pills;
  const style = useAnimatedStyle(() => {
    const d = pillDist(i, pillCont(pos, x.value, pitch));
    // Grown = the WHOLE slot, exactly the keys glass it crossfades with at the end — the old
    // strip's PILL_ITEM (94% of the slot) left a visible size jump at the swap back to the
    // keys (user, 2026-08-11, screenshots).
    return { width: width * pillWidthFrac(d), opacity: pillOpacity(d) };
  });
  // Anchored to the travel's edges, not the centre (user, 2026-08-11): a pill on the previous
  // side of the continuous position squeezes toward the LEFT edge of the slot — the side its
  // card exits through — and one on the next side grows in from the RIGHT. At its own window the
  // width is full and the anchor is moot, so the sign flip as `cont` crosses `i` never jumps.
  const anchor = useAnimatedStyle(() => ({
    alignItems: i < pillCont(pos, x.value, pitch) ? ('flex-start' as const) : ('flex-end' as const),
  }));
  // A whole glass pill per name, morphing Safari's way: the capsule SQUEEZES sideways — animated
  // width, height untouched, text clipped by the glass — and grows back out at its window.
  // No ‹ › hints, the morph is the indicator (user, 2026-08-11).
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.namePillSlot, anchor]}
      pointerEvents="none">
      <Animated.View style={[styles.namePillClip, style]}>
        <Glass theme={theme} radius={BAR_RADIUS} style={styles.namePill}>
          <Text numberOfLines={1} style={[styles.namePillText, { color: theme.foreground }]}>
            {name}
          </Text>
        </Glass>
      </Animated.View>
    </Animated.View>
  );
}

/* --- the popovers ---
 * Rendered by the screen in a layer over the terminal, anchored on the height KeyBar reports —
 * see `KeyBarProps.open` for why they cannot live inside the bar itself. */

export function ArrowsPopover({
  theme,
  decckm,
  bottom,
  sendBytes,
}: {
  theme: Theme;
  decckm: boolean;
  /** The measured `popBase`: the popover's bottom edge sits this far up the screen's layer. */
  bottom: number;
  sendBytes: (bytes: string) => void;
}) {
  const arrow = (key: NavKey, glyph: string, style: StyleProp<ViewStyle>) => (
    <Key key={key} onPress={() => sendBytes(navKey(key, decckm))} style={style}>
      <Text style={[styles.arrowGlyph, { color: theme.foreground }]}>{glyph}</Text>
    </Key>
  );
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      style={[styles.arrowsPop, { bottom }]}>
      <Glass theme={theme} radius={22} style={styles.arrowsGlass}>
        <View style={styles.dpad}>
          <View style={styles.dpadRow}>
            <View style={styles.dpadHole} />
            {arrow('up', '↑', [styles.dpadKey, { backgroundColor: KEY_TINT }])}
            <View style={styles.dpadHole} />
          </View>
          <View style={styles.dpadRow}>
            {arrow('left', '←', [styles.dpadKey, { backgroundColor: KEY_TINT }])}
            {arrow('down', '↓', [styles.dpadKey, { backgroundColor: KEY_TINT }])}
            {arrow('right', '→', [styles.dpadKey, { backgroundColor: KEY_TINT }])}
          </View>
        </View>
        <View style={[styles.popDivider, { backgroundColor: theme.border }]} />
        <View style={styles.homeEnd}>
          {arrow('home', 'Home', styles.homeEndKey)}
          {arrow('end', 'End', styles.homeEndKey)}
        </View>
      </Glass>
    </Animated.View>
  );
}

/** The greyed tabs circle's answer, hanging off the same `popBase` every other popover uses and
 *  right-aligned under the button that was tapped. Says one thing and takes no touches — the
 *  scrim behind it is the dismiss, like the rest. */
export function TabsHintPopover({
  theme,
  bottom,
  text,
}: {
  theme: Theme;
  bottom: number;
  text: string;
}) {
  return (
    <Animated.View
      pointerEvents="none"
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      style={[styles.hintPop, { bottom }]}>
      <Glass theme={theme} radius={16} style={styles.hintGlass}>
        <Text style={[styles.hintText, { color: theme.foreground }]}>{text}</Text>
      </Glass>
    </Animated.View>
  );
}

const UPLOAD_ROWS = [
  { label: 'Files', kind: 'files' },
  { label: 'Photo or video', kind: 'photo' },
  { label: 'Camera', kind: 'camera' },
] as const;

export function BarMenu({
  theme,
  bottom,
  onUpload,
  onOpenSettings,
}: {
  theme: Theme;
  /** The measured `popBase`, as on ArrowsPopover. */
  bottom: number;
  /** §4.6's destination flow: the screen runs picker → destination sheet → silent SFTP save. */
  onUpload: (kind: 'files' | 'photo' | 'camera') => void;
  onOpenSettings: () => void;
}) {
  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      style={[styles.menuPop, { bottom }]}>
      <Glass theme={theme} radius={26}>
        <Text style={[styles.menuHeader, { color: theme.muted }]}>UPLOAD FILE</Text>
        {UPLOAD_ROWS.map(({ label, kind }) => (
          <Pressable
            key={kind}
            onPress={() => onUpload(kind)}
            style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: KEY_TINT }]}>
            <Text style={[styles.menuLabel, { color: theme.foreground }]}>{label}</Text>
          </Pressable>
        ))}
        <View style={styles.menuBreak} />
        <Pressable
          onPress={onOpenSettings}
          style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: KEY_TINT }]}>
          <Text style={[styles.menuLabel, { color: theme.foreground }]}>Settings</Text>
        </Pressable>
      </Glass>
    </Animated.View>
  );
}

/**
 * The clipboard popover (§4.4): slots with content preview and provenance, pin toggles, the
 * phone-pasteboard row last. Opening reads the pasteboard once — the iOS paste banner firing
 * here is accepted by the spec. Tapping a row types it; nothing here ever appends a newline.
 */
export function ClipboardPopover({
  theme,
  bottom,
  bracketedPaste,
  sendBytes,
  onClose,
}: {
  theme: Theme;
  /** The measured `popBase`, as on ArrowsPopover. */
  bottom: number;
  /** Whether the far end asked for bracketed paste — see `pasteBytes`. */
  bracketedPaste: boolean;
  sendBytes: (bytes: string) => void;
  onClose: () => void;
}) {
  const { slots, pasteboard } = useClipboard();

  useEffect(() => {
    void refreshPasteboard();
  }, []);

  const type = (text: string) => {
    // Typed, never executed — multiline yanks included, no newline of ours, and wrapped so the
    // newlines a yank does carry stay content (see `pasteBytes`).
    sendBytes(pasteBytes(text, bracketedPaste));
    onClose();
  };

  const now = Date.now();
  const row = (slot: Slot, highlight: boolean, onPin: () => void, onPick: () => void) => (
    <Pressable
      onPress={onPick}
      style={({ pressed }) => [
        styles.clipRow,
        { borderTopColor: HAIRLINE },
        highlight && { backgroundColor: rgba(theme.accent, 0.12) },
        pressed && { backgroundColor: KEY_TINT },
      ]}>
      <View style={styles.clipBody}>
        <Text numberOfLines={1} style={[styles.clipText, { color: theme.foreground }]}>
          {slot.text}
        </Text>
        <Text style={[styles.clipMeta, { color: theme.muted }]}>{provenance(slot, now)}</Text>
      </View>
      <Pressable onPress={onPin} hitSlop={8} style={styles.clipPin}>
        <SymbolView
          name={slot.pinned ? 'pin.fill' : 'pin'}
          size={15}
          tintColor={slot.pinned ? theme.accentAlternate : theme.placeholder}
          fallback={
            <Text style={{ fontSize: 13, color: slot.pinned ? theme.accentAlternate : theme.placeholder }}>
              {slot.pinned ? '●' : '○'}
            </Text>
          }
        />
      </Pressable>
    </Pressable>
  );

  return (
    <Animated.View
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      style={[styles.clipPop, { bottom }]}>
      <Glass theme={theme} radius={20} style={styles.clipGlass}>
        <Text style={[styles.clipHeader, { color: theme.placeholder }]}>CLIPBOARD</Text>
        {slots.map((slot, i) => (
          <View key={`${slot.at}-${i}`}>{row(slot, i === 0, () => togglePin(i), () => type(slot.text))}</View>
        ))}
        {pasteboard !== null && row(pasteboard, false, pinPasteboard, () => type(pasteboard.text))}
        {slots.length === 0 && pasteboard === null && (
          <Text style={[styles.clipEmpty, { color: theme.muted }]}>Nothing yanked or copied yet.</Text>
        )}
      </Glass>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /* the bar row — §3 metrics */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: SIDE_MARGIN,
    paddingTop: BAR_PAD_TOP,
    paddingBottom: 6,
  },
  circleSlot: { width: 49, height: 49 },
  circle: { width: 49, height: 49, alignItems: 'center', justifyContent: 'center' },
  /** Disabled, not hidden — the glyph is already `placeholder`; this takes the glass down with it
   *  so the whole control reads inert rather than just faintly drawn. */
  circleOff: { opacity: 0.5 },
  pill: { flex: 1, height: 49 },
  pillGlass: { flex: 1 },
  keysRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
  },
  keysGroup: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 },
  key: {
    height: 35,
    paddingHorizontal: 8,
    borderRadius: KEY_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillDivider: { width: 1, height: 27 },
  // No overflow clip: a pill mid-slide is partly outside the slot, and the clip sheared its
  // rounded corner flat at the edge (user, 2026-08-11, screenshot). Unclipped it slides in
  // whole, passing under the circles either side (they render later, so above).
  namesWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  namePillSlot: { justifyContent: 'center' },
  namePillClip: { height: '100%' },
  namePill: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  namePillText: { fontFamily: MONO, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  arrowsButton: {
    width: 35,
    height: 35,
    borderRadius: KEY_RADIUS,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* chord strip */
  chordWrap: { alignItems: 'center', paddingTop: 2, paddingBottom: 8 },
  chordPill: { flexDirection: 'row', gap: 4, padding: 6 },
  cap: { width: 48, borderRadius: 14, alignItems: 'center', paddingTop: 5, paddingBottom: 4 },
  capLetter: { fontFamily: MONO, fontSize: 16 },
  capCaption: { fontSize: 8.5 },

  /* popovers, hanging off the popBase anchor */
  arrowsPop: { position: 'absolute', right: SIDE_MARGIN },
  arrowsGlass: { flexDirection: 'row', gap: 7, padding: 6 },
  dpad: { gap: 4 },
  dpadRow: { flexDirection: 'row', gap: 4 },
  dpadHole: { width: 44, height: 34 },
  dpadKey: { width: 44, height: 34, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  arrowGlyph: { fontFamily: MONO, fontSize: 15 },
  popDivider: { width: 1, opacity: 0.5, marginVertical: 3 },
  homeEnd: { gap: 4 },
  homeEndKey: { width: 56, height: 34, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  hintPop: { position: 'absolute', right: SIDE_MARGIN, maxWidth: 240 },
  hintGlass: { paddingHorizontal: 14, paddingVertical: 10 },
  hintText: { fontSize: 13, lineHeight: 18 },
  menuPop: { position: 'absolute', left: SIDE_MARGIN, width: 256 },
  menuHeader: {
    paddingHorizontal: 18,
    paddingTop: 11,
    paddingBottom: 6,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.5,
    opacity: 0.8,
  },
  menuRow: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: HAIRLINE,
  },
  menuLabel: { fontSize: 15 },
  menuBreak: { height: 6, backgroundColor: 'rgba(0,0,0,0.14)' },

  /* clipboard popover — centered, 300pt, 20pt corners per the prototype */
  clipPop: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  clipGlass: { width: 300 },
  clipHeader: {
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 7,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  clipRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  clipBody: { flex: 1, minWidth: 0 },
  clipText: { fontFamily: MONO, fontSize: 12 },
  clipMeta: { fontSize: 10, marginTop: 1 },
  clipPin: { padding: 2 },
  clipEmpty: {
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: HAIRLINE,
  },

  /* the invisible keyboard owner */
  /**
   * Invisible, but no longer 1×1: iOS's hold-space trackpad walks the caret by hit-testing the
   * field's own text layout, and a field one point wide has nowhere to walk — the caret never
   * moved and no selection event ever fired. Full width gives the drag real characters to cross
   * (the field scrolls its content, as any single-line field does, so the pad past the edge is
   * still reachable). It lies over the keys but cannot take their touches: RN's own hit test
   * drops any view under `alpha < 0.01` (RCTViewComponentView.mm:746), and `pointerEvents:
   * 'none'` is deliberately *not* used — that sets `userInteractionEnabled = NO`, which is what
   * a UITextField consults before agreeing to become first responder.
   *
   * MONO at 13 is the calibration: the drag moves one terminal column per column of finger
   * travel only if the field's characters are about as wide as the terminal's, and 13 is the
   * default font size. Set larger in Settings and the cursor runs a little ahead of the finger —
   * the eye closes that loop; threading the live size down here would be a prop for a feel.
   */
  input: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 24,
    opacity: 0,
    fontFamily: MONO,
    fontSize: 13,
  },
});
