/**
 * The key bar (§4.4): ⋯ circle | glass pill Ctrl · Esc · Tab · Paste ‖ arrows | tabs circle,
 * with the chord strip and the popovers stacking above it. Geometry and glass follow
 * `docs/design/Port22-Prototype.dc.html` (the spec wherever PLAN prose disagrees): 49pt circles
 * and pill, 35pt keys at 18pt radius, 24pt side margins, 48pt chord caps with 8.5pt captions,
 * arrows popover at 22pt corners, menu at 26pt.
 *
 * The native `TextInput` here owns the keyboard (T4's device-proven decision): the webview never
 * takes focus, typing reaches the PTY through `sendBytes`, and touching the terminal blurs the
 * input natively — which is what lets a long-press selection proceed with the keyboard up.
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
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  useAnimatedStyle,
  type SharedValue,
} from 'react-native-reanimated';

import {
  PILL_GAP,
  PILL_ITEM,
  pillCont,
  pillDist,
  pillOpacity,
  pillScale,
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
  DEL,
  afterChord,
  applyCtrl,
  classifyBarSwipe,
  controlByte,
  ctrlTap,
  diffInput,
  navKey,
  pasteBytes,
  type BarSwipe,
  type CtrlMode,
  type NavKey,
} from '@/keybar-model';
import { MONO, type Theme } from '@/theme';

export type BarPopover = 'none' | 'menu' | 'arrows' | 'clipboard';

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
  /** The bar stack's height (chord strip included, T11's ribbon later too), remeasured on every
   *  change — the `popBase` the screen anchors popovers on. One number, one place. */
  onHeight: (height: number) => void;
  /** Raise the keyboard when this flips true — the session just connected. */
  active: boolean;
  /** Bump to raise the keyboard again — the switcher closing back onto the terminal (T10), the
   *  prototype's `kbShown: true` on return. A counter, not a boolean: every close counts. */
  focusSignal?: number;
  /** T9's derived "tabs available": tmux present AND conf applied (§4.5). False renders no tabs
   *  circle at all — no tmux (or a toggled-off config) is silence, not a message (§7). */
  showTabs: boolean;
  /** The live tmux window index (T9's ~2s poll; null while not attached). The badge falls back
   *  to the design default `1`. */
  windowIndex?: number;
  /** §4.6: an upload in flight. The ⋯ circle tints accent and goes inert — the whole progress
   *  UI. Both flows flip it (quick-attach included, via `useUploadBusy`). */
  sending?: boolean;
  /** T10: tabs circle tap opens the switcher. */
  onTabsTap?: () => void;
  /** T10: bar swipe ↑ with the keyboard already up becomes the drag into the switcher — the
   *  prototype's `zoomFollow`. Fired per move with the pan's translation once the swipe has
   *  classified as up-with-keyboard-shown, then once with 'end' on release; the screen turns
   *  dy into zoom progress and decides commit-or-spring-back. Only wired while `showTabs`. */
  onSwitcherDrag?: (phase: 'move' | 'end', dx: number, dy: number) => void;
  /** T11: bar swipe ↔ is the page-slide window hop. Raw gesture only — 'start' once when the pan
   *  claims the horizontal axis, 'move' per frame with the pan's translation, 'end' on release.
   *  The screen owns the model: rubber band, thresholds, commit, and the shared `x` the pages
   *  and the pills both ride (`src/barswipe-model.ts`). Unset = the axis is silence (no tmux). */
  onBarSwipe?: (phase: 'start' | 'move' | 'end', dx: number) => void;
  /** While a page swipe is live: the tab-name pills that replace the bar keys (§4.4). `x` is the
   *  screen's page offset, `pitch` its page step — the strip derives the continuous position. */
  pills?: { names: string[]; pos: number; x: SharedValue<number>; pitch: number } | null;
  /** T11's context ribbon, rendered in the slot above the chord strip so its height rides the
   *  same `onHeight` measurement the popovers anchor on. The screen owns its state. */
  ribbon?: React.ReactNode;
};

/* --- §3's glass recipe --- */

const GLASS_BORDER = 'rgba(255,255,255,0.12)';
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
 *  the border carries the edge alone. Exported for T11's ribbon, which is the same glass. */
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
        { borderRadius: radius, overflow: 'hidden', borderWidth: 0.5, borderColor: GLASS_BORDER },
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

/** Every pressable on the bar: dim + shrink while touched, light haptic on touch (not on echo). */
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
      onPressIn={() => {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      }}
      onPress={onPress}
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

export default function KeyBar(props: KeyBarProps) {
  const { theme, open, onOpenChange } = props;
  const input = useRef<TextInput>(null);
  /** What the (uncontrolled) TextInput last held — the other half of `diffInput`. */
  const typed = useRef('');
  const [ctrl, setCtrl] = useState<CtrlMode>('off');
  const lastCtrlTap = useRef(0);
  /** The axis this bar pan committed to, so it fires once and never also presses keys. */
  const swipe = useRef<BarSwipe>(null);
  /** The pill's measured width — the name-pill pitch (prototype: item + gap exactly fill it). */
  const [pillW, setPillW] = useState(0);

  // The session just connected: raise the keyboard, typing is what comes next.
  useEffect(() => {
    if (props.active) input.current?.focus();
  }, [props.active]);

  // The switcher closed back onto the terminal: same move (0 = never signalled, skip mount).
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
   * key. Held-delete lands in `onKeyPress` on the TextInput below.
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
    typed.current = next;
    for (const key of bytes) emitKey(key); // string iteration = one code point per key
    if (next.length > 500) {
      // The field only ever grows (nothing reads it back); trim before iOS starts caring. The
      // ref is cleared first so a change event fired by clear() diffs against '' to nothing.
      typed.current = '';
      input.current?.clear();
    }
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

  // The bar swipe (§4.4): ↓ hides the keyboard, ↑ shows it — or hands over to T10's switcher
  // drag when it is already up. Horizontal is T11's window switch; the hook fires on release.
  // Keys never fire during a swipe: the pan activating cancels the childrens' touches.
  /** The swipe became T10's switcher drag: every further move is forwarded as zoom progress. */
  const zooming = useRef(false);
  const pan = Gesture.Pan()
    .runOnJS(true)
    .maxPointers(1)
    .onBegin(() => {
      swipe.current = null;
      zooming.current = false;
    })
    .onUpdate((e) => {
      if (zooming.current) {
        props.onSwitcherDrag?.('move', e.translationX, e.translationY);
        return;
      }
      if (swipe.current === 'horizontal') {
        props.onBarSwipe?.('move', e.translationX);
        return;
      }
      if (swipe.current !== null) return;
      const s = classifyBarSwipe(e.translationX, e.translationY);
      if (s === null) return;
      swipe.current = s;
      if (s === 'horizontal') props.onBarSwipe?.('start', e.translationX);
      else if (s === 'down') Keyboard.dismiss();
      else if (s === 'up') {
        if (input.current?.isFocused()) {
          // Keyboard already up: this swipe is the drag into the switcher (§4.4) — where there
          // is a switcher to drag into. Without tmux the gesture is silence, like the button.
          if (props.showTabs && props.onSwitcherDrag) {
            zooming.current = true;
            Keyboard.dismiss(); // the prototype drops the keyboard the moment the grab starts
            props.onSwitcherDrag('move', e.translationX, e.translationY);
          }
        } else input.current?.focus();
      }
    })
    .onEnd((e) => {
      if (zooming.current) {
        zooming.current = false;
        props.onSwitcherDrag?.('end', e.translationX, e.translationY);
        return;
      }
      if (swipe.current === 'horizontal') props.onBarSwipe?.('end', e.translationX);
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
      {/* T11's context ribbon, above the chord strip — its height feeds the same `onHeight`
          measurement the popovers anchor on, for free. */}
      {props.ribbon}

      {ctrl !== 'off' && (
        <Animated.View
          entering={FadeInDown.duration(180)}
          exiting={FadeOutDown.duration(140)}
          style={styles.chordWrap}>
          <Glass theme={theme} radius={22} style={styles.chordPill}>
            {CHORD_STRIP.map(({ letter, caption }, i) => (
              <Key
                key={letter}
                onPress={() => sendChord(letter)}
                style={[styles.cap, i === 0 && { backgroundColor: KEY_TINT }]}>
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

          <Glass theme={theme} radius={BAR_RADIUS} style={styles.pill}>
            <View
              style={[styles.keysRow, props.pills != null && { opacity: 0 }]}
              pointerEvents={props.pills != null ? 'none' : 'auto'}
              onLayout={(e) => setPillW(e.nativeEvent.layout.width)}>
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
            {/* §4.4: during a bar swipe the tab-name pills replace the keys. */}
            {props.pills != null && pillW > 0 && (
              <Animated.View
                entering={FadeIn.duration(150)}
                exiting={FadeOut.duration(150)}
                pointerEvents="none"
                style={styles.namesWrap}>
                <NameStrip theme={theme} pills={props.pills} width={pillW} />
              </Animated.View>
            )}
          </Glass>

          {props.showTabs && (
            <Key onPress={props.onTabsTap /* TODO(T10): opens the switcher */} style={styles.circleSlot}>
              <Glass theme={theme} radius={BAR_RADIUS} style={styles.circle}>
                <SymbolView
                  name="square.on.square"
                  size={19}
                  tintColor={theme.foreground}
                  fallback={<Text style={keyLabel}>▣</Text>}
                />
                <Text style={[styles.badge, { color: theme.foreground }]}>
                  {props.windowIndex ?? 1}
                </Text>
              </Glass>
            </Key>
          )}
        </View>
      </GestureDetector>

      {/* The keyboard's owner. Invisible but real: iOS focuses it, every keystroke lands in
          `onChangeText`, and the diff against what it held last is what goes to the PTY. */}
      <TextInput
        ref={input}
        style={styles.input}
        onChangeText={onChangeText}
        onSubmitEditing={() => emitKey('\r')}
        // §4.2 held-delete: iOS's own keyboard auto-repeats `deleteBackward`, and each repeat
        // reaches this input — as an `onChangeText` while the field still has content (the diff
        // emits the DEL), and as this key event once it is empty, when there is no text change to
        // fire on. So repeat needs no timer of ours; this handler is only the empty-field half.
        // Non-empty backspace never lands here twice: `typed` is still non-empty at key-press
        // time, so the diff path keeps sole custody of it.
        onKeyPress={({ nativeEvent }) => {
          if (nativeEvent.key === 'Backspace' && typed.current === '') emitKey(DEL);
        }}
        submitBehavior="submit" // Return sends without blurring
        onBlur={() => {
          typed.current = '';
          input.current?.clear();
        }}
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
  const { names, pos, x, pitch } = pills;
  const stripStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -pillCont(pos, x.value, pitch) * width }],
  }));
  return (
    <Animated.View
      style={[
        styles.nameStrip,
        { gap: PILL_GAP * width, paddingLeft: ((1 - PILL_ITEM) * width) / 2 },
        stripStyle,
      ]}>
      {names.map((name, i) => (
        <NamePill key={i} theme={theme} name={name} i={i} pills={pills} width={width} />
      ))}
    </Animated.View>
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
    return { transform: [{ scale: pillScale(d) }], opacity: pillOpacity(d) };
  });
  return (
    <Animated.View style={[styles.namePill, { width: PILL_ITEM * width }, style]}>
      <Text style={[styles.namePillArrow, { color: theme.placeholder }]}>‹</Text>
      <Text numberOfLines={1} style={[styles.namePillText, { color: theme.foreground }]}>
        {name}
      </Text>
      <Text style={[styles.namePillArrow, { color: theme.placeholder }]}>›</Text>
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
  badge: {
    position: 'absolute',
    fontSize: 10,
    fontWeight: '600',
    transform: [{ translateX: 3 }, { translateY: 3 }],
  },
  pill: { flex: 1, height: 49 },
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
  namesWrap: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden' },
  nameStrip: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  namePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  namePillText: { fontFamily: MONO, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  namePillArrow: { fontSize: 14 },
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
  input: { position: 'absolute', width: 1, height: 1, opacity: 0 },
});
