import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import ExpoSSH from '../../modules/expo-ssh/src/ExpoSSHModule';
import { useTheme } from '@/hooks/use-theme';
import { toBase64 } from '@/base64';
import { loadOrCreateKey, type KeyPair } from '@/keys';
import { updateSettings, useSettings } from '@/settings';
import { MONO, MONO_BOLD, THEME_CHOICES } from '@/theme';

/** Throwaway harness until T5 puts the Setup screen here. Two jobs: prove T1 (bundled Nerd Font,
 *  live flavour switch, `auto` follows the system) and walk the T2 acceptance list — connect to a
 *  real host, `ls` over an exec channel, shell I/O, one file over SFTP. */
export default function Scratch() {
  const theme = useTheme();
  const settings = useSettings();
  const [key, setKey] = useState<KeyPair | null>(null);
  const [lines, setLines] = useState<string[]>([]);

  // On screen and in Metro both: the phone is where you notice, the console is where you read a
  // stack trace and scroll back past the 120 lines this keeps.
  const log = (line: string) => {
    console.log('[harness]', line);
    setLines((l) => [...l.slice(-120), line]);
  };

  useEffect(() => {
    loadOrCreateKey().then(setKey, (error) => log(`key: ${error}`));
  }, []);

  useEffect(() => {
    const hostKey = ExpoSSH.addListener('onHostKey', ({ fingerprint }) => {
      Alert.alert('Unknown host', `ed25519 ${fingerprint}`, [
        { text: 'Cancel', style: 'cancel', onPress: () => ExpoSSH.verifyHostKey(false) },
        { text: 'Trust', onPress: () => ExpoSSH.verifyHostKey(true) },
      ]);
    });
    const data = ExpoSSH.addListener('onShellData', ({ data }) =>
      log(new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))),
    );
    const closed = ExpoSSH.addListener('onShellClose', () => log('— shell closed —'));
    return () => {
      hostKey.remove();
      data.remove();
      closed.remove();
    };
  }, []);

  /** Every button is the same shape: say what it did, or say what went wrong. */
  const attempt = (label: string, action: () => Promise<unknown>) => async () => {
    log(`> ${label}`);
    try {
      const result = await action();
      if (typeof result === 'string' && result !== '') log(result.trimEnd());
    } catch (error) {
      log(`! ${error}`);
    }
  };

  const actions: [string, () => Promise<unknown>][] = [
    ['connect', () => ExpoSSH.connect(settings.host, settings.port, settings.username, key!.seedBase64)],
    ['exec ls', () => ExpoSSH.exec('ls', 1 << 16)],
    ['shell', () => ExpoSSH.startShell(80, 24, 'xterm-256color')],
    ['send date', () => ExpoSSH.send('date\n')],
    [
      'upload',
      () =>
        ExpoSSH.upload(toBase64(new TextEncoder().encode('port22\n')), '/tmp/port22/hello.txt', [
          '/tmp/port22',
        ]),
    ],
    ['ls /tmp/port22', () => ExpoSSH.listDirectory('/tmp/port22').then((e) => JSON.stringify(e))],
    ['alive?', () => ExpoSSH.isAlive(2000).then(String)],
    ['disconnect', () => ExpoSSH.disconnect()],
  ];

  const cycle = () => {
    const next = THEME_CHOICES[(THEME_CHOICES.indexOf(settings.theme) + 1) % THEME_CHOICES.length];
    updateSettings({ theme: next });
  };

  const field = (
    value: string,
    onChangeText: (text: string) => void,
    placeholder: string,
    keyboardType?: 'numeric',
  ) => (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={theme.placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={keyboardType}
      style={[styles.field, { color: theme.foreground, borderColor: theme.border }]}
    />
  );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text selectable style={[styles.log, { color: theme.muted }]}>
          {key?.publicKeyLine ?? 'generating key…'}
        </Text>

        <View style={styles.row}>
          {field(settings.host, (host) => updateSettings({ host }), 'host')}
          {field(
            String(settings.port),
            (port) => updateSettings({ port: Number(port) || 0 }),
            'port',
            'numeric',
          )}
          {field(settings.username, (username) => updateSettings({ username }), 'user')}
        </View>

        <View style={styles.buttons}>
          {actions.map(([label, action]) => (
            <Pressable
              key={label}
              disabled={key === null}
              onPress={attempt(label, action)}
              style={[styles.pill, { backgroundColor: theme.surface }]}>
              <Text style={[styles.pillLabel, { color: theme.foreground }]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        <Text selectable style={[styles.log, { color: theme.foreground }]}>
          {lines.join('\n')}
        </Text>

        <Pressable
          onPress={() => router.push('/terminal')}
          style={[styles.pill, { backgroundColor: theme.surface }]}>
          <Text style={[styles.pillLabel, { color: theme.foreground }]}>terminal (T4)</Text>
        </Pressable>

        <Pressable onPress={cycle} style={[styles.pill, { backgroundColor: theme.accent }]}>
          <Text style={[styles.pillLabel, { color: theme.onAccent }]}>
            {settings.theme}
            {settings.theme === 'auto' ? ` · ${theme.name}` : ''}
          </Text>
        </Pressable>

        <Text style={[styles.mono, { color: theme.foreground, fontSize: settings.fontSize }]}>
          {'     ~/Projects/ExpoPort22 $ tmux attach'}
        </Text>
        <Text
          style={[
            styles.mono,
            { color: theme.foreground, fontFamily: MONO_BOLD, fontSize: settings.fontSize },
          ]}>
          {'bold 0O1lI |=> <-> ligature-free'}
        </Text>

        <View style={styles.swatches}>
          {theme.ansi.map((hex, i) => (
            <View key={i} style={[styles.ansi, { backgroundColor: hex }]} />
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 24, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  field: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 8,
    paddingVertical: 6,
    fontFamily: MONO,
    fontSize: 13,
  },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  pill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 18,
  },
  pillLabel: { fontSize: 14, fontWeight: '600' },
  log: { fontFamily: MONO, fontSize: 11 },
  mono: { fontFamily: MONO },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', marginTop: 8 },
  ansi: { width: 22, height: 22 },
});
