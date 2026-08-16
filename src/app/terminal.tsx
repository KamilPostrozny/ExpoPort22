import * as Clipboard from 'expo-clipboard';
import { BlurView } from 'expo-blur';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  BackHandler,
  Dimensions,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollView,
  type ViewStyle,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  runOnJS,
  useAnimatedStyle,
  type AnimatedStyle,
  type SharedValue,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  PAGE_GAP,
  ROW_REACH,
  pageRadius,
  pagePitch,
  slideMs,
  rubber,
  swipeTarget,
  zoomCommits,
} from '@/barswipe-model';
import { pushYank } from '@/clipboard';
import { useTheme } from '@/hooks/use-theme';
import KeyBar, {
  ArrowsPopover,
  BAR_PAD_TOP,
  BarMenu,
  ClipboardPopover,
  TabsHintPopover,
  type BarPopover,
} from '@/keybar';
import { RibbonAccessory } from '@/ribbon';
import {
  RIBBON_IDLE,
  RIBBON_MIN_RUN_MS,
  killCommand,
  ribbonPoll,
  ribbonResumed,
  ribbonSent,
  ribbonSwitchedToIdle,
  selectRecipe,
} from '@/ribbon-model';
import { type Cap } from '@/ribbon-recipes';
import type { ModeSignal } from '@/scroll-model';
import {
  answerHostKey,
  attachTerminal,
  disconnect,
  forgetPinnedHostKey,
  reconnect,
  send,
  setSize,
  useSession,
  type Session,
} from '@/session';
import { endpoint, getSettings, updateSettings, useSettings, usesTmux } from '@/settings';
import { SEARCH_HIGHLIGHT_MS, normalizeQuery, windowSurvives } from '@/search-model';
import Switcher, {
  Snapshot,
  useScrollbackSearch,
  useSwitcherCards,
  type Card,
  type Snap,
} from '@/switcher';
import {
  SEARCH_BAR_H,
  gridTop,
  revealOffset,
  HOLD_REACH,
  aimFrame,
  heldFrame,
  slotFrame,
  snapshotType,
  termPad,
  zoomBox,
  zoomFrame,
  type Frame,
} from '@/switcher-model';
import SettingsSheet from '@/settings-sheet';
import TerminalView, { type TerminalHandle } from '@/terminal';
import { exec, killWindow, moveWindow, newWindow, selectWindow, useTmux } from '@/tmux';
import {
  IDLE_SHELLS,
  tabsAvailable,
  tabsHint,
  type TmuxWindow,
} from '@/tmux-model';
import { MONO, type Theme } from '@/theme';
import { pick, quickAttach, sendFile, useUploadBusy, type UploadKind } from '@/upload';
import { joinPath, sanitizeFilename, stampName } from '@/upload-model';
import UploadSheet from '@/upload-sheet';

/**
 * The session on screen: the terminal, and — over it, whenever there is no shell behind it — the
 * three states §4.9 asks for. The terminal itself stays mounted through all of them, so a reconnect
 * comes back to the same scrollback in a webview that is already booted.
 *
 * Below the terminal sits T7's key bar, and inside the bar the native `TextInput` that owns the
 * keyboard (T4's decision — the webview never takes focus). `keyboardPad` is what docks the bar
 * above the keyboard and shrinks the terminal with it, which is also what triggers §4.2's
 * debounced resize.
 */
export default function SessionScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const settings = useSettings();
  const { fontSize, host, lastUploadDir } = settings;
  const session = useSession();
  const tmux = useTmux();
  const sending = useUploadBusy();
  const terminal = useRef<TerminalHandle>(null);
  const detach = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState<BarPopover>('none');
  /** T6's emulator-internal signal, whole: DECCKM for the arrows, altScreen for the ribbon,
   *  bracketed paste for the Paste key. */
  const [modes, setModes] = useState<ModeSignal>({
    altScreen: false,
    mouseReporting: false,
    decckm: false,
    bracketedPaste: false,
  });
  /** The bar stack's measured height — the `popBase` the popovers anchor on. */
  const [barHeight, setBarHeight] = useState(60);
  /** A picked file waiting on a destination (§4.6): the sheet is up exactly while this is set. */
  const [pendingUpload, setPendingUpload] = useState<{ base64: string; suggestedName: string } | null>(
    null,
  );
  /**
   * The keyboard's overlap, as bottom padding for the stage — what `KeyboardAvoidingView` used to
   * do here, minus its timing. KAV animates the padding on the keyboard's own curve, so the two
   * move together and the keyboard is over the bar for the first frames of the slide. Here the
   * shrink is a plain state write on `keyboardWillChangeFrame`, which iOS fires *before* the
   * animation starts: the terminal is out of the way by the time the keyboard leaves the bottom
   * edge. Both edges hang off that one event. `keyboardWillHide` says the same thing and is the
   * obvious listener for the way back down, but it arrives ~27ms later, which is a quarter of the
   * budget between the keyboard starting to move and the webview repainting (measured on device:
   * event to ResizeObserver is ~25-35ms, plus a frame to paint).
   */
  const [keyboardPad, setKeyboardPad] = useState(0);
  /**
   * Were the keys up when the last overlay took the terminal? The way back puts them back the way
   * they were rather than raising them unconditionally — the reference app's `keyboardHidden` is
   * the bar's own state and the tabs view never writes it, so closing the grid comes back to
   * whatever the keys were doing before it opened (user, 2026-08-10). Written only by the doors
   * the *terminal* leaves through; an overlay opening on top of another one leaves it alone.
   *
   * ponytail: the keyboard's frame stands in for focus, which is what the bar actually owns. They
   * part company only with a hardware keyboard attached (focused, no frame) — plumb a focus
   * callback out of KeyBar if that ever matters.
   */
  const keysWereUp = useRef(false);
  /** The emulator's measured cell and the rows it settled on (see TerminalProps.onResize). The
   *  cell is what every snapshot's type comes from, so a card draws the pane at the size the
   *  flying surface hands over at; the rows are what the vertical inset is worked out from. */
  const [cell, setCell] = useState({ w: 0, h: 0 });
  /** The live pane's column count, as the webview last measured it. tmux's `window-size latest`
   *  leaves a window at the size of the last client that DISPLAYED it, so a tab not yet opened
   *  from this phone is still 80-odd columns wide and its capture with it — and a card drawn to
   *  fit 80 columns into 173pt is the "zoomed out" one (user, 2026-08-11, screenshot). Every card
   *  is a preview of a pane this client is about to size to itself, so this is the width to draw
   *  them all at; anything longer clips, exactly as it will when tmux reflows it. */
  const [liveCols, setLiveCols] = useState(0);
  /** The inset the terminal took above its first row — the row remainder, which it works out
   *  itself (see TerminalProps.onResize). The cards need it to aim the zoom's crossfade. */
  const [padTop, setPadTop] = useState(0);
  /** A keyboard we asked for and have not seen yet — the terminal's size stays held until it
   *  lands, so the host hears the geometry once. Self-clearing: a focus that never raises one
   *  (hardware keyboard, a refusal) must not hold the size for the rest of the session. */
  const [kbSettle, setKbSettle] = useState(false);
  useEffect(() => {
    if (!kbSettle) return;
    const timer = setTimeout(() => setKbSettle(false), 500);
    return () => clearTimeout(timer);
  }, [kbSettle]);
  /** The listener's math, off the keyboard's current frame instead of an event — for the doors
   *  that unfreeze the pad with no keyboard move left to re-report it. */
  const syncPad = () => {
    if (Platform.OS !== 'ios') return;
    const frame = Keyboard.metrics();
    const overlap = frame ? Dimensions.get('window').height - frame.screenY : 0;
    setKeyboardPad(overlap > 0 ? Math.max(0, overlap - insets.bottom) : 0);
  };
  useEffect(() => {
    // Android has no Will* events, and its window already resizes for Gboard (§4.10's docking):
    // padding here would subtract the keyboard twice.
    if (Platform.OS !== 'ios') return;
    const subs = [
      Keyboard.addListener('keyboardWillChangeFrame', (e) => {
        // The stage's bottom is the window's bottom less the safe-area strip SafeAreaView already
        // pads; only what the keyboard covers beyond that is padding of ours.
        // A `screenY` of 0 is not a keyboard covering the whole window, it is a frame reported
        // with no position — the sheets' Modals raise one on the way in and out. Taking it at face
        // value padded the entire stage away for a frame or two (seen on device).
        if (e.endCoordinates.screenY <= 0) return;
        // The zoom owns the stage's box while it runs. The tabs-tap dismisses the keyboard in
        // the same tick the flight starts, and this event lands (often more than once) before
        // `holdSize` has marshaled into the webview — each pad change resized the webview and
        // the observer refit xterm mid-flight, which is the hitching (device, 2026-08-11).
        // Frozen here, the box never moves; `finishClose` reconciles the pad on the way out.
        if (swRef.current !== 'closed') return;
        const overlap = Dimensions.get('window').height - e.endCoordinates.screenY;
        // Both edges off this one event: a keyboard parked at or below the window's bottom edge
        // overlaps nothing, which is the hide. `keyboardWillHide` says the same thing later.
        setKeyboardPad(overlap > 0 ? Math.max(0, overlap - insets.bottom) : 0);
        setKbSettle(false); // the keyboard we were waiting for: this is the final geometry
      }),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, [insets.bottom]);

  // Which screen is in front decides what a screenshot taken from the laptop contains, and the
  // person tapping is holding the same phone.
  useEffect(() => {
    console.log('[terminal] screen open');
    return () => console.log('[terminal] screen closed');
  }, []);

  // The terminal attaches itself on every boot (see `onBoot`), so all this has to do is let go when
  // the screen goes away.
  useEffect(
    () => () => {
      detach.current?.();
      clearTimeout(warmTimer.current ?? undefined);
    },
    [],
  );

  // The TOFU prompt (§4.1). Keyed on the fingerprint rather than the session object so it is raised
  // once per unknown key, not once per re-render that happens to be in `connecting`.
  const fingerprint = session.status === 'connecting' ? (session.hostKey?.fingerprint ?? null) : null;
  useEffect(() => {
    if (fingerprint === null) return;
    Alert.alert(
      'Unknown host',
      `${endpoint(getSettings())} has not been seen before.\n\ned25519 ${fingerprint}\n\n` +
        'Check it against `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the machine itself. ' +
        'Trusting it pins it: a different key later is refused, not asked about.',
      [
        { text: 'Cancel', style: 'cancel', onPress: () => answerHostKey(false) },
        { text: 'Trust', onPress: () => answerHostKey(true) },
      ],
      { cancelable: false },
    );
  }, [fingerprint]);

  const leave = async () => {
    await disconnect();
    router.back();
  };

  // §4.6's destination flow: picker → destination browser sheet → silent SFTP save. The sheet
  // does the browsing; the save (and the one failure alert) happens here, the same `sendFile`
  // quick-attach uses — so the ⋯ circle's busy tint covers both flows from one flag.
  const startUpload = async (kind: UploadKind) => {
    setOpen('none');
    const picked = await pick(kind);
    if (picked === null) return; // cancelled — not a failure, nothing to say
    const suggestedName =
      kind === 'camera'
        ? stampName(new Date(), picked.name ?? 'photo.jpg') // §4.6: camera defaults to timestamp
        : sanitizeFilename(picked.name ?? '');
    setPendingUpload({ base64: picked.base64, suggestedName });
  };

  const saveUpload = async (dir: string, filename: string) => {
    if (pendingUpload === null) return;
    const { base64 } = pendingUpload;
    setPendingUpload(null);
    updateSettings({ lastUploadDir: dir }); // §4.6: the sheet remembers where it was
    // Saves silently: on success nothing is typed and nothing is shown (§4.6). `sendFile` owns
    // the failure alert.
    await sendFile(base64, joinPath(dir, filename));
  };

  // T12: the Settings sheet (§4.8). Both doors — the ⋯ menu row and the two-finger tap on the
  // grid — land here; the sheet slides over the live terminal, and the prototype puts the
  // keyboard away for it and gives back what it took on close.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => {
    console.log('[settings] sheet open');
    setOpen('none');
    // The grid's door is the grid's business: opening from up there must not record its
    // (always down) keys as the terminal's, or closing the grid afterwards would leave a
    // keyboard behind that was up when the person went in.
    if (swRef.current === 'closed') keysWereUp.current = keyboardPad > 0;
    Keyboard.dismiss();
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    console.log('[settings] sheet closed');
    setSettingsOpen(false);
    // Only onto the terminal, and only if that is where the keys were: closing back onto the
    // grid would raise the keyboard over it.
    if (swRef.current === 'closed' && keysWereUp.current) setFocusSignal((n) => n + 1);
  };

  /* --- T10: the tab switcher (§4.5) ---
   *
   * An in-screen overlay, not an Expo Router route, on purpose: the zoom transition scales the
   * LIVE terminal surface into a specific card slot and back, which needs the terminal and the
   * grid in one coordinate space with one shared progress value. A modal route would cover (or
   * unmount) the very view that has to keep rendering mid-transition. The grid sits behind the
   * stage; the stage wrapper below animates over it, driven by tested math in switcher-model.
   */
  type SwPhase = 'closed' | 'drag' | 'opening' | 'open' | 'closing' | 'birth';
  const [sw, setSw] = useState<SwPhase>('closed');
  /** The phase read from a handler that runs after the render it was written in (same reason as
   *  `searchRef`) — the settings doors both need to know which screen is in front. */
  const swRef = useRef(sw);
  swRef.current = sw;
  // The shell's bytes used to be HELD while the surface was in the air and flushed at the landing.
  // Both halves of that turned out to be wrong. It bought nothing: the frame probe finds the same
  // dropped frames mid-flight with the hold in place, so writes were never what dropped them — and
  // the flight already waits for the redraw burst, so all it ever held was the drip. And it cost
  // something real: up to 400ms of a LIVE pane parked and then painted in one go the instant the
  // motion stopped, which is the picture changing and the lines stepping up a beat after the tab
  // lands (user, 2026-08-11, and the trace agrees — no refit within a second of any landing, just
  // a flush).
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const scrollY = useRef(0);
  const gridRef = useRef<ScrollView>(null);
  const prog = useSharedValue(0); // 0 = terminal at rest, 1 = terminal inside its card slot
  const dragX = useSharedValue(0); // finger drift during the bar-swipe-up follow
  const alpha = useSharedValue(1); // the stage fades out at the end of the zoom-out, back in first on return
  const slotSV = useSharedValue<Frame>({ x: 0, y: 0, w: 1, h: 1 });
  /** 0 = the card is in the hand, aimed at the centred hold pose; 1 = aimed at its slot in the
   *  grid. Only the bar drag ever takes it off 1, and only its release puts it back — every other
   *  route into the switcher flies terminal↔slot as it always did (`aimFrame`). */
  const flight = useSharedValue(1);
  /** Whose slot `slotSV` is aimed at — the grid leaves that one card undrawn while the surface is
   *  in the air (see `zoomId` in switcher.tsx). Set wherever the aim is: the two are one decision. */
  const [zoomId, setZoomId] = useState<string | null>(null);
  const stageSV = useSharedValue({ w: 390, h: 800 });

  const connected = session.status === 'connected';
  const showTabs = tabsAvailable(tmux.present, tmux.attached);
  // T11's page-slide state lives up here with the switcher's: the snapshot cache has to know
  // when a slide is running, and it is the same "nothing may change while something is moving"
  // rule the zoom needs. Everything else about the slide is in its own block below.
  const [pageSwipe, setPageSwipe] = useState<PageSwipe | null>(null);
  /** Mid-zoom, mid-slide: the moving views must not have their content swapped underneath them. */
  const frozen = (sw !== 'closed' && sw !== 'open') || pageSwipe !== null;
  const { cards, setCards, refresh, refreshCard } = useSwitcherCards(
    showTabs && connected,
    sw !== 'closed',
    frozen,
  );

  /* The terminal is a DOM component: every render re-serializes its props across the webview
   * bridge, and the screen re-renders on every phase of every gesture. The element is
   * memoized on the three props that actually change it, and the handlers reach the latest
   * closure through a ref so their identities can stay stable (perf, 2026-08-13). */
  const termH = useRef<Record<string, (...args: any[]) => any>>({});
  termH.current = {
    onData: async (data) => send(data),
    onResize: async (cols, rows, cellW, cellH, topInset) => {
          // What MOVED, not what was measured: the pane shifting up a touch a beat after the
          // landing is either this report changing the top inset (or the row count, which re-rolls
          // the remainder) or the flushed bytes scrolling a line. The two are a row apart and look
          // alike; only the trace tells them apart (user, 2026-08-11).
          const was = lastFit.current;
          if (was === null || was.cols !== cols || was.rows !== rows || was.top !== topInset)
            probe(
              `FIT ${was ? `${was.cols}×${was.rows} padTop ${was.top.toFixed(1)}` : 'first'} → ` +
                `${cols}×${rows} padTop ${topInset.toFixed(1)}`,
            );
          // The box this side computed, checked against the box the webview actually got. The two
          // are worked out on opposite sides of a bridge that rounds — fractional points here,
          // integer `clientHeight` there — so `rowRemainder` leaves a point of slack and this inset
          // is what is left of it. More than that means the sides disagree, and the disagreement is
          // paid in whole rows: 17pt of an 18pt cell was a lost row and the pane sitting one row
          // low, on every keyboard close, for a day (2026-08-12). Any chrome change can re-open it,
          // and the webview is the only witness — so it says so rather than being read off a probe
          // that has to be there at the time. The first report is the boot fit, whose cell is not
          // measured yet.
          if (__DEV__ && was !== null && topInset >= 2 && cellH > 0)
            console.warn(
              `[terminal] box off by ${topInset.toFixed(1)}pt of a ${cellH.toFixed(1)}pt cell — ` +
                'the stage and the webview disagree; see `rowRemainder`',
            );
          lastFit.current = { cols, rows, top: topInset };
          if ((sw !== 'closed' && sw !== 'open') || kbSettle) {
            // Gated: this branch's condition is "a zoom is in flight", so it only ever logged
            // DURING a gesture — a Metro socket write on the JS thread per refit, animating.
            if (GESTURE_LOG) console.log('[terminal] size held, not sent:', cols, '×', rows);
            return;
          }
          if (cellW > 0 && cellH > 0) setCell({ w: cellW, h: cellH });
          if (cols > 0) setLiveCols(cols);
          setPadTop(topInset);
          setSize(cols, rows);
        },
    onBoot: async () => {
          detach.current?.();
          detach.current = attachTerminal((chunks) => {
            dataSeq.current += chunks.length; // "has the host redrawn yet" — see `afterHostRedraw`
            // `probe` bails on GESTURE_LOG, but the argument is built before the call: one
            // template literal per batch off the PTY, and a tmux redraw after a switch is hundreds
            // of chunks — allocating on the JS thread inside the flight that switch is animating.
            if (GESTURE_LOG) probe(`byte ${chunks.reduce((n, c) => n + c.length, 0)}b`);
            terminal.current?.write(chunks);
          });
        },
    onBell: () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
    onClipboard: async (text) => {
          await Clipboard.setStringAsync(text);
          pushYank(text);
        },
    onLink: async (url) => {
          await WebBrowser.openBrowserAsync(url);
        },
    onModes: async (next) => {
          console.log('[session] modes', JSON.stringify(next));
          setModes(next);
        },
    onTwoFingerTap: async () => openSettings(),
    onTap: async () => {
          if (keyboardPad > 0) Keyboard.dismiss();
          else setFocusSignal((n) => n + 1);
        },
    onSearchResults: async (i, n) => setOcc({ i, n }),
  };
  const tv_onData = useCallback(async (...a: any[]) => termH.current.onData?.(...a), []);
  const tv_onResize = useCallback(async (...a: any[]) => termH.current.onResize?.(...a), []);
  const tv_onBoot = useCallback(async (...a: any[]) => termH.current.onBoot?.(...a), []);
  const tv_onBell = useCallback(async (...a: any[]) => termH.current.onBell?.(...a), []);
  const tv_onClipboard = useCallback(async (...a: any[]) => termH.current.onClipboard?.(...a), []);
  const tv_onLink = useCallback(async (...a: any[]) => termH.current.onLink?.(...a), []);
  const tv_onModes = useCallback(async (...a: any[]) => termH.current.onModes?.(...a), []);
  const tv_onTwoFingerTap = useCallback(async (...a: any[]) => termH.current.onTwoFingerTap?.(...a), []);
  const tv_onTap = useCallback(async (...a: any[]) => termH.current.onTap?.(...a), []);
  const tv_onSearchResults = useCallback(async (...a: any[]) => termH.current.onSearchResults?.(...a), []);
  const termHold = (sw !== 'closed' && sw !== 'open') || kbSettle;
  const terminalView = useMemo(
    () => (
      <TerminalView
        ref={terminal}
        theme={theme}
        fontSize={fontSize}
        holdSize={termHold}
        onData={tv_onData}
        onResize={tv_onResize}
        onBoot={tv_onBoot}
        onBell={tv_onBell}
        onClipboard={tv_onClipboard}
        onLink={tv_onLink}
        onModes={tv_onModes}
        onTwoFingerTap={tv_onTwoFingerTap}
        onTap={tv_onTap}
        onSearchResults={tv_onSearchResults}
        dom={{ scrollEnabled: false, style: styles.terminal }}
      />
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the handlers are identity-stable
    [theme, fontSize, termHold],
  );

  /** The cards as of this render, for the deferred neighbour refresh — a `setTimeout` closure
   *  would otherwise hold the list from before the hop. */
  const cardsRef = useRef(cards);
  cardsRef.current = cards;

  /* --- T14: one search, shared by the grid and the terminal view --- *
   *
   * `q`/`on` are the whole armed-or-disarmed state: the switcher's field and the terminal's bar
   * edit the same string, and disarming from either side clears both. The scrollback half runs
   * host-side greps only while the grid is up; the terminal view searches its own xterm buffer
   * through the search addon instead — the emulator already holds those 10k lines. */
  const [search, setSearch] = useState({ q: '', on: false });
  const searchRef = useRef(search);
  searchRef.current = search;
  /** The addon's live "i/N" for the terminal bar; `null` until it first speaks. */
  const [occ, setOcc] = useState<{ i: number; n: number } | null>(null);
  const hits = useScrollbackSearch(search.on ? search.q : '', cards, sw !== 'closed' && search.on);
  const nq = search.on ? normalizeQuery(search.q) : '';
  const visibleCards =
    nq === '' ? cards : cards.filter((c) => windowSurvives(c.win, nq, hits[c.win.id]));
  /**
   * The list the GRID draws, frozen for the length of a hop.
   *
   * `memo(SwitcherInner)` is what makes the permanently-mounted grid free, and the commit's
   * optimistic `active` flip is the one thing that reliably breaks it: it rebuilds every card
   * object, so `visibleCards` changes identity on the exact frame `slideTo` starts, and the whole
   * grid — one WindowCard per window, each re-running `snapshotType` and a path split — re-renders
   * into the first frame of the animation. The flip is for the NEXT grid open; nothing is looking
   * at the grid during a page slide (it sits at opacity 0 until prog passes 0.75).
   *
   * This is the same rule `frozen` already states — nothing may change while something is moving —
   * applied to the one path that bypasses it. Gated on `pageSwipe` rather than `frozen` on purpose:
   * the zoom phases, a grid open and `birth` all have `pageSwipe === null`, so a newly born card
   * still appears at once. Written during render like `cardsRef`/`searchRef` above, and
   * `setPageSwipe(null)` in `clearBarSwipe` is itself a render, so the grid catches up at the
   * landing with no effect of its own.
   */
  const gridCards = useRef(visibleCards);
  if (pageSwipe === null) gridCards.current = visibleCards;

  const disarmSearch = () => {
    console.log('[search] disarmed');
    setSearch({ q: '', on: false });
    setOcc(null);
  };

  // The armed query drives the addon's decorations (and lands on the next occurrence). It runs
  // whichever view is in front, so a card tap arrives on an already-highlighted terminal.
  // Every handle call is `?.()` on the METHOD, not just the ref: expo/dom's native proxy answers
  // `undefined` for every imperative prop until the webview boots and posts its registration —
  // a plain call in that window is a TypeError that unmounts the screen (found on device).
  const searchEverArmed = useRef(false);
  useEffect(() => {
    if (!connected) return;
    if (search.on && search.q.trim() !== '') {
      searchEverArmed.current = true;
      // Debounced, because this is not a cheap call: with decorations on, the addon walks the
      // whole scrollback to rebuild the highlight set, inside the same webview that is parsing
      // shell output — and undebounced it did that once per character typed.
      const t = setTimeout(() => terminal.current?.search?.(search.q.trim()), SEARCH_HIGHLIGHT_MS);
      return () => clearTimeout(t);
    } else if (searchEverArmed.current) {
      searchEverArmed.current = false;
      terminal.current?.searchOff?.();
      setOcc(null);
    }
  }, [search.on, search.q, connected]);

  /** The active window's position in `list` — tmux's fresher poll first, the list's flag second. */
  const activePosIn = (list: Card[]) => {
    const byIndex = list.findIndex((c) => c.win.index === tmux.windowIndex);
    if (byIndex >= 0) return byIndex;
    const byFlag = list.findIndex((c) => c.win.active);
    return byFlag >= 0 ? byFlag : 0;
  };
  /** Over the *visible* list: with a search armed, that is the grid the zoom aims into. The bar
   *  swipe keeps the full list — it hops real neighbours, not the filtered ones. */
  const activePos = () => activePosIn(visibleCards);
  /** The window sitting in a visible slot — the aim and the card to hide are the same window. */
  const idAt = (pos: number) => visibleCards[pos]?.win.id ?? null;

  /** Grid position → the card's frame in stage coordinates (search field and headroom above the
   *  grid, minus the grid's own scroll) — where the zoom aims. */
  const zoomSlot = (pos: number): Frame => {
    const w = stage?.w ?? 390;
    const f = slotFrame(pos, w);
    // The stage is the full window now, so the grid's content — pushed below the notch by the
    // switcher's own inset padding — sits `insets.top` lower in stage coordinates.
    return { ...f, y: insets.top + SEARCH_BAR_H + gridTop(w) + f.y - scrollY.current };
  };

  /** The switcher's bottom bar, unmeasured — its own `barH` default. A few points either way only
   *  decide how much air the revealed card keeps under it. */
  const BAR_RESERVE = 64;
  /**
   * Scroll the grid so the slot the zoom is about to aim at is actually on screen — see
   * `revealOffset` for why it usually is not. Answers whether it had to move.
   *
   * On the way IN nothing is animated and nothing waits: the grid is invisible until prog 0.75, so
   * the jump is never seen, and `scrollY` is written here rather than read back from `onScroll`,
   * because `zoomSlot` takes the aim on this frame. On the way OUT the grid is in plain sight, so
   * it scrolls properly and the aim waits for it (`REVEAL_MS`) — `onScroll` reports the offset as
   * it travels, and the flight reads it once it has arrived.
   */
  const revealSlot = (pos: number, animated = false) => {
    if (stage === null) return false;
    const y = revealOffset({
      pos,
      count: gridCards.current.length,
      at: scrollY.current,
      width: stage.w,
      height: stage.h,
      headerH: insets.top + SEARCH_BAR_H + gridTop(stage.w),
      bottomH: BAR_RESERVE + insets.bottom,
    });
    if (y === scrollY.current) return false;
    if (!animated) scrollY.current = y;
    gridRef.current?.scrollTo({ y, animated });
    return true;
  };
  /** How long the grid's own scroll takes before a Done can fly out of it. UIScrollView's animated
   *  `setContentOffset` is a fixed ~300ms whatever the distance, and leaving early aims the flight
   *  at an offset still moving. */
  const REVEAL_MS = 320;

  /** How long a zoom phase may stand before the watchdog below calls it stuck. The animations are
   *  340 and 380ms, so this is comfortably past any real one and still inside a lost second. */
  const PHASE_WATCHDOG_MS = 1500;
  const ZOOM_OUT = { duration: 340, easing: Easing.out(Easing.cubic) };
  const ZOOM_IN = { duration: 380, easing: Easing.out(Easing.cubic) };
  /** Every console.log serializes through Metro's socket ON the JS thread — the same cost that
   *  made the SSH tap the thing we were measuring. A hop emits ~10 of them between the harness,
   *  the trace and §7's own lines, which is JS-thread time inside the gesture being measured.
   *  Flip on to debug; off to measure or to use the app. */
  const GESTURE_LOG = false;

  /** The guard for a redraw that never comes at all: ~1–2s of frames, an order of magnitude
   *  past the ~50ms roundtrip the trace measured, so it never shapes how a switch feels. */
  const ZOOM_WEDGE_FRAMES = 120;

  const finishClose = () => {
    probe('landed');
    setSw('closed');
    // The keys come back exactly as they were left (`keysWereUp`) — except onto an armed search
    // hit, where you came to read, not type (T14). The size hold outlives the zoom by exactly
    // that keyboard: released at the end of the animation it measures a stage with no keyboard in
    // it, reports that, and is corrected ~250ms later — two reflows of every pane on the host,
    // landing just as the terminal comes back into view (device). Nothing is raised, nothing to
    // wait for.
    if (!searchRef.current.on && keysWereUp.current) {
      setKbSettle(true);
      setFocusSignal((n) => n + 1);
    } else {
      // The pad froze at the open (see the keyboardWillChangeFrame guard) and no keyboard event
      // is coming to re-report it — ask the OS where the keyboard actually is. Usually that is
      // "down" (pad 0), but a search-hit select can land with the grid's keyboard still up.
      syncPad();
    }
  };

  /* --- probe: the one-hitch-per-flight on a switch to another window (T10, temporary) ---
   * Everything that could stall a frame, stamped against the tap: the flight leaving, each chunk
   * off the shell, every size the webview measures, the bar's height changing, the landing. What
   * lands INSIDE the flight window is the suspect; the trace decides between the redraw's tail and
   * the ribbon's reflow instead of another guess. Rip this out once it has answered. */
  const probeT0 = useRef(0);
  /** The last size the webview reported, so the probe can print what changed, not what was seen. */
  const lastFit = useRef<{ cols: number; rows: number; top: number } | null>(null);
  const probe = (what: string) => {
    if (!GESTURE_LOG || probeT0.current === 0) return;
    const dt = Date.now() - probeT0.current;
    if (dt > 2000) {
      probeT0.current = 0;
      return;
    }
    console.log(`[probe] +${dt}ms ${what}`);
  };

  /* The frame-drop probe used to live here: a useFrameCallback that logged any frame over 12ms.
   * It went the way of the rest of the harness (07430ef), which missed it — it was never behind
   * GESTURE_LOG, so it was measuring with the instrument's own weight on the scale. On a panel
   * asking for 120Hz almost every flight frame cleared 12ms, and each one cost a runOnJS hop plus
   * a console.log serialized through Metro's socket ON the JS thread — which made the next frame
   * slower, which logged again. The callback also never stopped: registered on every render (its
   * effect keys on the callback's identity) and looping on the UI thread's rAF for the life of the
   * screen, flight or no flight. Frame timing is what Instruments is for. */

  const commitOpen = () => {
    setSw('opening');
    dragX.value = withTiming(0, { duration: 250 });
    // The release is what sends the card to its slot: until now it has been aimed at the hold pose
    // under the finger (`aimFrame`). On every other route in this is already 1 and the timing is a
    // no-op. It rides ZOOM_OUT so the aim and the progress arrive together — a shorter curve here
    // would land the card in its slot and then keep scaling into it.
    //
    // The hand-over cut (alpha 0, sw 'open') rides whichever of the two values actually has
    // distance to travel. On a DEEP pull prog is already 1 at the release, its timing finishes
    // immediately, and a cut attached there fired before the flight moved a point — the
    // fly-to-grid animation visibly skipped (user, 2026-08-13). On a tap-open it is the mirror:
    // flight is already 1 and prog travels.
    const flightTravels = flight.value < 0.999;
    flight.value = withTiming(1, ZOOM_OUT, (done) => {
      if (done && flightTravels) {
        alpha.value = 0;
        runOnJS(setSw)('open');
      }
    });
    // The prototype fades the surface out only near the end, once it covers its card — and "near
    // the end" is measured in TRAVEL, not in milliseconds. ZOOM_OUT is out-cubic, so at 180ms
    // (53% of 340) the surface is only ~90% of the way there, while the card underneath goes fully
    // solid the instant this fade starts (`fade.value >= 1` in switcher.tsx). That last 10% is a
    // ghost hanging above and outside the solid card: 15pt for a row-1 slot, 45pt and 22pt too
    // wide for row 2 — which reads as the surface flying to the wrong place and popping into it
    // (user, 2026-08-11). 270ms is where out-cubic has spent 99% of the distance.
    // …and "99% of the distance" stopped being good enough once the content PANS as well as
    // scales. A card is the pane's tail now (`cropShift`), which slides the content 205pt over the
    // flight instead of the 59 it used to — so the last 1% is ~2pt of travel, and handing over
    // there shows the card's text sitting that much higher than the surface's still is. That is
    // the jump as a tab lands in the grid (user, 2026-08-11).
    //
    // So the hand-over waits for the arrival: the surface goes at the animation's own callback, at
    // t=1 exactly, where the two pictures are the same picture — which is the whole point of the
    // geometry. A cut, not a fade, for the reason `springBack` snaps its own (see there).
    prog.value = withTiming(1, ZOOM_OUT, (done) => {
      if (done && !flightTravels) {
        alpha.value = 0;
        runOnJS(setSw)('open');
      }
    });
  };

  const springBack = () => {
    // A release with nothing to fly home from: the grab armed the zoom (it always does now — the
    // vertical is live from the first frame) but the finger never actually pulled. Flying anyway
    // round-tripped `sw` through `closing` for a frame, and the page row's render condition sat
    // out that frame — both neighbour cards unmounting and remounting mid-slide, which is the
    // flash on every plain hop (trace, 2026-08-13: `- card:next` one line after the commit,
    // `+ card:next` two lines later).
    if (prog.value < 0.005) {
      cancelAnimation(dragX);
      dragX.value = 0;
      flight.value = 1; // normally the flight's own completion resets the aim — there is none
      // …and nothing is owed the keyboard either. `keysWereUp` is the promise that an overlay
      // which TOOK the keys gives them back, but on this path no overlay ever opened: `sw` never
      // left `closed` (the arm needs prog > 0.01). What can have happened is the other vertical
      // exit — a swipe DOWN, which is the gesture whose whole purpose is to put the keys away
      // (`barDismisses`). Both axes are one pan, so the dismiss and this release are the same
      // gesture, and honouring the promise here raised the keyboard again the instant it had
      // gone: swipe down, keyboard bounces back up (user, 2026-08-13). A finger that barely moved
      // dismissed nothing, so clearing this costs that case nothing to give back.
      keysWereUp.current = false;
      // …and if the gesture never armed, leave the PAD alone too. `finishClose`'s other half is
      // `syncPad`, which exists for the doors that thaw a pad the `keyboardWillChangeFrame`
      // listener was frozen out of (it returns early unless `sw` is `closed`). Here `sw` never
      // left `closed`, so that listener has been live the whole way through and has already
      // reported the dismiss. Calling `syncPad` on top of it asks iOS where the keyboard is in
      // the middle of its hide animation, gets the frame it still has, and writes the old overlap
      // back — the keys go away and the bar stays parked where they were, mid-screen (user,
      // 2026-08-13). Nothing to reconcile: the listener owns this one.
      if (swRef.current === 'closed') return;
      finishClose();
      return;
    }
    probe('fly');
    closeArmed.current = false;
    setSw('closing'); // already `closing` when `closeTo` armed it two frames ago; a drag release sets it here
    // Solid on the first frame, not dissolved in over 120ms. The card and the surface are the
    // same geometry at t=1 — that is what all the crossfade arithmetic buys — so the swap has
    // nothing to hide, and a dissolve between two pictures that differ AT ALL is ghosting in plain
    // sight for a tenth of a second: the "one hitch during the flight" on every switch (user,
    // 2026-08-11). Where the pictures agree this is invisible; where they cannot (the card holds
    // the last poll's capture, the surface holds the pane tmux just redrew) one frame of cut beats
    // 120ms of double exposure. It also means the flight owes the host nothing but its redraw.
    alpha.value = 1;
    dragX.value = withTiming(0, { duration: 200 });
    prog.value = withTiming(0, ZOOM_IN, (done) => {
      if (done) {
        // Back to aiming at the slot. At prog 0 the aim draws nothing, so this costs no frame —
        // it is only here so the NEXT way in (a tabs tap) does not inherit a hold pose.
        flight.value = 1;
        runOnJS(finishClose)();
      }
    });
  };

  const openSwitcher = () => {
    if (sw !== 'closed' || stage === null) return;
    console.log('[switcher] open (tabs tap)');
    setOpen('none');
    keysWereUp.current = keyboardPad > 0; // read before the dismiss moves it
    Keyboard.dismiss();
    const pos = activePos();
    setZoomId(idAt(pos));
    revealSlot(pos);
    slotSV.value = zoomSlot(pos);
    // The card this zoom-out lands on may be stale (tabs switched since the grid was last up) —
    // recapture it under the surface, so the crossfade lands on the pane being looked at.
    const aimed = visibleCards[pos]?.win;
    if (aimed) void refreshCard(aimed);
    // The bar flick pays the open's one-off costs — the phase render, the holdSize marshal into
    // the webview, the keyboard starting down — frames before its commit, under the finger. The
    // tap paid them all on the flight's first frame, which is the initial hitch (device,
    // 2026-08-11). So: flip the phase now, fly two frames later. Progress sits at 0 in the gap,
    // so nothing on screen moves until the flight's first frame is clean.
    setSw('opening');
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (swRef.current === 'opening') commitOpen(); // a disconnect mid-gap resets to closed
      }),
    );
  };

  // The drag-follow (prototype `zoomFollow`): progress tracks the finger from the GRAB, with
  // nothing in between — up, back down, up again — and only the release decides, on how far it
  // got or how fast it was thrown (`zoomCommits`).
  /** Has the open's one-off cost landed (two frames, as in `openSwitcher`)? Until it has, the
   *  drag is set-up only and nothing moves. Shared values, not refs: the pan's per-frame path
   *  runs on the UI thread now (the perf harness convicted the JS thread — 41–305ms stalls under
   *  every gesture while the UI thread ran clean), and the worklet must read these. */
  const zoomReadySV = useSharedValue(0);
  const zoomFromXSV = useSharedValue(0);
  const zoomFromYSV = useSharedValue(0);
  const zoomFromSetSV = useSharedValue(0);
  const zoomBaseSV = useSharedValue(0);
  const draggingSV = useSharedValue(0);
  /** Has the worklet already asked React to arm the switcher? (see `onZoomArm`) */
  const armedSV = useSharedValue(0);
  /** The live page row, mirrored for the worklet: whether a hop is live, and the rubber band's
   *  position/count. */
  const rowLiveSV = useSharedValue(0);
  const rowPosSV = useSharedValue(0);
  const rowCountSV = useSharedValue(0);
  /** Is a zoom drag live? The gesture's own truth, and the only thing its lifecycle turns on.
   *  `sw` cannot be: `setSw('drag')` is read back by the very next pan report, and a flick that
   *  ends in the same frame gets its release judged against a phase React has not written yet —
   *  the release is dropped, the render lands on `drag`, and nothing is left to end it. That is a
   *  frozen app (user, 2026-08-11), and it is the same shape as the two before it. */
  const dragging = useRef(false);
  /**
   * Is this gesture's card held in the air? Written by the bar's worklet — 0 at every grab, 1 at
   * the settle latch — and read on the same thread by the page row's own style.
   *
   * A shared value and not React state, and that is the whole point. The latch sets `rowVis` and
   * this in ONE frame; routing the same fact through a `setState` put React a commit behind, so
   * the blank new-tab page beside a held card became visible and then vanished a frame or two
   * later (user, 2026-08-13). What reveals the row has to be what hides that page.
   *
   * It decides only DRAWING. Reach is `windows + 1` either way — see `onBarSwipe`.
   */
  const heldAirSV = useSharedValue(0);
  /** The held join's approach, 0→1 on a clamped spring the moment the hand settles. A Reanimated
   *  `entering` did this job and flickered: layout animations under a scaled, translated parent
   *  paint their first frame at the final position before jumping to the start (user,
   *  2026-08-13, "flickeringly show up"). A shared value through the same seat term the swipe
   *  join uses cannot. */
  const joinSV = useSharedValue(0);
  /** Is the page row on screen? Opacity, not mounting: the cards stay mounted for the life of the
   *  terminal view because each is a snapshot tree of Text runs, and building one costs 53-93ms of
   *  React on the JS thread — the hitch at the start of every swipe the original code was written
   *  to avoid, which mounting them per gesture brought back (perf, 2026-08-13). */
  const rowVisSV = useSharedValue(0);

  /** The grab, one JS call per gesture: the open's one-off costs. Everything per-frame — prog,
   *  dragX, the settle latch — runs in the bar's worklet against the shared values above. */
  const onZoomGrab = (dx: number, dy: number) => {
    if (stage === null) return;
    setRbOpen(false); // the band fades out with the bar; it must not be open where the flight lands
    const at = swRef.current;
    {
      if (!dragging.current && at === 'closed') {
        if (GESTURE_LOG) console.log('[switcher] open (bar drag)');
        // The grab no longer implies a raised keyboard (the swipe ↑ is one gesture whatever the
        // keys are doing), so read the pad as the tap door does. KeyBar's dismiss is one call old
        // at this point and iOS reports the frame a beat later, so this is still the pre-drag
        // truth — and it is what decides whether the keys come back on the way out.
        keysWereUp.current = keyboardPad > 0;
        const pos = activePos();
        revealSlot(pos);
        slotSV.value = zoomSlot(pos);
        // In the hand, not on its way to the grid: the card shrinks toward the centred hold pose
        // and stays somewhere it can still be pushed sideways. `commitOpen` releases it.
        flight.value = 0;
        armPos.current = pos;
        // The tap defers its flight two frames so the open's one-off costs — the phase render, the
        // holdSize marshal into the webview, the keyboard starting down — are paid before anything
        // moves (see `openSwitcher`). This gesture used to pay them on the frame its motion
        // started, which is the same hitch, under a finger instead of an animation (user,
        // 2026-08-11). It waits the same two frames; where the tap can simply delay, the drag
        // re-origins at the frame it arms, so the surface grows from zero where the finger has got
        // to rather than jumping to the travel it spent waiting.
        dragging.current = true;
        draggingSV.value = 1;
        armedSV.value = 0;
        zoomReadySV.value = 0;
        zoomFromSetSV.value = 0;
        zoomBaseSV.value = 0;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            zoomReadySV.value = 1;
          }),
        );
        return;
      } else if (!dragging.current && at === 'closing') {
        // The flight home is catchable. `closed` only arrives when the timing formally ends, and
        // an out-cubic has spent 99% of its distance at 78% of its duration — so the last ~80ms
        // look exactly like a landed terminal that refuses to swipe (user, 2026-08-11). Nothing
        // needs setting up here: the aim, the cards and the size hold are the ones this close was
        // already flying under, so the grab is free and immediate. It resumes from where the
        // surface has got to (`zoomBase`) rather than snapping to zero.
        console.log('[switcher] open (caught the close)');
        closeArmed.current = false; // caught inside the two-frame gap: no flight is owed
        dragging.current = true;
        draggingSV.value = 1;
        cancelAnimation(prog);
        cancelAnimation(dragX);
        cancelAnimation(alpha);
        alpha.value = 1;
        zoomBaseSV.value = prog.value;
        zoomFromXSV.value = dx;
        zoomFromYSV.value = dy;
        zoomFromSetSV.value = 1;
        zoomReadySV.value = 1;
        setSw('drag');
        return;
      }
    }
  };

  /** Which window the grab aimed at, for the deferred arm. */
  const armPos = useRef(0);
  /**
   * The switcher's own state, armed only once the card has ACTUALLY started to lift.
   *
   * The grab arms nothing but shared values now. Since the vertical lost its threshold, every
   * horizontal hop grabs — and doing the full open there charged each flat swipe a phase render,
   * a grid re-render and an SSH capture it never used before, which is JS-thread work inside the
   * gesture (perf, 2026-08-13). Nothing here is needed to SHOW the card moving: the box's
   * transform reads `prog`, which the worklet writes from the first pixel.
   */
  const onZoomArm = () => {
    if (swRef.current !== 'closed' || !dragging.current) return;
    setOpen('none');
    setZoomId(idAt(armPos.current));
    const aimed = visibleCards[armPos.current]?.win;
    if (aimed) void refreshCard(aimed);
    setSw('drag');
  };

  const onZoomEnd = (dx: number, dy: number, vx: number, vy: number) => {
    if (stage === null) return;
    if (dragging.current) {
      dragging.current = false;
      draggingSV.value = 0;
      // The row goes back out to the sides so the card flies to the grid alone — unless a hop is
      // landing, whose own clear cuts it (see `clearBarSwipe`).
      if (swipeInfo.current?.live !== true) {
        joinSV.value = withTiming(0, { duration: 160 });
        rowVisSV.value = withTiming(0, { duration: 160 });
      }
      // The hop is asked FIRST: with the card held in the air `prog` sits past ZOOM_COMMIT the
      // whole time, so asking the grid first meant every release went to the grid and a sideways
      // hop could never win (user, 2026-08-13). The grid takes the release only when the
      // horizontal axis decides nothing.
      const info = swipeInfo.current;
      const hopWould =
        info?.live === true &&
        swipeTarget(swipeX.value, Date.now() - info.t0, info.pos, info.slots) !== info.pos;
      if (!hopWould && zoomCommits(prog.value, vx, vy)) {
        // The grid outranks the hop: the card flying into the grid is the one that was under the
        // finger, so a page swipe still open under this release must decide nothing. It is told by
        // this flag rather than by a call, because the bar reports the two axes in order and the
        // horizontal's own 'end' is the next thing to arrive.
        // ponytail: the flight always aims at the window it started on. Committing to the grid
        // from 80% of the way to the NEXT tab could reasonably land there instead; nobody has
        // asked, and it costs a re-aim mid-release.
        gridTookIt.current = true;
        commitOpen();
      } else springBack();
    }
  };

  const closeTo = (pos: number) => {
    // The phase flip and the aim first, the motion two frames later — the same gap `openSwitcher`
    // takes for the same reason. `setZoomId` re-renders the grid and `setSw('closing')` flips the
    // size hold, the freeze and the wrapper's pointer events, and paying all of that on the frame
    // the surface starts moving is a long frame right at the start of the flight (probe: FRAME
    // 33ms at prog 0.92). Progress does not move in the gap, so nothing on screen is waiting.
    probe('aim');
    setZoomId(idAt(pos));
    slotSV.value = zoomSlot(pos);
    setSw('closing');
    // Armed on a ref, NOT on `swRef`: that one is written during render, and two frames is not a
    // promise that React has rendered. When it had not, the guard read the old phase, the motion
    // never started and `closing` stood — with the grid untouchable and the surface invisible,
    // which is an app that has frozen (user, 2026-08-11). Only a grab clears this.
    closeArmed.current = true;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (closeArmed.current) springBack();
      }),
    );
  };
  /** Is a `closeTo` waiting out its two frames? Cleared by the flight itself and by a grab. */
  const closeArmed = useRef(false);

  /**
   * Leaving the grid for the active window — Done, and Android's back press. Unlike a card tap,
   * which lands on a card the finger could reach, this one aims at whichever card is active, and a
   * grid scrolled away from it used to fly out of a slot below the fold: a frame of bare backdrop
   * where the card should have vanished from, then the terminal arriving from off the edge of the
   * screen (user, 2026-08-13). The grid goes to that card first, in sight, and the flight leaves
   * from it. A tap that lands on another card during the scroll has already flown by the time the
   * timer fires — `open` is the only phase this owns.
   */
  const doneToActive = () => {
    const pos = activePos();
    if (!revealSlot(pos, true)) return closeTo(pos);
    setTimeout(() => {
      if (swRef.current === 'open') closeTo(activePos());
    }, REVEAL_MS);
  };

  const selectCard = (pos: number, win: TmuxWindow) => {
    if (sw !== 'open') return;
    console.log('[switcher] select', win.id);
    probeT0.current = Date.now();
    probe(`tap ${win.id} (${win.index === tmux.windowIndex ? 'same' : 'switch'})`);
    ribbonForWindow(win, 'card tap'); // as with the bar swipe: under the zoom, not a beat after it
    void selectWindow(win.index); // §7: no haptic on tab select
    // The accent outline is `win.active`, which only the ~2s list beat refreshes — flipped
    // optimistically here (as a kill removes its card), or the old tab stays haloed through
    // the flight and a beat past it (user, 2026-08-11).
    setCards((prev) => prev.map((c) => ({ ...c, win: { ...c.win, active: c.win.id === win.id } })));
    // The flight leaves when the HOST has finished redrawing (`afterHostRedraw`), not after a
    // duration someone picked. Flying before any of it is the other end and no better: the
    // surface then carries the pane of the window being LEFT, for the length of a roundtrip.
    // Same tab: nothing switches, nothing to wait for.
    if (win.index === tmux.windowIndex) {
      closeTo(pos);
      return;
    }
    // No second roundtrip here. Recapturing this card so the dissolve had a matching picture did
    // fix the hitch, which is what proved the diagnosis — but it put a whole capture between the
    // finger and the motion (~250ms, against the redraw's ~50). `springBack` goes solid on its
    // first frame instead, so there is no dissolve to match and nothing to wait for; the card is
    // one frame of cut behind the live pane rather than a tenth of a second of double exposure.
    afterHostRedraw(dataSeq.current, () => {
      if (swRef.current === 'open') closeTo(pos);
    });
  };

  /**
   * The host has finished with a window switch, told rather than timed. Two facts, no tuned
   * durations — the same two the zoom's flight and the bar swipe's settle both need, which is why
   * this is one function and not two copies drifting apart:
   *
   *   - bytes on the PTY that were not there at `bytesAtStart` are tmux's redraw of the window it
   *     was just told to select; nothing else is talking;
   *   - the redraw is a BURST, so it is over when a whole display frame passes without one. The
   *     probe trace (2026-08-11) is the shape of it: 5460 bytes at +53ms, 1916 more at +54, and
   *     nothing after. Leaving on the first chunk put that second write one frame into the motion.
   *
   * `bytesAtStart` is the caller's baseline, not `dataSeq` read here: a bar swipe arms this after
   * its slide, by which time the redraw has usually already landed, and a watch that started
   * counting now would wait for a byte an idle shell never sends.
   *
   * (A switch used to be able to change the chrome too — the old in-bar ribbon resized the
   * terminal — and this then had to wait out the refit before counting bytes. The edge handle
   * costs no height, so a switch redraws at the size the pane already has.) The frame cap is a
   * wedge guard for a redraw that never comes at all, not a wait: if it is what releases a
   * caller, something upstream is broken.
   */
  const afterHostRedraw = (bytesAtStart: number, done: () => void) => {
    const mine = ++selectSeq.current; // a second switch mid-wait supersedes this one
    let frames = 0;
    const base = bytesAtStart;
    // What has arrived ALREADY, not the baseline: "quiet for a frame" about a burst that ended
    // before this wait was armed is answerable on the first frame, and pinning this to `base`
    // spent one doing nothing. Identical for a caller that arms at the switch, where they agree.
    let lastFrame = dataSeq.current;
    const step = () => {
      if (selectSeq.current !== mine) return;
      const seen = dataSeq.current;
      const settled = seen > base && seen === lastFrame; // arrived, and quiet for a frame
      lastFrame = seen;
      if (frames >= ZOOM_WEDGE_FRAMES) console.log('[terminal] redraw never arrived — going anyway');
      else if (!settled) {
        frames++;
        requestAnimationFrame(step);
        return;
      }
      selectSeq.current++;
      done();
    };
    requestAnimationFrame(step);
  };

  /** The one select whose redraw-wait may still fly — bumped by every new select (superseding
   *  the last) and by the flight itself (making the cap timer a no-op after the redraw won). */
  const selectSeq = useRef(0);

  const killCard = (win: TmuxWindow) => {
    // The last window is unkillable (user decision, 2026-08-10): killing it ends the tmux
    // session and drops the PTY back into a bare shell — not a state the switcher can stand
    // over. The grid hides the lone card's ✕ and rubber-bands its swipe for the same reason.
    if (cards.length <= 1) return;
    if (!cards.some((c: Card) => c.win.id === win.id)) return; // already killed: indices renumber
    console.log('[switcher] kill', win.id);
    setCards(cards.filter((c: Card) => c.win.id !== win.id)); // optimistic: leaves before tmux answers
    // A renumber race can leave the index stale — log, re-list, move on.
    killWindow(win.index).catch((error) => {
      console.log('[switcher] kill failed:', error);
      void refresh(false);
    });
  };

  const birthCard = () => {
    if (sw !== 'open' || stage === null) return;
    console.log('[switcher] new window');
    // A fresh window has no history to match — birth disarms the search (prototype's newTab).
    if (searchRef.current.on) disarmSearch();
    // The birth is its card's zoom-in, seen whole (user, 2026-08-10): the new card pops into the
    // grid first, then the surface flies into it — the same flight as a select, aimed at a slot
    // that did not exist a beat ago. `birth` holds the gestures off while the card lands.
    setSw('birth');
    newWindow()
      .then(() => refresh(false)) // tmux has switched the client to it; the fresh list names it
      .then((wins) => {
        const pos = wins?.findIndex((w) => w.active) ?? -1;
        if (!wins || pos < 0) {
          // The window never appeared, or the ~2s poll superseded this re-list mid-flight: the
          // grid stays open with the new card in it, one tap from the flight it missed.
          setSw('open');
          return;
        }
        ribbonForWindow(wins[pos], 'new window'); // as with a select: under the zoom, not a beat after it
        setZoomId(wins[pos].id);
        // The new card is the last row, possibly below the fold — reveal it on the frame after
        // its row has laid out, then give the eye a beat to see it exist before the flight.
        requestAnimationFrame(() => gridRef.current?.scrollToEnd({ animated: false }));
        setTimeout(() => {
          slotSV.value = zoomSlot(pos);
          springBack();
        }, 160);
      })
      .catch((error) => {
        console.log('[switcher] new window failed:', error);
        setSw('open');
      });
  };

  /* The grid's handlers, through a ref — the same trampoline the terminal's DOM props take above
   * (`termH`/`tv_*`), and for a sharper version of the same reason.
   *
   * `Switcher` is `memo(SwitcherInner)`, added because this screen re-renders on every phase of
   * every gesture. The memo was inert: eight of its props were a fresh identity on every render
   * (four inline arrows in the JSX, four plain consts in this body), so its shallow compare never
   * passed once. Every phase flip of every swipe therefore walked the whole grid — SwitcherInner
   * plus one WindowCard per window, each re-running `snapshotType` and a path split and rebuilding
   * its element tree — on the JS thread, inside the gesture. (The `Snapshot` trees themselves were
   * always spared; they are memoised on `card.snap`.) React Compiler cannot rescue this: the
   * screen bails out of compilation entirely, and so does SwitcherInner (verified by running the
   * plugin over both files).
   *
   * Written during render, like `swRef`/`cardsRef`/`searchRef` above: a handler assigned in an
   * effect would serve the previous render's closure to a tap that lands before it runs.
   */
  const swH = useRef<Record<string, (...args: any[]) => any>>({});
  swH.current = {
    onQuery: (q: string) => setSearch({ q, on: true }),
    onClearSearch: disarmSearch,
    onSelect: selectCard,
    onKill: killCard,
    onNew: birthCard,
    onDone: doneToActive,
    onMove: async ({ from, to }: { from: number; to: number }) => {
      // A rapid re-drag can race the previous move's renumbering and send a stale index —
      // the re-list below is the truth either way. TODO: target windows by `@id` in every
      // tmux command (move/select/kill/capture) so a stale index can't touch the wrong
      // window at all; that is a tmux-model change with its own tests.
      try {
        await moveWindow(from, to);
      } catch (error) {
        console.log('[switcher] move failed:', error);
      }
      await refresh(true); // landing indices are tmux's call (renumbering) — re-list
    },
    onScrollY: (y: number) => {
      scrollY.current = y;
    },
  };
  const sw_onQuery = useCallback((...a: any[]) => swH.current.onQuery(...a), []);
  const sw_onClearSearch = useCallback((...a: any[]) => swH.current.onClearSearch(...a), []);
  const sw_onSelect = useCallback((...a: any[]) => swH.current.onSelect(...a), []);
  const sw_onKill = useCallback((...a: any[]) => swH.current.onKill(...a), []);
  const sw_onNew = useCallback((...a: any[]) => swH.current.onNew(...a), []);
  const sw_onDone = useCallback((...a: any[]) => swH.current.onDone(...a), []);
  /** `async`, unlike its siblings: the card drag does `onMove(args).finally(…)` to clear its
   *  optimistic order (switcher.tsx), so a trampoline that dropped the promise would throw there
   *  and strand the grid in that order for good. */
  const sw_onMove = useCallback(async (...a: any[]) => swH.current.onMove(...a), []);
  const sw_onScrollY = useCallback((...a: any[]) => swH.current.onScrollY(...a), []);

  // A transitional phase makes the grid non-interactive and the stage an animation, so a phase
  // that never resolves is an app that has frozen — which it has done twice today, from two
  // different missed callbacks (user, 2026-08-11). Rather than trusting the next one not to,
  // this puts the screen back into a resting state a beat later whatever the reason. `drag` is
  // not here: a finger may legitimately hold it for a minute, and the pan's `onFinalize` is what
  // ends it. If this ever fires, the log line is the bug report.
  useEffect(() => {
    // `drag` counts too, but only with no finger on it: a real one may hold still for a minute,
    // and `dragging` is what says whether the gesture is still there to end it.
    if (sw !== 'opening' && sw !== 'closing' && sw !== 'drag') return;
    const stuck = setTimeout(() => {
      if (sw === 'drag' && dragging.current) return;
      console.log('[switcher] phase stuck in', sw, '— resolving it');
      if (sw === 'opening') {
        prog.value = 1;
        alpha.value = 0;
        setSw('open');
      } else {
        dragging.current = false;
        prog.value = 0;
        alpha.value = 1;
        finishClose();
      }
    }, PHASE_WATCHDOG_MS);
    return () => clearTimeout(stuck);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sw]);

  // The session went away (backgrounded, killed, last window closed): the grid has nothing to
  // stand on. Reset without animation; the §4.9 overlay is already up.
  useEffect(() => {
    if (!connected && sw !== 'closed') {
      dragging.current = false;
      prog.value = 0;
      dragX.value = 0;
      alpha.value = 1;
      setSw('closed');
      syncPad(); // the pad froze at the open; no event is coming to thaw it
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  // §4.10: Android system back closes the grid back into the active pane — it must never pop
  // the route out from under an open switcher. Subscribed only while the switcher is up;
  // mid-transition the press is swallowed, the running zoom owns the screen. This is the
  // BackHandler half only: `predictiveBackGestureEnabled` stays false in app.json because RN
  // 0.86's ReactActivity opts back into legacy dispatch itself — an always-enabled
  // OnBackPressedCallback ("Due to enforced predictive back on targetSdk 36, 'onBackPressed()'
  // is disabled by default. Using a workaround to trigger it manually") — so the flag buys no
  // OS peek animation for JS-handled backs, and BackHandler works either way.
  // T12A folds the rest of §5d's back ladder into the same subscription: switcher first (as
  // T10A wired it), then an open popover/⋯ menu, and at the terminal itself back is "home" —
  // `exitApp` invokes the activity's default back, which on a task-root activity backgrounds
  // the app (moveTaskToBack) rather than finishing it; §4.9's lifecycle owns what follows. It
  // deliberately never pops the route to Setup: that pop skipped `leave()`'s disconnect, and
  // leaving is the sheet's Disconnect / the overlay's Setup button's job (same reasoning as
  // the iOS `gestureEnabled: false` below). The sheets are Modals, whose dialog windows take
  // the back press natively (`onRequestClose`) before this handler can see it.
  /** The band's open flag, read by the back ladder below — which is declared above the ribbon's
   *  own state, and a `rbOpen` in this effect's dependency array would be a temporal-dead-zone
   *  throw on the first render (the same reason the key bar's handlers ride a ref). */
  const rbOpenRef = useRef(false);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sw !== 'closed') {
        if (sw === 'open') doneToActive(); // mid-transition: swallowed, the zoom owns the screen
      } else if (open !== 'none') {
        setOpen('none');
      } else if (rbOpenRef.current) {
        setRbOpen(false); // the band is a mode, and back closes a mode (the CAB contract)
      } else {
        BackHandler.exitApp();
      }
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doneToActive is a per-render
    // closure; cards keeps the activePos inside it fresh across the grid's snapshot polls.
  }, [sw, cards, open]);

  /* --- T11: bar-swipe window hop (§4.4) ---
   *
   * Horizontal bar pan → page-slide: the live terminal and a neighbour snapshot ride the finger
   * as rounded page cards, tab-name pills replace the bar keys, rubber-band at the ends,
   * commit/flick thresholds from the prototype (all in barswipe-model, tested). The neighbour's
   * content is the switcher's own snapshot of that window, already in hand at swipe start — a
   * capture fired here instead landed 100–300ms in, which is a blank card for the whole first
   * half of a quick flick (user, 2026-08-10). The swipe kicks a refresh for the next one. After
   * a commit `select-window` makes tmux redraw the PTY, and a short settle overlay holds the
   * snapshot until that lands. */
  const swipeX = useSharedValue(0);
  /** A constant zero the pills read during the settle, in place of `swipeX` — see the pills
   *  prop for why the real value is briefly stale there. */
  /** The pills' position and their read-zero gate, as shared values rather than props.
   *
   *  Every `NamePill` has two `useAnimatedStyle` mappers, and both closed over the numeric `pos`
   *  and over whichever shared value `x` pointed at — which used to SWAP between a constant zero
   *  and `swipeX`. Reanimated derives a mapper's dependencies from its worklet's closure, so a
   *  changing number and a swapping identity restarted both mappers on every pill about three
   *  times a swipe, on a strip that is deliberately pre-mounted so a swipe never pays to build it.
   *  As shared values the closure is constant and the mappers attach once, at mount. */
  const pillPosSV = useSharedValue(0);
  /** 1 = read the offset as zero (at rest, and through the settle — see `pillsProp`). */
  const pillHoldSV = useSharedValue(1);
  const roundSV = useSharedValue(0); // gate for the page's card edge, 0→1 (the corners are constant)
  // `pageSwipe` itself is declared with the switcher state above (the cache freezes on it).
  const swipeInfo = useRef<{
    windows: TmuxWindow[];
    pos: number;
    t0: number;
    live: boolean;
    /** The row's length for this swipe: the windows, plus the new-tab slot unless the card is held
     *  in the air. Fixed at 'start' and read by every decision after it, so the band, the release
     *  and the pills all stop in the same place. */
    slots: number;
  } | null>(null);
  /** The pending neighbour-cache warm (see `clearBarSwipe`) — so a new swipe can call it off. */
  const warmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bytes off the shell, counted. A one-shot watch cannot answer "has anything arrived since the
   *  commit?" — it only answers "did something arrive while I happened to be armed", and the two
   *  differ exactly when the answer matters (see `afterHostRedraw`). */
  const dataSeq = useRef(0);
  /** `dataSeq` at the moment `select-window` went out, the baseline the settle's redraw-wait
   *  measures from. Read at the commit, not at the settle: on a LAN the redraw beats the slide
   *  home (user, 2026-08-10: "small delay still there"). */
  const bytesAtCommit = useRef(0);
  /** Constant velocity for whatever distance is left (see slideMs) — a fixed 320ms ease-out
   *  sprinted the rest of the way on an early release (user, 2026-08-11). */
  const slideTo = (to: number, done: () => void) => {
    swipeX.value = withTiming(
      to,
      // A mild ease-out, not linear: pure constant speed read mechanical; the strong bezier
      // read as a sprint. Duration still scales with the distance, which is what matters.
      { duration: slideMs(to - swipeX.value), easing: Easing.out(Easing.quad) },
      (finished) => {
        if (finished) runOnJS(done)();
      },
    );
  };

  const clearBarSwipe = (skipRefresh = false) => {
    // The refresh that keeps the cache warm for the NEXT swipe runs here rather than at the
    // start of this one: a capture per window is an exec burst and a parse of every answer, and
    // on the JS thread at the instant the finger goes down that is a stutter in the slide it is
    // meant to serve (user, 2026-08-10). Nothing on screen is waiting for it. Skipped when this
    // clear IS a swipe's first frame (the settle yielding to an impatient re-swipe) — exactly
    // that stutter; the cache stays one hop stale and the next clear refreshes it.
    // Only the two windows a NEXT swipe can reach, and a beat after the landing. This used to
    // re-capture and re-parse every pane in the session: with ten tabs that is ten execs and ten
    // ANSI parses on the JS thread after every single hop — the 150-213ms stall the perf
    // heartbeat caught next to each commit, which is what a fast repeated swipe felt like
    // (2026-08-13). The rest of the grid is refreshed when the grid itself opens.
    // Held on a handle, and every swipe's start cancels it (see `onBarSwipe`). Unhandled, each hop
    // left a timer nothing could stop: `skipRefresh` only declines to arm a NEW one. Hopping at any
    // normal rate then landed the *previous* hop's two captures — two SSH execs, two `parseAnsi`
    // over a full pane, two `setCards` — squarely inside the next swipe's drag, on the JS thread,
    // which is exactly the "simplest swipe is laggy" report (perf, 2026-08-13).
    clearTimeout(warmTimer.current ?? undefined);
    if (!skipRefresh)
      warmTimer.current = setTimeout(() => {
        const at = activePosIn(cardsRef.current);
        for (const side of [-1, 1] as const) {
          const win = cardsRef.current[at + side]?.win;
          if (win) void refreshCard(win);
        }
      }, 350);
    selectSeq.current++; // supersedes a settle's redraw-wait, so it cannot clear a later swipe
    swipeInfo.current = null;
    rowLiveSV.value = 0;
    // A cut, not a fade: the landed card and the live terminal under it are the same picture.
    rowVisSV.value = 0;
    joinSV.value = 0;
    setPageSwipe(null);
    swipeX.value = 0;
    roundSV.value = 0; // x is already 0 here, so the travel factor has faded the edge out too
  };

  const settleBarSwipe = () => {
    // Nothing to cover. The overlay hides a redraw that has not landed yet, and on a LAN it is
    // rarely outstanding by the time the slide is home (the trace: redraw complete at +35ms
    // against a ~300ms slide). Mounting it anyway costs a React commit and the wait's own frames
    // AFTER the motion has already stopped, which is the beat between the card settling and the
    // tab being live (user, 2026-08-11).
    if (dataSeq.current > bytesAtCommit.current) {
      clearBarSwipe();
      return;
    }
    // The overlay covers the terminal until the host has finished redrawing the pane it lands
    // on. Its insets FREEZE at this commit's values, so a chrome change under it (the keyboard)
    // cannot reflow it in plain view.
    setPageSwipe((s) =>
      s === null
        ? s
        : {
            ...s,
            phase: 'settle',
            pos: s.target,
            settled: cards[s.target]?.snap ?? null,
            settleInsets: paneInsets,
          },
    );
    roundSV.value = withTiming(0, { duration: 200 });
    // The same wait the zoom's flight uses — usually already satisfied by the time the slide has
    // landed, which is the whole point of taking the baseline back at the commit.
    afterHostRedraw(bytesAtCommit.current, clearBarSwipe);
  };

  // The settle overlay (a static copy of the committed page) is mounted: reset the slide offset
  // under it, so the live terminal is back at rest by the time the overlay drops. An effect, not
  // the callback, so the reset paints strictly after the translated pages have unmounted.
  useEffect(() => {
    // After the row's unmount commit: the box snaps home and the live, already-redrawn terminal
    // stands exactly where the landed card was — the same cut as before, minus the overlay whose
    // mount was a 25-32ms Fabric commit at the end of every fast hop (perf, hop-settle window).
    if (pageSwipe === null) swipeX.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSwipe]);

  /** The page slides home and the swipe is over, no hop. Both ways out that decide nothing: a
   *  release under the thresholds, and a release that committed to the grid instead — there the
   *  hop is not cancelled so much as outranked, and marking the swipe spent here is what stops the
   *  bar's own 'end' (which arrives straight after) from also hopping. */
  /** Set by a release that committed to the grid, read by the page swipe's own 'end' a call later:
   *  one gesture, two axes, and only one of them gets to decide the release. */
  const gridTookIt = useRef(false);

  const springPageHome = (skipRefresh: boolean) => {
    if (swipeInfo.current === null) return;
    swipeInfo.current.live = false;
    rowLiveSV.value = 0;
    setPageSwipe((s) => (s === null ? s : { ...s, phase: 'anim' }));
    // No edge-fade timer: the slide home takes x to 0 and the travel factor fades it with it.
    slideTo(0, () => clearBarSwipe(skipRefresh));
  };

  // `-next-line`, never the block form. A block `eslint-disable` makes babel-plugin-react-compiler
  // treat every function declared later in the file as suppressed — it never pairs the matching
  // `eslint-enable` back up — and it then refuses to compile them. This one and the twin below
  // were costing PageContent, NeighborPage and Status their compilation, though neither of them
  // contains a suppression of its own.
  const panBridge = useMemo(
    () => ({
      swipeX,
      prog,
      dragX,
      join: joinSV,
      zoomReady: zoomReadySV,
      zoomBase: zoomBaseSV,
      zoomFromX: zoomFromXSV,
      zoomFromY: zoomFromYSV,
      zoomFromSet: zoomFromSetSV,
      dragging: draggingSV,
      armed: armedSV,
      rowLive: rowLiveSV,
      rowVis: rowVisSV,
      rowPos: rowPosSV,
      rowCount: rowCountSV,
      heldAir: heldAirSV,
      stage: stageSV,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every member is a stable shared value
    [],
  );

  const onBarSwipe = (phase: 'start' | 'end', dx: number, air = false) => {
    if (stage === null) return;
    if (phase === 'start') {
      // `drag` is a swipe that has ALREADY lifted — Safari's card can be paged sideways after it
      // has left the bar, and the finger may only decide that a hundred points into the pull up
      // (user, 2026-08-12). Off the ref, not the render: mid-gesture the render is a frame behind.
      if ((swRef.current !== 'closed' && swRef.current !== 'drag') || !connected) return;
      // The last hop's cache warm has 350ms to land and this finger did not wait for it: two execs
      // and two ANSI parses inside the drag are the stutter it exists to prevent. Dropped, not
      // deferred — the next `clearBarSwipe` arms a fresher one over newer neighbours anyway.
      clearTimeout(warmTimer.current ?? undefined);
      warmTimer.current = null;
      if (swipeInfo.current !== null) {
        // Mid-settle re-swipe: the hold exists to hide a refit, but making the finger WAIT for
        // it read as lag — rapid back-and-forth hopping used to be instant (user, 2026-08-11).
        // The settle yields: everything it was holding applies now, under the new drag's motion.
        if (pageSwipe?.phase !== 'settle') return; // a slide is still flying — too early
        clearBarSwipe(true);
      }
      const windows = cards.map((c) => c.win);
      if (windows.length === 0) return;
      const pos = activePosIn(cards);
      // A lift that never went sideways leaves the flag set — no 'end' arrives on this axis to
      // read it — so every swipe starts by clearing it rather than trusting the last one to.
      gridTookIt.current = false;
      // A held card's row ends at the last window — nothing drawn past it and nothing to commit
      // onto (user, 2026-08-13). `air` is the worklet's own `heldAir` latch, which is also what
      // hides the page, so the two cannot disagree. A flat swipe is unchanged: the slot past the
      // last tab is there, and committing onto it births a window.
      const slots = windows.length + (air ? 0 : 1);
      swipeInfo.current = { windows, pos, t0: Date.now(), live: true, slots };
      rowLiveSV.value = 1;
      rowVisSV.value = 1;
      rowPosSV.value = pos;
      rowCountSV.value = slots;
      setOpen('none');
      // §7: "the neighbour did not render" and "the neighbour rendered with nothing in it" look
      // identical on a dark theme — an empty page card is the background colour. Only the cache
      // can tell them apart (user, 2026-08-13, three screenshots of an empty half-screen).
      if (GESTURE_LOG)
        console.log(
          '[barswipe] start at', pos, 'of', windows.length,
          'snaps', cards.map((c) => (c.snap ? '#' : '.')).join(''),
        );
      setPageSwipe({
        names: [...windows.map((w) => w.name), ...(air ? [] : [NEW_TAB_NAME])],
        pos,
        target: pos,
        phase: 'drag',
        settled: null,
        settleInsets: null,
      });
      roundSV.value = 1; // the edge itself rides the travel — see pageEdgeStyle
      swipeX.value = rubber(dx, pos, slots);
    } else {
      const info = swipeInfo.current;
      if (!info?.live) return;
      // The same release lifted the card into the grid: this axis yields (see `onSwitcherDrag`).
      // The refresh is skipped — a capture per window on the JS thread is the stutter
      // `clearBarSwipe` describes, and here it would land inside the flight.
      if (gridTookIt.current) {
        gridTookIt.current = false;
        if (GESTURE_LOG) console.log('[barswipe] yielded to the grid');
        springPageHome(true);
        return;
      }
      const target = swipeTarget(dx, Date.now() - info.t0, info.pos, info.slots);
      if (target === info.pos) {
        if (GESTURE_LOG) console.log('[barswipe] cancel');
        springPageHome(false);
      } else {
        info.live = false;
        rowLiveSV.value = 0;
        // `undefined` at the slot past the last tab — the page sliding in is a window that does
        // not exist yet, and committing onto it is what births it (user, 2026-08-10).
        const win = info.windows[target];
        if (GESTURE_LOG)
          console.log('[barswipe] commit →', win ? `window ${win.index} (${win.name})` : 'new window');
        // The handle changes with the slide, not a poll beat after it — and it costs no height,
        // so nothing refits. A window we are about to create runs an idle shell: no handle.
        if (win) ribbonForWindow(win, 'bar swipe commit');
        else setRibbonCore((c) => ribbonPoll(c, null, Date.now()));
        // The settle's redraw-wait counts from here, not from the settle: on a LAN tmux's redraw
        // beats the slide home.
        bytesAtCommit.current = dataSeq.current;
        // Either way tmux redraws the PTY, which replaces the snapshot: `new-window` makes the
        // window it creates the active one, exactly as `select-window` does.
        if (win) {
          void selectWindow(win.index);
          // Same optimistic `active` flip as a card select — the next grid open must not show
          // the halo a list beat behind.
          setCards((prev) => prev.map((c) => ({ ...c, win: { ...c.win, active: c.win.id === win.id } })));
        }
        // …and re-list, exactly as the grid's ✚ does (`birthCard`). Committing onto the slot past
        // the last tab BIRTHS a window, and nothing here ever told the card list about it: with
        // the grid closed there is no poll running at all (`useSwitcherCards`'s interval is armed
        // on `live`), so the new tab stayed missing until the grid was next opened AND its 2s beat
        // came round — "tens of seconds" (user, 2026-08-13). Worse than a missing card: `tmux`
        // has already switched to a window `cards` does not contain, so `activePosIn` finds
        // neither the index nor the active flag and falls back to 0 — the anchor, the pills and
        // the halo all point at the wrong tab until something re-lists.
        // `refresh(false)` is list-only: no capture burst on the JS thread, and the fresh shell
        // has nothing to snapshot yet. Rare by nature — this is a window being created, not a hop.
        else
          newWindow()
            .then(() => refresh(false))
            .catch((error) => console.log('[barswipe] new window failed:', error));
        setPageSwipe((s) => (s === null ? s : { ...s, phase: 'anim', target }));
        slideTo((info.pos - target) * pagePitch(stage.w), settleBarSwipe);
      }
    }
  };

  /* The neighbour pages are mounted whenever the terminal view is up, not when a swipe starts:
   * mounting them is 53–93ms of React on the JS thread (measured on device), the bar's pan runs
   * on JS too, and so the first `move` callback of every swipe arrived after that — the hitch at
   * the beginning (user, 2026-08-10). At rest they sit a full pitch off either edge and cost
   * nothing to keep; the snapshot inside them is memoised, so the 2s cache beat walks past them.
   *
   * The anchor freezes for the length of a swipe: committing switches the active window, and a
   * neighbour recomputed at that moment would swap its content while the slide is still running. */
  const anchor = pageSwipe?.pos ?? activePosIn(cards);
  const neighbour = (side: -1 | 1) => cards[anchor + side]?.snap ?? null;

  // The live terminal is itself a page while a swipe is on: it slides, already wearing the
  // screen's corner. The radius is a constant, not an animation — the page is round at rest too
  // (user, 2026-08-11), so there is nothing to round *into*.
  const pageR = pageRadius(stage?.w ?? 390);
  /** The page's bottom corners, square while the keyboard is up: that edge is not the bottom of
   *  anything, it is where the keyboard cuts the page off, and a rounded cut sitting on top of the
   *  keys reads as a card that ends early (user, 2026-08-11). It stays square through the flight
   *  too — there the outer surface is the card and owns the corners, and the page rounding off a
   *  second time just below the key bar drew a corner in the middle of the flying card (user,
   *  2026-08-11, screenshot). A bar swipe is the exception: there the page IS the card. */
  const kbSquare = keyboardPad > 0 && pageSwipe === null;
  const pageRB = kbSquare ? 0 : pageR;
  const roundR = 0.1 * (stage?.w ?? 390);
  // The card's edge: in the dark flavours base and crust are nearly the same ink, so the gap
  // alone does not separate card from backdrop (user, 2026-08-11, screenshot) — the same
  // hairline the switcher's cards wear does. An overlay, NOT a real border: a border is part of
  // the box and would resize the terminal mid-swipe. This one still fades in with the travel —
  // the corners are permanent, a hairline round the resting page is not.
  const pageEdgeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(Math.abs(swipeX.value) / roundR, 1) * roundSV.value,
  }));

  /* --- T11: the edge handle (§4.4) ---
   *
   * State crosses in ribbon-model's reducer (tested): T9's foreground poll, T6's altScreen, and
   * the ^Z watch on the key bar's send path. The screen only feeds events in and executes caps. */
  const [ribbonCore, setRibbonCore] = useState(RIBBON_IDLE);
  /** The band: unrolled by the chip's tap (iOS: or its leftward swipe), rolled back up by a cap,
   *  the chip, a tap on the terminal above it, or Android's back. */
  const [rbOpen, setRbOpen] = useState(false);
  rbOpenRef.current = rbOpen;
  const fgCommand = tmux.foreground?.command ?? null;
  const fgPid = tmux.foreground?.pid ?? null;
  useEffect(() => {
    // Not while anything is sliding: after a committed hop the very next display-message answer
    // carries the NEW window's foreground, and this flipped the handle ~100ms into every slide.
    // `ribbonForWindow` already set the right recipe at the commit; when the freeze lifts this
    // re-applies the latest poll, a no-op whenever the two agree.
    if (frozen) return;
    setRibbonCore((c) =>
      ribbonPoll(c, fgCommand === null || fgPid === null ? null : { command: fgCommand, pid: fgPid }, Date.now()),
    );
  }, [fgCommand, fgPid, frozen, tmux.windowIndex]);
  /** One re-render as `RIBBON_MIN_RUN_MS` elapses. `selectRecipe` reads the clock, and a quiet
   *  poll deliberately returns the same core object (no re-render), so without this the band for
   *  a slow job would wait for whatever happened to render next. 50ms of slack: the timeout must
   *  land on the far side of the gate, never a millisecond short of it. */
  const [, setGateBeat] = useState(0);
  useEffect(() => {
    console.log(
      `[ribbon] run #${ribbonCore.instance} ${ribbonCore.command ?? 'idle'} pid=${ribbonCore.pid ?? '-'} startedAt=${ribbonCore.startedAt}`,
    );
    const timer = setTimeout(() => setGateBeat((n) => n + 1), RIBBON_MIN_RUN_MS + 50);
    return () => clearTimeout(timer);
  }, [ribbonCore.instance]);

  /** The recipe for a window we are switching to, named from the list rather than waited for,
   *  so the handle changes with the transition instead of a poll beat after it. Every switch
   *  goes through here — a committed bar swipe, a card tap, a new window. */
  const ribbonForWindow = (win: TmuxWindow, why: string) => {
    console.log(`[ribbon] forWindow ${win.index} ${win.command} (${why})`);
    const idle = IDLE_SHELLS.has(win.command);
    setRibbonCore((c) =>
      idle ? ribbonSwitchedToIdle(c) : ribbonPoll(c, { command: win.command, pid: null }, Date.now()),
    );
  };

  const recipe = connected ? selectRecipe(ribbonCore, modes.altScreen, Date.now()) : null;
  // A DIFFERENT recipe means the caps under the finger changed, so the band collapses. A new
  // instance of the same one (a second `npm run build`) leaves it open and just restarts the
  // clock — closing chrome the user did not close is worse than a stale timer.
  useEffect(() => setRbOpen(false), [recipe?.id]);

  /** Every key on its way to the PTY, with the ribbon's ^Z watch on the side. `ribbonSent`
   *  returns the same object for bytes that are not its business, so this re-renders nothing. */
  const sendKeys = (bytes: string) => {
    setRibbonCore((c) => ribbonSent(c, bytes, Date.now()));
    send(bytes);
  };

  /** The key bar's handlers, same trampoline and same reason — `KeyBar` is memoised now, and its
   *  props were nine fresh closures a render. `open`/`onOpenChange` are already stable (a state
   *  value and its setter) and `panSV` is built once, so with these the bar only re-renders when
   *  something it actually draws has changed. Declared down here, not with the grid's: `sendKeys`
   *  and `onBarSwipe` are `const`s above, and reading them from a block placed earlier is a
   *  temporal-dead-zone throw on the first render. */
  const kbH = useRef<Record<string, (...args: any[]) => any>>({});
  kbH.current = {
    sendBytes: sendKeys,
    onHeight: (h: number) => {
      if (h !== barHeight) probe(`barHeight ${barHeight.toFixed(0)} → ${h.toFixed(0)}`);
      setBarHeight(h);
    },
    onTabsTap: openSwitcher,
    onZoomGrab,
    onZoomArm,
    onZoomEnd,
    onBarSwipe,
  };
  const kb_sendBytes = useCallback((...a: any[]) => kbH.current.sendBytes(...a), []);
  const kb_onHeight = useCallback((...a: any[]) => kbH.current.onHeight(...a), []);
  const kb_onTabsTap = useCallback((...a: any[]) => kbH.current.onTabsTap(...a), []);
  const kb_onZoomGrab = useCallback((...a: any[]) => kbH.current.onZoomGrab(...a), []);
  const kb_onZoomArm = useCallback((...a: any[]) => kbH.current.onZoomArm(...a), []);
  const kb_onZoomEnd = useCallback((...a: any[]) => kbH.current.onZoomEnd(...a), []);
  const kb_onBarSwipe = useCallback((...a: any[]) => kbH.current.onBarSwipe(...a), []);

  const onRibbonCap = (cap: Cap) => {
    console.log('[ribbon] cap', cap.label);
    if (cap.action === 'attach') {
      void quickAttach(); // §4.6: /tmp/port22 + typed path; the busy flag tints the cap inert
      return;
    }
    if (cap.action === 'kill') {
      if (ribbonCore.pid !== null) {
        const command = killCommand(ribbonCore.pid);
        console.log('[ribbon] kill-force:', command);
        void exec(command).catch((error) => console.log('[ribbon] kill-force failed:', error));
      }
      setRibbonCore(ribbonResumed); // a killed stopped job is resolved; running clears on the next poll
      return;
    }
    if (cap.action === 'bg') {
      // ^Z then `bg` in one tap. Deliberately NOT through sendKeys: this ^Z ends backgrounded,
      // not stopped, so it must not become a suspension candidate.
      send('\x1a');
      send('bg\r');
      return;
    }
    if (cap.action === 'fg' || cap.action === 'bg2') {
      send(cap.action === 'fg' ? 'fg\r' : 'bg\r');
      setRibbonCore(ribbonResumed);
      return;
    }
    if (cap.bytes !== undefined) {
      send(cap.bytes);
      if (cap.focus) setFocusSignal((n) => n + 1); // pager/htop search needs typing (§4.4)
    }
  };

  /* --- the name pills' inputs --- */

  /** Where the strip sits, and whether the offset counts. The settle moves `pos` to the target in
   *  the same commit, but `swipeX` keeps the slide's final offset until the post-paint reset
   *  effect — read together they put the continuous position a full window off, snapping the new
   *  pill to a capsule and back (user, 2026-08-11). The settle IS the landing, so the offset is
   *  gated to zero there rather than `x` being pointed at a different value: swapping the shared
   *  value was what made the pills' mappers restart (see `pillPosSV`). */
  const pillPos = pageSwipe?.pos ?? activePosIn(cards);
  const pillHold = pageSwipe === null || pageSwipe.phase === 'settle';
  useEffect(() => {
    pillPosSV.value = pillPos;
    pillHoldSV.value = pillHold ? 1 : 0;
  }, [pillPos, pillHold, pillPosSV, pillHoldSV]);

  /** The names, keyed by CONTENT: the array is rebuilt from `cards` on every list refresh, and a
   *  hop's `setCards` plus the two warm captures behind it changed its identity three times a
   *  swipe without a single name being different. */
  const pillNames = pageSwipe?.names ?? [...cards.map((c) => c.win.name), NEW_TAB_NAME];
  const pillNamesKey = pillNames.join('\u0000');
  /** Keys or pills? The settle is the BAR's landing, not the terminal's — the overlay still waits
   *  for the host to finish redrawing because it is a picture of a pane, but the keys are not a
   *  picture of anything, and holding them behind that wait read as the bar taking forever to
   *  settle (user, 2026-08-11; the trace put tmux's redraw at +35ms and the keys at +550). Both
   *  sets are mounted, so this flips two opacities. */
  const pillsLive = pageSwipe !== null && pageSwipe.phase !== 'settle';

  /** The bar-swipe morph inputs the name pills ride. See KeyBarProps.pills for why it exists at
   *  rest too. */
  /* Memoised so `KeyBar`'s memo can bite: rebuilt every render, this object alone re-rendered the
   * whole bar — pills, glass and all — on every keyboard step, ribbon poll and phase flip, none of
   * which change a pill. Every member is now either stable by construction (the shared values) or
   * keyed by content (`pillNamesKey`). */
  /* eslint-disable-next-line react-hooks/exhaustive-deps -- `pillNames` is keyed by
     `pillNamesKey`; the shared values are stable. */
  const pillsProp = useMemo(
    () =>
    showTabs && connected && stage !== null
      ? {
          names: pillNames,
          pos: pillPosSV,
          hold: pillHoldSV,
          x: swipeX,
          pitch: pagePitch(stage.w),
          live: pillsLive,
        }
      : null,
    [showTabs, connected, stage, pillNamesKey, pillsLive, pillPosSV, pillHoldSV, swipeX],
  );

  /* --- the pane's insets ---
   *
   * Sideways it is the plain gap. Vertically it is the gap PLUS half of whatever the rows could
   * not divide the box into: `rows × cell` almost never equals the height available, and the
   * remainder — up to a whole row, 12.6pt of it on device — used to fall entirely below the last
   * line, which is why the gap to the key bar read as three times the one at the sides (user,
   * 2026-08-10). Split, it is the same gap above and below. It settles rather than oscillates:
   * the padding takes exactly the remainder away, so the fit that follows lands on the same rows.
   */
  const padH = stage === null ? 0 : termPad(stage.w);
  // The remainder, halved onto each side — and this is the padding the fit will measure against,
  // so it has to give the rows back exactly the height they came from. Two things make that safe:
  // it is clamped to one row (a stale `rows`, mid-keyboard, cannot ask for an absurd inset), and
  // it is floored to a whole device pixel, so the box can only ever be a rounding hair TOO tall.
  // Rounding it the other way costs a row, which grows the inset by half a row, which costs
  // another — the rows walked 38 → 33 in the log before the floor went in.
  // Below the last line the eye adds the terminal's inset to the key bar's own 5pt, so the
  // terminal's share is the gap minus that, and the two together come to the gap at the sides.
  // Above there is no inset of ours at all: the row remainder goes there, and the terminal
  // applies it itself, inside its own layout pass (see TerminalProps.onResize). Worked out here
  // it needed a measured height, which only arrives after a layout — so every keyboard open laid
  // out once wrong and once right, which is the bounce (user, 2026-08-10).
  const padBottom = Math.max(0, padH - BAR_PAD_TOP);
  /** The card face runs the full window now, so its content clears the notch itself — except
   *  under an armed search, whose row (padded past the notch on its own) already pushed the
   *  terminal area below it. */
  const notchPad = search.on ? 0 : insets.top;
  /** The floating bar's ground: home strip + the bar stack itself, all inside the card face. */
  const barPad = barHeight + insets.bottom;
  /** The row remainder, absorbed into the BOTTOM padding so the first row is pinned to the top
   *  of the box: the webview used to carry it above the rows (`box % cell`), and any chrome
   *  change — ribbon, keyboard — re-rolled it, shifting the whole pane by up to a row at the
   *  hop's reveal (user, 2026-08-11, screenshot pairs: ~13pt, down on bare, up on ribboned).
   *  Down here it merges into the gap the bar already keeps, where a varying gap is at home. */
  const searchRowH = search.on ? insets.top + 46 : 0;
  const innerH =
    stage === null ? 0 : stage.h - keyboardPad - searchRowH - notchPad - padBottom - barPad;
  // A point of slack, because an exact multiple is the one number this must not aim at. The box is
  // handed over through three fractional paddings, each rounded to a device pixel on the way, so
  // what the webview measures is up to a point SHORT of what is computed here — and a box a hair
  // under a whole row costs the row: xterm drops it and parks the leftover as a top inset, which is
  // the whole pane stepping down 17pt of an 18pt cell every time the keyboard leaves (device,
  // 2026-08-12: box 738.00 out, `clientHeight` 737 in, 41 rows → 40 and padTop 0 → 17). A point over
  // is free — it lands as a padTop of a few tenths, under a device pixel.
  const rowRemainder = cell.h > 0 && innerH > 0 ? Math.max(0, (innerH % cell.h) - 1) : 0;
  /** What the pane sits inside — the page cards of the T11 slide draw at 1:1 beside it and take
   *  the same three numbers, or their text does not line up with the live terminal's. */
  const paneInsets = { top: notchPad + padTop, side: padH, bottom: padBottom + barPad + rowRemainder };
  /** Where a popover's bottom edge sits in the layer below — 6pt above the bar stack, plus the
   *  home strip and the keyboard's overlap, because that layer's bottom is the window's. */
  const popBase = barHeight + 6 + keyboardPad + insets.bottom;

  /**
   * What the surface is aimed at this frame — the hold pose under the finger, the slot once
   * released, interpolated by `flight` (see `aimFrame`). Every style that draws the zoom reads the
   * aim rather than the slot, so the card, its ring and its neighbours agree by construction.
   *
   * Deliberately a per-render closure, which makes it a changing dependency of the four mappers
   * that call it (`boxStyle`, `cardClipStyle`, `cardRadiiStyle`, `ringStyle`) and restarts all
   * four on every render. That churn was hoisted to module scope for exactly that reason — and the
   * hoist put the keyboard-up page's rounded bottom corners back (user, 2026-08-13).
   *
   * Why: these mappers are attached CONDITIONALLY (`zoomActive && …`). A restarting mapper
   * re-runs and rewrites its props the moment it is re-registered, so the accidental every-render
   * restart was also what repainted the radius whenever the style attached. With stable
   * dependencies the mapper only re-runs when a dependency or a shared value it reads changes —
   * and `zoomActive` flipping true is neither, so the newly attached view kept the radius from the
   * last gesture, rounded, under a raised keyboard where `kbSquare` wants it square.
   *
   * ponytail: the churn is a real per-render cost and this is a real fix for the wrong problem.
   * The honest version is to stop conditioning the attachment on `zoomActive` (or to drive
   * `kbSquare` through a shared value so the mapper re-runs on its own), but both change what
   * 85b36ab measured — no layout or raster props written during a flat hop — so they want their
   * own change and their own device walk, not a rider on this one.
   */
  /** The shared values `aimAt` reads, as one stable object — see `aimAt` at module scope. */
  // eslint-disable-next-line react-hooks/exhaustive-deps -- every member is a stable shared value
  const aimSV = useMemo(() => ({ stage: stageSV, slot: slotSV, prog, flight }), []);

  /**
   * A neighbouring page's card, INSIDE the zoomed container with the live one. It carries nothing
   * but its pitch and the crop — the scale and the flight are the container's, which is the only
   * way two cards are guaranteed to agree (see `zoomBox`).
   *
   * The swipe offset lives on the container alone — the row is rigid by construction.
   */
  const usePageCardStyle = (side: -1 | 1, phantom = false) =>
    useAnimatedStyle(() => {
      // Deliberately reads only what it uses: a leftover `zoomFrame` call here made this worklet
      // a dependent of prog, dragX, slotSV and flight, so it recomputed on every value the zoom
      // touches instead of only on the ones that move the row.
      const pitch = stageSV.value.w * (1 + PAGE_GAP);
      // The swipe join's approach, locked to the TRAVEL rather than a clock: the card starts a
      // little beyond its pitch and closes in as the finger uncovers the gap, fully seated by
      // 130pt — slow and firm, and it can never lag the swipe or pop (user, 2026-08-13, after
      // instant read as harsh and every timed entrance was either too quick or too slow). A held
      // join seats immediately; its entrance is the clamped spring on the mount instead.
      // One distance for every swipe. It used to shrink with the swipe's speed — the quicker the
      // swipe, the faster the slide-in (user, 2026-08-13) — and that coupling was withdrawn a day
      // later: the neighbours are to arrive at one speed whatever the hand did (user, 2026-08-14).
      const seat = Math.max(joinSV.value, Math.min(Math.abs(swipeX.value) / ROW_REACH, 1));
      return {
        // `phantom` is the new-tab page — the one past the last window, which a card held in the
        // air must not be given. Read off the worklet's own latch so it is dark on the very frame
        // the row is revealed, never a commit later.
        opacity: rowVisSV.value * (phantom && heldAirSV.value === 1 ? 0 : 1),
        transform: [{ translateX: side * (pitch + 44 * (1 - seat)) }],
      };
    });
  /** The card face's corners, riding the SAME `f.radius` the ring draws — the page wore its
   *  static at-rest radius mid-air, and its rounder corner pulled away from the ring's arc
   *  (movement 3, screenshot). Shared by the live page, its edge, and the neighbours. */
  /**
   * ALWAYS attached, unlike the crop below. Detaching a Reanimated style does not put back what it
   * wrote: the props it set stay on the view, and a React commit carrying the static value does
   * not reliably clear them. So the rounded corner a gesture left behind stayed on the page
   * afterwards, sitting at the top of the keys under a raised keyboard where `kbSquare` wants it
   * square — and stating the resting radius statically did not displace it (user, 2026-08-13,
   * twice). Nothing to displace if the style never leaves.
   *
   * It costs nothing to keep: a mapper runs when a value it READS changes, and this one reads
   * `prog`, `dragX`, the aim's values and `stageSV` — none of which move during a flat hop, which
   * animates `swipeX` alone. So the raster write 85b36ab took out of the hop stays out; what comes
   * back is one write when `kbSquare` flips, which is exactly the write that was going missing.
   * At rest the worklet computes the same `pageR`/`pageRB` the static style states.
   */
  const cardRadiiStyle = useAnimatedStyle(() => {
    'worklet';
    const r = zoomFrame(prog.value, dragX.value, aimAt(aimSV), stageSV.value).radius;
    const rb = kbSquare ? 0 : r;
    return {
      borderTopLeftRadius: r,
      borderTopRightRadius: r,
      borderBottomLeftRadius: rb,
      borderBottomRightRadius: rb,
    };
  });

  const prevCardStyle = usePageCardStyle(-1);
  /** The page on the right is the phantom exactly when the anchor is the last window. A plain
   *  boolean in the worklet's closure: it changes when the tab list or the active tab does, never
   *  per frame. */
  const nextCardStyle = usePageCardStyle(1, anchor >= cards.length - 1);

  /**
   * The card's crop and corner, SEPARATED from the per-frame transform above and applied only
   * while the zoom is actually live (`zoomActive`).
   *
   * `height` is a layout prop — writing it per frame runs Yoga over the card's subtree, a
   * snapshot tree of Text runs — and `borderRadius` re-rasterizes the layer. Neither value even
   * changes during a flat hop, but Reanimated writes what the worklet returns every frame, so
   * both costs were being paid on every swipe by six views at once. That is the lag inside the
   * frames, which a frame-gap counter cannot see (user, 2026-08-13: "the animation itself is
   * laggy"). At rest the static styles below stand in, and the gesture animates transforms only.
   */
  const cardClipStyle = useAnimatedStyle(() => {
    const f = zoomFrame(prog.value, dragX.value, aimAt(aimSV), stageSV.value);
    const rb = kbSquare ? 0 : f.radius;
    return {
      height: f.height,
      borderTopLeftRadius: f.radius,
      borderTopRightRadius: f.radius,
      borderBottomLeftRadius: rb,
      borderBottomRightRadius: rb,
    };
  });
  /** Is anything scaling? Only then do the layout-and-raster styles above go live. */
  const zoomActive = sw !== 'closed';

  /** The grid's arrival, the same travel that carries the card (§7's no-clocks principle): the
   *  backdrop stays dark until the card is halfway to the tabs view, then the grid comes in
   *  quickly over the next fifth — on a drag it rides the finger, on a tap-open or a release it
   *  rides the same `prog` the flight animates. It also keeps the grid out of the gap between
   *  page cards during a plain hop, where prog is 0 and this is 0. */
  const gridInStyle = useAnimatedStyle(() => ({
    opacity: Math.min(Math.max((prog.value - 0.75) / 0.15, 0), 1),
  }));
  /** …and it arrives BLURRED, sharpening only as the card lands — Safari's sequencing (user's
   *  reference screenshots). The blur's INTENSITY is fixed and its OPACITY animates: animating
   *  intensity rebuilds the blur effect every frame over a full screen of text, which is GPU
   *  work no CPU-side frame counter sees — the "5fps, and your numbers do not show it" lag
   *  (user, 2026-08-13). A fixed-effect view fading out is plain compositing. */
  const gridBlurStyle = useAnimatedStyle(() => ({
    opacity: 1 - flight.value,
  }));

  /** The container every card rides: one scale, one flight, one place. Its height is the stage's
   *  and stays there — the cards inside clip themselves — so it can hold pages a pitch to either
   *  side without a clip cutting them off. */
  const boxStyle = useAnimatedStyle(() => {
    const b = zoomBox(prog.value, dragX.value, aimAt(aimSV), stageSV.value);
    return {
      opacity: alpha.value,
      transform: [
        // The row moves as one, always: the box IS the swipe. The page/card handover that used
        // to live here (cardCarry) existed for a bar that no longer rides inside the card, and
        // its migrating offset was a scrim band visibly collapsing in the gap whenever a flick
        // crossed a swipe (user, 2026-08-13, screenshot).
        { translateX: b.translateX + swipeX.value * b.scale },
        { translateY: b.translateY },
        { scale: b.scale },
      ],
    };
  });

  /* --- §7 structured-test trace (TEMPORARY): phase flips and layer mounts only — the per-frame
   * geometry sampler is gone, it was JS load inside the very gestures under test. --- */
  useEffect(() => {
    if (GESTURE_LOG) console.log('[trace] sw →', sw);
  }, [sw, GESTURE_LOG]);
  const pagePhase = pageSwipe?.phase ?? 'none';
  useEffect(() => {
    if (GESTURE_LOG) console.log('[trace] page →', pagePhase);
  }, [pagePhase, GESTURE_LOG]);

  // The stage wrapper: identity at rest, the zoom interpolation the moment progress moves.
  // Height is the clip (the prototype's clip-path inset), radius the rounding, translate
  // compensated for RN's centre-origin scale — all from the one tested function.
  // The live card's crop and corner — the same layout-and-raster props as `cardClipStyle`, and
  // applied on the same condition, for the same reason.
  const wrapperStyle = cardClipStyle;

  /** What the card is NOT a picture of: the chrome above the pane — the notch strip, and the
   *  search row when it is armed. Safari's cards are the page, cropped past the status bar
   *  (user, 2026-08-11, screenshots), and ours reserved that band as dead space at the top of
   *  every card. The crop grows with the flight instead of switching at either end, so the
   *  surface stays the same picture the whole way: at rest nothing is cropped (identity), and by
   *  the landing the wrapper's window into the stage is exactly the card's. */
  /** The key bar leaves at the START of the flight, not at the end of it. It used to ride the
   *  whole way into the card and then blink out with the stage's fade at the landing, which is a
   *  bar sitting on a tab card for a beat and then not (user, 2026-08-11). Gone by a quarter of
   *  the way in — and back only in the last quarter of the return, on the same curve. */
  const barFadeStyle = useAnimatedStyle(() => ({
    opacity: 1 - Math.min(prog.value / 0.25, 1),
  }));

  const cropTop = notchPad + searchRowH;
  // The chrome crop follows the FLIGHT, not the progress: a grid card is the page cropped past
  // the status bar, but a card in the hand is the whole screen made small — `holdFrame` is
  // uncropped by construction, and cropping on `prog` alone slid the content up inside the held
  // card while the hold's clip (deliberately) never closed: a grown forehead above, an exposed
  // band below with the page's own rounded corners floating inside the ring (movement 3,
  // screenshot). `prog * flight` is zero for the whole hold and exactly the old value on every
  // flight to the grid, where the two ramp together.
  const cropStyle = useAnimatedStyle(() => ({
    transform: [
      { translateY: -cropTop * prog.value * Math.max(flight.value, HOLD_REACH * prog.value) },
    ],
  }));

  // The accent ring riding the transition (§4.5) — inside the wrapper so it clips and scales
  // with it; border width divided by scale so it reads ~3pt on screen throughout.
  const ringStyle = useAnimatedStyle(() => {
    const f = zoomFrame(prog.value, dragX.value, aimAt(aimSV), stageSV.value);
    return {
      opacity: f.ringOpacity,
      borderRadius: f.radius,
      borderWidth: prog.value > 0 ? 3 / f.scale : 0,
    };
  });

  return (
    // Full-bleed root: the safe-area strips are INSIDE the stage now, so the notch and home-bar
    // bands are part of the flying surface and of every page card — they used to sit outside
    // (SafeAreaView padding, a separate scrim fading them with the zoom), which is why they
    // changed colour on their own schedule at each end of the flight and the bar-swipe cards
    // read as bare text (user, 2026-08-11: the strips are integral to the card). Content clears
    // the strips by its own padding below.
    // The one backdrop (user, 2026-08-13): `scrim`, darker than the terminal's own ground — the
    // near-black the swipe gap shows, because it is also what the terminal area paints under a
    // sliding page. The gap, the held-gesture backdrop and the open grid all sit on this same
    // surface; the grid paints no ground of its own and the cards bring theirs.
    <View style={[styles.screen, { backgroundColor: theme.scrim }]}>
      {/* No iOS edge-swipe-back on this screen: it pops to the connect screen WITHOUT running
          `leave()`'s disconnect, and a rightward card drag near the left edge triggers it by
          accident (T13). Leaving is `leave()`'s job. */}
      <Stack.Screen options={{ gestureEnabled: false }} />
      {/* The measured area both layers share: the switcher grid behind, the zooming stage
          wrapper in front, one coordinate space. */}
      <View
        style={styles.screen}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setStage({ w: width, h: height });
          stageSV.value = { w: width, h: height };
        }}>
      {/* Mounted from the moment tabs are reachable, not from the moment the zoom starts: a grid
          of N cards is N snapshot trees of up to MAX_LINES <Text> runs each, and building them on
          the frame the gesture commits is a stall on that frame — the flight then crosses an empty
          grid and the cards appear as it lands (user, 2026-08-10). It costs nothing to leave up:
          the stage wrapper in front of it is opaque and full-screen at rest, so while `closed` this
          is a static subtree nobody can see or touch. Same condition as the snapshot cache's own
          `enabled` (T14A) — the content and the views it draws warm together. */}
      {stage !== null && (sw !== 'closed' || (showTabs && connected)) && (
        <Animated.View pointerEvents="box-none" style={[StyleSheet.absoluteFill, gridInStyle]}>
        <Switcher
          theme={theme}
          stageW={stage.w}
          cell={cell}
          liveCols={liveCols}
          insetTop={insets.top}
          insetBottom={insets.bottom}
          // The flight crops its top chrome away (`cropTop`), so what is left above the first row
          // — on both sides of the crossfade — is the webview's own inset and nothing else.
          padTop={padTop}
          cards={gridCards.current}
          total={cards.length}
          query={search.on ? search.q : ''}
          hits={hits}
          onQuery={sw_onQuery}
          onClearSearch={sw_onClearSearch}
          interactive={sw === 'open'}
          zoomActive={zoomActive}
          onSelect={sw_onSelect}
          onKill={sw_onKill}
          onNew={sw_onNew}
          onDone={sw_onDone}
          onMove={sw_onMove}
          onScrollY={sw_onScrollY}
          gridRef={gridRef}
          zoomId={zoomId}
          fade={alpha}
        />
        {/* Mounted only while the zoom is live: a UIVisualEffectView re-renders its backdrop
            continuously and does NOT stop costing GPU because a parent's opacity is zero — a
            full-screen one sitting under everything that moves is a per-frame cost no CPU
            counter sees (user, 2026-08-13: laggy inside the animation). */}
        {zoomActive && (
          <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, gridBlurStyle]}>
            <BlurView intensity={30} tint="dark" style={StyleSheet.absoluteFill} />
          </Animated.View>
        )}
        </Animated.View>
      )}

      {/* The zoomed container: one scale, one flight, holding the live card and — once a swipe is
          actually running — the pages either side of it. It keeps the stage's full height and does
          NOT clip, so a card a pitch away is not cut off; each card inside crops itself. */}
      <Animated.View
        // `closing` is touchable too: the bar rides inside this, so a dead subtree is a bar that
        // ignores the finger — and the phase outlives the motion by the tail of its ease-out,
        // which is a terminal that looks landed and will not swipe (user, 2026-08-11).
        // The gesture picks the flight up from where it is (see `onSwitcherDrag`).
        pointerEvents={sw === 'closed' || sw === 'closing' || sw === 'drag' ? 'auto' : 'none'}
        style={[
          stage === null ? styles.screen : [styles.zoomBox, { width: stage.w, height: stage.h }],
          stage !== null && boxStyle,
        ]}>

      {/* The live card: the clipped, rounded, ringed terminal surface. Identity at rest — at which
          point it is the screen — and the thing the ring belongs to at every other. Its ground is
          safe again now the neighbours are drawn IN FRONT (an arriving card covers it rather than
          hiding behind it), and the flight needs it: the crop view's keyboard-pad band is bare
          otherwise, a see-through strip along the held card's bottom. */}
      <Animated.View
        style={[
          stage === null
            ? styles.screen
            : [
                styles.stageWrapper,
                { width: stage.w, height: stage.h, borderRadius: pageR, backgroundColor: theme.background },
              ],
          stage !== null && zoomActive && wrapperStyle,
        ]}>
      {/* The stage: everything above the keyboard. The popover layer fills *this* view, not the
          screen, so it clips and flies with the zoom — but it fills the border box, padding and
          all (Yoga), so what it covers is the screen and `popBase` adds the keyboard back.
          Its height is the stage's own, fixed, NOT the wrapper's: the wrapper's height is what
          the zoom animates, and a flex child of an animating height does not get clipped by it,
          it gets re-laid-out by it — the terminal area shrinking a little more every frame with
          the key bar riding the bottom edge all the way into the card. Then the surface faded
          and the card underneath showed a pane with no bar and a different vertical scale, which
          is the jolt at the end of the flight (user, 2026-08-10). Fixed here, the wrapper clips
          instead: the bar slides out of the bottom of the frame, the pane keeps its geometry the
          whole way, and the snapshot it lands on is drawing the same rows at the same size. */}
      <Animated.View
        style={[
          stage === null ? styles.screen : { height: stage.h },
          { paddingBottom: keyboardPad },
          cropStyle,
        ]}>
      {/* T14: the terminal view's search bar — up exactly while the shared search is armed. The
          same string as the switcher's field; prev/next walk the addon's occurrences; Done
          disarms both views. */}
      {search.on && (
        <View style={[styles.searchRow, { paddingTop: insets.top }]}>
          <View style={[styles.searchField, { backgroundColor: theme.surface }]}>
            <TextInput
              value={search.q}
              onChangeText={(q) => setSearch({ q, on: true })}
              placeholder="Search this window"
              placeholderTextColor={theme.placeholder}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              style={[styles.searchInput, { color: theme.foreground, fontFamily: MONO }]}
            />
            <Text style={[styles.searchCount, { color: theme.muted }]}>
              {occ === null || search.q.trim() === ''
                ? ''
                : occ.n === 0
                  ? 'none'
                  : occ.i >= 0
                    ? `${occ.i + 1}/${occ.n}`
                    : `${occ.n}`}
            </Text>
          </View>
          {(['prev', 'next'] as const).map((dir) => (
            <Pressable
              key={dir}
              disabled={occ === null || occ.n === 0}
              onPress={() => {
                const q = search.q.trim();
                if (q === '') return;
                if (dir === 'prev') terminal.current?.searchPrev?.(q);
                else terminal.current?.searchNext?.(q);
              }}
              style={({ pressed }) => [
                styles.searchStep,
                { backgroundColor: theme.surface, opacity: occ === null || occ.n === 0 ? 0.35 : 1 },
                pressed && { opacity: 0.6 },
              ]}>
              <Text style={{ color: theme.foreground, fontSize: 13, fontWeight: '600' }}>
                {dir === 'prev' ? '∧' : '∨'}
              </Text>
            </Pressable>
          ))}
          <Pressable onPress={disarmSearch} hitSlop={8}>
            <Text style={[styles.searchDone, { color: theme.accent }]}>Done</Text>
          </Pressable>
        </View>
      )}
      {/* The terminal area: the full window face. During a bar swipe the live terminal slides
          inside it as a rounded page card — notch strip to home strip, the whole screen as one
          card (user, 2026-08-11, Safari screenshots) — with the neighbour snapshots as its
          siblings and the bar floating on top. Crust behind it, as behind the switcher's cards:
          it is what shows in the page gap and behind the rounded corners. At rest the live page
          (square, flex:1) covers it entirely. */}
      <View style={[styles.termArea, { backgroundColor: theme.scrim }]}>
      {/* The pane's own breathing room. It is also what makes the zoom's crossfade seamless: a
          card's snapshot is inset by exactly this much seen through the zoom (switcher-model
          derives one from the other), so the text does not move when the surface hands over.
          The top and bottom insets carry the safe-area strips and the floating bar's ground —
          the card face owns those bands now. */}
      <Animated.View
        style={[
          styles.termSlide,
          {
            backgroundColor: theme.background,
            paddingTop: notchPad,
            paddingHorizontal: padH,
            // The remainder makes the box an exact multiple of the cell, so the webview's own
            // top inset stays ~0 and the first row never moves — see rowRemainder.
            paddingBottom: padBottom + barPad + rowRemainder,
            // The resting corner, stated rather than left to the absence of one — what the view
            // wears before the first frame, and what the code says the page's corner IS. It is
            // not the mechanism that keeps it right (see `cardRadiiStyle`'s note on why the style
            // is no longer detached); stating it twice is deliberate, and the two agree by
            // construction: `zoomFrame`'s radius at t=0 is `SCREEN_R * stage.w`, which is
            // `pageRadius`, and `pageRB` carries the same `kbSquare` the worklet applies.
            borderTopLeftRadius: pageR,
            borderTopRightRadius: pageR,
            borderBottomLeftRadius: pageRB,
            borderBottomRightRadius: pageRB,
          },
          cardRadiiStyle,
        ]}>
      {terminalView}
      {/* see pageEdgeStyle — the live page's card edge while a swipe is on */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.pageEdge,
          { borderColor: theme.accent, borderRadius: pageR, borderBottomLeftRadius: pageRB, borderBottomRightRadius: pageRB },
          cardRadiiStyle,
          pageEdgeStyle,
        ]}
      />
      </Animated.View>


      </View>
      </Animated.View>

      {/* The transition's accent ring — absoluteFill of the CARD, deliberately outside the crop
          view. Inside it the ring rode the crop's upward translate: its top line left through the
          wrapper's clip and its bottom line hovered above the card's true edge, with the page's
          square keyboard-cut corners poking out beneath (movement 3, screenshot). */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderColor: theme.accent }, ringStyle]}
      />
      </Animated.View>

      {/* The neighbouring windows, a page-pitch to either side. They JOIN when the swipe does, not
          when the card lifts: a card held up on its own has no row around it until the finger
          actually starts moving sideways (user, 2026-08-13) — which is exactly `pageSwipe`, the
          state a horizontal swipe creates.

          AFTER the live card, and outside it. Behind it they were laid out correctly — 420×912 at
          the right offset, every number checked on device — and never drawn, because the live card
          is a full-stage view in front of them (user, 2026-08-13, four screenshots and three
          probes to establish that the geometry was never the problem). Outside it because a child
          of the card shares its clip, which is the whole width of the card once it lifts. Being in
          front costs nothing: they are a pitch away and never overlap it. The bar moved out with
          them, so it still draws over every card in the row rather than under the arriving one.

          Gone once the release commits to the GRID (`opening`), or they would fly in one pitch
          behind the card: tabs arriving in pairs (user, 2026-08-13, screenshot). `closing` keeps
          them: that is the spring back from a lift, the slide can still be live under it, and
          sitting the phase out unmounted them mid-slide — the flash (trace, movement 1).

          The exits are conditional on purpose: releasing a HELD card (no page swipe live) sends
          the neighbours back out to their sides so the main card flies to the grid alone (user,
          2026-08-13) — but a hop's landing must stay an instant cut, because the landed card sits
          exactly over the settle overlay's identical picture, and sliding it away would show the
          same tab twice, one peeling off the other. */}
      {stage !== null && showTabs && connected && (
        <>
          {anchor > 0 && (
            <Animated.View pointerEvents="none" style={[
                styles.stageWrapper,
                { width: stage.w, height: stage.h, borderRadius: pageR, backgroundColor: theme.background },
                prevCardStyle,
                zoomActive && cardClipStyle,
              ]}>
              <Animated.View style={[{ height: stage.h, paddingBottom: keyboardPad }, cropStyle]}>
                <NeighborPage snap={neighbour(-1)} stageW={stage.w} theme={theme} cell={cell} insets={paneInsets} liveCols={liveCols} radii={cardRadiiStyle} />
              </Animated.View>
              {/* The card's outline, at the CARD's bounds — inside the crop view it rode the
                  crop's upward translate and clipped out at the top, the ring bug over again
                  (user, 2026-08-13, "outlines bugging out"). */}
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.pageEdge, { borderColor: theme.accent }, cardRadiiStyle]}
              />
            </Animated.View>
          )}
          {/* One past the last window is the new-tab page: no snapshot, so it slides in as the
              empty pane the shell about to be born will draw into. A FLAT swipe gets it, exactly
              as it always did — that blank page is what covers the moment the new shell is being
              drawn, and taking it away left the arrival blinking dark with the card's accent edge
              standing on it (user, 2026-08-13). A card held in the air gets nothing on this side:
              there the new tab is not a page you slide onto.
              MOUNTED for both, and hidden for one — the difference is `heldAir` inside the style,
              not a condition here. Unmounting it on a React commit is a frame or two behind the
              worklet that reveals the row, which is precisely long enough to see the page appear
              and then go (user, 2026-08-13). Either way the slot is reachable and births a
              window; this is only about what is drawn. */}
          {anchor < cards.length && (
            <Animated.View pointerEvents="none" style={[
                styles.stageWrapper,
                { width: stage.w, height: stage.h, borderRadius: pageR, backgroundColor: theme.background },
                nextCardStyle,
                zoomActive && cardClipStyle,
              ]}>
              <Animated.View style={[{ height: stage.h, paddingBottom: keyboardPad }, cropStyle]}>
                <NeighborPage snap={neighbour(1)} stageW={stage.w} theme={theme} cell={cell} insets={paneInsets} liveCols={liveCols} radii={cardRadiiStyle} />
              </Animated.View>
              {/* The card's outline, at the CARD's bounds — inside the crop view it rode the
                  crop's upward translate and clipped out at the top, the ring bug over again
                  (user, 2026-08-13, "outlines bugging out"). */}
              <Animated.View
                pointerEvents="none"
                style={[StyleSheet.absoluteFill, styles.pageEdge, { borderColor: theme.accent }, cardRadiiStyle]}
              />
            </Animated.View>
          )}
        </>
      )}

      </Animated.View>

      {/* Everything from here down is SCREEN-STATIC chrome, deliberately outside the box the
          cards ride in: the box carries the swipe itself now (no page/card handover — see
          cardCarry's removal), so anything inside it would slide with every hop. The settle
          overlay is static for the same reason: it covers the stage while the box snaps home
          beneath it. */}

      {/* The bar floats over the card face's bottom band — absolute, so the cards can run the
          full window height under it. Its own glass pills carry no full-width ground, so the
          card's background (or the crust gap, mid-swipe) shows through around them. */}
      <Animated.View
        style={[
          { position: 'absolute', left: 0, right: 0, bottom: keyboardPad + insets.bottom },
          barFadeStyle,
        ]}>
      <KeyBar
        theme={theme}
        decckm={modes.decckm}
        bracketedPaste={modes.bracketedPaste}
        sendBytes={kb_sendBytes}
        open={open}
        onOpenChange={setOpen}
        onHeight={kb_onHeight}
        focusSignal={focusSignal}
        sending={sending}
        // §4.5: tabs are reachable only with tmux present AND the config applied AND a client
        // attached. False no longer removes the button — it greys it, and the tap explains itself
        // (`tabsHint`, user 2026-08-12).
        showTabs={showTabs}
        onTabsTap={kb_onTabsTap}
        onZoomGrab={kb_onZoomGrab}
        onZoomArm={kb_onZoomArm}
        onZoomEnd={kb_onZoomEnd}
        // T11: the page-slide window hop rides the horizontal bar pan — where there is tmux to
        // hop through; without it the axis is silence, like the tabs button (§7).
        onBarSwipe={showTabs ? kb_onBarSwipe : undefined}
        // The pan's per-frame writes happen on the UI thread against these (perf: the JS thread
        // stalls 40-300ms under load and a runOnJS pan hitched with it). A STABLE object: the
        // bar memoizes its gesture on it, and an inline literal re-serialized the worklets and
        // re-attached the recognizer on every render — mid-gesture (user: "hitching even worse").
        panSV={panBridge}
        pills={pillsProp}
      />
      </Animated.View>

      {/* The context band (§4.4, "Accessory"): a 52pt opaque band at `popBase`, resting as a
          44pt identity chip on the terminal's trailing edge and unrolling leftward into a row of
          caps. Absolute, so it costs no vertical space however many caps a recipe has — the
          agent's thirteen and the running recipe's three are the same 52pt. It fades with the
          bar during the switcher's flight. */}
      {/* The layer stays mounted whatever the recipe is: the band's own exit animation needs a
          parent that outlives it, or a finished process takes the band off screen in one frame
          instead of the 180ms glide down. */}
      <Animated.View
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, barFadeStyle]}>
        {recipe !== null && (
          <RibbonAccessory
            theme={theme}
            recipe={recipe}
            startedAt={ribbonCore.startedAt}
            busy={sending}
            bottom={popBase}
            width={stage?.w ?? 0}
            padH={padH}
            open={rbOpen}
            onOpenChange={(next) => {
              if (next) console.log('[ribbon] open', recipe.proc);
              setRbOpen(next);
            }}
            onCap={onRibbonCap}
          />
        )}
      </Animated.View>

      {/* The popover layer: outside-tap scrim over everything (bar included, as in the
          prototype), popovers anchored `popBase` up. That base carries the keyboard itself:
          Yoga positions an absolute child off the *border* box, not the padding box (see
          `positionAbsoluteChild` — border and margin are subtracted, padding is not), so this
          layer's bottom edge is the screen's, not the stage's padded one. Without the pad in
          the anchor the popover opened `barHeight` up from the screen bottom — behind the
          keyboard, invisible (user, 2026-08-10). */}
      {open !== 'none' && (
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen('none')} />
          {open === 'arrows' ? (
            <ArrowsPopover
              theme={theme}
              decckm={modes.decckm}
              bottom={popBase}
              sendBytes={send}
            />
          ) : open === 'tabsHint' ? (
            <TabsHintPopover
              theme={theme}
              bottom={popBase}
              text={tabsHint(tmux.present, usesTmux(settings))}
            />
          ) : open === 'clipboard' ? (
            <ClipboardPopover
              theme={theme}
              bottom={popBase}
              bracketedPaste={modes.bracketedPaste}
              sendBytes={send}
              onClose={() => setOpen('none')}
            />
          ) : (
            <BarMenu
              theme={theme}
              bottom={popBase}
              onUpload={startUpload}
              onOpenSettings={openSettings}
            />
          )}
        </View>
      )}
      </View>

      {pendingUpload !== null && (
        <UploadSheet
          theme={theme}
          host={host}
          initialDir={lastUploadDir}
          suggestedName={pendingUpload.suggestedName}
          onCancel={() => setPendingUpload(null)}
          onSave={saveUpload}
        />
      )}

      {settingsOpen && (
        <SettingsSheet
          theme={theme}
          onClose={closeSettings}
          onDisconnect={() => {
            setSettingsOpen(false);
            void leave();
          }}
        />
      )}

      {session.status !== 'connected' && (
        <Status session={session} theme={theme} onSetup={leave} />
      )}
    </View>
  );
}

/**
 * What the surface is aimed at this frame — the hold pose under the finger, the slot once
 * released, interpolated by `flight` (see `aimFrame`). Every style that draws the zoom reads the
 * aim rather than the slot, so the card, its ring and its neighbours agree by construction.
 *
 * At MODULE scope, taking its shared values as an argument, because four `useAnimatedStyle`
 * worklets call it. Reanimated derives a mapper's dependencies from its worklet's closure, and the
 * plugin mints a new function object for a worklet declared in a component body on every render —
 * so an `aim` living inside the component restarted `boxStyle`, `cardClipStyle`, `cardRadiiStyle`
 * and `ringStyle` on every render of the screen.
 *
 * This was hoisted once before and reverted, because the keyboard-up page came back with rounded
 * bottom corners. That was the wrong culprit: the corner was `cardRadiiStyle` being DETACHED at
 * rest and leaving its last write on the view, and the per-render restart had been papering over
 * it by rewriting the radius on every commit. The style is attached for good now (see its note),
 * so the papering-over is not needed — and with four views permanently attached, a mapper that
 * restarts every render rewrites raster props on all four every render, which is worse than what
 * it was hiding. Stable identity here, one write when something actually moves.
 */
function aimAt(sv: {
  stage: SharedValue<{ w: number; h: number }>;
  slot: SharedValue<Frame>;
  prog: SharedValue<number>;
  flight: SharedValue<number>;
}): Frame {
  'worklet';
  // Held: slot-SIZED by the pull's reach, screen-centred (`heldFrame`). Released: the flight
  // carries whatever pose the hold reached into the real slot.
  const held = heldFrame(sv.stage.value, sv.slot.value, HOLD_REACH * sv.prog.value);
  return aimFrame(held, sv.slot.value, sv.flight.value);
}

/* --- T11: the page-slide's cards --- */

/** A neighbour's captured pane, parsed for the Snapshot renderer — the switcher's snapshot of
 *  that window. `null` only for a window nothing has captured yet: a blank page card. */
type PageSnap = Snap | null;

/** The name pill for the slot past the last tab — the one that births a window on commit. */
const NEW_TAB_NAME = 'New Tab';

type PageSwipe = {
  names: string[];
  /** Grid position of the current window at swipe start. */
  pos: number;
  /** Where a commit is headed (= `pos` until the release decides). */
  target: number;
  /** drag = finger down; anim = commit/cancel slide running; settle = snapshot holding the
   *  screen while tmux redraws the PTY under it. */
  phase: 'drag' | 'anim' | 'settle';
  /** The page the commit landed on, kept for the settle overlay — `pos` has moved to `target` by
   *  then, so which side it came from is no longer derivable. Moving `pos` is the point: the name
   *  pills read their position from it, and leaving it behind snapped the strip back to the tab
   *  just left for the length of the settle, which is a second flicker of the wrong name before
   *  the keys return (user, 2026-08-10). */
  settled: PageSnap;
  /** The pane insets AS OF the settle's mount — the deferred ribbon swap changes the live ones
   *  a layout later, and the overlay must not move with them (see settleBarSwipe). */
  settleInsets: { top: number; side: number; bottom: number } | null;
};

/** The captured pane at page size — T10's Snapshot renderer, fitted to the pane's true columns
 *  inside the box they are drawn in. A page card rides beside the live terminal at 1:1, so every
 *  number here is the terminal's own: its insets, all three of them, and its cell. Taking the
 *  plain gap for the top instead of the terminal's row remainder put the page's text 5.5pt below
 *  the live one, which is a jump at each end of the slide (user, 2026-08-10, two photographs). */
function PageContent({
  snap,
  stageW,
  theme,
  cell,
  insets,
  liveCols,
}: {
  snap: PageSnap;
  stageW: number;
  theme: Theme;
  cell: { w: number; h: number };
  insets: { top: number; side: number; bottom: number };
  /** The live pane's columns — the cap, exactly as on the switcher's cards. */
  liveCols: number;
}) {
  if (snap === null) return null;
  // Capped at the live pane's width for the same reason the grid's cards are: `window-size
  // latest` leaves a window at the size of the last client that DISPLAYED it, so a tab not
  // opened from this phone is still 80-odd columns wide, and fitting those into the page's ~49
  // drew the whole page at half type — the swipe landing on a shrunken pane (user, 2026-08-11,
  // screenshot). This page is a preview of a pane tmux is about to reflow to this client.
  const cols = liveCols > 0 ? Math.min(snap.cols, liveCols) : snap.cols;
  // Scale 1: a page card rides beside the live terminal, not shrunk into anything.
  return (
    <View
      style={{
        flex: 1,
        paddingTop: insets.top,
        paddingHorizontal: insets.side,
        paddingBottom: insets.bottom,
      }}>
      <Snapshot
        lines={snap.lines}
        theme={theme}
        {...snapshotType(cell, 1, cols, stageW - 2 * insets.side)}
      />
    </View>
  );
}

/** One neighbouring window's page. The pitch, the swipe offset and the zoom all live on the card
 *  wrapper around this (`usePageCardStyle`) — this is just the picture inside it. */
function NeighborPage({
  snap,
  stageW,
  theme,
  cell,
  insets,
  liveCols,
  radii,
}: {
  snap: PageSnap;
  stageW: number;
  /** The shared card-corner style while the zoom is live, null at rest (see `cardClipStyle`). */
  radii: AnimatedStyle<ViewStyle> | null;
  theme: Theme;
  cell: { w: number; h: number };
  insets: { top: number; side: number; bottom: number };
  liveCols: number;
}) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        styles.page,
        { backgroundColor: theme.background, borderRadius: pageRadius(stageW) },
        radii,
      ]}>
      <PageContent
        snap={snap}
        stageW={stageW}
        theme={theme}
        cell={cell}
        insets={insets}
        liveCols={liveCols}
      />
    </Animated.View>
  );
}

/** The three not-connected states (§4.9). Each says what happened, in one sentence, and offers the
 *  only two moves there are: try again, or go back to Setup. */
function Status({
  session,
  theme,
  onSetup,
}: {
  session: Session;
  theme: Theme;
  onSetup: () => void;
}) {
  const button = (label: string, colour: string, textColour: string, onPress: () => void) => (
    <Pressable key={label} onPress={onPress} style={[styles.action, { backgroundColor: colour }]}>
      <Text style={[styles.actionLabel, { color: textColour }]}>{label}</Text>
    </Pressable>
  );

  const forget = () =>
    Alert.alert(
      'Forget this host key?',
      'The next connection will ask you to trust a key again — and if something is answering in ' +
        'the machine’s place, that is the key you would be trusting.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Forget', style: 'destructive', onPress: () => forgetPinnedHostKey() },
      ],
    );

  // Nerd Font glyphs: the font is bundled and already loaded, so this is an icon without an icon
  // set. \uf1e6 is a plug, \uf071 a warning triangle — written as escapes so a copy of this file
  // through a tool that does not carry the private-use plane still says what it meant.
  const where = endpoint(getSettings());
  const face =
    session.status === 'disconnected'
      ? {
          glyph: '\uf1e6',
          tint: theme.muted,
          headline: 'Disconnected',
          sentence: `The connection to ${where} ended. Backgrounding the app does that every time.`,
        }
      : session.status === 'failed'
        ? {
            glyph: '\uf071',
            tint: theme.warning,
            headline: 'Cannot connect',
            sentence: session.message,
          }
        : {
            glyph: null,
            tint: theme.muted,
            headline: 'Connecting',
            sentence: `Opening a shell on ${where}.`,
          };

  return (
    <View style={[styles.status, { backgroundColor: theme.background }]}>
      {face.glyph === null ? (
        <ActivityIndicator size="large" color={theme.accent} />
      ) : (
        <Text style={[styles.glyph, { color: face.tint }]}>{face.glyph}</Text>
      )}
      <Text style={[styles.headline, { color: theme.foreground }]}>{face.headline}</Text>
      <Text style={[styles.sentence, { color: theme.muted }]}>{face.sentence}</Text>

      <View style={styles.actions}>
        {session.status !== 'connecting' &&
          button('Reconnect', theme.accent, theme.onAccent, reconnect)}
        {session.status === 'failed' &&
          session.mismatch &&
          button('Forget host key', theme.danger, theme.onAccent, forget)}
        {button('Setup', theme.surface, theme.foreground, onSetup)}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  // T14's terminal-side search bar (design: 38pt field, 12pt radius; Android 16dp per §5d).
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  searchField: {
    flex: 1,
    height: 38,
    borderRadius: Platform.OS === 'android' ? 16 : 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
  },
  searchInput: { flex: 1, fontSize: 13, paddingVertical: 0 },
  searchCount: { fontFamily: MONO, fontSize: 11 },
  searchStep: {
    width: 34,
    height: 38,
    borderRadius: Platform.OS === 'android' ? 16 : 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchDone: { fontSize: 15, paddingHorizontal: 2 },
  stageWrapper: { position: 'absolute', top: 0, left: 0, overflow: 'hidden' },
  /** The shared zoom container — deliberately NOT clipping: the cards beside the live one live a
   *  pitch outside it and each brings its own crop. */
  zoomBox: { position: 'absolute', top: 0, left: 0 },
  terminal: { flex: 1 },
  termArea: { flex: 1 },
  termSlide: { flex: 1, overflow: 'hidden' },
  page: { overflow: 'hidden' },
  /** The card edge during a swipe — the ZOOM's ring, deliberately: the hop and the flick start
   *  from the same grab, so their outline is one outline (user, 2026-08-13). Same accent, same
   *  3pt the ring draws; it was a grey 1pt hairline, which read as a different gesture. */
  pageEdge: { borderWidth: 3 },
  status: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    padding: 32,
  },
  glyph: { fontFamily: MONO, fontSize: 44 },
  headline: { fontSize: 24, fontWeight: '700' },
  sentence: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: 8 },
  action: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 12 },
  actionLabel: { fontSize: 16, fontWeight: '600' },
});
