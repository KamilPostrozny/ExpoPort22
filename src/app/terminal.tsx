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
  type ScrollView,
} from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeOut,
  runOnJS,
  useAnimatedStyle,
  useFrameCallback,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  PAGE_GAP,
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
import { RibbonHandle, RibbonPanel } from '@/ribbon';
import {
  RIBBON_IDLE,
  killCommand,
  ribbonPoll,
  ribbonResumed,
  ribbonSent,
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
  gridTop,
  aimFrame,
  cardCarry,
  holdFrame,
  slotFrame,
  snapshotType,
  termPad,
  zoomBox,
  zoomFrame,
  zoomProgress,
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

  /** How long a zoom phase may stand before the watchdog below calls it stuck. The animations are
   *  340 and 380ms, so this is comfortably past any real one and still inside a lost second. */
  const PHASE_WATCHDOG_MS = 1500;
  const ZOOM_OUT = { duration: 340, easing: Easing.out(Easing.cubic) };
  const ZOOM_IN = { duration: 380, easing: Easing.out(Easing.cubic) };
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
    if (probeT0.current === 0) return;
    const dt = Date.now() - probeT0.current;
    if (dt > 2000) {
      probeT0.current = 0;
      return;
    }
    console.log(`[probe] +${dt}ms ${what}`);
  };

  /* The events all land outside the flight and it still hitches, so the next question is not WHAT
   * happened but WHEN a frame was missed. This runs on the UI thread — the one actually drawing
   * the zoom — and reports any frame that took longer than two, with the progress it happened at.
   * Early means the flight's own first frames, late means the crossfade and the landing; the
   * number says how many frames went. Temporary, with the rest of the probe. */
  const dropped = (ms: number, at: number) =>
    console.log(`[probe] FRAME ${ms.toFixed(0)}ms at prog ${at.toFixed(2)}`);
  useFrameCallback((frame) => {
    'worklet';
    const t = prog.value;
    if (t <= 0 || t >= 1) return; // nothing is flying
    const dt = frame.timeSincePreviousFrame ?? 0;
    // 12, not 26: on a 120Hz panel a frame is 8.3ms, so a single missed frame is ~16.6 — under the
    // old threshold, which is why the probe only ever caught the 3-and-4-frame stalls at the ends
    // and stayed silent through the one being reported in the middle (user, 2026-08-11).
    if (dt > 12) runOnJS(dropped)(dt, t);
  });

  const commitOpen = () => {
    setSw('opening');
    dragX.value = withTiming(0, { duration: 250 });
    // The release is what sends the card to its slot: until now it has been aimed at the hold pose
    // under the finger (`aimFrame`). On every other route in this is already 1 and the timing is a
    // no-op. It rides ZOOM_OUT so the aim and the progress arrive together — a shorter curve here
    // would land the card in its slot and then keep scaling into it.
    flight.value = withTiming(1, ZOOM_OUT);
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
      if (done) {
        alpha.value = 0;
        runOnJS(setSw)('open');
      }
    });
  };

  const springBack = () => {
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

  // The bar-swipe-up drag-follow (prototype `zoomFollow`): progress tracks the finger, release
  // past the threshold — or a flick that never got that far — commits, anything less springs back.
  /** Touch-down of the current zoom drag, for `zoomCommits`' flick window. The horizontal hop
   *  keeps its own in `swipeInfo.t0` for the same reason: the pan reports travel, not time. */
  const zoomT0 = useRef(0);
  /** Has the open's one-off cost landed (two frames, as in `openSwitcher`)? Until it has, the
   *  drag is set-up only and nothing moves. */
  const zoomReady = useRef(false);
  /** The pan's translation at the frame the follow armed — the origin the surface grows from. */
  const zoomFrom = useRef<{ x: number; y: number } | null>(null);
  /** The progress the follow starts from: 0 for a fresh grab, wherever a caught close had got to. */
  const zoomBase = useRef(0);
  /** Is a zoom drag live? The gesture's own truth, and the only thing its lifecycle turns on.
   *  `sw` cannot be: `setSw('drag')` is read back by the very next pan report, and a flick that
   *  ends in the same frame gets its release judged against a phase React has not written yet —
   *  the release is dropped, the render lands on `drag`, and nothing is left to end it. That is a
   *  frozen app (user, 2026-08-11), and it is the same shape as the two before it. */
  const dragging = useRef(false);
  const onSwitcherDrag = (phase: 'move' | 'end', dx: number, dy: number) => {
    if (stage === null) return;
    // Where the phase IS consulted it comes off the ref, not the render: a pan reports every frame,
    // and through a closure a render behind, "already dragging" still looks like "closed" — the
    // open ran again every frame until React caught up, re-firing its capture and resetting the
    // origin under the finger (user, 2026-08-11, "laggy").
    const at = swRef.current;
    if (phase === 'move') {
      if (!dragging.current && at === 'closed') {
        console.log('[switcher] open (bar drag)');
        setOpen('none');
        // The grab no longer implies a raised keyboard (the swipe ↑ is one gesture whatever the
        // keys are doing), so read the pad as the tap door does. KeyBar's dismiss is one call old
        // at this point and iOS reports the frame a beat later, so this is still the pre-drag
        // truth — and it is what decides whether the keys come back on the way out.
        keysWereUp.current = keyboardPad > 0;
        zoomT0.current = Date.now();
        const pos = activePos();
        setZoomId(idAt(pos));
        slotSV.value = zoomSlot(pos);
        // In the hand, not on its way to the grid: the card shrinks toward the centred hold pose
        // and stays somewhere it can still be pushed sideways. `commitOpen` releases it.
        flight.value = 0;
        const aimed = visibleCards[pos]?.win; // same staleness as the tap door — see openSwitcher
        if (aimed) void refreshCard(aimed);
        setSw('drag');
        // The tap defers its flight two frames so the open's one-off costs — the phase render, the
        // holdSize marshal into the webview, the keyboard starting down — are paid before anything
        // moves (see `openSwitcher`). This gesture used to pay them on the frame its motion
        // started, which is the same hitch, under a finger instead of an animation (user,
        // 2026-08-11). It waits the same two frames; where the tap can simply delay, the drag
        // re-origins at the frame it arms, so the surface grows from zero where the finger has got
        // to rather than jumping to the travel it spent waiting.
        dragging.current = true;
        zoomReady.current = false;
        zoomFrom.current = null;
        zoomBase.current = 0;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            zoomReady.current = true;
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
        cancelAnimation(prog);
        cancelAnimation(dragX);
        cancelAnimation(alpha);
        alpha.value = 1;
        zoomBase.current = prog.value;
        zoomT0.current = Date.now();
        zoomFrom.current = { x: dx, y: dy };
        zoomReady.current = true;
        setSw('drag');
        return;
      } else if (!dragging.current) return;
      if (!zoomReady.current) return;
      if (zoomFrom.current === null) zoomFrom.current = { x: dx, y: dy };
      prog.value = Math.min(1, zoomBase.current + zoomProgress(dy - zoomFrom.current.y, stage.w));
      dragX.value = dx - zoomFrom.current.x;
    } else if (dragging.current) {
      dragging.current = false;
      if (zoomCommits(dy, Date.now() - zoomT0.current, prog.value)) {
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

  const selectCard = (pos: number, win: TmuxWindow) => {
    if (sw !== 'open') return;
    console.log('[switcher] select', win.id);
    probeT0.current = Date.now();
    probe(`tap ${win.id} (${win.index === tmux.windowIndex ? 'same' : 'switch'})`);
    ribbonForWindow(win); // as with the bar swipe: under the zoom, not a beat after it
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
        ribbonForWindow(wins[pos]); // as with a select: under the zoom, not a beat after it
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
  /** A constant zero the pills read during the settle, in place of `swipeX` — see the pills
   *  prop for why the real value is briefly stale there. */
  const pillsSettled = useSharedValue(0);
  const roundSV = useSharedValue(0); // gate for the page's card edge, 0→1 (the corners are constant)
  // `pageSwipe` itself is declared with the switcher state above (the cache freezes on it).
  const swipeInfo = useRef<{ windows: TmuxWindow[]; pos: number; t0: number; live: boolean } | null>(
    null,
  );
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
    if (!skipRefresh) void refresh(true);
    selectSeq.current++; // supersedes a settle's redraw-wait, so it cannot clear a later swipe
    swipeInfo.current = null;
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
    if (pageSwipe?.phase === 'settle') swipeX.value = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageSwipe?.phase]);

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
    setPageSwipe((s) => (s === null ? s : { ...s, phase: 'anim' }));
    // No edge-fade timer: the slide home takes x to 0 and the travel factor fades it with it.
    slideTo(0, () => clearBarSwipe(skipRefresh));
  };

  const onBarSwipe = (phase: 'start' | 'move' | 'end', dx: number) => {
    if (stage === null) return;
    if (phase === 'start') {
      // `drag` is a swipe that has ALREADY lifted — Safari's card can be paged sideways after it
      // has left the bar, and the finger may only decide that a hundred points into the pull up
      // (user, 2026-08-12). Off the ref, not the render: mid-gesture the render is a frame behind.
      if ((swRef.current !== 'closed' && swRef.current !== 'drag') || !connected) return;
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
      swipeInfo.current = { windows, pos, t0: Date.now(), live: true };
      setOpen('none');
      // §7: "the neighbour did not render" and "the neighbour rendered with nothing in it" look
      // identical on a dark theme — an empty page card is the background colour. Only the cache
      // can tell them apart (user, 2026-08-13, three screenshots of an empty half-screen).
      console.log(
        '[barswipe] start at', pos, 'of', windows.length,
        'snaps', cards.map((c) => (c.snap ? '#' : '.')).join(''),
      );
      setPageSwipe({
        names: [...windows.map((w) => w.name), NEW_TAB_NAME],
        pos,
        target: pos,
        phase: 'drag',
        settled: null,
        settleInsets: null,
      });
      roundSV.value = 1; // the edge itself rides the travel — see pageEdgeStyle
      swipeX.value = rubber(dx, pos, windows.length + 1);
    } else if (phase === 'move') {
      const info = swipeInfo.current;
      if (!info?.live) return;
      swipeX.value = rubber(dx, info.pos, info.windows.length + 1);
    } else {
      const info = swipeInfo.current;
      if (!info?.live) return;
      // The same release lifted the card into the grid: this axis yields (see `onSwitcherDrag`).
      // The refresh is skipped — a capture per window on the JS thread is the stutter
      // `clearBarSwipe` describes, and here it would land inside the flight.
      if (gridTookIt.current) {
        gridTookIt.current = false;
        console.log('[barswipe] yielded to the grid');
        springPageHome(true);
        return;
      }
      const target = swipeTarget(dx, Date.now() - info.t0, info.pos, info.windows.length + 1);
      if (target === info.pos) {
        console.log('[barswipe] cancel');
        springPageHome(false);
      } else {
        info.live = false;
        // `undefined` at the slot past the last tab — the page sliding in is a window that does
        // not exist yet, and committing onto it is what births it (user, 2026-08-10).
        const win = info.windows[target];
        console.log('[barswipe] commit →', win ? `window ${win.index} (${win.name})` : 'new window');
        // The handle changes with the slide, not a poll beat after it — and it costs no height,
        // so nothing refits. A window we are about to create runs an idle shell: no handle.
        if (win) ribbonForWindow(win);
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
        else newWindow().catch((error) => console.log('[barswipe] new window failed:', error));
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
  // The other half of `cardCarry`: the page slides inside the surface exactly as much as the card
  // around it does not. The two are the same distance on screen, so nothing moves at the handover.
  const termSlideStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: swipeX.value * (1 - cardCarry(prog.value)) }],
  }));
  // The card's edge: in the dark flavours base and crust are nearly the same ink, so the gap
  // alone does not separate card from backdrop (user, 2026-08-11, screenshot) — the same
  // hairline the switcher's cards wear does. An overlay, NOT a real border: a border is part of
  // the box and would resize the terminal mid-swipe. This one still fades in with the travel —
  // the corners are permanent, a hairline round the resting page is not.
  const pageEdgeStyle = useAnimatedStyle(() => ({
    opacity: Math.min(Math.abs(swipeX.value) / roundR, 1) * roundSV.value,
  }));
  /** The settle overlay's edge follows `roundSV`'s fade-out, not the travel — the reset has
   *  already zeroed `swipeX` under it. */
  const settleEdgeStyle = useAnimatedStyle(() => ({ opacity: roundSV.value }));

  /* --- T11: the edge handle (§4.4) ---
   *
   * State crosses in ribbon-model's reducer (tested): T9's foreground poll, T6's altScreen, and
   * the ^Z watch on the key bar's send path. The screen only feeds events in and executes caps. */
  const [ribbonCore, setRibbonCore] = useState(RIBBON_IDLE);
  /** The panel: open by the handle's tap/swipe, closed by a cap, the scrim, or the stub. */
  const [rbOpen, setRbOpen] = useState(false);
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
  }, [fgCommand, fgPid, frozen]);
  // A new process instance means the caps under the finger changed: the panel closes.
  useEffect(() => setRbOpen(false), [ribbonCore.instance]);

  /** The recipe for a window we are switching to, named from the list rather than waited for,
   *  so the handle changes with the transition instead of a poll beat after it. Every switch
   *  goes through here — a committed bar swipe, a card tap, a new window. */
  const ribbonForWindow = (win: TmuxWindow) => {
    const idle = IDLE_SHELLS.has(win.command);
    setRibbonCore((c) =>
      ribbonPoll(c, idle ? null : { command: win.command, pid: null }, Date.now()),
    );
  };

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

  /** The bar-swipe morph inputs the name pills ride. See KeyBarProps.pills for why it exists at
   *  rest too. */
  const pillsProp =
    showTabs && connected && stage !== null
      ? {
          names: pageSwipe?.names ?? [...cards.map((c) => c.win.name), NEW_TAB_NAME],
          pos: pageSwipe?.pos ?? activePosIn(cards),
          // The settle moves `pos` to the target in the same commit, but `swipeX` keeps the
          // slide's final offset until the post-paint reset effect — read together they put the
          // continuous position a full window off, snapping the new pill to a capsule and back
          // (user, 2026-08-11). The settle IS the landing: pinned to a zero offset there.
          x: pageSwipe === null || pageSwipe.phase === 'settle' ? pillsSettled : swipeX,
          pitch: pagePitch(stage.w),
          // The settle is the BAR's landing, not the terminal's. The overlay still waits for the
          // host to finish redrawing, because it is a picture of a pane and a stale one would
          // show — but the keys are not a picture of anything, and holding them behind that wait
          // is what read as the bar taking forever to settle (user, 2026-08-11; the probe trace
          // put tmux's redraw at +35ms and the keys at +550). Pills and keys are both mounted, so
          // this flips two opacities.
          live: pageSwipe !== null && pageSwipe.phase !== 'settle',
        }
      : null;

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

  /** What the surface is aimed at this frame — the hold pose under the finger, the slot once
   *  released, interpolated by `flight` (see `aimFrame`). Every style that draws the zoom reads
   *  the aim rather than the slot, so the card, its ring and its neighbours agree by construction. */
  const aim = () => {
    'worklet';
    return aimFrame(holdFrame(stageSV.value), slotSV.value, flight.value);
  };

  /**
   * A neighbouring page's card, INSIDE the zoomed container with the live one. It carries nothing
   * but its pitch and the crop — the scale and the flight are the container's, which is the only
   * way two cards are guaranteed to agree (see `zoomBox`).
   *
   * The swipe offset it carries is the half `cardCarry` leaves it: at rest the pages slide and the
   * container is identity, lifted the container slides and the pages sit still in it. The live
   * page's own `termSlideStyle` is the same expression, which is what keeps the row rigid.
   */
  const usePageCardStyle = (side: -1 | 1) =>
    useAnimatedStyle(() => {
      const f = zoomFrame(prog.value, dragX.value, aim(), stageSV.value);
      const pitch = stageSV.value.w * (1 + PAGE_GAP);
      return {
        height: f.height,
        borderRadius: f.radius,
        transform: [{ translateX: side * pitch + swipeX.value * (1 - cardCarry(prog.value)) }],
      };
    });
  const prevCardStyle = usePageCardStyle(-1);
  const nextCardStyle = usePageCardStyle(1);

  /** The container every card rides: one scale, one flight, one place. Its height is the stage's
   *  and stays there — the cards inside clip themselves — so it can hold pages a pitch to either
   *  side without a clip cutting them off. */
  const boxStyle = useAnimatedStyle(() => {
    const b = zoomBox(prog.value, dragX.value, aim(), stageSV.value);
    return {
      opacity: alpha.value,
      transform: [
        // The row moves as one once the card has lifted (`cardCarry`); at rest the pages inside
        // move instead, and this is identity.
        { translateX: b.translateX + swipeX.value * cardCarry(prog.value) * b.scale },
        { translateY: b.translateY },
        { scale: b.scale },
      ],
    };
  });

  // The stage wrapper: identity at rest, the zoom interpolation the moment progress moves.
  // Height is the clip (the prototype's clip-path inset), radius the rounding, translate
  // compensated for RN's centre-origin scale — all from the one tested function.
  const wrapperStyle = useAnimatedStyle(() => {
    const f = zoomFrame(prog.value, dragX.value, aim(), stageSV.value);
    return {
      height: f.height,
      // All four corners together, the keyboard's cut included: the flying surface is the card,
      // and a card's bottom rounds in on the same beat as its top (user, 2026-08-11). The square
      // cut lives on the page inside it — see `kbSquare`.
      borderRadius: f.radius,
    };
  });

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
  const cropStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -cropTop * prog.value }],
  }));

  // The accent ring riding the transition (§4.5) — inside the wrapper so it clips and scales
  // with it; border width divided by scale so it reads ~3pt on screen throughout.
  const ringStyle = useAnimatedStyle(() => {
    const f = zoomFrame(prog.value, dragX.value, aim(), stageSV.value);
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
    <View style={[styles.screen, { backgroundColor: theme.background }]}>
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
          gridRef={gridRef}
          zoomId={zoomId}
          fade={alpha}
        />
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

      {/* The neighbouring windows, a page-pitch to either side. They JOIN when the swipe does, not
          when the card lifts: a card held up on its own has no row around it until the finger
          actually starts moving sideways (user, 2026-08-13) — which is exactly `pageSwipe`, the
          state a horizontal swipe creates. Drawn before the live card so it and its bar stay on
          top; they never overlap it anyway, being a pitch away.

          Gone once the release commits, or they would fly into the grid one pitch behind the card:
          tabs arriving in pairs (user, 2026-08-13, screenshot). */}
      {stage !== null && showTabs && connected && pageSwipe !== null && pageSwipe.phase !== 'settle' &&
        (sw === 'closed' || sw === 'drag') && (
        <>
          {anchor > 0 && (
            <Animated.View pointerEvents="none" style={[styles.stageWrapper, { width: stage.w, backgroundColor: theme.background }, prevCardStyle]}>
              <Animated.View style={[{ height: stage.h, paddingBottom: keyboardPad }, cropStyle]}>
                <NeighborPage snap={neighbour(-1)} stageW={stage.w} theme={theme} cell={cell} insets={paneInsets} liveCols={liveCols} bottomR={pageRB} />
              </Animated.View>
            </Animated.View>
          )}
          {/* One past the last window is the new-tab page: no snapshot, so it slides in as the
              empty pane the shell about to be born will draw into. */}
          {anchor < cards.length && (
            <Animated.View pointerEvents="none" style={[styles.stageWrapper, { width: stage.w, backgroundColor: theme.background }, nextCardStyle]}>
              <Animated.View style={[{ height: stage.h, paddingBottom: keyboardPad }, cropStyle]}>
                <NeighborPage snap={neighbour(1)} stageW={stage.w} theme={theme} cell={cell} insets={paneInsets} liveCols={liveCols} bottomR={pageRB} />
              </Animated.View>
            </Animated.View>
          )}
        </>
      )}

      {/* The live card: the clipped, rounded, ringed terminal surface. Identity at rest — at which
          point it is the screen — and the thing the ring belongs to at every other.

          No ground of its own, deliberately. At rest this box does not move: the page slides INSIDE
          it (`cardCarry`), so a background here stays spread across the whole stage while the page
          vacates half of it — an opaque sheet exactly where the arriving card is meant to show
          through, which is the neighbour that kept going missing (user, 2026-08-13, twice). The
          page paints its own ground, the bar band included, so nothing here needs to. */}
      <Animated.View
        style={[
          stage === null ? styles.screen : [styles.stageWrapper, { width: stage.w }],
          stage !== null && wrapperStyle,
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
            borderRadius: pageR,
            borderBottomLeftRadius: pageRB,
            borderBottomRightRadius: pageRB,
            paddingTop: notchPad,
            paddingHorizontal: padH,
            // The remainder makes the box an exact multiple of the cell, so the webview's own
            // top inset stays ~0 and the first row never moves — see rowRemainder.
            paddingBottom: padBottom + barPad + rowRemainder,
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
            console.log('[terminal] size held, not sent:', cols, '×', rows);
            return;
          }
          if (cellW > 0 && cellH > 0) setCell({ w: cellW, h: cellH });
          if (cols > 0) setLiveCols(cols);
          setPadTop(topInset);
          setSize(cols, rows);
        }}
        // The zoom owns the stage's height while it runs, and the keyboard leaves on the way in:
        // the terminal keeps the geometry it had at rest until the grid is gone, so the panes the
        // cards capture are the panes the user was just looking at.
        //
        // Except while the grid stands fully over it. A select can change the chrome under the
        // pane — a different window's ribbon appears or leaves with `ribbonForWindow` — and a
        // hold across `open` deferred that refit to the release settle, ~150ms after the landing:
        // the pane rewrapping in plain view on every switch between windows whose ribbons differ
        // (device, 2026-08-11, screenshots). While `open` the terminal is invisible, so the fit,
        // the report and tmux's redraw all run there for free; `selectCard` waits for the
        // redraw's first byte before it flies. Every phase where the terminal is on screen and
        // moving — opening, drag, birth, closing — stays held.
        holdSize={(sw !== 'closed' && sw !== 'open') || kbSettle}
        // Every boot, not just the first: iOS reaps a backgrounded webview, and the one that comes
        // back is empty even though the shell behind it never went anywhere.
        onBoot={async () => {
          detach.current?.();
          detach.current = attachTerminal((base64) => {
            dataSeq.current++; // "has the host redrawn yet" — see `afterHostRedraw`
            probe(`byte ${base64.length}b`);
            terminal.current?.write(base64);
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
        // §4.4: a tap on the terminal is the keyboard's door — the bar no longer raises it.
        // §4.4's door to the keyboard, both ways (user, 2026-08-12): a tap puts the keys away when
        // they are up and asks for them when they are down. It used to only ask — the going-away
        // half was the field resigning when the webview took the touch, which is not the same
        // thing as a tap and did not read as one.
        onTap={async () => {
          if (keyboardPad > 0) Keyboard.dismiss();
          else setFocusSignal((n) => n + 1);
        }}
        onSearchResults={async (i, n) => setOcc({ i, n })}
        dom={{ scrollEnabled: false, style: styles.terminal }}
      />
      {/* see pageEdgeStyle — the live page's card edge while a swipe is on */}
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.pageEdge,
          { borderColor: theme.border, borderRadius: pageR, borderBottomLeftRadius: pageRB, borderBottomRightRadius: pageRB },
          pageEdgeStyle,
        ]}
      />
      </Animated.View>

      {/* The settle overlay after a commit — holds the committed snapshot over the terminal until
          tmux's redraw has landed. (The neighbour pages are siblings of the whole wrapper now, not
          children of this crop: see `usePageCardStyle`.) */}
      {pageSwipe?.phase === 'settle' && stage !== null && (
        <Animated.View
          pointerEvents="none"
          // A dissolve, not a cut: the overlay holds the PRE-hop geometry (frozen insets) and
          // the live pane under it has already refit — the ribbon genuinely trades ~3 rows — so
          // an instant drop read as the terminal jumping at the end (user, 2026-08-11,
          // screenshots either side of the settle).
          exiting={FadeOut.duration(150)}
          style={[
            StyleSheet.absoluteFill,
            styles.page,
            { backgroundColor: theme.background, borderRadius: pageR, borderBottomLeftRadius: pageRB, borderBottomRightRadius: pageRB },
          ]}>
          <PageContent
            snap={pageSwipe.settled}
            stageW={stage.w}
            theme={theme}
            cell={cell}
            insets={pageSwipe.settleInsets ?? paneInsets}
            liveCols={liveCols}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              StyleSheet.absoluteFill,
              styles.pageEdge,
              { borderColor: theme.border, borderRadius: pageR, borderBottomLeftRadius: pageRB, borderBottomRightRadius: pageRB },
              settleEdgeStyle,
            ]}
          />
        </Animated.View>
      )}

      </View>

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
        sendBytes={sendKeys}
        open={open}
        onOpenChange={setOpen}
        onHeight={(h) => {
          if (h !== barHeight) probe(`barHeight ${barHeight.toFixed(0)} → ${h.toFixed(0)}`);
          setBarHeight(h);
        }}
        focusSignal={focusSignal}
        sending={sending}
        // §4.5: tabs are reachable only with tmux present AND the config applied AND a client
        // attached. False no longer removes the button — it greys it, and the tap explains itself
        // (`tabsHint`, user 2026-08-12).
        showTabs={showTabs}
        onTabsTap={openSwitcher}
        onSwitcherDrag={onSwitcherDrag}
        // T11: the page-slide window hop rides the horizontal bar pan — where there is tmux to
        // hop through; without it the axis is silence, like the tabs button (§7).
        onBarSwipe={showTabs ? onBarSwipe : undefined}
        pills={pillsProp}
      />
      </Animated.View>

      {/* The edge handle (§4.4): the recipe's colour tab on the terminal's right edge, floating
          over output just above the bar — zero vertical cost, so a recipe appearing or leaving
          never resizes the terminal. It fades with the bar during the switcher's flight. Open,
          the panel is its own layer: an invisible scrim (tap the terminal to close) under a
          right-aligned column of caps. */}
      {recipe !== null && !rbOpen && (
        <Animated.View
          pointerEvents="box-none"
          style={[StyleSheet.absoluteFill, barFadeStyle]}>
          <RibbonHandle
            theme={theme}
            recipe={recipe}
            bottom={popBase}
            onOpen={() => {
              console.log('[ribbon] open', recipe.proc);
              setRbOpen(true);
            }}
          />
        </Animated.View>
      )}
      {recipe !== null && rbOpen && (
        <RibbonPanel
          theme={theme}
          recipe={recipe}
          startedAt={ribbonCore.startedAt}
          busy={sending}
          bottom={popBase}
          maxCapsHeight={Math.max(150, (stage?.h ?? 600) - popBase - insets.top - 104)}
          onCap={onRibbonCap}
          onClose={() => setRbOpen(false)}
        />
      )}

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
      </Animated.View>

      {/* the transition's accent ring, clipping and scaling with the card it belongs to */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderColor: theme.accent }, ringStyle]}
      />
      </Animated.View>
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
    </View>
  );
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
  bottomR,
}: {
  snap: PageSnap;
  stageW: number;
  /** see `pageRB` — square while the keyboard cuts the page off */
  bottomR: number;
  theme: Theme;
  cell: { w: number; h: number };
  insets: { top: number; side: number; bottom: number };
  liveCols: number;
}) {
  return (
    <View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        styles.page,
        { backgroundColor: theme.background, borderRadius: pageRadius(stageW), borderBottomLeftRadius: bottomR, borderBottomRightRadius: bottomR },
      ]}>
      <PageContent
        snap={snap}
        stageW={stageW}
        theme={theme}
        cell={cell}
        insets={insets}
        liveCols={liveCols}
      />
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.pageEdge,
          { borderColor: theme.border, borderRadius: pageRadius(stageW), borderBottomLeftRadius: bottomR, borderBottomRightRadius: bottomR },
        ]}
      />
    </View>
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
  pageEdge: { borderWidth: 1 },
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
