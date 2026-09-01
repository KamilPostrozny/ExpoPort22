import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, Stack, useNavigation } from 'expo-router';
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
import { endpoint, getSettings, pollSession, updateSettings, useSettings, usesTmux } from '@/settings';
import {
  SEARCH_DEBOUNCE_MS,
  normalizeQuery,
  searchLabel,
  windowSurvives,
  type WindowSearch,
} from '@/search-model';
import Switcher, {
  Snapshot,
  useScrollbackSearch,
  useSwitcherCards,
  type Card,
  type Snap,
} from '@/switcher';
import {
  CARD_RING,
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
import { CENTER, PRESSED, RADIUS, SEARCH_RADIUS, SPACE, TEXT, leading } from '@/style';
import TerminalView, { type TerminalHandle } from '@/terminal';
import {
  killWindow,
  moveWindow,
  newWindow,
  searchWindow,
  selectWindow,
  useTmux,
} from '@/tmux';
import { tabsAvailable, tabsHint, type TmuxWindow } from '@/tmux-model';
import { MONO, rgba, SANS, SANS_BOLD, SANS_SEMIBOLD, type Theme } from '@/theme';
import { pick, sendFile, useUploadBusy, type UploadKind } from '@/upload';
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
  /** The key row's height alone — what the pane insets by. The chord strip is deliberately not in
   *  it: it overlays the terminal like a popover rather than costing it rows (see
   *  `KeyBarProps.onRowHeight`). Equal to `barHeight` whenever Ctrl is off, which is most of the
   *  time; the two only part while the strip is up. */
  const [rowHeight, setRowHeight] = useState(60);
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
  /** The pad the last keyboard event ANNOUNCED, whether or not it was rendered. The listeners below
   *  freeze while a zoom owns the stage's box, but the freeze only needs to skip the render — the
   *  record costs nothing and is the one honest answer to "where is the keyboard now" for the doors
   *  that thaw the pad afterwards. `Keyboard.metrics()` cannot answer it: it is the last frame the
   *  keyboard was SHOWN at, so mid-hide it still reports the departing one (see `syncPad`). */
  const announcedPad = useRef(0);
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
  /** Thaw: render the pad the last event announced — for the doors that unfreeze with no keyboard
   *  move left to re-report it. It used to ask `Keyboard.metrics()` where the keyboard is, which is
   *  a question that API does not answer mid-hide (it is the last SHOWN frame; RN clears
   *  `_currentlyShowing` only on `keyboardDidHide`, at the END of the hide). Every door here thaws
   *  during exactly that window — the grid's open dismissed the keyboard — so `metrics()` wrote the
   *  departing keyboard's overlap back and the bar sat raised over dead space until the backstop
   *  below corrected it (286 → 0, device probe 2026-08-15). Platform-free: both listeners record. */
  const syncPad = () => setKeyboardPad(announcedPad.current);
  // Category (1), an API that exists on one platform only: Android has no
  // `keyboardWillChangeFrame`, so the pad is driven off `keyboardDidShow`/`Hide` instead — the same
  // pad, the same subtraction, the same freeze while a zoom owns the box. What is NOT true any more
  // is the reason this used to be an iOS-only effect: "Android's activity window resizes itself for
  // the IME" holds under `adjustResize`, and this app is edge-to-edge, where it does not. Measured
  // on the emulator 2026-08-16 with Gboard up: the IME inset starts at y=1517 and the activity's
  // own frame is still [0,0][1080,2400] — so nothing shrank, the key bar sat under the keyboard,
  // and the shell was never told it had lost the rows. `did` rather than `will` costs the head
  // start iOS gets; there is no earlier event to take.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const pad = (height: number) => {
      announcedPad.current = height; // recorded even while frozen — `syncPad` thaws off this
      if (swRef.current !== 'closed') return;
      // No `- insets.bottom` here, and that is not a slip: the bar is placed at
      // `keyboardPad + insets.bottom`, and Android's reported height already stops at the top of
      // the gesture strip. Measured on the emulator (density 420): RN says 312.4dp while the
      // system's own IME inset is 883px = 336.4dp — the 24dp between them IS `insets.bottom`, so
      // subtracting it again parked the bar a gesture-strip's worth under the keyboard. iOS
      // subtracts because it reports a screen-space frame that runs to the very bottom edge; same
      // pad, two conventions.
      setKeyboardPad(height);
      setKbSettle(false);
    };
    const subs = [
      Keyboard.addListener('keyboardDidShow', (e) => pad(e.endCoordinates.height)),
      Keyboard.addListener('keyboardDidHide', () => pad(0)),
    ];
    return () => subs.forEach((sub) => sub.remove());
  }, [insets.bottom]);
  useEffect(() => {
    // Category (1): `keyboardWillChangeFrame` has no Android twin — the effect above is that
    // platform's answer. Note the asymmetry with `src/upload-sheet.tsx`, which pads on Android for
    // its own reason: a `statusBarTranslucent` Modal window does not adjustResize either.
    if (Platform.OS !== 'ios') return;
    const subs = [
      Keyboard.addListener('keyboardWillChangeFrame', (e) => {
        // The stage's bottom is the window's bottom less the safe-area strip SafeAreaView already
        // pads; only what the keyboard covers beyond that is padding of ours.
        // A `screenY` of 0 is not a keyboard covering the whole window, it is a frame reported
        // with no position — the sheets' Modals raise one on the way in and out. Taking it at face
        // value padded the entire stage away for a frame or two (seen on device).
        if (e.endCoordinates.screenY <= 0) return;
        const overlap = Dimensions.get('window').height - e.endCoordinates.screenY;
        // Both edges off this one event: a keyboard parked at or below the window's bottom edge
        // overlaps nothing, which is the hide. `keyboardWillHide` says the same thing later.
        const next = overlap > 0 ? Math.max(0, overlap - insets.bottom) : 0;
        announcedPad.current = next; // recorded even while frozen — `syncPad` thaws off this
        // The zoom owns the stage's box while it runs. The tabs-tap dismisses the keyboard in
        // the same tick the flight starts, and this event lands (often more than once) before
        // `holdSize` has marshaled into the webview — each pad change resized the webview and
        // the observer refit xterm mid-flight, which is the hitching (device, 2026-08-11).
        // Frozen here, the box never moves; `finishClose` reconciles the pad on the way out.
        if (swRef.current !== 'closed') return;
        setKeyboardPad(next);
        setKbSettle(false); // the keyboard we were waiting for: this is the final geometry
      }),
      // This used to be the backstop that CORRECTED a pad `syncPad` had misread mid-hide (the
      // probe walk saw 286 → 0 on every exit from the grid — the bar sitting raised for the rest
      // of the hide). `syncPad` reads the announced record now and never writes the 286, so what
      // is left here is the one hole that record has: `keyboardWillChangeFrame` above drops any
      // frame reported with `screenY <= 0`, which the sheets' Modals raise on the way in and out.
      // The end of a hide is unambiguous — no keyboard, no pad — so it closes that hole for both
      // the render and the record.
      Keyboard.addListener('keyboardDidHide', () => {
        announcedPad.current = 0;
        // Same freeze as above — the zoom owns the stage's box while it runs, and `finishClose`
        // thaws on the way out.
        if (swRef.current !== 'closed') return;
        setKeyboardPad(0);
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
  // `tmux.session` rather than `tmux.attached`: tabs exist only for a session the app can NAME, and
  // so scope its window commands to (BUGS "The switcher lists — and can kill — windows of a session
  // the phone is not attached to"). It goes null the moment our session does — which is what the
  // teardown below hangs on.
  const showTabs = tabsAvailable(tmux.present, tmux.session);
  // T11's page-slide state lives up here with the switcher's: the snapshot cache has to know
  // when a slide is running, and it is the same "nothing may change while something is moving"
  // rule the zoom needs. Everything else about the slide is in its own block below.
  const [pageSwipe, setPageSwipe] = useState<PageSwipe | null>(null);
  /** Mid-zoom, mid-slide: the moving views must not have their content swapped underneath them. */
  const frozen = (sw !== 'closed' && sw !== 'open') || pageSwipe !== null;
  const { cards, setCards, refresh, refreshCard, listFailed } = useSwitcherCards(
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
          // A resize re-rolls the search: the host reflows the pane for the new size, so every
          // on-screen hit position the last capture reported is about to be wrong (a keyboard open
          // takes eighteen rows off the bottom, and the marks would stay where they were). Only
          // when a search is armed, and only on a size that actually moved — this callback also
          // fires as a re-report that changes nothing.
          if (searchRef.current.on && (was === null || was.cols !== cols || was.rows !== rows))
            setSearchFit((n) => n + 1);
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
          // On the LAST report of a settling, not on every one of them. `rowRemainder` is rolled
          // from `cell.h`, and `cell.h` arrives in this very callback — so the fit that first
          // measures a cell is computed against the remainder of the old one and reports the whole
          // leftover, and the fit after it is still ahead of the layout that carries the new
          // remainder across. That is the boot handshake (8.1 → 8.8 → 0.8 on the emulator,
          // 2026-08-16) and a font-size change is the same three steps. Warning on the middle of it
          // is what taught the reader to skip the line — it cried once per connect and the day it
          // meant something nobody would have looked.
          //
          // The bug it exists for does not settle: 17pt of an 18pt cell, fit after fit, on every
          // keyboard close. So the report arms it and the next report disarms it; only a box still
          // off with nothing following says anything.
          clearTimeout(offBoxTimer.current);
          if (__DEV__ && was !== null && topInset >= 2 && cellH > 0)
            offBoxTimer.current = setTimeout(() => {
              console.warn(
                `[terminal] box off by ${topInset.toFixed(1)}pt of a ${cellH.toFixed(1)}pt cell — ` +
                  'the stage and the webview disagree; see `rowRemainder`',
              );
            }, 600); // 4× the 150ms report throttle, so a settling never outruns it
          lastFit.current = { cols, rows, top: topInset };
          if ((sw !== 'closed' && sw !== 'open') || kbSettle) {
            // Gated: this branch's condition is "a zoom is in flight", so it only ever logged
            // DURING a gesture — a Metro socket write on the JS thread per refit, animating.
            if (GESTURE_LOG) console.log('[terminal] size held, not sent:', cols, '×', rows);
            return;
          }
          // Same object back when nothing moved, so React bails out instead of re-rendering: a
          // re-report carries the cell it already carried, and a fresh `{w,h}` is a new identity
          // every time — which re-ran this screen, and `rowRemainder` and the insets with it, once
          // per switcher open for a cell that had not changed.
          if (cellW > 0 && cellH > 0)
            setCell((c) => (c.w === cellW && c.h === cellH ? c : { w: cellW, h: cellH }));
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
   * edit the same string, and disarming from either side clears both.
   *
   * BOTH halves are host-side now (BUGS.md §6): the grid greps every window for its first hit, the
   * terminal asks the same host for every occurrence in the window in front of the user. The two
   * searches finally have the same reach — tmux's whole history — where the terminal's used to walk
   * xterm's buffer and see the visible screen and nothing else. */
  const [search, setSearch] = useState({ q: '', on: false });
  const searchRef = useRef(search);
  searchRef.current = search;
  /** What the host last answered for the terminal's search: the true count for the window, and the
   *  hits that are on the screen. `null` until it answers, `'failed'` when it could not be asked —
   *  which is NOT "no hits" (§ the grid's `SearchAnswer`, same distinction). */
  const [found, setFound] = useState<WindowSearch | 'failed' | null>(null);
  /** Which of the ON-SCREEN hits the steppers are standing on. The off-screen ones are counted and
   *  reported and cannot be stepped to — see `stepHit`. */
  const [hitAt, setHitAt] = useState(0);
  /** Bumped by a resize that moved the row count (see `onResize`): the pane reflows on the host,
   *  so the hit positions have to be asked for again. */
  const [searchFit, setSearchFit] = useState(0);
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
    setFound(null);
    setHitAt(0);
  };

  /**
   * The window a hop is waiting to hear about. `select-window` is asynchronous, so for a beat or
   * two after a commit the poll still describes the window we LEFT — which revived the old
   * window's process on the new tab (user, 2026-08-16: "the pill stayed"). An answer about any
   * other window is stale until the one we hopped to shows up.
   *
   * It clears itself three ways: the expected window answers, three answers go by without it (the
   * hop did not take, and reality wins), or the recipe is set by the hop itself. So unlike a
   * standing filter this cannot strand the band on a window you are no longer looking at.
   */
  const awaiting = useRef<{ index: number; tries: number } | null>(null);
  const awaitWindow = (index: number) => {
    awaiting.current = { index, tries: 0 };
  };

  /** The active window's position in `list` — tmux's fresher poll first, the list's flag second.
   *  Unless a hop is still awaiting confirmation: then the poll is the STALE one (it names the
   *  window we left), and the window we hopped to is the answer. Reading the poll there put the
   *  next swipe back at the pre-hop position — from the last tab, left-then-right hopped to the
   *  phantom slot and birthed a window instead of returning (user, 2026-08-26). */
  const activePosIn = (list: Card[]) => {
    const wait = awaiting.current;
    const byIndex = list.findIndex((c) => c.win.index === (wait === null ? tmux.windowIndex : wait.index));
    if (byIndex >= 0) return byIndex;
    const byFlag = list.findIndex((c) => c.win.active);
    return byFlag >= 0 ? byFlag : 0;
  };
  /** Over the *visible* list: with a search armed, that is the grid the zoom aims into. The bar
   *  swipe keeps the full list — it hops real neighbours, not the filtered ones. */
  const activePos = () => activePosIn(visibleCards);
  /** The window sitting in a visible slot — the aim and the card to hide are the same window. */
  const idAt = (pos: number) => visibleCards[pos]?.win.id ?? null;

  /* --- the terminal's own search: one host grep per settled keystroke (BUGS.md §6) --- *
   *
   * The window the user is looking at, by tmux's `@N` — never `:index`, which slides under a
   * renumber and greps somebody else's scrollback (`target`'s note). The full list, not the
   * filtered one: what is searched is the window in front, whether or not the grid would keep it.
   *
   * Every handle call is `?.()` on the METHOD, not just the ref: expo/dom's native proxy answers
   * `undefined` for every imperative prop until the webview boots and posts its registration — a
   * plain call in that window is a TypeError that unmounts the screen (found on device).
   */
  const activeWinId = cards[activePosIn(cards)]?.win.id ?? null;
  /** The hits over the bridge, which carries JSON: two parallel arrays, not one of objects (see
   *  `showHits`). */
  const pushHits = (hits: WindowSearch['onScreen'], len: number, active: number) =>
    terminal.current?.showHits?.(
      hits.map((h) => h.row),
      hits.map((h) => h.col),
      len,
      active,
    );
  const searchEverArmed = useRef(false);
  useEffect(() => {
    if (!connected) return;
    const q = search.on ? search.q.trim() : '';
    if (q === '') {
      if (searchEverArmed.current) {
        searchEverArmed.current = false;
        terminal.current?.searchOff?.();
        setFound(null);
        setHitAt(0);
      }
      return;
    }
    searchEverArmed.current = true;
    // No tmux, no history to reach — and no way in either: the search is armed from the switcher's
    // field, and the switcher only exists under tmux (`tabsAvailable`). Belt and braces.
    if (!tmux.present || activeWinId === null) return;
    // Not while the grid is up: the grid is running its own greps at that moment (one per window,
    // three channels' worth) and the terminal's count is behind an opacity-0 stage. It re-fires on
    // the way out, which is also how landing in ANOTHER window re-searches — `activeWinId` changes
    // and this effect is keyed on it.
    if (sw !== 'closed') return;
    // The same settled keystroke the grid greps on — one exec per query, not one per character.
    let live = true;
    const timer = setTimeout(() => {
      void searchWindow(activeWinId, q)
        .then((answer) => {
          if (!live) return;
          console.log(
            `[search] ${JSON.stringify(q)} in ${activeWinId}:`,
            answer.total, 'in the window,', answer.onScreen.length, 'on screen',
          );
          setFound(answer);
          setHitAt(0);
          pushHits(answer.onScreen, q.length, 0);
        })
        .catch((error) => {
          if (!live) return;
          // Said, not swallowed: a search that never reached the host must not read as "no hits
          // here" (§ disabled-over-hidden, and the grid's `'failed'` for the same reason).
          console.log('[search] host search failed:', error);
          setFound('failed');
          terminal.current?.searchOff?.();
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `pushHits` is a render-fresh closure
    // over a ref, called from the timer; keying the effect on it would re-fire on every render.
  }, [search.on, search.q, connected, tmux.present, activeWinId, sw, searchFit]);

  /** ∧/∨: the next on-screen hit, wrapping. The off-screen ones are NOT stepped to — nothing this
   *  side can do would show them (the pane's history is tmux's, and the alternate buffer does not
   *  scroll), and moving the label onto a hit the user cannot see is the one thing worse than not
   *  moving at all. The count says how many there are and where this one sits among them; ∧ at the
   *  first reachable hit is greyed by `stepsLive` below, which is the honest end of the walk.
   *
   *  ponytail: reaching them means driving tmux's copy-mode — `copy-mode -t @N` plus
   *  `send-keys -X search-backward`, which tmux does natively and highlights in the pane. That
   *  hands the pane's keyboard to copy-mode and needs its own exit, so it is a feature, not a
   *  branch of this one. */
  const stepHit = (dir: 1 | -1) => {
    if (found === null || found === 'failed' || found.onScreen.length === 0) return;
    const n = found.onScreen.length;
    const next = (hitAt + dir + n) % n;
    setHitAt(next);
    pushHits(found.onScreen, search.q.trim().length, next);
  };
  const stepsLive = found !== null && found !== 'failed' && found.onScreen.length > 0;

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
   *  260 and 280ms, so this is comfortably past any real one and still inside a lost second. */
  const PHASE_WATCHDOG_MS = 1500;
  // 340/380 as built; cut ~25% because the flight read as heavy (user, 2026-09-01).
  const ZOOM_OUT = { duration: 260, easing: Easing.out(Easing.cubic) };
  const ZOOM_IN = { duration: 280, easing: Easing.out(Easing.cubic) };
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
    // The keys come back exactly as they were left (`keysWereUp`), with no exception — T14's "an
    // armed search hit is for reading, not typing" was overruled on device: whatever the keyboard
    // was doing before the grid, it is doing again after it (user, 2026-08-15). The size hold
    // outlives the zoom by exactly that keyboard: released at the end of the animation it measures
    // a stage with no keyboard in it, reports that, and is corrected ~250ms later — two reflows of
    // every pane on the host, landing just as the terminal comes back into view (device). Nothing
    // is raised, nothing to wait for.
    //
    // The pad froze at the open (see the keyboardWillChangeFrame guard) and no keyboard event is
    // coming to re-report it, so thaw it to the last one that WAS announced. The thaw that MATTERS
    // for the bar's position already happened at the commit (`closeTo`/`springBack`) — this one is
    // the reconcile, for the two things that can still be owed at the landing: the no-flight
    // `springBack` path above, which never reaches a commit thaw, and any keyboard event that
    // landed frozen during the flight's 380ms. Same value on the ordinary path, so React bails.
    syncPad();
    if (keysWereUp.current) {
      setKbSettle(true);
      setFocusSignal((n) => n + 1);
    }
  };

  /**
   * A grid must never outlive the session it belongs to (BUGS, T10A.8: after the phone's own
   * session ended the app logged `attached:false` and then re-listed onto the USER's session
   * instead of tearing down). `showTabs` is now "we are attached to a session we can name", so its
   * falling edge is exactly that moment — the cards in hand describe windows nobody can vouch for
   * any more, and every ✕ on them is aimed at an id from a list that can no longer be refreshed.
   *
   * It snaps rather than flying home: there is nothing left to fly out of, and the flight's
   * completion callbacks are what would otherwise land `sw` back in `open`.
   */
  useEffect(() => {
    if (showTabs || swRef.current === 'closed') return;
    console.log('[switcher] tearing the grid down: the session it belongs to is gone');
    cancelAnimation(prog);
    cancelAnimation(dragX);
    cancelAnimation(flight);
    prog.value = 0;
    dragX.value = 0;
    flight.value = 1;
    alpha.value = 1;
    setZoomId(null);
    setCards([]);
    finishClose();
  }, [showTabs]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- probe: the one-hitch-per-flight on a switch to another window (T10, temporary) ---
   * Everything that could stall a frame, stamped against the tap: the flight leaving, each chunk
   * off the shell, every size the webview measures, the bar's height changing, the landing. What
   * lands INSIDE the flight window is the suspect; the trace decides between the redraw's tail and
   * the ribbon's reflow instead of another guess. Rip this out once it has answered. */
  const probeT0 = useRef(0);
  /** The last size the webview reported, so the probe can print what changed, not what was seen. */
  const lastFit = useRef<{ cols: number; rows: number; top: number } | null>(null);
  /** Armed by a report whose box is off by a row's worth, disarmed by the next one — see `onResize`. */
  const offBoxTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(offBoxTimer.current), []);
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
    syncPad(); // the drag path's thaw — see `closeTo`. A no-op on the `closeTo` path, which did it there.
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
    if (stage === null) return;
    if (sw === 'closing') {
      // The flight home is catchable from the tabs button too, not only the bar grab (see
      // onZoomGrab): the last stretch of the out-cubic reads as a landed terminal, so a tap
      // there was swallowed — which is what blocked hopping through tabs via the grid
      // (user, 2026-09-01). Nothing to set up: the aim, the cards and the size hold are the
      // ones this close was already flying under, so just reverse the flight.
      console.log('[switcher] open (tabs tap caught the close)');
      closeArmed.current = false;
      cancelAnimation(prog);
      cancelAnimation(alpha);
      alpha.value = 1;
      commitOpen();
      return;
    }
    if (sw !== 'closed') return;
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
  /** Is the page row on screen? Opacity, not mounting: the cards stay mounted for the life of the
   *  terminal view because each is a snapshot tree of Text runs, and building one costs 53-93ms of
   *  React on the JS thread — the hitch at the start of every swipe the original code was written
   *  to avoid, which mounting them per gesture brought back (perf, 2026-08-13). */
  const rowVisSV = useSharedValue(0);

  /** The grab, one JS call per gesture: the open's one-off costs. Everything per-frame — prog and
   *  dragX — runs in the bar's worklet against the shared values above. */
  const onZoomGrab = (dx: number, dy: number) => {
    if (stage === null) return;
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
      if (swipeInfo.current?.live !== true) rowVisSV.value = withTiming(0, { duration: 160 });
      // The hop is asked FIRST: a hop's own arc can carry `prog` past ZOOM_COMMIT, so asking the
      // grid first meant a sideways release could be taken as a lift (user, 2026-08-13). The grid
      // takes the release only when the horizontal axis decides nothing.
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

  const closeTo = (pos: number, gate?: (done: () => void) => void) => {
    // The phase flip and the aim first, the motion two frames later — the same gap `openSwitcher`
    // takes for the same reason. `setZoomId` re-renders the grid and `setSw('closing')` flips the
    // size hold, the freeze and the wrapper's pointer events, and paying all of that on the frame
    // the surface starts moving is a long frame right at the start of the flight (probe: FRAME
    // 33ms at prog 0.92). Progress does not move in the gap, so nothing on screen is waiting.
    probe('aim');
    setZoomId(idAt(pos));
    slotSV.value = zoomSlot(pos);
    setSw('closing');
    // Thaw the pad HERE, on the frame the close is committed, not in `finishClose`. It used to be
    // the landing's alone, and a landing thaw is late by construction: `finishClose` is
    // `runOnJS`'d from the ZOOM_IN completion callback, so the UI thread has already painted the
    // frame at prog 0 — the frame the card's left edge reaches x=0 — before the JS thread has even
    // been handed the call, let alone rendered and committed the new pad. Whatever the commit
    // costs, the bar paints at least one frame at the keyboard-up position it was frozen at, over
    // an empty band, and then DROPS to the bottom. Measured on the emulator 2026-08-17 at 30fps:
    // bar at 1373–1501px for frames 66–69 after a landing at 66, at the bottom from 70. Motion in
    // the wrong direction, which is worse than the symptom it replaced.
    // Committed here it lands ~380ms before the landing, while the bar is still faded out
    // (`barFadeStyle` is 0 until prog < 0.25, ~140ms into the flight), so the bar fades in already
    // at the bottom and the keyboard's own event raises it from there. `holdSize` has been true
    // and marshaled for the whole grid session, so the box change this causes is one the
    // ResizeObserver drops — nothing refits and the host hears nothing (the freeze's reason was
    // the OPEN, where the hold has not marshaled yet). It also moves that relayout off the
    // landing frame, where it was in plain sight, into the flight, where it is not.
    syncPad();
    // Armed on a ref, NOT on `swRef`: that one is written during render, and two frames is not a
    // promise that React has rendered. When it had not, the guard read the old phase, the motion
    // never started and `closing` stood — with the grid untouchable and the surface invisible,
    // which is an app that has frozen (user, 2026-08-11). Only a grab clears this.
    closeArmed.current = true;
    // The motion waits for BOTH the two-frame gap and the caller's gate (the redraw wait, on a
    // card tap) — armed in parallel, so the aim render is paid while the roundtrip is in the air
    // instead of queued after it. That serial chain was the "initial delay" on a card tap
    // (user, 2026-09-01).
    let framesDone = false;
    let gateDone = !gate;
    const fire = () => {
      if (framesDone && gateDone && closeArmed.current) springBack();
    };
    gate?.(() => {
      gateDone = true;
      fire();
    });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        framesDone = true;
        fire();
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

  /**
   * The only place a `select-window` is asked for — one catch for both routes to a tab (a card tap
   * and a committed bar swipe), rather than one per call site that the next route would forget.
   *
   * Bare `void selectWindow(...)` was an unhandled rejection whenever the host ran out of exec
   * channels (`open failed`, BUGS.md), and in the dev client an unhandled rejection raises the
   * LogBox toast — which covers the key bar and swallows taps on the tabs button, so a transient
   * host hiccup locked the user out of the grid entirely.
   *
   * NOT pushed down into `src/tmux.ts`: `killWindow`, `moveWindow` and `capturePane` all reject and
   * let the caller decide, and the decision here is one only this screen can make — the optimistic
   * `active` flip. Both routes paint the tapped window active before the host answers, so a select
   * that never landed leaves the halo, the pills and the anchor all pointing at a tab we are not
   * on. Rolled back by ASKING rather than by remembering: `refresh(false)` is list-only (no capture
   * burst on the JS thread) and comes back with tmux's own `active` flag, which is the truth the
   * flip was guessing at — the same move `killCard` makes when a kill fails.
   */
  const switchTo = (win: TmuxWindow) =>
    selectWindow(win.id).catch(async (error) => {
      console.log(`[terminal] select failed: ${win.id}(:${win.index}) — the tab did not change`, error);
      await refresh(false); // undo the optimistic `active` flip: whatever tmux says is where we are
    });

  const selectCard = (pos: number, win: TmuxWindow) => {
    if (sw !== 'open') return;
    console.log('[switcher] select', win.id);
    probeT0.current = Date.now();
    probe(`tap ${win.id} (${win.index === tmux.windowIndex ? 'same' : 'switch'})`);
    awaitWindow(win.index); // as with the bar swipe: under the zoom, not a beat after it
    void switchTo(win); // §7: no haptic on tab select
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
    closeTo(pos, (done) => afterHostRedraw(dataSeq.current, done));
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
    if (!cards.some((c: Card) => c.win.id === win.id)) return; // already killed
    console.log('[switcher] kill', win.id);
    setCards(cards.filter((c: Card) => c.win.id !== win.id)); // optimistic: leaves before tmux answers
    // The card is already gone from the grid, so a failure here has to answer the only question
    // that matters — is the window still THERE? — and the answer is a re-list, not an assumption.
    // (Since the target is a `@N` id, exit 1 means tmux could not find that window at all, and
    // nothing else was killed in its place; the re-list is what proves it rather than claims it.)
    killWindow(win.id).catch(async (error) => {
      const wins = await refresh(false);
      const alive = wins === undefined ? null : wins.some((w) => w.id === win.id);
      console.log(
        '[switcher] kill failed:',
        win.id,
        alive === null ? 'still there? the re-list failed too' : alive ? 'WINDOW IS STILL ALIVE' : 'window is gone anyway',
        error,
      );
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
        awaitWindow(wins[pos].index); // as with a select: under the zoom, not a beat after it
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

  // Category (2), hardware affordance: Android has a system back button and iOS has no twin.
  // System back closes the grid back into the active pane — it must never pop the route out from
  // under an open switcher. Mid-transition the press is swallowed, the running zoom owns the
  // screen. This is the BackHandler half only: `predictiveBackGestureEnabled` stays false in
  // app.json because RN 0.86's ReactActivity opts back into legacy dispatch itself — an
  // always-enabled OnBackPressedCallback ("Due to enforced predictive back on targetSdk 36,
  // 'onBackPressed()' is disabled by default. Using a workaround to trigger it manually") — so
  // the flag buys no OS peek animation for JS-handled backs, and BackHandler works either way.
  // The rest of the ladder rides the same subscription: switcher first, then an open popover/⋯
  // menu, and at the terminal itself back is "home" —
  // `exitApp` invokes the activity's default back, which on a task-root activity backgrounds
  // the app (moveTaskToBack) rather than finishing it; §4.9's lifecycle owns what follows. It
  // deliberately never pops the route to Setup: that pop skipped `leave()`'s disconnect, and
  // leaving is the sheet's Disconnect / the overlay's Setup button's job (same reasoning as
  // the iOS `gestureEnabled: false` below). The sheets are Modals, whose dialog windows take
  // the back press natively (`onRequestClose`) before this handler can see it.
  const navigation = useNavigation();
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // This screen stays MOUNTED under a route pushed on top of it (T16's key screen), and RN
      // runs the newest subscription first — so without this the terminal's ladder would answer a
      // back press meant for the screen in front and background the app instead of popping. Read
      // at press time, not through `useIsFocused`, which would re-render the terminal on every
      // navigation. `false` passes the press down to React Navigation's own handler.
      if (!navigation.isFocused()) return false;
      if (sw !== 'closed') {
        if (sw === 'open') doneToActive(); // mid-transition: swallowed, the zoom owns the screen
      } else if (open !== 'none') {
        setOpen('none');
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
   *  measures from. It used to be read a slide EARLIER than the request, at the commit, so that on
   *  a LAN the redraw beat the slide home — which is what painted the incoming window into the
   *  outgoing card (see `settleBarSwipe`). Now the two are one line apart. */
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
    setPageSwipe(null);
    swipeX.value = 0;
    roundSV.value = 0; // x is already 0 here, so the travel factor has faded the edge out too
  };

  /**
   * The slide is home, the arriving card is exactly over the screen — and only NOW is tmux told to
   * switch. That ordering is the whole fix for BUGS.md §3.
   *
   * The live terminal is the OUTGOING page of a hop: it is the card the finger pushes off the
   * screen, and it is a live webview, not a picture. Telling the host at the commit (which is what
   * this used to do, "so the redraw beats the slide home") meant tmux repainted that card with the
   * window being switched TO while it was still most of the way on screen — the previous tab's
   * card showing the next tab's contents, every hop, for the ~50ms-to-slide-end remainder. The
   * card-tap path never had it and that is the tell: there the switch is issued while the surface
   * is invisible behind the grid (`selectCard`), and nothing live is on screen to catch the paint.
   *
   * So the hop is given the same guarantee. The landed neighbour is the cover (bf8efbb: the row
   * survives the settle and the arriving card IS the overlay), the redraw lands underneath it, and
   * `afterHostRedraw` drops it once the burst is quiet. What it costs is the roundtrip — the tab is
   * live one redraw after the motion stops instead of during it — and that time is spent behind a
   * still of the tab being arrived at, which is what the settle is for.
   *
   * The old fast path ("nothing to cover, the redraw already landed") went with it: nothing can
   * have landed when the baseline is taken on the line above the request.
   */
  const settleBarSwipe = (win: TmuxWindow | undefined) => {
    bytesAtCommit.current = dataSeq.current;
    // Either way tmux redraws the PTY, which replaces the snapshot: `new-window` makes the
    // window it creates the active one, exactly as `select-window` does.
    if (win) void switchTo(win);
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
    // `awaiting` is armed on the born window here: the commit above had no index to await on
    // yet, so without this the first poll answer — which still describes the window we LEFT —
    // would stand as the position the next swipe hops from.
    else
      newWindow()
        .then(() => refresh(false))
        .then((wins) => {
          const born = wins?.find((w) => w.active);
          if (born) awaitWindow(born.index);
        })
        .catch((error) => console.log('[barswipe] new window failed:', error));
    // `pos` deliberately stays where the swipe started: it is what `anchor` renders the row
    // around, and moving it to the target here re-pointed the very card that is covering the
    // screen at the tab one PAST the target — a content swap in plain sight, in the phase that now
    // holds for a whole roundtrip. The pills, which are what wanted `pos` moved (their strip
    // otherwise snapped back to the tab just left), read `target` during the settle instead.
    setPageSwipe((s) => (s === null ? s : { ...s, phase: 'settle' }));
    roundSV.value = withTiming(0, { duration: 200 });
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
      stage: stageSV,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- every member is a stable shared value
    [],
  );

  const onBarSwipe = (phase: 'start' | 'end', dx: number) => {
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
      // One slot past the last tab, always: committing onto it births a window. It used to be
      // withheld from a card held in the air, which had no new-tab page to land on; that whole
      // path went on 2026-08-17.
      const slots = windows.length + 1;
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
        names: [...windows.map((w) => w.name), NEW_TAB_NAME],
        pos,
        target: pos,
        phase: 'drag',
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
        // A birth gets the placeholder: tmux picks the new window's number and has not told us
        // yet, so no answer can match and the few that describe the window we left are ignored —
        // `settleBarSwipe`'s re-list replaces this with the real index within a roundtrip.
        awaitWindow(win ? win.index : -1);
        // Optimistic `active` flip, here and not with the switch below: the pills, the anchor and
        // the next grid open all read it, and none of them may wait for a roundtrip.
        if (win)
          setCards((prev) => prev.map((c) => ({ ...c, win: { ...c.win, active: c.win.id === win.id } })));
        setPageSwipe((s) => (s === null ? s : { ...s, phase: 'anim', target }));
        // The HOST is told at the landing, not here — see `settleBarSwipe`.
        slideTo((info.pos - target) * pagePitch(stage.w), () => settleBarSwipe(win));
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
  /** The page's TOP corners, square while the search row is up — the mirror of `kbSquare`, for the
   *  mirror of its reason: that edge is not the top of anything, it is where the search bar cuts
   *  the page off, and a 24pt corner hanging in mid-screen under the bar reads as the grid's card
   *  left behind (BUGS.md #1). Nothing is stale there — `pageRadius` is the screen's radius at rest
   *  too, and its "0 at rest" wording is the stale part; the corner is simply in plain sight once
   *  the row has pushed the page below the notch. Same bar-swipe exception: there the page IS the
   *  card. */
  const searchSquare = search.on && pageSwipe === null;
  const pageRT = searchSquare ? 0 : pageR;
  const roundR = 0.1 * (stage?.w ?? 390);
  // The card's edge: in the dark flavours base and crust are nearly the same ink, so the gap
  // alone does not separate card from backdrop (user, 2026-08-11, screenshot) — the same
  // hairline the switcher's cards wear does. An overlay, NOT a real border: a border is part of
  // the box and would resize the terminal mid-swipe. This one still fades in with the travel —
  // the corners are permanent, a hairline round the resting page is not.
  const pageEdgeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(Math.abs(swipeX.value) / roundR, 1) * roundSV.value,
  }));

  /** A hop's confirmation, given up on after three answers that describe some other window: the
   *  `select-window` did not take, and reality wins. Without a give-up `activePosIn` would keep
   *  reading a window we never reached. */
  useEffect(() => {
    if (frozen) return;
    const wait = awaiting.current;
    if (wait === null) return;
    if (tmux.windowIndex === wait.index || ++wait.tries > 3) awaiting.current = null;
  }, [frozen, tmux]);

  const sendKeys = send;

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
    onRowHeight: setRowHeight,
    onTabsTap: openSwitcher,
    onZoomGrab,
    onZoomArm,
    onZoomEnd,
    onBarSwipe,
  };
  const kb_sendBytes = useCallback((...a: any[]) => kbH.current.sendBytes(...a), []);
  const kb_onHeight = useCallback((...a: any[]) => kbH.current.onHeight(...a), []);
  const kb_onRowHeight = useCallback((...a: any[]) => kbH.current.onRowHeight(...a), []);
  const kb_onTabsTap = useCallback((...a: any[]) => kbH.current.onTabsTap(...a), []);
  const kb_onZoomGrab = useCallback((...a: any[]) => kbH.current.onZoomGrab(...a), []);
  const kb_onZoomArm = useCallback((...a: any[]) => kbH.current.onZoomArm(...a), []);
  const kb_onZoomEnd = useCallback((...a: any[]) => kbH.current.onZoomEnd(...a), []);
  const kb_onBarSwipe = useCallback((...a: any[]) => kbH.current.onBarSwipe(...a), []);

  /* --- the name pills' inputs --- */

  /** Where the strip sits, and whether the offset counts. The strip lands on the TARGET at the
   *  settle — leaving it on `pos` snapped it back to the tab just left for the length of the
   *  settle, a second flicker of the wrong name (user, 2026-08-11). It used to get there by
   *  `settleBarSwipe` moving `pos` itself, which the card row also reads (see there). Meanwhile
   *  `swipeX` keeps the slide's final offset until the post-paint reset effect — read together
   *  they put the continuous position a full window off, snapping the new pill to a capsule and
   *  back (same report). The settle IS the landing, so the offset is gated to zero there rather
   *  than `x` being pointed at a different value: swapping the shared value was what made the
   *  pills' mappers restart (see `pillPosSV`). */
  const pillPos =
    pageSwipe === null
      ? activePosIn(cards)
      : pageSwipe.phase === 'settle'
        ? pageSwipe.target
        : pageSwipe.pos;
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
  /** The floating bar's ground: home strip + the key ROW, all inside the card face. The chord
   *  strip is not in it — it overlays the pane, see `rowHeight`. */
  const barPad = rowHeight + insets.bottom;
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
      // The join's approach, locked to the TRAVEL rather than a clock: the card starts a little
      // beyond its pitch and closes in as the finger uncovers the gap, fully seated by 130pt —
      // slow and firm, and it can never lag the swipe or pop (user, 2026-08-13, after instant read
      // as harsh and every timed entrance was either too quick or too slow). One distance for
      // every swipe. It used to shrink with the swipe's speed — the quicker the swipe, the faster
      // the slide-in (user, 2026-08-13) — and that coupling was withdrawn a day later: the
      // neighbours are to arrive at one speed whatever the hand did (user, 2026-08-14).
      const seat = Math.min(Math.abs(swipeX.value) / ROW_REACH, 1);
      return {
        opacity: rowVisSV.value,
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
    const rt = searchSquare ? 0 : r;
    return {
      borderTopLeftRadius: rt,
      borderTopRightRadius: rt,
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

  /**
   * Can the terminal's own chrome be TOUCHED this phase? Every layer of it — the zoom box, the
   * floating key bar, the ribbon band — answers with this one expression, because they all sit in
   * front of the grid in paint order and they all go invisible together (`barFadeStyle`).
   *
   * Invisible is not untouchable. Android's touch dispatch walks the view tree without ever
   * looking at a view's alpha, so an opacity-0 key bar in front of the open grid keeps every hit
   * that lands on it — and the bar's `…` and tabs circles sit at exactly the coordinates of the
   * grid's `+` and `✓` (emulator, 2026-08-17: `+` opened the UPLOAD FILE sheet, `✓` reached
   * `openSwitcher`, which returns early on `sw !== 'closed'`, so the grid could not be closed by
   * anything but the system back button). iOS hides the fault because UIKit's `hitTest:` skips
   * any view with alpha ≤ 0.01 — the same JSX, two behaviours, and the phone's is the correct
   * one. This says out loud what iOS was getting for free, so both platforms do it for the same
   * reason.
   *
   * `closing` and `drag` stay live on purpose: the bar owns the drag gesture, and the phase
   * outlives the motion by the tail of its ease-out — a dead bar there is a terminal that looks
   * landed and will not swipe (user, 2026-08-11).
   */
  const chromeLive = sw === 'closed' || sw === 'closing' || sw === 'drag';

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
  // with it; border width divided by scale so it reads `CARD_RING` on screen throughout, which is
  // the same width the grid card it hands over to draws. It was 3 against that card's 2 and the
  // ring stepped thinner on the landing frame (user, 2026-08-17).
  const ringStyle = useAnimatedStyle(() => {
    const f = zoomFrame(prog.value, dragX.value, aimAt(aimSV), stageSV.value);
    return {
      opacity: f.ringOpacity,
      borderRadius: f.radius,
      borderWidth: prog.value > 0 ? CARD_RING / f.scale : 0,
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
          unreachable={listFailed}
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
        {/* The grid recedes behind the flying card. This was a backdrop blur; it is a wash of the
            screen's own ground now, because a backdrop blur is not something both platforms can
            draw from one code path (see `Plate` in `src/keybar.tsx`). The wash reads the same at
            this scale — the grid is already small and moving — and it is a flat fill, so the
            per-frame cost the blur had is simply gone. That cost was real and measured: a
            UIVisualEffectView re-renders its backdrop continuously and does NOT stop costing GPU
            because a parent's opacity is zero (user, 2026-08-13: laggy inside the animation),
            which is why this still mounts only while the zoom is live. */}
        {zoomActive && (
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              { backgroundColor: rgba(theme.background, 0.55) },
              gridBlurStyle,
            ]}
          />
        )}
        </Animated.View>
      )}

      {/* The zoomed container: one scale, one flight, holding the live card and — once a swipe is
          actually running — the pages either side of it. It keeps the stage's full height and does
          NOT clip, so a card a pitch away is not cut off; each card inside crops itself. */}
      <Animated.View
        // See `chromeLive`: the same phases the key bar and the ribbon band answer to. The gesture
        // picks the flight up from where it is (see `onSwitcherDrag`).
        pointerEvents={chromeLive ? 'auto' : 'none'}
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
              style={[styles.searchInput, { color: theme.foreground, fontFamily: MONO, includeFontPadding: false  }]}
            />
            {/* BUGS.md §6: the count is the host's now — every occurrence in the window, tmux's
                whole history included. `searchLabel` owns the wording, because the honesty is in
                the arithmetic: the index is the hit's place in the WHOLE window, so `1265/1284`
                says both what this hit is and how much of the search is above the screen and out
                of the steppers' reach. Same Text, same MONO 11 in `muted`. */}
            <Text numberOfLines={1} style={[styles.searchCount, { color: theme.muted }]}>
              {search.q.trim() === '' ? '' : searchLabel(found, hitAt)}
            </Text>
          </View>
          {/* The pair, in a group of its own: they are one segmented control, so they sit closer
              to each other than the row's own gap puts them — and Done stays outside it. */}
          <View style={{ flexDirection: 'row', gap: 2 }}>
            {(['prev', 'next'] as const).map((dir) => (
              <Pressable
                key={dir}
                disabled={!stepsLive}
                onPress={() => stepHit(dir === 'prev' ? -1 : 1)}
                style={({ pressed }) => [
                  styles.searchStep,
                  { backgroundColor: theme.surface, opacity: stepsLive ? 1 : 0.35 },
                  pressed && PRESSED,
                ]}>
                <Text style={{ color: theme.foreground, fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: 13 }}>
                  {dir === 'prev' ? '∧' : '∨'}
                </Text>
              </Pressable>
            ))}
          </View>
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
            borderTopLeftRadius: pageRT,
            borderTopRightRadius: pageRT,
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
          { borderColor: theme.accent, borderRadius: pageR, borderTopLeftRadius: pageRT, borderTopRightRadius: pageRT, borderBottomLeftRadius: pageRB, borderBottomRightRadius: pageRB },
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

          Mounted unconditionally, and shown by `rowVis` alone (a91809f) — the phase test that used
          to stand here (`sw === 'closed' || 'drag' || 'closing'`, so gone for `opening`) is not a
          condition on this JSX any more, and every reason it existed is now a reason `rowVis` has
          to be written: a release that commits to the GRID must take the row out, or the
          neighbours fly in one pitch behind the card — tabs arriving in pairs (user, 2026-08-13,
          screenshot). `onZoomEnd` is where that write lives.

          The exits are conditional on purpose: releasing a card to the grid — held, or mid-hop —
          sends the neighbours back out to their sides so it flies alone (user, 2026-08-13) — but a
          hop's LANDING must stay an instant cut, because the landed card sits exactly over the
          live pane's identical picture, and sliding it away would show the same tab twice, one
          peeling off the other. */}
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
              empty pane the shell about to be born will draw into. That blank page is what covers
              the moment the new shell is being drawn, and taking it away left the arrival blinking
              dark with the card's accent edge standing on it (user, 2026-08-13). It used to be
              withheld from a card held in the air — hidden by `heldAir` inside the style rather
              than unmounted here, because a React commit lags the worklet by long enough to see it
              appear and then go; that whole path went on 2026-08-17. */}
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
        // It used to ride inside the zoom box, which gated it; out here it is the grid's own
        // bottom bar that it covers, and the fade alone does not stop a hit (see `chromeLive`).
        pointerEvents={chromeLive ? 'auto' : 'none'}
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
        onRowHeight={kb_onRowHeight}
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
              text={tabsHint(tmux.present, usesTmux(settings), pollSession(settings) !== null)}
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
  /** drag = finger down; anim = commit/cancel slide running; settle = the landed neighbour card
   *  holding the screen while tmux redraws the PTY under it (`settleBarSwipe`). */
  phase: 'drag' | 'anim' | 'settle';
};
/* `settled`/`settleInsets` used to ride here — a duplicate snapshot of the committed page, mounted
 * as an overlay at the landing. bf8efbb made the landed neighbour its own cover and stopped
 * rendering the overlay; the two fields were still being filled in for nobody. */

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
    <Pressable
      key={label}
      onPress={onPress}
      // The same touch-down every other button in the app answers with — these three sat in a
      // fixed box and answered with nothing at all.
      style={({ pressed }) => [styles.action, { backgroundColor: colour }, pressed && PRESSED]}>
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
  // T14's terminal-side search bar: a 38pt field and two 34×38 stepper keys at
  // `SEARCH_RADIUS.terminal`, sized to the box.
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    // The prototype's row gap. The field is flex:1, so it absorbs the two points; the row's
    // height is `searchRowH`'s business and is untouched by this.
    gap: SPACE.sm,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  searchField: {
    flex: 1,
    height: 38,
    borderRadius: SEARCH_RADIUS.terminal,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 11,
  },
  searchInput: { flex: 1, fontFamily: SANS, includeFontPadding: false, fontSize: 13, paddingVertical: 0 },
  searchCount: { fontFamily: MONO, includeFontPadding: false, fontSize: 11 },
  /** One stepper key. The pair sits in a 2pt-gap group of its own (see the row's JSX) so it reads
   *  as one segmented control, which is how the prototype draws them. */
  searchStep: {
    width: 34,
    height: 38,
    borderRadius: SEARCH_RADIUS.terminal,
    ...CENTER,
  },
  searchDone: { fontFamily: SANS, includeFontPadding: false, fontSize: 15, paddingHorizontal: 2 },
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
    ...CENTER,
    gap: SPACE.md,
    padding: SPACE.xxl,
  },
  glyph: { fontFamily: MONO, includeFontPadding: false, fontSize: 44 },
  headline: { fontFamily: SANS_BOLD, includeFontPadding: false, fontSize: 24 },
  sentence: {
    fontFamily: SANS,
    includeFontPadding: false,
    fontSize: TEXT.label,
    lineHeight: leading(TEXT.label),
    textAlign: 'center',
  },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10, marginTop: SPACE.sm },
  /** A filled button, wearing the app's button corner rather than the field's — these three had
   *  drifted to 12, which is what a field is. */
  action: { paddingHorizontal: SPACE.wide, paddingVertical: SPACE.md, borderRadius: RADIUS.button },
  actionLabel: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: TEXT.button },
});
