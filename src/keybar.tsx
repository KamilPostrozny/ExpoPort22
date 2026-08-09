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
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';

import {
  pinPasteboard,
  refreshPasteboard,
  togglePin,
  topSlotText,
  useClipboard,
  type Slot,
} from '@/clipboard';
import { provenance } from '@/clipboard-model';
import {
  CHORD_STRIP,
  afterChord,
  applyCtrl,
  classifyBarSwipe,
  controlByte,
  ctrlTap,
  diffInput,
  navKey,
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
  /** TODO(T11): bar swipe ↔ switches tmux window; +1 = next (leftward swipe), −1 = previous. */
  onBarSwipeHorizontal?: (direction: 1 | -1) => void;
};

/* --- §3's glass recipe --- */

const GLASS_BORDER = 'rgba(255,255,255,0.12)';
/** The prototype's neutral key tint (overlay-grey at low alpha, same literal on all flavours). */
const KEY_TINT = 'rgba(127,132,156,0.16)';
const HAIRLINE = 'rgba(127,132,156,0.25)';

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** One glass surface: blur, tint, border — §3's recipe. `blur(14px) saturate(160%)` maps onto
 *  BlurView's 0–100 intensity scale (≈40); the inset specular highlight has no RN equivalent, so
 *  the border carries the edge alone. */
function Glass({
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

  // The session just connected: raise the keyboard, typing is what comes next.
  useEffect(() => {
    if (props.active) input.current?.focus();
  }, [props.active]);

  // The switcher closed back onto the terminal: same move (0 = never signalled, skip mount).
  useEffect(() => {
    if (props.focusSignal) input.current?.focus();
  }, [props.focusSignal]);

  /**
   * The per-key seam: every typed key passes through here one at a time — chords apply, then the
   * bytes go out. T12's dictation leading-space filter and held-delete repeat are built HERE and
   * nowhere else; nothing upstream of this function knows about keys.
   */
  const emitKey = (key: string) => {
    const applied = applyCtrl(ctrl, key);
    if (applied.mode !== ctrl) setCtrl(applied.mode);
    props.sendBytes(applied.out);
  };

  const onChangeText = (next: string) => {
    const bytes = diffInput(typed.current, next);
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
    props.sendBytes(controlByte(letter)!);
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
    if (text) props.sendBytes(text); // typed, never executed — no trailing newline of ours
  };

  const toggle = (which: Exclude<BarPopover, 'none'>) => {
    const next = open === which ? 'none' : which;
    // §4.4: opening the ⋯ menu closes other popovers (single-valued state does that) and puts
    // the keyboard away.
    if (next === 'menu') Keyboard.dismiss();
    onOpenChange(next);
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
      if (swipe.current !== null) return;
      const s = classifyBarSwipe(e.translationX, e.translationY);
      if (s === null) return;
      swipe.current = s;
      if (s === 'down') Keyboard.dismiss();
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
      // TODO(T11): the real thresholds (70px, or 30px flicked) and the page-slide live there.
      if (swipe.current === 'horizontal' && Math.abs(e.translationX) > 30) {
        props.onBarSwipeHorizontal?.(e.translationX < 0 ? 1 : -1);
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
      {/* TODO(T11): the context ribbon renders here, above the chord strip — its height then
          feeds the same `onHeight` measurement the popovers anchor on, for free. */}

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
              radius={24.5}
              style={[styles.circle, props.sending && { backgroundColor: rgba(theme.accent, 0.85) }]}>
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

          <Glass theme={theme} radius={24.5} style={styles.pill}>
            <View style={styles.keysRow}>
              <View style={styles.keysGroup}>
                <Key onPress={onCtrlTap} style={[styles.key, ctrlStyle]}>
                  <Text style={keyLabel}>Ctrl</Text>
                </Key>
                <Key onPress={() => props.sendBytes('\x1b')} style={styles.key}>
                  <Text style={keyLabel}>Esc</Text>
                </Key>
                <Key onPress={() => props.sendBytes('\x09')} style={styles.key}>
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

          {props.showTabs && (
            <Key onPress={props.onTabsTap /* TODO(T10): opens the switcher */} style={styles.circleSlot}>
              <Glass theme={theme} radius={24.5} style={styles.circle}>
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
  sendBytes,
  onClose,
}: {
  theme: Theme;
  /** The measured `popBase`, as on ArrowsPopover. */
  bottom: number;
  sendBytes: (bytes: string) => void;
  onClose: () => void;
}) {
  const { slots, pasteboard } = useClipboard();

  useEffect(() => {
    void refreshPasteboard();
  }, []);

  const type = (text: string) => {
    sendBytes(text); // typed, never executed — multiline yanks included, no newline of ours
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
    paddingHorizontal: 24,
    paddingTop: 5,
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
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillDivider: { width: 1, height: 27 },
  arrowsButton: {
    width: 35,
    height: 35,
    borderRadius: 18,
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
  arrowsPop: { position: 'absolute', right: 24 },
  arrowsGlass: { flexDirection: 'row', gap: 7, padding: 6 },
  dpad: { gap: 4 },
  dpadRow: { flexDirection: 'row', gap: 4 },
  dpadHole: { width: 44, height: 34 },
  dpadKey: { width: 44, height: 34, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  arrowGlyph: { fontFamily: MONO, fontSize: 15 },
  popDivider: { width: 1, opacity: 0.5, marginVertical: 3 },
  homeEnd: { gap: 4 },
  homeEndKey: { width: 56, height: 34, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  menuPop: { position: 'absolute', left: 24, width: 256 },
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
