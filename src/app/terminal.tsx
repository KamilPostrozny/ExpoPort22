import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';
import KeyBar, { ArrowsPopover, BarMenu, type BarPopover } from '@/keybar';
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
import { endpoint, getSettings, useSettings } from '@/settings';
import TerminalView, { type TerminalHandle } from '@/terminal';
import { MONO, type Theme } from '@/theme';

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
  const { fontSize } = useSettings();
  const session = useSession();
  const terminal = useRef<TerminalHandle>(null);
  const detach = useRef<(() => void) | null>(null);
  const [open, setOpen] = useState<BarPopover>('none');
  const [decckm, setDecckm] = useState(false);
  /** The bar stack's measured height — the `popBase` the popovers anchor on. */
  const [barHeight, setBarHeight] = useState(60);

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

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
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
        // §4.7: a yank lands on the phone's pasteboard. The slot history is T8's.
        onClipboard={async (text) => {
          await Clipboard.setStringAsync(text);
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
        active={session.status === 'connected'}
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
          ) : (
            <BarMenu theme={theme} bottom={barHeight + 6} onOpenSettings={openSettings} />
          )}
        </View>
      )}
      </View>
      </KeyboardAvoidingView>

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
