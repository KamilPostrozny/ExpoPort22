import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';
import { loadOrCreateKey, type KeyPair } from '@/keys';
import { connect, listHostSessions } from '@/session';
import {
  SESSION_NAME,
  getSettings,
  updateSettings,
  useSettings,
  validate,
  type StartMode,
} from '@/settings';
import { CENTER, PRESSED, RADIUS, SECTION_HEADER, SPACE, TEXT, TINT, leading } from '@/style';
import { MONO } from '@/theme';

/** §4.1's start section, in the order a user would try them. The tmux pair first: they are the
 *  ones with the app's features attached. */
const START_ROWS: { mode: StartMode; label: string; note: string }[] = [
  { mode: 'session', label: 'tmux session', note: SESSION_NAME },
  { mode: 'attach', label: 'Existing tmux session', note: 'pick below' },
  { mode: 'shell', label: 'Plain shell', note: 'no tmux' },
  { mode: 'custom', label: 'Custom command', note: 'your own line' },
];

/** The attach mode's "no pick yet", which is a row like any other rather than an empty state. */
const MOST_RECENT = 'Most recent';

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

  // The attach picker's rows are the host's, so they are re-asked for whenever that mode is on
  // screen — cached ones show meanwhile, and on a host whose key is not pinned yet there is
  // nothing to ask with (see `listHostSessions`) and the list simply stays as it was.
  useEffect(() => {
    if (settings.startMode !== 'attach') return;
    let stale = false;
    listHostSessions().then((names) => {
      if (!stale && names.length > 0) updateSettings({ knownSessions: names });
    });
    return () => {
      stale = true;
    };
  }, [settings.startMode]);

  const pickMode = (mode: StartMode) => {
    console.log('[settings] startMode →', mode);
    updateSettings({ startMode: mode });
  };

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

        <View style={styles.fields}>
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
        </View>

        <Text style={[styles.header, { color: theme.muted }]}>Start</Text>
        <View style={styles.fields}>
          {START_ROWS.map(({ mode, label, note }) => (
            <Pressable
              key={mode}
              onPress={() => pickMode(mode)}
              style={[styles.row, styles.modeRow, { backgroundColor: theme.panel }]}>
              <View style={styles.modeText}>
                <Text style={[styles.modeLabel, { color: theme.foreground }]}>{label}</Text>
                <Text style={[styles.modeNote, { color: theme.muted }]}>{note}</Text>
              </View>
              {settings.startMode === mode && (
                <Text style={[styles.tick, { color: theme.accent }]}>✓</Text>
              )}
            </Pressable>
          ))}
          {/* The only mode with anything to type. */}
          {settings.startMode === 'custom' &&
            field(
              'Command',
              settings.startupCommand ?? '',
              (text) => updateSettings({ startupCommand: text === '' ? null : text }),
              'e.g. tmux attach',
            )}
        </View>

        {settings.startMode === 'attach' && (
          <View style={styles.fields}>
            {[null, ...settings.knownSessions].map((name) => (
              <Pressable
                key={name ?? MOST_RECENT}
                onPress={() => updateSettings({ attachSession: name })}
                style={[styles.row, styles.modeRow, { backgroundColor: theme.panel }]}>
                <Text style={[styles.modeLabel, styles.modeText, { color: theme.foreground }]}>
                  {name ?? MOST_RECENT}
                </Text>
                {settings.attachSession === name && (
                  <Text style={[styles.tick, { color: theme.accent }]}>✓</Text>
                )}
              </Pressable>
            ))}
          </View>
        )}

        {problem !== null && <Text style={[styles.problem, { color: theme.danger }]}>{problem}</Text>}

        <Pressable
          onPress={start}
          style={({ pressed }) => [
            styles.connect,
            { backgroundColor: theme.accent },
            pressed && PRESSED,
          ]}>
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
            style={({ pressed }) => [
              styles.copy,
              { backgroundColor: theme.surface },
              pressed && PRESSED,
            ]}>
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
  content: { padding: SPACE.xl, gap: SPACE.md },
  title: { fontSize: 34, fontWeight: '700' },
  caption: { fontSize: TEXT.base, lineHeight: leading(TEXT.base) },
  /** The label over a card, drawn the way the settings sheet draws its own group headers. */
  header: { ...SECTION_HEADER, paddingHorizontal: SPACE.gutter, paddingBottom: 7 },
  card: { borderRadius: RADIUS.card, overflow: 'hidden' },
  // The dividers are the gaps: the container is painted in the divider tint and each row covers
  // its own share of it, which is one hairline between rows and none against the card's edges.
  fields: {
    backgroundColor: TINT.line,
    borderRadius: RADIUS.card,
    overflow: 'hidden',
    gap: StyleSheet.hairlineWidth,
  },
  row: { flexDirection: 'row', alignItems: 'center' },
  modeRow: { paddingHorizontal: SPACE.gutter, paddingVertical: 9 },
  modeText: { flex: 1 },
  modeLabel: { fontSize: TEXT.label },
  modeNote: { fontSize: 12, lineHeight: 16 },
  tick: { fontSize: TEXT.label, fontWeight: '700' },
  label: { width: 88, paddingLeft: SPACE.gutter, fontSize: TEXT.label },
  input: { flex: 1, paddingVertical: 13, paddingRight: SPACE.gutter, fontSize: 16 },
  problem: { fontSize: 14, lineHeight: 19 },
  // The design pins its one filled button at 48 tall, so the height is set rather than left to
  // whatever the label plus a padding comes to.
  connect: { borderRadius: RADIUS.button, height: 48, ...CENTER },
  connectLabel: { fontSize: TEXT.button, fontWeight: '600' },
  key: { fontFamily: MONO, fontSize: 11, lineHeight: 16, padding: SPACE.gutter },
  copy: {
    alignSelf: 'flex-start',
    marginHorizontal: SPACE.gutter,
    marginBottom: 14,
    paddingHorizontal: SPACE.gutter,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.button,
  },
  copyLabel: { fontSize: 14, fontWeight: '600' },
});
