import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router, Stack } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
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
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  PAGE_RADIUS,
  SETTLE_HOLD_MS,
  pagePitch,
  rubber,
  swipeTarget,
} from '@/barswipe-model';
import { pushYank } from '@/clipboard';
import { useTheme } from '@/hooks/use-theme';
import KeyBar, {
  ArrowsPopover,
  BAR_PAD_TOP,
  BarMenu,
  ClipboardPopover,
  type BarPopover,
} from '@/keybar';
import Ribbon, { RIBBON_PAD_TOP } from '@/ribbon';
import {
  RIBBON_IDLE,
  killCommand,
  ribbonDismiss,
  ribbonPoll,
  ribbonResumed,
  ribbonSent,
  selectRecipe,
} from '@/ribbon-model';
import { RECIPES, type Cap } from '@/ribbon-recipes';
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
import { endpoint, getSettings, updateSettings, useSettings } from '@/settings';
import { normalizeQuery, windowSurvives } from '@/search-model';
import Switcher, {
  Snapshot,
  useScrollbackSearch,
  useSwitcherCards,
  type Card,
  type Snap,
} from '@/switcher';
import {
  SEARCH_BAR_H,
  ZOOM_COMMIT,
  fabFrame,
  gridTop,
  plusFrame,
  slotFrame,
  snapshotType,
  termPad,
  zoomFrame,
  zoomProgress,
  type Frame,
} from '@/switcher-model';
import SettingsSheet from '@/settings-sheet';
import TerminalView, { type TerminalHandle } from '@/terminal';
import { exec, killWindow, moveWindow, newWindow, selectWindow, useTmux } from '@/tmux';
import { deriveConfigStatus, tabsAvailable, type TmuxWindow } from '@/tmux-model';
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
  const { fontSize, configureTmux, host, lastUploadDir } = useSettings();
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
  /** The emulator's measured cell and the rows it settled on (see TerminalProps.onResize). The
   *  cell is what every snapshot's type comes from, so a card draws the pane at the size the
   *  flying surface hands over at; the rows are what the vertical inset is worked out from. */
  const [cell, setCell] = useState({ w: 0, h: 0 });
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
  useEffect(() => () => detach.current?.(), []);

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
  // keyboard away for it and raises it again on close.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => {
    console.log('[settings] sheet open');
    setOpen('none');
    Keyboard.dismiss();
    setSettingsOpen(true);
  };
  const closeSettings = () => {
    console.log('[settings] sheet closed');
    setSettingsOpen(false);
    setFocusSignal((n) => n + 1);
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
  const [stage, setStage] = useState<{ w: number; h: number } | null>(null);
  const [focusSignal, setFocusSignal] = useState(0);
  const scrollY = useRef(0);
  const prog = useSharedValue(0); // 0 = terminal at rest, 1 = terminal inside its card slot
  const dragX = useSharedValue(0); // finger drift during the bar-swipe-up follow
  const alpha = useSharedValue(1); // the stage fades out at the end of the zoom-out, back in first on return
  const slotSV = useSharedValue<Frame>({ x: 0, y: 0, w: 1, h: 1 });
  const stageSV = useSharedValue({ w: 390, h: 800 });

  const connected = session.status === 'connected';
  const showTabs = tabsAvailable(
    tmux.present,
    deriveConfigStatus(configureTmux, tmux.config),
    tmux.attached,
  );
  // T11's page-slide state lives up here with the switcher's: the snapshot cache has to know
  // when a slide is running, and it is the same "nothing may change while something is moving"
  // rule the zoom needs. Everything else about the slide is in its own block below.
  const [pageSwipe, setPageSwipe] = useState<PageSwipe | null>(null);
  /** Mid-zoom, mid-slide: the moving views must not have their content swapped underneath them. */
  const frozen = (sw !== 'closed' && sw !== 'open') || pageSwipe !== null;
  const { cards, setCards, refresh } = useSwitcherCards(
    showTabs && connected,
    sw !== 'closed',
    frozen,
  );

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
      terminal.current?.search?.(search.q.trim());
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

  /** Grid position → the card's frame in stage coordinates (search field and headroom above the
   *  grid, minus the grid's own scroll) — where the zoom aims. */
  const zoomSlot = (pos: number): Frame => {
    const w = stage?.w ?? 390;
    const f = slotFrame(pos, w);
    return { ...f, y: SEARCH_BAR_H + gridTop(w) + f.y - scrollY.current };
  };

  const ZOOM_OUT = { duration: 340, easing: Easing.out(Easing.cubic) };
  const ZOOM_IN = { duration: 380, easing: Easing.out(Easing.cubic) };

  const finishClose = () => {
    setSw('closed');
    // The prototype re-raises the keyboard on return — except onto an armed search hit, where
    // you came to read, not type (T14). The size hold outlives the zoom by exactly that keyboard:
    // released at the end of the animation it measures a stage with no keyboard in it, reports
    // that, and is corrected ~250ms later — two reflows of every pane on the host, landing just
    // as the terminal comes back into view (device). Nothing is raised, nothing to wait for.
    if (!searchRef.current.on) {
      setKbSettle(true);
      setFocusSignal((n) => n + 1);
    }
  };

  const commitOpen = () => {
    setSw('opening');
    dragX.value = withTiming(0, { duration: 250 });
    // The prototype fades the surface out only near the end, once it covers its card.
    alpha.value = withDelay(180, withTiming(0, { duration: 140 }));
    prog.value = withTiming(1, ZOOM_OUT, (done) => {
      if (done) runOnJS(setSw)('open');
    });
  };

  const springBack = () => {
    setSw('closing');
    alpha.value = withTiming(1, { duration: 120 });
    dragX.value = withTiming(0, { duration: 200 });
    prog.value = withTiming(0, ZOOM_IN, (done) => {
      if (done) runOnJS(finishClose)();
    });
  };

  const openSwitcher = () => {
    if (sw !== 'closed' || stage === null) return;
    console.log('[switcher] open (tabs tap)');
    setOpen('none');
    Keyboard.dismiss();
    slotSV.value = zoomSlot(activePos());
    commitOpen();
  };

  // The bar-swipe-up drag-follow (prototype `zoomFollow`): progress tracks the finger, release
  // past the threshold commits, anything less springs back.
  const onSwitcherDrag = (phase: 'move' | 'end', dx: number, dy: number) => {
    if (stage === null) return;
    if (phase === 'move') {
      if (sw === 'closed') {
        console.log('[switcher] open (bar drag)');
        setOpen('none');
        slotSV.value = zoomSlot(activePos());
        setSw('drag');
      } else if (sw !== 'drag') return;
      prog.value = zoomProgress(dy, stage.w);
      dragX.value = dx;
    } else if (sw === 'drag') {
      if (prog.value > ZOOM_COMMIT) commitOpen();
      else springBack();
    }
  };

  const closeTo = (pos: number) => {
    slotSV.value = zoomSlot(pos);
    springBack();
  };

  const selectCard = (pos: number, win: TmuxWindow) => {
    if (sw !== 'open') return;
    console.log('[switcher] select', win.id);
    void selectWindow(win.index); // §7: no haptic on tab select
    closeTo(pos);
  };

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
    // tmux switches the attached client to it, so the terminal lands on it
    newWindow().catch((error) => console.log('[switcher] new window failed:', error));
    // The birth origin: iOS's + circle, or the Android FAB (§4.10) — same growth either way.
    slotSV.value =
      Platform.OS === 'android' ? fabFrame(stage.w, stage.h) : plusFrame(stage.w, stage.h);
    prog.value = 1; // teleport the (invisible) surface into the + button…
    setSw('birth');
    alpha.value = withTiming(1, { duration: 200 });
    prog.value = withTiming(0, { duration: 400, easing: Easing.out(Easing.cubic) }, (done) => {
      if (done) runOnJS(finishClose)(); // …and grow it to full screen, Safari's new-tab birth
    });
  };

  // The session went away (backgrounded, killed, last window closed): the grid has nothing to
  // stand on. Reset without animation; the §4.9 overlay is already up.
  useEffect(() => {
    if (!connected && sw !== 'closed') {
      prog.value = 0;
      dragX.value = 0;
      alpha.value = 1;
      setSw('closed');
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
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sw !== 'closed') {
        if (sw === 'open') closeTo(activePos()); // mid-transition: swallowed, the zoom owns the screen
      } else if (open !== 'none') {
        setOpen('none');
      } else {
        BackHandler.exitApp();
      }
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- closeTo/activePos are per-render
    // closures; cards keeps activePos fresh while the grid sits open across snapshot polls.
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
  const roundSV = useSharedValue(0); // page corner radius, 0→1 of PAGE_RADIUS
  // `pageSwipe` itself is declared with the switcher state above (the cache freezes on it).
  const swipeInfo = useRef<{ windows: TmuxWindow[]; pos: number; t0: number; live: boolean } | null>(
    null,
  );
  /** The next byte off the shell, while anyone is waiting for one. A committed swipe is: the
   *  redraw is what the settle is waiting for, and it is watched for from the moment
   *  `select-window` goes out — not from the moment the slide lands, because on a LAN it beats
   *  the 320ms slide home, and a watch armed after it has already arrived waits for a byte an
   *  idle shell never sends, i.e. the whole cap (user, 2026-08-10: "small delay still there"). */
  const onShellData = useRef<(() => void) | null>(null);
  const redrawn = useRef(false);
  const settleCap = useRef<ReturnType<typeof setTimeout> | null>(null);
  const SLIDE = { duration: 320, easing: Easing.bezier(0.22, 1, 0.36, 1) };

  const clearBarSwipe = () => {
    // The refresh that keeps the cache warm for the NEXT swipe runs here rather than at the
    // start of this one: a capture per window is an exec burst and a parse of every answer, and
    // on the JS thread at the instant the finger goes down that is a stutter in the slide it is
    // meant to serve (user, 2026-08-10). Nothing on screen is waiting for it.
    void refresh(true);
    onShellData.current = null;
    if (settleCap.current !== null) clearTimeout(settleCap.current);
    settleCap.current = null;
    swipeInfo.current = null;
    setPageSwipe(null);
    swipeX.value = 0;
    roundSV.value = withTiming(0, { duration: 150 });
  };

  const settleBarSwipe = () => {
    // The redraw already landed while the slide was running: the terminal underneath is the new
    // window, so there is nothing to hold over it.
    if (redrawn.current) {
      clearBarSwipe();
      return;
    }
    // Otherwise the overlay covers the terminal until the redraw arrives; the cap is only for a
    // redraw that never does.
    setPageSwipe((s) =>
      s === null
        ? s
        : {
            ...s,
            phase: 'settle',
            pos: s.target,
            settled: cards[s.target]?.snap ?? null,
          },
    );
    roundSV.value = withTiming(0, { duration: 200 });
    onShellData.current = clearBarSwipe;
    const cap = setTimeout(clearBarSwipe, SETTLE_HOLD_MS);
    settleCap.current = cap;
  };

  // The settle overlay (a static copy of the committed page) is mounted: reset the slide offset
  // under it, so the live terminal is back at rest by the time the overlay drops. An effect, not
  // the callback, so the reset paints strictly after the translated pages have unmounted.
  useEffect(() => {
    if (pageSwipe?.phase === 'settle') swipeX.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSwipe?.phase]);

  const onBarSwipe = (phase: 'start' | 'move' | 'end', dx: number) => {
    if (stage === null) return;
    if (phase === 'start') {
      if (swipeInfo.current !== null || sw !== 'closed' || !connected) return;
      const windows = cards.map((c) => c.win);
      if (windows.length === 0) return;
      const pos = activePosIn(cards);
      swipeInfo.current = { windows, pos, t0: Date.now(), live: true };
      setOpen('none');
      console.log('[barswipe] start at', pos, 'of', windows.length);
      setPageSwipe({
        names: windows.map((w) => w.name),
        pos,
        count: windows.length,
        target: pos,
        phase: 'drag',
        settled: null,
      });
      roundSV.value = withTiming(1, { duration: 180 });
      swipeX.value = rubber(dx, pos, windows.length);
    } else if (phase === 'move') {
      const info = swipeInfo.current;
      if (!info?.live) return;
      swipeX.value = rubber(dx, info.pos, info.windows.length);
    } else {
      const info = swipeInfo.current;
      if (!info?.live) return;
      info.live = false;
      const target = swipeTarget(dx, Date.now() - info.t0, info.pos, info.windows.length);
      if (target === info.pos) {
        console.log('[barswipe] cancel');
        setPageSwipe((s) => (s === null ? s : { ...s, phase: 'anim' }));
        roundSV.value = withTiming(0, { duration: 200 });
        swipeX.value = withTiming(0, SLIDE, (done) => {
          if (done) runOnJS(clearBarSwipe)();
        });
      } else {
        const win = info.windows[target];
        console.log('[barswipe] commit → window', win.index, `(${win.name})`);
        // Watch for tmux's redraw from here, not from the settle: it usually beats the slide.
        redrawn.current = false;
        onShellData.current = () => {
          redrawn.current = true;
        };
        void selectWindow(win.index); // tmux redraws the PTY, which replaces the snapshot
        setPageSwipe((s) => (s === null ? s : { ...s, phase: 'anim', target }));
        swipeX.value = withTiming((info.pos - target) * pagePitch(stage.w), SLIDE, (done) => {
          if (done) runOnJS(settleBarSwipe)();
        });
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

  // The live terminal is itself a page while a swipe is on: it slides and rounds its corners.
  const termSlideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipeX.value }],
    borderRadius: PAGE_RADIUS * roundSV.value,
  }));

  /* --- T11: the context ribbon (§4.4) ---
   *
   * State crosses in ribbon-model's reducer (tested): T9's foreground poll, T6's altScreen, and
   * the ^Z watch on the key bar's send path. The screen only feeds events in and executes caps. */
  const [ribbonCore, setRibbonCore] = useState(RIBBON_IDLE);
  const [rbExpanded, setRbExpanded] = useState(false);
  const fgCommand = tmux.foreground?.command ?? null;
  const fgPid = tmux.foreground?.pid ?? null;
  useEffect(() => {
    setRibbonCore((c) =>
      ribbonPoll(c, fgCommand === null || fgPid === null ? null : { command: fgCommand, pid: fgPid }, Date.now()),
    );
  }, [fgCommand, fgPid]);
  // A new process instance always arrives compact (design 4a: expansion is never sticky).
  useEffect(() => setRbExpanded(false), [ribbonCore.instance]);

  const recipe = connected ? selectRecipe(ribbonCore, modes.altScreen) : null;

  /** Every key on its way to the PTY, with the ribbon's ^Z watch on the side. `ribbonSent`
   *  returns the same object for bytes that are not its business, so this re-renders nothing. */
  const sendKeys = (bytes: string) => {
    setRibbonCore((c) => ribbonSent(c, bytes, Date.now()));
    send(bytes);
  };

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

  const ribbonEl =
    recipe === null ? null : (
      <Ribbon
        theme={theme}
        recipe={recipe}
        startedAt={ribbonCore.startedAt}
        expanded={rbExpanded}
        busy={sending}
        onToggle={() => setRbExpanded((e) => !e)}
        onDismiss={() => {
          console.log('[ribbon] dismissed', recipe.proc);
          setRibbonCore(ribbonDismiss);
        }}
        onCap={onRibbonCap}
      />
    );

  /** Outside-tap collapses an expanded TUI recipe (§4.4): one transparent layer over the
   *  terminal area only, so the ribbon's own caps stay tappable. */
  const rbScrim = recipe !== null && RECIPES[recipe.id].collapsible && rbExpanded;

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
  // Below the last line the eye adds the terminal's inset to whatever the chrome under it keeps
  // for itself — the key bar's 5pt, the ribbon's 2 — so the terminal's share is the gap minus
  // that, and the two together come to the gap at the sides. Above there is no inset of ours at
  // all: the row remainder goes there, and the terminal applies it itself, inside its own layout
  // pass (see TerminalProps.onResize). Worked out here it needed a measured height, which only
  // arrives after a layout — so every keyboard open laid out once wrong and once right, which is
  // the bounce (user, 2026-08-10).
  const chromePad = ribbonEl === null ? BAR_PAD_TOP : RIBBON_PAD_TOP;
  const padBottom = Math.max(0, padH - chromePad);
  /** What the pane sits inside — the page cards of the T11 slide draw at 1:1 beside it and take
   *  the same three numbers, or their text does not line up with the live terminal's. */
  const paneInsets = { top: padTop, side: padH, bottom: padBottom };

  // The stage wrapper: identity at rest, the zoom interpolation the moment progress moves.
  // Height is the clip (the prototype's clip-path inset), radius the rounding, translate
  // compensated for RN's centre-origin scale — all from the one tested function.
  const wrapperStyle = useAnimatedStyle(() => {
    const f = zoomFrame(prog.value, dragX.value, slotSV.value, stageSV.value);
    return {
      height: f.height,
      borderRadius: f.radius,
      opacity: alpha.value,
      transform: [{ translateX: f.translateX }, { translateY: f.translateY }, { scale: f.scale }],
    };
  });

  // The accent ring riding the transition (§4.5) — inside the wrapper so it clips and scales
  // with it; border width divided by scale so it reads ~3pt on screen throughout.
  const ringStyle = useAnimatedStyle(() => {
    const f = zoomFrame(prog.value, dragX.value, slotSV.value, stageSV.value);
    return {
      opacity: f.ringOpacity,
      borderRadius: f.radius,
      borderWidth: prog.value > 0 ? 3 / f.scale : 0,
    };
  });

  return (
    // The safe-area strips take the switcher's own ground while it is up: the prototype paints the
    // grid `inset: 0` in crust, and leaving the root at `background` left a lighter bar above and
    // below the grid (seen on device in Latte, where base and crust are far apart — T13/T10.3).
    <SafeAreaView
      style={[styles.screen, { backgroundColor: sw === 'closed' ? theme.background : theme.scrim }]}>
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
      {sw !== 'closed' && stage !== null && (
        <Switcher
          theme={theme}
          stageW={stage.w}
          cell={cell}
          padTop={padTop}
          cards={visibleCards}
          total={cards.length}
          query={search.on ? search.q : ''}
          hits={hits}
          onQuery={(q) => setSearch({ q, on: true })}
          onClearSearch={disarmSearch}
          interactive={sw === 'open'}
          onSelect={selectCard}
          onKill={killCard}
          onNew={birthCard}
          onDone={() => closeTo(activePos())}
          onMove={async ({ from, to }) => {
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
          }}
          onScrollY={(y) => {
            scrollY.current = y;
          }}
        />
      )}

      {/* The stage wrapper the zoom animates: at rest an invisible identity, mid-transition the
          clipped, scaled, ringed terminal surface riding into its card slot. */}
      <Animated.View
        pointerEvents={sw === 'closed' ? 'auto' : 'none'}
        style={[
          stage === null
            ? styles.screen
            : [styles.stageWrapper, { width: stage.w, backgroundColor: theme.background }],
          stage !== null && wrapperStyle,
        ]}>
      {/* The stage: everything above the keyboard. The popover layer fills *this* view, not the
          screen, so a `bottom` measured from the bar holds whether the keyboard is up or not —
          absolute children sit inside the padding box, which is exactly the uncovered rect.
          Its height is the stage's own, fixed, NOT the wrapper's: the wrapper's height is what
          the zoom animates, and a flex child of an animating height does not get clipped by it,
          it gets re-laid-out by it — the terminal area shrinking a little more every frame with
          the key bar riding the bottom edge all the way into the card. Then the surface faded
          and the card underneath showed a pane with no bar and a different vertical scale, which
          is the jolt at the end of the flight (user, 2026-08-10). Fixed here, the wrapper clips
          instead: the bar slides out of the bottom of the frame, the pane keeps its geometry the
          whole way, and the snapshot it lands on is drawing the same rows at the same size. */}
      <View
        style={[
          stage === null ? styles.screen : { height: stage.h },
          { paddingBottom: keyboardPad },
        ]}>
      {/* T14: the terminal view's search bar — up exactly while the shared search is armed. The
          same string as the switcher's field; prev/next walk the addon's occurrences; Done
          disarms both views. */}
      {search.on && (
        <View style={styles.searchRow}>
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
      {/* The terminal area: the flex region above the bar. During a bar swipe the live terminal
          slides inside it as a rounded page card, with the neighbour snapshots as its siblings —
          the bar itself stays put, showing the name pills. */}
      <View style={styles.termArea}>
      {/* The pane's own breathing room. It is also what makes the zoom's crossfade seamless: a
          card's snapshot is inset by exactly this much seen through the zoom (switcher-model
          derives one from the other), so the text does not move when the surface hands over. */}
      <Animated.View
        style={[
          styles.termSlide,
          {
            backgroundColor: theme.background,
            paddingHorizontal: padH,
            paddingBottom: padBottom,
          },
          termSlideStyle,
        ]}>
      <TerminalView
        ref={terminal}
        theme={theme}
        fontSize={fontSize}
        onData={async (data) => send(data)}
        // The same hold, on this side of the bridge. `holdSize` is a prop, so it reaches the
        // webview a frame or two after the zoom has already started animating the stage's height
        // — long enough for one report to get out (a 25 on every tabs-tap open, device). This
        // guard is state, read in the same tick, so nothing slips through; the release re-reports
        // unconditionally, which is what makes dropping a report here safe.
        onResize={async (cols, rows, cellW, cellH, topInset) => {
          if (sw !== 'closed' || kbSettle) {
            console.log('[terminal] size held, not sent:', cols, '×', rows);
            return;
          }
          if (cellW > 0 && cellH > 0) setCell({ w: cellW, h: cellH });
          setPadTop(topInset);
          setSize(cols, rows);
        }}
        // The zoom owns the stage's height while it runs, and the keyboard leaves on the way in:
        // the terminal keeps the geometry it had at rest until the grid is gone, so the panes the
        // cards capture are the panes the user was just looking at.
        holdSize={sw !== 'closed' || kbSettle}
        // Every boot, not just the first: iOS reaps a backgrounded webview, and the one that comes
        // back is empty even though the shell behind it never went anywhere.
        onBoot={async () => {
          detach.current?.();
          detach.current = attachTerminal((base64) => {
            terminal.current?.write(base64);
            // A settle waiting on tmux's redraw ends here, at the first byte of it.
            const settled = onShellData.current;
            onShellData.current = null;
            settled?.();
          });
        }}
        onBell={() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
        // §4.7: a yank lands on the phone's pasteboard AND in the clipboard slots. OSC 52 reads
        // are refused inside the webview and never get here.
        onClipboard={async (text) => {
          await Clipboard.setStringAsync(text);
          pushYank(text);
        }}
        onLink={async (url) => {
          await WebBrowser.openBrowserAsync(url);
        }}
        // T6 produces the signal; the bar's arrows cluster consumes DECCKM, the ribbon consumes
        // altScreen. The log line stays — a missing one is a bridge fault.
        onModes={async (next) => {
          console.log('[session] modes', JSON.stringify(next));
          setModes(next);
        }}
        onTwoFingerTap={async () => openSettings()}
        onSearchResults={async (i, n) => setOcc({ i, n })}
        dom={{ scrollEnabled: false, style: styles.terminal }}
      />
      </Animated.View>

      {/* The neighbour pages while a swipe is live, and the settle overlay after a commit —
          which holds the committed snapshot over the terminal until tmux's redraw has landed. */}
      {stage !== null && showTabs && connected && pageSwipe?.phase !== 'settle' && (
        <>
          {anchor > 0 && (
            <NeighborPage side={-1} snap={neighbour(-1)} pitch={pagePitch(stage.w)} stageW={stage.w} theme={theme} cell={cell} insets={paneInsets} x={swipeX} />
          )}
          {anchor < cards.length - 1 && (
            <NeighborPage side={1} snap={neighbour(1)} pitch={pagePitch(stage.w)} stageW={stage.w} theme={theme} cell={cell} insets={paneInsets} x={swipeX} />
          )}
        </>
      )}
      {pageSwipe?.phase === 'settle' && stage !== null && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.page, { backgroundColor: theme.background }]}>
          <PageContent
            snap={pageSwipe.settled}
            stageW={stage.w}
            theme={theme}
            cell={cell}
            insets={paneInsets}
          />
        </View>
      )}

      {/* Outside-tap collapses an expanded TUI ribbon; only the terminal area eats the tap. */}
      {rbScrim && (
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setRbExpanded(false)} />
      )}
      </View>

      <KeyBar
        theme={theme}
        decckm={modes.decckm}
        bracketedPaste={modes.bracketedPaste}
        sendBytes={sendKeys}
        open={open}
        onOpenChange={setOpen}
        onHeight={setBarHeight}
        active={connected}
        focusSignal={focusSignal}
        sending={sending}
        // §4.5: the tabs button exists only with tmux present AND the config applied — so the
        // Settings toggle going off takes the button with it, and a host without tmux never
        // shows one (§7: silence, not a message).
        showTabs={showTabs}
        windowIndex={tmux.windowIndex ?? undefined}
        onTabsTap={openSwitcher}
        onSwitcherDrag={onSwitcherDrag}
        // T11: the page-slide window hop rides the horizontal bar pan — where there is tmux to
        // hop through; without it the axis is silence, like the tabs button (§7).
        onBarSwipe={showTabs ? onBarSwipe : undefined}
        pills={
          pageSwipe !== null && stage !== null
            ? { names: pageSwipe.names, pos: pageSwipe.pos, x: swipeX, pitch: pagePitch(stage.w) }
            : null
        }
        ribbon={ribbonEl}
      />

      {/* The popover layer: outside-tap scrim over everything (bar included, as in the
          prototype), popovers anchored `popBase` up. */}
      {open !== 'none' && (
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen('none')} />
          {open === 'arrows' ? (
            <ArrowsPopover
              theme={theme}
              decckm={modes.decckm}
              bottom={barHeight + 6}
              sendBytes={send}
            />
          ) : open === 'clipboard' ? (
            <ClipboardPopover
              theme={theme}
              bottom={barHeight + 6}
              bracketedPaste={modes.bracketedPaste}
              sendBytes={send}
              onClose={() => setOpen('none')}
            />
          ) : (
            <BarMenu
              theme={theme}
              bottom={barHeight + 6}
              onUpload={startUpload}
              onOpenSettings={openSettings}
            />
          )}
        </View>
      )}
      </View>

      {/* the transition's accent ring, clipping and scaling with the wrapper */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderColor: theme.accent }, ringStyle]}
      />
      </Animated.View>
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
    </SafeAreaView>
  );
}

/* --- T11: the page-slide's cards --- */

/** A neighbour's captured pane, parsed for the Snapshot renderer — the switcher's snapshot of
 *  that window. `null` only for a window nothing has captured yet: a blank page card. */
type PageSnap = Snap | null;

type PageSwipe = {
  names: string[];
  /** Grid position of the current window at swipe start, and how many there are. */
  pos: number;
  count: number;
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
}: {
  snap: PageSnap;
  stageW: number;
  theme: Theme;
  cell: { w: number; h: number };
  insets: { top: number; side: number; bottom: number };
}) {
  if (snap === null) return null;
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
        {...snapshotType(cell, 1, snap.cols, stageW - 2 * insets.side)}
      />
    </View>
  );
}

/** One neighbour page card, riding the shared page offset a full pitch to the side. */
function NeighborPage({
  side,
  snap,
  pitch,
  stageW,
  theme,
  cell,
  insets,
  x,
}: {
  side: -1 | 1;
  snap: PageSnap;
  pitch: number;
  stageW: number;
  theme: Theme;
  cell: { w: number; h: number };
  insets: { top: number; side: number; bottom: number };
  x: SharedValue<number>;
}) {
  const style = useAnimatedStyle(() => ({
    transform: [{ translateX: side * pitch + x.value }],
  }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.page, { backgroundColor: theme.background }, style]}>
      <PageContent snap={snap} stageW={stageW} theme={theme} cell={cell} insets={insets} />
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
  terminal: { flex: 1 },
  termArea: { flex: 1 },
  termSlide: { flex: 1, overflow: 'hidden' },
  page: { borderRadius: PAGE_RADIUS, overflow: 'hidden' },
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
