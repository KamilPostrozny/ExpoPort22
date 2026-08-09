import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';

import { pushYank } from '@/clipboard';
import { useTheme } from '@/hooks/use-theme';
import KeyBar, { ArrowsPopover, BarMenu, ClipboardPopover, type BarPopover } from '@/keybar';
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
import Switcher, { useSwitcherCards, type Card } from '@/switcher';
import {
  ZOOM_COMMIT,
  gridTop,
  plusFrame,
  slotFrame,
  zoomFrame,
  zoomProgress,
  type Frame,
} from '@/switcher-model';
import TerminalView, { type TerminalHandle } from '@/terminal';
import { killWindow, moveWindow, newWindow, selectWindow, useTmux } from '@/tmux';
import { deriveConfigStatus, tabsAvailable, type TmuxWindow } from '@/tmux-model';
import { MONO, type Theme } from '@/theme';
import { pick, sendFile, useUploadBusy, type UploadKind } from '@/upload';
import { joinPath, sanitizeFilename, stampName } from '@/upload-model';
import UploadSheet from '@/upload-sheet';

/**
 * The session on screen: the terminal, and — over it, whenever there is no shell behind it — the
 * three states §4.9 asks for. The terminal itself stays mounted through all of them, so a reconnect
 * comes back to the same scrollback in a webview that is already booted.
 *
 * Below the terminal sits T7's key bar, and inside the bar the native `TextInput` that owns the
 * keyboard (T4's decision — the webview never takes focus). KeyboardAvoidingView is what docks the
 * bar above the keyboard and shrinks the terminal with it, which is also what triggers §4.2's
 * debounced resize.
 */
export default function SessionScreen() {
  const theme = useTheme();
  const { fontSize, configureTmux, host, lastUploadDir } = useSettings();
  const session = useSession();
  const tmux = useTmux();
  const sending = useUploadBusy();
  const terminal = useRef<TerminalHandle>(null);
  const detach = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState<BarPopover>('none');
  const [decckm, setDecckm] = useState(false);
  /** The bar stack's measured height — the `popBase` the popovers anchor on. */
  const [barHeight, setBarHeight] = useState(60);
  /** A picked file waiting on a destination (§4.6): the sheet is up exactly while this is set. */
  const [pendingUpload, setPendingUpload] = useState<{ base64: string; suggestedName: string } | null>(
    null,
  );

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

  // TODO(T12): the real Settings sheet (§4.8). Both doors — the ⋯ menu row and the two-finger
  // tap on the grid — already lead here; until the sheet exists this stub keeps Disconnect
  // reachable, which is the one Settings action a session cannot be tested without.
  const openSettings = () => {
    setOpen('none');
    Alert.alert('Settings', 'The settings sheet lands in T12.', [
      { text: 'Disconnect', style: 'destructive', onPress: leave },
      { text: 'Close', style: 'cancel' },
    ]);
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
  const showTabs = tabsAvailable(tmux.present, deriveConfigStatus(configureTmux, tmux.config));
  const { cards, setCards, refresh } = useSwitcherCards(showTabs && connected, sw !== 'closed');

  /** The active window's grid position — tmux's fresher poll first, the list's flag second. */
  const activePos = () => {
    const byIndex = cards.findIndex((c) => c.win.index === tmux.windowIndex);
    if (byIndex >= 0) return byIndex;
    const byFlag = cards.findIndex((c) => c.win.active);
    return byFlag >= 0 ? byFlag : 0;
  };

  /** Grid position → the card's frame in stage coordinates (headroom above the grid, minus the
   *  grid's own scroll) — where the zoom aims. */
  const zoomSlot = (pos: number): Frame => {
    const w = stage?.w ?? 390;
    const f = slotFrame(pos, w);
    return { ...f, y: gridTop(w) + f.y - scrollY.current };
  };

  const ZOOM_OUT = { duration: 340, easing: Easing.out(Easing.cubic) };
  const ZOOM_IN = { duration: 380, easing: Easing.out(Easing.cubic) };

  const finishClose = () => {
    setSw('closed');
    setFocusSignal((n) => n + 1); // the prototype re-raises the keyboard on return
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
    if (!cards.some((c: Card) => c.win.id === win.id)) return; // already killed: indices renumber
    console.log('[switcher] kill', win.id);
    const remaining = cards.filter((c: Card) => c.win.id !== win.id);
    setCards(remaining); // optimistic: the card leaves before tmux answers
    void killWindow(win.index);
    if (remaining.length === 0) {
      // Last window: the shell behind the PTY dies with it, the §4.9 state machine takes the
      // screen. Just drop the grid — the Disconnected face is about to cover everything.
      prog.value = 0;
      dragX.value = 0;
      alpha.value = 1;
      setSw('closed');
    }
  };

  const birthCard = () => {
    if (sw !== 'open' || stage === null) return;
    console.log('[switcher] new window');
    void newWindow(); // tmux switches the attached client to it, so the terminal lands on it
    slotSV.value = plusFrame(stage.w, stage.h);
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
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
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
          cards={cards}
          interactive={sw === 'open'}
          onSelect={selectCard}
          onKill={killCard}
          onNew={birthCard}
          onDone={() => closeTo(activePos())}
          onMove={async ({ from, to }) => {
            await moveWindow(from, to);
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
      <KeyboardAvoidingView
        style={styles.screen}
        // 'padding' is the iOS behaviour; Android sizes the window itself (T3's sibling will
        // revisit when the bar rides Gboard per §4.10).
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      {/* The stage: everything above the keyboard. The popover layer fills *this* view, not the
          screen, so a `bottom` measured from the bar holds whether the keyboard is up or not. */}
      <View style={styles.screen}>
      <TerminalView
        ref={terminal}
        theme={theme}
        fontSize={fontSize}
        onData={async (data) => send(data)}
        onResize={async (cols, rows) => setSize(cols, rows)}
        // Every boot, not just the first: iOS reaps a backgrounded webview, and the one that comes
        // back is empty even though the shell behind it never went anywhere.
        onBoot={async () => {
          detach.current?.();
          detach.current = attachTerminal((base64) => terminal.current?.write(base64));
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
        // T6 produces the signal; the bar's arrows cluster consumes DECCKM now, T11's ribbon
        // takes the rest later. The log line stays — a missing one is a bridge fault.
        onModes={async (modes) => {
          console.log('[session] modes', JSON.stringify(modes));
          setDecckm(modes.decckm);
        }}
        onTwoFingerTap={async () => openSettings()}
        dom={{ scrollEnabled: false, style: styles.terminal }}
      />

      <KeyBar
        theme={theme}
        decckm={decckm}
        sendBytes={send}
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
      />

      {/* The popover layer: outside-tap scrim over everything (bar included, as in the
          prototype), popovers anchored `popBase` up. */}
      {open !== 'none' && (
        <View style={StyleSheet.absoluteFill}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setOpen('none')} />
          {open === 'arrows' ? (
            <ArrowsPopover
              theme={theme}
              decckm={decckm}
              bottom={barHeight + 6}
              sendBytes={send}
            />
          ) : open === 'clipboard' ? (
            <ClipboardPopover
              theme={theme}
              bottom={barHeight + 6}
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
      </KeyboardAvoidingView>

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

      {session.status !== 'connected' && (
        <Status session={session} theme={theme} onSetup={leave} />
      )}
    </SafeAreaView>
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
  stageWrapper: { position: 'absolute', top: 0, left: 0, overflow: 'hidden' },
  terminal: { flex: 1 },
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
