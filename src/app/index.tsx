import * as Clipboard from 'expo-clipboard';
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import AppearanceCard from '@/appearance';
import RequireAuthRow from '@/auth';
import { useTheme } from '@/hooks/use-theme';
import { forgetHostKey } from '@/host-keys';
import { loadOrCreateKey, type KeyPair } from '@/keys';
import { connect, listHostSessions } from '@/session';
import {
  SESSION_NAME,
  addHost,
  endpoint,
  getHost,
  removeHost,
  selectHost,
  updateHost,
  useHost,
  useSettings,
  validate,
  type HostSettings,
  type StartMode,
} from '@/settings';
import { CENTER, PRESSED, RADIUS, SECTION_HEADER, SPACE, TEXT, TINT, leading } from '@/style';
import { MONO, SANS, SANS_BOLD, SANS_SEMIBOLD } from '@/theme';

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

/** What a host row says before it has been typed into. */
const UNNAMED = 'New host';

/**
 * Setup (§4.1): the hosts, the one key, and the button that starts a session. The fields are the
 * active host in the settings store itself rather than a draft — there is nothing to cancel, and
 * the same values are what a reconnect uses hours later.
 *
 * The key is generated on first launch, not on demand: it is what the user has to paste into
 * `authorized_keys` before anything here can work, so it must be on screen before they ask.
 */
export default function Setup() {
  const theme = useTheme();
  const { hosts } = useSettings();
  const host = useHost();
  const [key, setKey] = useState<KeyPair | null>(null);
  // The port is edited as text so a half-typed field can be empty; `validate` has the last word.
  const [port, setPort] = useState(String(host.port));
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // On focus rather than on mount: Setup stays mounted underneath the key screen (T16), so a
  // Generate or a Paste over there would otherwise leave the old line — and the old Copy — on this
  // card, which is the one place the line is ever read from.
  useFocusEffect(
    useCallback(() => {
      loadOrCreateKey().then((pair) => {
        setKey(pair);
        setCopied(false);
      }, (error) => setProblem(`Could not read the key: ${error}`));
    }, []),
  );

  // The text field is local state, so switching host has to hand it the new host's port — without
  // this the previous machine's number stays on screen and the first keystroke writes it back.
  useEffect(() => setPort(String(getHost().port)), [host.id]);

  // The attach picker's rows are the host's, so they are re-asked for whenever that mode is on
  // screen — cached ones show meanwhile, and on a host whose key is not pinned yet there is
  // nothing to ask with (see `listHostSessions`) and the list simply stays as it was.
  useEffect(() => {
    if (host.startMode !== 'attach') return;
    let stale = false;
    listHostSessions().then((names) => {
      if (!stale && names.length > 0) updateHost({ knownSessions: names });
    });
    return () => {
      stale = true;
    };
  }, [host.startMode, host.id]);

  const pickMode = (mode: StartMode) => {
    console.log('[settings] startMode →', mode);
    updateHost({ startMode: mode });
  };

  /** Long-press on a host row. The pinned key is offered on the same confirm because an orphaned
   *  pin is invisible until the day the box is re-added and nobody is asked to trust it. */
  const askDelete = (victim: HostSettings) =>
    Alert.alert(
      `Delete ${victim.host === '' ? UNNAMED.toLowerCase() : victim.host}?`,
      'Its start mode, session list and upload directory go with it. The key you pinned for this ' +
        'machine can go too, or stay so the next connection is not asked about it again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => removeHost(victim.id) },
        {
          text: 'Delete and forget key',
          style: 'destructive',
          onPress: async () => {
            await forgetHostKey(endpoint(victim));
            removeHost(victim.id);
          },
        },
      ],
    );

  const start = () => {
    const invalid = validate(getHost());
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
          Your hosts, one key. The private half never leaves this phone.
        </Text>

        {/* T17: the host list and the fields that edit the selected one are one card, because they
            are one thought — the row above says which machine the three fields below are about.
            Long-press deletes; switching host mid-session is Disconnect, pick, Connect (§4.8). */}
        <View style={styles.fields}>
          {hosts.map((h) => (
            <Pressable
              key={h.id}
              onPress={() => selectHost(h.id)}
              onLongPress={() => askDelete(h)}
              style={[styles.row, styles.modeRow, { backgroundColor: theme.panel }]}>
              <View style={styles.modeText}>
                <Text style={[styles.modeLabel, { color: theme.foreground }]}>
                  {h.host === '' ? UNNAMED : h.host}
                </Text>
                <Text style={[styles.modeNote, { color: theme.muted }]}>
                  {h.username === '' ? 'no user yet' : h.username}
                </Text>
              </View>
              {h.id === host.id && (
                <Text style={[styles.tick, { color: theme.accent }]}>{'\uF00C'}</Text>
              )}
            </Pressable>
          ))}
          <Pressable
            onPress={() => addHost()}
            style={[styles.row, styles.modeRow, { backgroundColor: theme.panel }]}>
            <Text style={[styles.modeLabel, styles.modeText, { color: theme.accent }]}>
              Add host
            </Text>
          </Pressable>

          {field('Host', host.host, (text) => updateHost({ host: text }), 'hostname or IP')}
          {field(
            'Port',
            port,
            (text) => {
              setPort(text);
              updateHost({ port: Number(text) });
            },
            '22',
            'numeric',
          )}
          {field('User', host.username, (username) => updateHost({ username }), 'login name')}
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
              {host.startMode === mode && (
                <Text style={[styles.tick, { color: theme.accent }]}>{'\uF00C'}</Text>
              )}
            </Pressable>
          ))}
          {/* The only mode with anything to type. */}
          {host.startMode === 'custom' &&
            field(
              'Command',
              host.startupCommand ?? '',
              (text) => updateHost({ startupCommand: text === '' ? null : text }),
              'e.g. tmux attach',
            )}
        </View>

        {host.startMode === 'attach' && (
          <View style={styles.fields}>
            {[null, ...host.knownSessions].map((name) => (
              <Pressable
                key={name ?? MOST_RECENT}
                onPress={() => updateHost({ attachSession: name })}
                style={[styles.row, styles.modeRow, { backgroundColor: theme.panel }]}>
                <Text style={[styles.modeLabel, styles.modeText, { color: theme.foreground }]}>
                  {name ?? MOST_RECENT}
                </Text>
                {host.attachSession === name && (
                  <Text style={[styles.tick, { color: theme.accent }]}>{'\uF00C'}</Text>
                )}
              </Pressable>
            ))}
          </View>
        )}

        {/* T15, directly above the button it gates — Setup is the only screen a first-time user
            sees, so a lock offered nowhere else would be a lock nobody finds. */}
        <Text style={[styles.header, { color: theme.muted }]}>Security</Text>
        <RequireAuthRow theme={theme} card={theme.panel} />

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
          <View style={styles.keyButtons}>
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
            {/* T16: Copy stays here — it is the only key action that works before there is any
                connection, and it is the one a first-time user must do. Generate, Paste and Upload
                are a screen of their own, because each of them needs a sentence of explanation. */}
            <Pressable
              onPress={() => router.push('/keys')}
              style={({ pressed }) => [
                styles.copy,
                { backgroundColor: theme.surface },
                pressed && PRESSED,
              ]}>
              <Text style={[styles.copyLabel, { color: theme.accent }]}>Manage</Text>
            </Pressable>
          </View>
        </View>

        {/* The same card the settings sheet shows (§4.8), so the terminal can be dressed before
            there is one to dress. Last on the screen, under Connect and the key: it is the one
            section nobody needs to touch to get a session up. */}
        <Text style={[styles.header, { color: theme.muted }]}>Appearance</Text>
        <AppearanceCard theme={theme} card={theme.panel} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: SPACE.xl, gap: SPACE.md },
  title: { fontFamily: SANS_BOLD, includeFontPadding: false, fontSize: 34 },
  caption: { fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.base, lineHeight: leading(TEXT.base) },
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
  modeLabel: { fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.label },
  modeNote: { fontFamily: SANS, includeFontPadding: false, fontSize: 12, lineHeight: 16 },
  /** The bundled Nerd Font check, not `✓` U+2713 — see the call sites. */
  tick: { fontFamily: MONO, includeFontPadding: false, fontSize: TEXT.label },
  label: { fontFamily: SANS, includeFontPadding: false, width: 88, paddingLeft: SPACE.gutter, fontSize: TEXT.label },
  input: {
    fontFamily: SANS,
    includeFontPadding: false,
    flex: 1,
    paddingVertical: 13,
    paddingRight: SPACE.gutter,
    fontSize: 16,
  },
  problem: { fontFamily: SANS, includeFontPadding: false, fontSize: 14, lineHeight: 19 },
  // The design pins its one filled button at 48 tall, so the height is set rather than left to
  // whatever the label plus a padding comes to.
  connect: { borderRadius: RADIUS.button, height: 48, ...CENTER },
  connectLabel: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: TEXT.button },
  key: { fontFamily: MONO, includeFontPadding: false, fontSize: 11, lineHeight: 16, padding: SPACE.gutter },
  keyButtons: { flexDirection: 'row', gap: SPACE.md, marginHorizontal: SPACE.gutter, marginBottom: 14 },
  copy: {
    paddingHorizontal: SPACE.gutter,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.button,
  },
  copyLabel: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: 14 },
});
