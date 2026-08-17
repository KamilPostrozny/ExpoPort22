/**
 * The key bar (§4.4): ⋯ circle | keys pill Ctrl · Esc · Tab · Paste ‖ arrows | tabs circle,
 * with the chord strip and the popovers stacking above it. Geometry follows
 * the prototype, now deleted (the iOS build is the spec wherever PLAN prose disagrees): 49pt circles
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
 * Geometry lives in `src/style.ts` as `BAR`.
 */

import * as Haptics from 'expo-haptics';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeInDown,
  FadeOutDown,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';

import {
  pillCont,
  pillDist,
  pillOpacity,
  pillWidthFrac,
  rubber,
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
  KEYS_DROP_DY,
  rowJoins,
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
import {
  BAR,
  CAP_CAPTION,
  CENTER,
  MENU_RADIUS,
  PRESSED_KEY,
  RADIUS,
  SPACE,
  TEXT,
  leading,
} from '@/style';
import { zoomProgress } from '@/switcher-model';
import { MONO, rgba, SANS, SANS_SEMIBOLD, type Theme } from '@/theme';

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
  /** T10: the zoom drag's TRANSITIONS, one JS call each — the per-frame follow runs in this
   *  file's pan worklet against `panSV`, because the JS thread stalls 40–300ms under load and a
   *  runOnJS pan hitched with it (perf harness, 2026-08-13). `onZoomGrab` pays the open's
   *  one-off costs; `onZoomEnd` decides commit-or-spring-back from the release's velocity. */
  onZoomGrab?: (dx: number, dy: number) => void;
  onZoomEnd?: (dx: number, dy: number, vx: number, vy: number) => void;
  /** The card has actually begun to lift — arm the switcher's own state now, not at the grab. */
  onZoomArm?: () => void;
  /** T11: the page-slide window hop's transitions — 'start' once when the pan leaves the slop,
   *  'end' on release with the relative travel. The per-frame x rides `panSV.swipeX`, written by
   *  the worklet. The screen owns the model: rubber band, thresholds, commit
   *  (`src/barswipe-model.ts`). Unset = the axis is silence (no tmux). */
  onBarSwipe?: (phase: 'start' | 'end', dx: number) => void;
  /** The gesture's shared values, owned by the screen: the worklet writes the hot path here. */
  panSV?: {
    swipeX: SharedValue<number>;
    prog: SharedValue<number>;
    dragX: SharedValue<number>;
    zoomReady: SharedValue<number>;
    zoomBase: SharedValue<number>;
    zoomFromX: SharedValue<number>;
    zoomFromY: SharedValue<number>;
    zoomFromSet: SharedValue<number>;
    dragging: SharedValue<number>;
    armed: SharedValue<number>;
    rowLive: SharedValue<number>;
    rowVis: SharedValue<number>;
    rowPos: SharedValue<number>;
    rowCount: SharedValue<number>;
    stage: SharedValue<{ w: number; h: number }>;
  };
  /** The tab-name pills that replace the bar keys during a page swipe (§4.4). `x` is the
   *  screen's page offset, `pitch` its page step — the pills derive the continuous position.
   *  Passed whenever tabs are reachable, NOT just mid-swipe: mounting the set on the swipe's
   *  first frame was the hitch at the start of every swipe (user, 2026-08-11) — pre-mounted and
   *  hidden, `live` merely flips opacities. Cheaper now that a pill is a plain plate rather than
   *  a blur, but the pre-mount stays: it is what makes the first frame free. */
  pills?: {
    names: string[];
    /** Shared values, not numbers, and `x` never swaps: each pill runs two `useAnimatedStyle`
     *  mappers, Reanimated keys a mapper's dependencies on its worklet's closure, and a changing
     *  number or a swapping identity restarts every one of them. The strip is pre-mounted exactly
     *  so a swipe never pays to build it; restarting its mappers three times a swipe gave that
     *  back (perf, 2026-08-13). */
    pos: SharedValue<number>;
    /** 1 = read `x` as zero. The settle moves `pos` to the target while `x` still holds the
     *  slide's final offset until the screen's post-paint reset, and read together they put the
     *  continuous position a full window off (user, 2026-08-11). A gate, not a second value. */
    hold: SharedValue<number>;
    x: SharedValue<number>;
    pitch: number;
    live: boolean;
  } | null;
};

/* --- the chrome's one surface --- */

/** The plate's hairline. */
const PLATE_BORDER_W = 0.5;

/**
 * The prototype's tints, as fractions of the theme's own ink rather than as literals.
 *
 * These were three Catppuccin Mocha values — `overlay1` at 16% and 25%, and white at 12% — written
 * when there were four flavours and three of them dark. Across twenty-six they do not hold: a pale
 * grey tint over a pale plate is invisible on the nine light schemes, and a white edge on a white
 * sheet has no edge at all. They stay translucent on purpose: they are tints ON the plate `Plate`
 * paints, so they have to let its `surface` through — an opaque role here would be a second plate.
 *
 * `plateEdge` supersedes a two-value `glassBorder(isDark)`: the prototype defines the edge pair
 * together (`--glassBd`) and only the dark half had ever been written, so a light scheme drew a
 * white line over a near-white surface. Branching on appearance fixed that with two more literals;
 * taking it off `foreground` fixes it once for every scheme.
 */
const keyTint = (t: Theme) => rgba(t.foreground, 0.14);
const hairline = (t: Theme) => rgba(t.foreground, 0.22);
const plateEdge = (t: Theme) => rgba(t.foreground, 0.12);

/** Every popover in this file rises and leaves the same way — one decision, not five copies of it.
 *  Out is quicker than in: a dismissal should be gone before the finger is. */
const POP_IN = FadeInDown.duration(180);
const POP_OUT = FadeOutDown.duration(140);

/** How this bar hides a plate it wants to keep mounted. Never `opacity: 0` — see the two
 *  call sites; the frozen object keeps the style array's identity stable across renders. */
const DISPLAY_NONE = { display: 'none' } as const;

/**
 * One chrome surface: opaque plate, hairline edge, the caller's corner. No blur, on either
 * platform.
 *
 * It used to be a real `BlurView` on iOS and a flat plate on Android, which is the exact shape of
 * divergence this app no longer ships. A backdrop blur is not a thing both platforms can do: iOS's
 * `UIVisualEffectView` samples the window and needs nothing, while expo-blur on Android is Dimezis,
 * which cannot read the window at all — it re-draws one nominated view's subtree into an offscreen
 * canvas every frame, so it needs a `blurTarget` ref, an explicit `blurMethod`, three runtime forks
 * at API 31 (`ExpoBlurView.kt:70,103,133`) and an API 31 floor, and with no target expo-blur
 * silently coerces the method to `'none'` and paints a hardcoded near-black film
 * (`BlurView.js:54`). On top of that the bar sits over the terminal, which is a WebView compositing
 * on its own surface — quite possibly not capturable into that canvas at all. Two platforms, two
 * mechanisms, one of them unverifiable without hardware: that is a workaround, not a shared design.
 *
 * So the glass goes, and `src/ribbon.tsx` gets its precedent applied everywhere rather than only to
 * itself — it reached this conclusion first, for its own band, and the note there is still the
 * shortest statement of it. `theme.surface` is opaque on purpose: translucency without blur just
 * shows the terminal's own text through the bar, which is worse than either. Reduce Transparency is
 * now a no-op app-wide, which is a small accessibility win the blur was costing us.
 *
 * Exported for the edge handle's caps — the same surface.
 */
export function Plate({
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
  return (
    <View
      style={[
        {
          borderRadius: radius,
          overflow: 'hidden',
          borderWidth: PLATE_BORDER_W,
          borderColor: plateEdge(theme),
          backgroundColor: theme.surface,
        },
        style,
      ]}>
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
 *  completes the press, so swipes are silent. Exported for the ribbon's caps: they are the same
 *  kind of control and used to be a bare Pressable with neither the haptic nor the shrink. */
export function Key({
  onPress,
  onLongPress,
  delayLongPress,
  disabled,
  accessibilityLabel,
  accessibilityHint,
  style,
  children,
}: {
  onPress?: () => void;
  onLongPress?: () => void;
  delayLongPress?: number;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
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
        pressed && PRESSED_KEY,
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

function KeyBarInner(props: KeyBarProps) {
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
  /** Past the slop: the page is under the finger. Shared values, not refs — the whole pan runs
   *  on the UI thread now. */
  const held = useSharedValue(0);
  /** The grab happened: both axes are live from here. */
  const grabbed = useSharedValue(0);
  /** The keyboard has already been sent away by this pan. */
  const dismissed = useSharedValue(0);
  /** The pan's translation at the instant the card was grabbed. The grab costs `BAR_AXIS_SLOP` of
   *  travel, and the pan reports it from TOUCH-DOWN — so handing the page `e.translationX` made
   *  it open 10pt along instead of at zero: the card detached from the edge with a jump in the
   *  direction of the finger rather than growing out of it (user, 2026-08-11). The hop measures
   *  from here on, which also makes the commit and flick distances in `barswipe-model` mean the
   *  travel they say they do, the way the vertical gesture's already budget for this. The vertical
   *  tests keep the raw translation: the lift is measured from touch-down (its 24pt is the budget),
   *  and the zoom re-origins for itself at the frame it arms (the screen's `zoomFrom`). */
  const originX = useSharedValue(0);
  /** Stable JS trampolines: the gesture is memoized ONCE, so its worklets must capture functions
   *  whose identity never changes — the latest props are read through a ref at call time. An
   *  un-memoized gesture re-serialized its worklets and re-attached the recognizer on every
   *  render, mid-gesture (user: "hitching even worse" after the UI-thread move). */
  const cbRef = useRef({
    onZoomGrab: props.onZoomGrab,
    onZoomArm: props.onZoomArm,
    onZoomEnd: props.onZoomEnd,
    onBarSwipe: props.onBarSwipe,
  });
  cbRef.current = {
    onZoomGrab: props.onZoomGrab,
    onZoomArm: props.onZoomArm,
    onZoomEnd: props.onZoomEnd,
    onBarSwipe: props.onBarSwipe,
  };
  const jsZoomGrab = useCallback((dx: number, dy: number) => cbRef.current.onZoomGrab?.(dx, dy), []);
  const jsZoomEnd = useCallback(
    (dx: number, dy: number, vx: number, vy: number) => cbRef.current.onZoomEnd?.(dx, dy, vx, vy),
    [],
  );
  const jsZoomArm = useCallback(() => cbRef.current.onZoomArm?.(), []);
  const jsBarSwipe = useCallback(
    (phase: 'start' | 'end', dx: number) => cbRef.current.onBarSwipe?.(phase, dx),
    [],
  );
  const dismissKeys = useCallback(() => Keyboard.dismiss(), []);
  /** `showTabs` for the worklet without becoming a gesture dependency. */
  const showTabsSV = useSharedValue(props.showTabs ? 1 : 0);
  useEffect(() => {
    showTabsSV.value = props.showTabs ? 1 : 0;
  }, [props.showTabs, showTabsSV]);
  const panSV = props.panSV;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- every capture is identity-stable
  const pan = useMemo(() => Gesture.Pan()
    .maxPointers(1)
    .onBegin(() => {
      'worklet';
      held.value = 0;
      grabbed.value = 0;
      dismissed.value = 0;
    })
    .onUpdate((e) => {
      'worklet';
      const sv = props.panSV;
      const tx = e.translationX;
      const ty = e.translationY;
      // The grab. From here the card is in hand and BOTH axes are simply live — no threshold in
      // the way of the vertical (user, 2026-08-13). One JS call pays the open's costs; every
      // frame after is pure shared-value writes on this thread.
      if (grabbed.value === 0) {
        if (!barGrabbed(tx, ty)) return;
        grabbed.value = 1;
        if (showTabsSV.value === 1) runOnJS(jsZoomGrab)(tx, ty);
      }
      if (sv !== undefined && showTabsSV.value === 1 && sv.dragging.value === 1 && sv.zoomReady.value === 1) {
        if (sv.zoomFromSet.value === 0) {
          sv.zoomFromSet.value = 1;
          sv.zoomFromX.value = tx;
          sv.zoomFromY.value = ty;
        }
        // The zoom's horizontal drift freezes once a page swipe is running — two things moving the
        // card at once is a card travelling twice as far as the finger.
        if (held.value === 0) sv.dragX.value = tx - sv.zoomFromX.value;
        sv.prog.value = Math.min(
          1,
          sv.zoomBase.value + zoomProgress(ty - sv.zoomFromY.value, sv.stage.value.w, sv.dragX.value),
        );
        // The card has left the bar for real: only now does the switcher's React state cost
        // anything (see `onZoomArm`). A flat hop never reaches here.
        if (sv.armed.value === 0 && sv.prog.value > 0.01) {
          sv.armed.value = 1;
          runOnJS(jsZoomArm)();
        }
        // A card lifted off the bar goes to the grid ALONE. It used to gather its neighbours once
        // the hand settled, and push them away again past a ceiling — removed 2026-08-17 after
        // three fixes for the same report ("they flicker, and sometimes they don't disappear")
        // each fitted the evidence and each missed. The two gestures either side of it are the
        // ones that work and the ones that were being asked for: up goes to the grid, sideways
        // hops a tab. `git log -S heldAir` finds the latch, the ceiling and its constants.
      }
      // The keys get out of the way once the card is visibly off the bar — not at the slop, which
      // the opening arc of a flat hop passes through on its own (see `KEYS_DROP_DY`).
      if (dismissed.value === 0 && (ty <= -KEYS_DROP_DY || barDismisses(tx, ty))) {
        dismissed.value = 1;
        runOnJS(dismissKeys)();
      }
      // The page row joins when the finger goes sideways from a standing start on the bar. A card
      // already climbing is on its way to the grid alone — it has no row to join.
      if (held.value === 0) {
        if (!rowJoins(tx, ty, sv?.prog.value ?? 0)) return;
        held.value = 1;
        originX.value = tx;
        runOnJS(jsBarSwipe)('start', 0);
        return;
      }
      if (sv !== undefined) {
        // Guarded by the screen's own live flag: the JS 'start' above may still be in flight for
        // the first frame or two, and the rubber band needs its position/count.
        if (sv.rowLive.value === 1)
          sv.swipeX.value = rubber(tx - originX.value, sv.rowPos.value, sv.rowCount.value);
      }
    })
    // `onFinalize`, not `onEnd`: a pan can leave by being CANCELLED — another handler wins the
    // race, the view it is on unmounts — and that path never calls `onEnd`. The screen's zoom
    // phase is only ever left by this callback, so a miss leaves it stuck mid-drag (user,
    // 2026-08-11). Finalize fires for every exit, successful or not.
    .onFinalize((e) => {
      'worklet';
      // Both axes report, in this order, and the screen arbitrates: a release that commits to
      // the grid ends the page swipe itself, so the second call finds nothing live to decide.
      if (grabbed.value === 1 && showTabsSV.value === 1)
        runOnJS(jsZoomEnd)(e.translationX, e.translationY, e.velocityX, e.velocityY);
      grabbed.value = 0;
      if (held.value === 1) {
        held.value = 0;
        runOnJS(jsBarSwipe)('end', e.translationX - originX.value);
      }
    }), [panSV]);

  // No `fontWeight` beside `MONO`: it is a one-face family, so a numeric weight selects nothing
  // on iOS and risks minikin's synthetic bold on Android — a divergence for a weight the bundled
  // face does not have. `MONO_BOLD` is how this codebase asks for bold.
  const keyLabel = {
    color: theme.foreground,
    fontFamily: MONO,
    includeFontPadding: false,
    fontSize: TEXT.mono,
  };

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
          entering={POP_IN}
          exiting={POP_OUT}
          style={styles.chordWrap}>
          <Plate theme={theme} radius={22} style={styles.chordPill}>
            {CHORD_STRIP.map(({ letter, caption }) => (
              <Key
                key={letter}
                onPress={() => sendChord(letter)}
                style={styles.cap}>
                <Text style={[styles.capLetter, { color: theme.foreground }]}>{letter}</Text>
                <Text style={[styles.capCaption, { color: theme.muted }]}>{caption}</Text>
              </Key>
            ))}
          </Plate>
        </Animated.View>
      )}

      <GestureDetector gesture={pan}>
        <View style={styles.row}>
          {/* §4.6: during an upload the circle tints accent and goes inert — the whole progress
              UI. The Pressable disables, so a tap during a send does nothing at all. */}
          <Key onPress={props.sending ? undefined : () => toggle('menu')} style={styles.circleSlot}>
            <Plate
              theme={theme}
              radius={BAR.radius}
              style={styles.circle}>
              {/* §4.6's busy tint, drawn *over* the plate rather than under it. As the container's
                  backgroundColor it sat beneath the plate's own fill,
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
                    { backgroundColor: theme.accent, borderRadius: BAR.radius },
                  ]}
                />
              )}
              {/* U+F141 (nf-fa-ellipsis_h): three ROUND dots, which is what SF's `ellipsis` draws —
                  U+22EF's are square and read as a different mark at 18pt. The bundled face carries
                  it on both platforms; §4.6's busy tint rides the glyph's colour. */}
              <Text
                style={[
                  keyLabel,
                  { fontSize: 18 },
                  props.sending && { color: theme.onAccent },
                ]}>
                {'\uF141'}
              </Text>
            </Plate>
          </Key>

          {/* The middle slot. The keys live in one pill; during a bar swipe that WHOLE pill
              hides and each tab name is its own pill riding the strip — Safari's morph is the
              pill itself shrinking and growing, and scaling only the text inside a static pill
              read as no morph at all (user, 2026-08-11). */}
          <View style={styles.pill} onLayout={(e) => setPillW(e.nativeEvent.layout.width)}>
            {/* `display: 'none'`, not `opacity: 0`: a hidden view is not composited, where a
                zero-opacity one still is. It stays mounted either way — which is the whole point
                of keeping it here, so the swipe's first frame builds no plates. (The rule outlived
                its original reason: it was a UIVisualEffectView that kept re-rendering its backdrop
                under a zero opacity. The blur is gone; not compositing a hidden view is still
                free.) */}
            <View
              style={[StyleSheet.absoluteFill, props.pills?.live && DISPLAY_NONE]}
              pointerEvents={props.pills?.live ? 'none' : 'auto'}>
            <Plate theme={theme} radius={BAR.radius} style={styles.pillPlate}>
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
                {/* U+F047 (nf-fa-arrows) is the four-way on both platforms now: it is in the
                    bundled face, where ✛ is in none at all and fell through to Noto at another
                    weight — see `MONO` in fonts.ts. */}
                <Text style={[keyLabel, { fontSize: 18 }]}>{'\uF047'}</Text>
              </Key>
            </View>
            </Plate>
            </View>
            {/* §4.4: during a bar swipe the tab-name pills replace the keys. Mounted from
                the moment tabs are reachable — see the pills prop — visible only while live. */}
            {props.pills != null && pillW > 0 && (
              <View
                pointerEvents="none"
                style={[styles.namesWrap, !props.pills.live && DISPLAY_NONE]}>
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
            <Plate
              theme={theme}
              radius={BAR.radius}
              style={[styles.circle, !props.showTabs && styles.circleOff]}>
              {/* U+F24D (nf-fa-clone) is the icon on both platforms now: two offset squares, the
                  shape SF's `square.on.square` drew. The old ▣ is in no bundled face at all, so
                  it fell through to Noto at a different weight — see `MONO` in fonts.ts. Sized
                  to the 24pt symbol it replaces, not to a text cap, or it lands 40% short. */}
              <Text
                style={[
                  keyLabel,
                  { fontSize: 22 },
                  !props.showTabs && { color: theme.placeholder },
                ]}>
                {'\uF24D'}
              </Text>
            </Plate>
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
        // Category (1), iOS-only API: `ascii-capable` is an iOS `keyboardType` value with no
        // Android equivalent; Android takes its default layout. Nothing visual crosses this branch.
        keyboardType={Platform.OS === 'ios' ? 'ascii-capable' : 'default'}
        keyboardAppearance={theme.isDark ? 'dark' : 'light'} // iOS-only prop, ignored elsewhere
      />
    </View>
  );
}

/**
 * The bar re-rendered on every render of the terminal screen — which is every phase of every
 * gesture, every keyboard step, every ~2s tmux poll — and it is not a small tree: three `Plate`s,
 * the chord strip, the keys with their glyphs, the TextInput, and one `NamePill` per
 * window (two `useAnimatedStyle` hooks each), all deliberately mounted at rest so a swipe never
 * pays to build them. None of that changes unless a prop does, so: memo.
 *
 * It only bites because the screen hands over stable identities — every handler through a ref
 * trampoline and `pills` through a `useMemo` (see the `kbH`/`kb_*` block there). React Compiler
 * would have done this unasked, but this component bails out of compilation (verified by running
 * the plugin over the file), so it is done by hand.
 */
export default memo(KeyBarInner);

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
  const { pos, hold, x, pitch } = pills;
  const style = useAnimatedStyle(() => {
    const d = pillDist(i, pillCont(pos.value, hold.value === 1 ? 0 : x.value, pitch));
    // Grown = the WHOLE slot, exactly the keys pill it crossfades with at the end — the old
    // strip's PILL_ITEM (94% of the slot) left a visible size jump at the swap back to the
    // keys (user, 2026-08-11, screenshots).
    return { width: width * pillWidthFrac(d), opacity: pillOpacity(d) };
  });
  // Anchored to the travel's edges, not the centre (user, 2026-08-11): a pill on the previous
  // side of the continuous position squeezes toward the LEFT edge of the slot — the side its
  // card exits through — and one on the next side grows in from the RIGHT. At its own window the
  // width is full and the anchor is moot, so the sign flip as `cont` crosses `i` never jumps.
  const anchor = useAnimatedStyle(() => ({
    alignItems:
      i < pillCont(pos.value, hold.value === 1 ? 0 : x.value, pitch)
        ? ('flex-start' as const)
        : ('flex-end' as const),
  }));
  // A whole pill per name, morphing Safari's way: the capsule SQUEEZES sideways — animated
  // width, height untouched, text clipped by the plate — and grows back out at its window.
  // No ‹ › hints, the morph is the indicator (user, 2026-08-11).
  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.namePillSlot, anchor]}
      pointerEvents="none">
      <Animated.View style={[styles.namePillClip, style]}>
        <Plate theme={theme} radius={BAR.radius} style={styles.namePill}>
          <Text numberOfLines={1} style={[styles.namePillText, { color: theme.foreground }]}>
            {name}
          </Text>
        </Plate>
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
  const arrow = (
    key: NavKey,
    glyph: string,
    style: StyleProp<ViewStyle>,
    text: StyleProp<TextStyle> = styles.arrowGlyph,
  ) => (
    <Key key={key} onPress={() => sendBytes(navKey(key, decckm))} style={style}>
      <Text style={[text, { color: theme.foreground }]}>{glyph}</Text>
    </Key>
  );
  return (
    <Animated.View
      entering={POP_IN}
      exiting={POP_OUT}
      style={[styles.arrowsPop, { bottom }]}>
      <Plate theme={theme} radius={22} style={styles.arrowsPlate}>
        <View style={styles.dpad}>
          <View style={styles.dpadRow}>
            <View style={styles.dpadHole} />
            {arrow('up', '↑', [styles.dpadKey, { backgroundColor: keyTint(theme) }])}
            <View style={styles.dpadHole} />
          </View>
          <View style={styles.dpadRow}>
            {arrow('left', '←', [styles.dpadKey, { backgroundColor: keyTint(theme) }])}
            {arrow('down', '↓', [styles.dpadKey, { backgroundColor: keyTint(theme) }])}
            {arrow('right', '→', [styles.dpadKey, { backgroundColor: keyTint(theme) }])}
          </View>
        </View>
        <View style={[styles.popDivider, { backgroundColor: theme.border }]} />
        <View style={styles.homeEnd}>
          {arrow('home', 'Home', styles.homeEndKey, styles.homeEndGlyph)}
          {arrow('end', 'End', styles.homeEndKey, styles.homeEndGlyph)}
        </View>
      </Plate>
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
      entering={POP_IN}
      exiting={POP_OUT}
      style={[styles.hintPop, { bottom }]}>
      <Plate theme={theme} radius={16} style={styles.hintPlate}>
        <Text style={[styles.hintText, { color: theme.foreground }]}>{text}</Text>
      </Plate>
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
  onOpenKeys,
  onOpenSettings,
}: {
  theme: Theme;
  /** The measured `popBase`, as on ArrowsPopover. */
  bottom: number;
  /** §4.6's destination flow: the screen runs picker → destination sheet → silent SFTP save. */
  onUpload: (kind: 'files' | 'photo' | 'camera') => void;
  /** T16's key screen. It is here rather than only on Setup because Upload ("Add to
   *  authorized_keys") needs a session that is already up, and the only other door to that screen
   *  is Setup — which the terminal reaches through `leave()`, i.e. by disconnecting first. Through
   *  this row the session stays up underneath, exactly as it does for Settings. */
  onOpenKeys: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <Animated.View
      entering={POP_IN}
      exiting={POP_OUT}
      style={[styles.menuPop, { bottom }]}>
      <Plate theme={theme} radius={MENU_RADIUS}>
        <Text style={[styles.menuHeader, { color: theme.muted }]}>UPLOAD FILE</Text>
        {UPLOAD_ROWS.map(({ label, kind }, i) => (
          <Pressable
            key={kind}
            onPress={() => onUpload(kind)}
            style={({ pressed }) => [
              styles.menuRow,
              { borderTopColor: hairline(theme) },
              i === 0 && styles.menuRowFirst,
              pressed && { backgroundColor: keyTint(theme) },
            ]}>
            <Text style={[styles.menuLabel, { color: theme.foreground }]}>{label}</Text>
          </Pressable>
        ))}
        <View style={[styles.menuBreak, { backgroundColor: theme.scrim }]} />
        <Pressable
          onPress={onOpenKeys}
          style={({ pressed }) => [
            styles.menuRow,
            { borderTopColor: hairline(theme) },
            pressed && { backgroundColor: keyTint(theme) },
          ]}>
          <Text style={[styles.menuLabel, { color: theme.foreground }]}>Key</Text>
        </Pressable>
        <Pressable
          onPress={onOpenSettings}
          style={({ pressed }) => [
            styles.menuRow,
            { borderTopColor: hairline(theme) },
            pressed && { backgroundColor: keyTint(theme) },
          ]}>
          <Text style={[styles.menuLabel, { color: theme.foreground }]}>Settings</Text>
        </Pressable>
      </Plate>
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
        { borderTopColor: hairline(theme) },
        highlight && { backgroundColor: rgba(theme.accent, 0.12) },
        pressed && { backgroundColor: keyTint(theme) },
      ]}>
      <View style={styles.clipBody}>
        <Text numberOfLines={1} style={[styles.clipText, { color: theme.foreground }]}>
          {slot.text}
        </Text>
        <Text style={[styles.clipMeta, { color: theme.border }]}>{provenance(slot, now)}</Text>
      </View>
      <Pressable onPress={onPin} hitSlop={8} style={styles.clipPin}>
        {/* U+F08D (nf-fa-thumb-tack). One glyph, two colours: the colour carries pinned vs not,
            as the symbol's tint did. `fontFamily` is load-bearing — without it Android falls
            through to Noto Sans Symbols and draws another pin at another weight. */}
        <Text
          style={{
            fontFamily: MONO,
            includeFontPadding: false,
            fontSize: 13,
            color: slot.pinned ? theme.accentAlternate : theme.placeholder,
          }}>
          {'\uF08D'}
        </Text>
      </Pressable>
    </Pressable>
  );

  return (
    <Animated.View
      entering={POP_IN}
      exiting={POP_OUT}
      style={[styles.clipPop, { bottom }]}>
      <Plate theme={theme} radius={20} style={styles.clipPlate}>
        <Text style={[styles.clipHeader, { color: theme.border }]}>CLIPBOARD</Text>
        {slots.map((slot, i) => (
          <View key={`${slot.at}-${i}`}>{row(slot, i === 0, () => togglePin(i), () => type(slot.text))}</View>
        ))}
        {pasteboard !== null && row(pasteboard, false, pinPasteboard, () => type(pasteboard.text))}
        {slots.length === 0 && pasteboard === null && (
          <Text style={[styles.clipEmpty, { color: theme.muted, borderTopColor: hairline(theme) }]}>Nothing yanked or copied yet.</Text>
        )}
      </Plate>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  /* the bar row — §3 metrics */
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: BAR.gap,
    paddingHorizontal: BAR.sideMargin,
    paddingTop: BAR_PAD_TOP,
    paddingBottom: 6,
  },
  circleSlot: { width: BAR.circle, height: BAR.circle },
  circle: { width: BAR.circle, height: BAR.circle, ...CENTER },
  /** Disabled, not hidden — the glyph is already `placeholder`; this takes the plate down with it
   *  so the whole control reads inert rather than just faintly drawn. */
  circleOff: { opacity: 0.5 },
  pill: { flex: 1, height: BAR.circle },
  pillPlate: { flex: 1 },
  keysRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.xs,
    paddingHorizontal: BAR.gap,
  },
  keysGroup: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 3 },
  key: {
    height: BAR.key,
    paddingHorizontal: BAR.keyPad,
    borderRadius: BAR.keyRadius,
    ...CENTER,
  },
  pillDivider: { width: 1, height: 27 },
  // No overflow clip: a pill mid-slide is partly outside the slot, and the clip sheared its
  // rounded corner flat at the edge (user, 2026-08-11, screenshot). Unclipped it slides in
  // whole, passing under the circles either side (they render later, so above).
  namesWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  namePillSlot: { justifyContent: 'center' },
  namePillClip: { height: '100%' },
  namePill: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  namePillText: { fontFamily: MONO, includeFontPadding: false, fontSize: 14, flexShrink: 1 },
  arrowsButton: {
    width: BAR.key,
    height: BAR.key,
    borderRadius: BAR.keyRadius,
    ...CENTER,
  },

  /* chord strip */
  chordWrap: { alignItems: 'center', paddingTop: 2, paddingBottom: SPACE.sm },
  chordPill: { flexDirection: 'row', gap: SPACE.xs, padding: 6 },
  cap: {
    width: 48,
    borderRadius: RADIUS.button,
    alignItems: 'center',
    paddingTop: 5,
    paddingBottom: 4,
  },
  capLetter: { fontFamily: MONO, includeFontPadding: false, fontSize: TEXT.button },
  capCaption: { fontFamily: SANS, includeFontPadding: false, fontSize: CAP_CAPTION },

  /* popovers, hanging off the popBase anchor */
  arrowsPop: { position: 'absolute', right: BAR.sideMargin },
  arrowsPlate: { flexDirection: 'row', gap: BAR.gap, padding: 6 },
  dpad: { gap: SPACE.xs },
  dpadRow: { flexDirection: 'row', gap: SPACE.xs },
  dpadHole: { width: 44, height: 34 },
  dpadKey: { width: 44, height: 34, borderRadius: 13, ...CENTER },
  /** The prototype draws these two clusters at two sizes — a 17pt arrow and a 12pt word — and one
   *  style for both had split the difference at 15, which is neither. Both boxes are fixed, so
   *  nothing reflows. */
  arrowGlyph: { fontFamily: MONO, includeFontPadding: false, fontSize: 17 },
  homeEndGlyph: { fontFamily: MONO, includeFontPadding: false, fontSize: TEXT.note },
  popDivider: { width: 1, opacity: 0.5, marginVertical: 3 },
  homeEnd: { gap: SPACE.xs },
  homeEndKey: { width: 56, height: 34, borderRadius: 13, ...CENTER },
  hintPop: { position: 'absolute', right: BAR.sideMargin, maxWidth: 240 },
  hintPlate: { paddingHorizontal: 14, paddingVertical: 10 },
  hintText: { fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.base, lineHeight: leading(TEXT.base) },
  menuPop: { position: 'absolute', left: BAR.sideMargin, width: 256 },
  // The ⋯ menu's own header and rows keep the prototype's 11pt/0.5 and 18pt gutter — its numbers
  // are not the settings sheet's, and `SECTION_HEADER` deliberately does not reach here.
  menuHeader: {
    paddingHorizontal: 18,
    paddingTop: 11,
    paddingBottom: 6,
    fontFamily: SANS_SEMIBOLD,
    includeFontPadding: false,
    fontSize: TEXT.caption,
    letterSpacing: 0.5,
    opacity: 0.8,
  },
  menuRow: {
    paddingHorizontal: 18,
    paddingVertical: SPACE.md,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  /** The first row sits under the header, where the prototype draws no rule. */
  menuRowFirst: { borderTopWidth: 0 },
  menuLabel: { fontFamily: SANS, fontSize: TEXT.label, includeFontPadding: false },
  menuBreak: { height: 6 },

  /* clipboard popover — centered, 300pt, 20pt corners per the prototype */
  clipPop: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  clipPlate: { width: 300 },
  clipHeader: {
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 7,
    fontFamily: SANS_SEMIBOLD,
    includeFontPadding: false,
    fontSize: TEXT.caption,
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
  clipText: { fontFamily: MONO, includeFontPadding: false, fontSize: TEXT.note },
  clipMeta: { fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.micro, marginTop: 1 },
  clipPin: { padding: 2 },
  clipEmpty: {
    paddingHorizontal: 14,
    paddingVertical: SPACE.md,
    fontFamily: SANS,
    includeFontPadding: false,
    fontSize: TEXT.note,
    borderTopWidth: StyleSheet.hairlineWidth,
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
    includeFontPadding: false,
    fontSize: 13,
  },
});
