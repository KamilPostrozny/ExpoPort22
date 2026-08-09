import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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
  const [status, setStatus] = useState('—');

  const write = (text: string) => terminal.current?.write(toBase64(new TextEncoder().encode(text)));

  const DEMO = [
    '\x1b[1;34m~/Projects/ExpoPort22\x1b[0m $ vim src/terminal.tsx\r\n',
    '\x1b[38;5;213m  1 \x1b[0m\x1b[1mexport default function\x1b[0m \x1b[33mTerminalView\x1b[0m() {\r\n',
    '\x1b[38;5;213m  2 \x1b[0m  \x1b[32m// ┌───────────── box drawing ─────────────┐\x1b[0m\r\n',
    '\x1b[38;5;213m  3 \x1b[0m  \x1b[31mconst\x1b[0m nerd = "   ";\r\n',
    '\x1b[7m  NORMAL  src/terminal.tsx                        3,1   All \x1b[0m\r\n',
    'link: \x1b]8;;https://docs.expo.dev/guides/dom-components/\x1b\\Expo DOM components\x1b]8;;\x1b\\\r\n',
  ].join('');

  const actions: [string, () => void][] = [
    ['demo', () => write(DEMO)],
    ['bell', () => write('\x07')],
    ['yank', () => write(`\x1b]52;c;${toBase64(new TextEncoder().encode('yanked from tmux'))}\x07`)],
    ['osc52 read', () => write('\x1b]52;c;?\x07')],
    ['focus', () => terminal.current?.focus()],
  ];

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <TerminalView
        ref={terminal}
        theme={theme}
        fontSize={fontSize}
        onData={async (data) => {
          console.log('[terminal] data', JSON.stringify(data));
          // Local echo, the one job a host would otherwise do: CR becomes CRLF, delete rubs out.
          write(data === '\r' ? '\r\n' : data === '\x7f' ? '\b \b' : data);
        }}
        onResize={async (cols, rows) => setStatus(`${cols}×${rows}`)}
        onBell={async () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)}
        onClipboard={async (text) => setStatus(`yank: ${text}`)}
        onLink={async (url) => {
          await WebBrowser.openBrowserAsync(url);
        }}
        dom={{ scrollEnabled: false, style: styles.terminal }}
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
        <Text style={[styles.label, { color: theme.muted }]}>{status}</Text>
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
});
