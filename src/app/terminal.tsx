import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as WebBrowser from 'expo-web-browser';

import { toBase64 } from '@/base64';
import { useTheme } from '@/hooks/use-theme';
import { useSettings } from '@/settings';
import TerminalView, { type TerminalHandle } from '@/terminal';

/** Throwaway harness for T4: no host, no SSH — the terminal echoes what you type, and the buttons
 *  push at it the sequences a real session would (colour, bold, a link, a yank, a bell). T5 wires
 *  the same component to a PTY and deletes this. */
export default function TerminalHarness() {
  const theme = useTheme();
  const { fontSize } = useSettings();
  const terminal = useRef<TerminalHandle>(null);
  const native = useRef<TextInput>(null);
  const [status, setStatus] = useState('—');

  // The screen says when it is on and off screen, because the person tapping is on the same phone
  // and cannot narrate: the log is the only way to know which screen a screenshot will show.
  useEffect(() => {
    console.log('[terminal] screen open');
    return () => console.log('[terminal] screen closed');
  }, []);

  const write = (text: string) => terminal.current?.write(toBase64(new TextEncoder().encode(text)));

  /** On screen and in the Metro console both — the console is the only one of the two that can be
   *  read from the machine the fix is being written on. */
  const report = (line: string) => {
    console.log('[terminal]', line);
    setStatus(line);
  };

  const DEMO = [
    '\x1b[1;34m~/Projects/ExpoPort22\x1b[0m $ vim src/terminal.tsx\r\n',
    '\x1b[38;5;213m  1 \x1b[0m\x1b[1mexport default function\x1b[0m \x1b[33mTerminalView\x1b[0m() {\r\n',
    '\x1b[38;5;213m  2 \x1b[0m  \x1b[32m// ┌───────────── box drawing ─────────────┐\x1b[0m\r\n',
    '\x1b[38;5;213m  3 \x1b[0m  \x1b[31mconst\x1b[0m nerd = "   ";\r\n',
    // 31 columns wide on purpose: the narrowest this app gets is 33, and a status line that wraps
    // says nothing about the terminal, only about the demo string.
    `\x1b[7m${' NORMAL  terminal.tsx'.padEnd(24)}3,1 All\x1b[0m\r\n`,
    'link: \x1b]8;;https://docs.expo.dev/guides/dom-components/\x1b\\Expo DOM components\x1b]8;;\x1b\\\r\n',
  ].join('');

  const actions: [string, () => void][] = [
    ['demo', () => write(DEMO)],
    ['bell', () => write('\x07')],
    ['yank', () => write(`\x1b]52;c;${toBase64(new TextEncoder().encode('yanked from tmux'))}\x07`)],
    ['osc52 read', () => write('\x1b]52;c;?\x07')],
    ['focus', () => terminal.current?.focus()],
    // The experiment behind the long-press question: raise the keyboard from a *native* input, so
    // nothing inside the webview has focus. If a long-press then selects, the answer for §4.2 is to
    // take keyboard input natively and leave the page to display and selection alone.
    ['native kbd', () => native.current?.focus()],
  ];

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <TerminalView
        ref={terminal}
        theme={theme}
        fontSize={fontSize}
        onData={async (data) => {
          report(`data ${JSON.stringify(data)}`);
          // Local echo, the one job a host would otherwise do: CR becomes CRLF, delete rubs out.
          write(data === '\r' ? '\r\n' : data === '\x7f' ? '\b \b' : data);
        }}
        onResize={async (cols, rows) => report(`resize ${cols}×${rows}`)}
        onBell={async () => {
          report('bell');
          await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        }}
        onClipboard={async (text) => report(`yank: ${text}`)}
        onLink={async (url) => {
          report(`link: ${url}`);
          await WebBrowser.openBrowserAsync(url);
        }}
        dom={{ scrollEnabled: false, style: styles.terminal }}
      />

      <TextInput
        ref={native}
        style={styles.offscreen}
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={(text) => report(`native key ${JSON.stringify(text)}`)}
      />

      <View style={styles.bar}>
        {actions.map(([label, action]) => (
          <Pressable
            key={label}
            onPress={action}
            style={[styles.pill, { backgroundColor: theme.surface }]}>
            <Text style={[styles.label, { color: theme.foreground }]}>{label}</Text>
          </Pressable>
        ))}
        {/* One line, never wrapping: a status that grows a second line changes the bar's height,
            which resizes the terminal, which writes a new status — the terminal never settles. */}
        <Text numberOfLines={1} style={[styles.status, { color: theme.muted }]}>
          {status}
        </Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  terminal: { flex: 1 },
  bar: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: 8 },
  pill: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  label: { fontSize: 13, fontWeight: '600' },
  status: { fontSize: 13, fontWeight: '600', flexBasis: '100%' },
  // Focusable and on screen, but nothing to look at: this is the keyboard's owner, not a field.
  offscreen: { position: 'absolute', top: 0, left: 0, width: 1, height: 1, opacity: 0 },
});
