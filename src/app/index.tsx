import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';
import { loadOrCreateKey, type KeyPair } from '@/keys';
import { connect } from '@/session';
import { getSettings, updateSettings, useSettings, validate } from '@/settings';
import { MONO } from '@/theme';

/**
 * Setup (§4.1): the one host, the one key, and the button that starts a session. The fields are the
 * settings store itself rather than a draft — there is nothing to cancel, and the same values are
 * what a reconnect uses hours later.
 *
 * The key is generated on first launch, not on demand: it is what the user has to paste into
 * `authorized_keys` before anything here can work, so it must be on screen before they ask.
 */
export default function Setup() {
  const theme = useTheme();
  const settings = useSettings();
  const [key, setKey] = useState<KeyPair | null>(null);
  // The port is edited as text so a half-typed field can be empty; `validate` has the last word.
  const [port, setPort] = useState(String(settings.port));
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadOrCreateKey().then(setKey, (error) => setProblem(`Could not read the key: ${error}`));
  }, []);

  const start = () => {
    const invalid = validate(getSettings());
    setProblem(invalid);
    if (invalid !== null) return;
    connect();
    router.push('/terminal');
  };

  const copyKey = async () => {
    if (key === null) return;
    await Clipboard.setStringAsync(key.publicKeyLine);
    setCopied(true);
  };

  const field = (
    label: string,
    value: string,
    onChangeText: (text: string) => void,
    placeholder: string,
    keyboardType?: 'numeric',
  ) => (
    <View style={[styles.row, { backgroundColor: theme.panel }]}>
      <Text style={[styles.label, { color: theme.muted }]}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType={keyboardType}
        style={[styles.input, { color: theme.foreground }]}
      />
    </View>
  );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.title, { color: theme.foreground }]}>Port22</Text>
        <Text style={[styles.caption, { color: theme.muted }]}>
          One host, one key. The private half never leaves this phone.
        </Text>

        <View style={[styles.fields, { backgroundColor: theme.border }]}>
          {field('Host', settings.host, (host) => updateSettings({ host }), 'hostname or IP')}
          {field(
            'Port',
            port,
            (text) => {
              setPort(text);
              updateSettings({ port: Number(text) });
            },
            '22',
            'numeric',
          )}
          {field('User', settings.username, (username) => updateSettings({ username }), 'login name')}
          {field(
            'On connect',
            settings.startupCommand ?? '',
            (text) => updateSettings({ startupCommand: text === '' ? null : text }),
            'optional command, e.g. tmux attach',
          )}
        </View>

        {problem !== null && <Text style={[styles.problem, { color: theme.danger }]}>{problem}</Text>}

        <Pressable onPress={start} style={[styles.connect, { backgroundColor: theme.accent }]}>
          <Text style={[styles.connectLabel, { color: theme.onAccent }]}>Connect</Text>
        </Pressable>

        <Text style={[styles.caption, { color: theme.muted }]}>
          Add this line to ~/.ssh/authorized_keys on the host. Port22 never writes it for you.
        </Text>
        <View style={[styles.card, { backgroundColor: theme.panel }]}>
          <Text selectable style={[styles.key, { color: theme.foreground }]}>
            {key?.publicKeyLine ?? 'generating…'}
          </Text>
          <Pressable
            onPress={copyKey}
            disabled={key === null}
            style={[styles.copy, { backgroundColor: theme.surface }]}>
            <Text style={[styles.copyLabel, { color: theme.foreground }]}>
              {copied ? 'Copied' : 'Copy'}
            </Text>
          </Pressable>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: 24, gap: 12 },
  title: { fontSize: 34, fontWeight: '700' },
  caption: { fontSize: 13, lineHeight: 18 },
  card: { borderRadius: 12, overflow: 'hidden' },
  // The dividers are the gaps: the container is painted in the border colour and each row covers
  // its own share of it, which is one hairline between rows and none against the card's edges.
  fields: { borderRadius: 12, overflow: 'hidden', gap: StyleSheet.hairlineWidth },
  row: { flexDirection: 'row', alignItems: 'center' },
  label: { width: 96, paddingLeft: 14, fontSize: 15 },
  input: { flex: 1, paddingVertical: 13, paddingRight: 14, fontSize: 16 },
  problem: { fontSize: 14, lineHeight: 19 },
  connect: { borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  connectLabel: { fontSize: 17, fontWeight: '600' },
  key: { fontFamily: MONO, fontSize: 11, lineHeight: 16, padding: 14 },
  copy: {
    alignSelf: 'flex-start',
    marginHorizontal: 14,
    marginBottom: 14,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
  },
  copyLabel: { fontSize: 14, fontWeight: '600' },
});
