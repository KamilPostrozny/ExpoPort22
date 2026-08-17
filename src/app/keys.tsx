import * as Clipboard from 'expo-clipboard';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useTheme } from '@/hooks/use-theme';
import { fingerprint, importKey, loadOrCreateKey, regenerateKey, uploadPublicKey } from '@/keys';
import { useSession } from '@/session';
import { CENTER, PRESSED, RADIUS, SECTION_HEADER, SPACE, TEXT, TINT, leading } from '@/style';
import { MONO, SANS, SANS_SEMIBOLD } from '@/theme';

/**
 * The key screen (T16): the one ed25519 identity, its `SHA256:` fingerprint, and the three verbs
 * Setup's card has no room for — Generate, Paste, Upload.
 *
 * Copy is NOT here. It stays on Setup, because it is the only one of the four that works before
 * there is any connection at all, and it is what a first-time user has to do before Connect can
 * ever succeed. Upload is the opposite: it needs a session that is already authenticated, so it
 * cannot bootstrap the first key — it is for rotating one (connect with the old, upload the new)
 * and for retiring a pasted one. That is why the button is disabled with the reason on it rather
 * than hidden.
 */
export default function Keys() {
  const theme = useTheme();
  const session = useSession();
  const [line, setLine] = useState<string | null>(null);
  const [print, setPrint] = useState('');
  const [pasted, setPasted] = useState('');
  const [passphrase, setPassphrase] = useState('');
  /** One message area for all three verbs: the last thing that happened, and whether it went. */
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void show(loadOrCreateKey());
  }, []);

  async function show(pending: Promise<{ publicKeyLine: string }>) {
    const key = await pending;
    setLine(key.publicKeyLine);
    setPrint(await fingerprint(key.publicKeyLine));
    return key;
  }

  /** Same red-plus-confirm shape as Forget host key, and for the same reason: there is no undo and
   *  the cost lands on a machine that is not in the room. */
  const askGenerate = () =>
    Alert.alert(
      'Replace this key?',
      'The key on this phone is replaced the moment you confirm, and the old line stops ' +
        'authenticating anywhere at once. The new line is on no host yet — you have to add it to ' +
        '~/.ssh/authorized_keys yourself, or Upload it while this session is still up. There is no ' +
        'undo, and no copy of the old key is kept.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Replace',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              await show(regenerateKey());
              setNote({ bad: false, text: 'New key. Its line has to reach the host before the next connect.' });
            } catch (error) {
              setNote({ bad: true, text: `Could not write the new key: ${error}` });
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );

  const fromClipboard = async () => {
    setPasted(await Clipboard.getStringAsync());
    setNote(null);
  };

  const paste = async () => {
    setBusy(true);
    try {
      const result = await importKey(pasted, passphrase);
      if ('problem' in result) {
        setNote({ bad: true, text: result.problem });
        return;
      }
      await show(Promise.resolve(result.key));
      setPasted('');
      setPassphrase(''); // never stored, and not left on screen either
      setNote({ bad: false, text: 'Imported. This is the key Port22 connects with from now on.' });
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (line === null) return;
    setBusy(true);
    try {
      const { ok, note: text } = await uploadPublicKey(line);
      setNote({ bad: !ok, text });
    } finally {
      setBusy(false);
    }
  };

  const connected = session.status === 'connected';

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: theme.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable onPress={() => router.back()} hitSlop={SPACE.gutter}>
          <Text style={[styles.back, { color: theme.accent }]}>Setup</Text>
        </Pressable>
        <Text style={[styles.title, { color: theme.foreground }]}>Key</Text>

        <View style={[styles.card, { backgroundColor: theme.panel }]}>
          <Text selectable style={[styles.mono, { color: theme.foreground }]}>
            {print === '' ? 'reading…' : print}
          </Text>
        </View>
        <Text style={[styles.caption, { color: theme.muted }]}>
          ed25519, on this phone only. The line itself, and Copy, are on Setup.
        </Text>

        <Text style={[styles.header, { color: theme.muted }]}>Replace</Text>
        <View style={styles.fields}>
          <Pressable
            onPress={askGenerate}
            disabled={busy}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: theme.panel },
              pressed && PRESSED,
            ]}>
            <Text style={[styles.rowLabel, { color: theme.danger }]}>Generate a new key</Text>
          </Pressable>
        </View>

        <Text style={[styles.header, { color: theme.muted }]}>Paste a key</Text>
        <View style={styles.fields}>
          <TextInput
            value={pasted}
            onChangeText={setPasted}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            placeholderTextColor={theme.placeholder}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            style={[styles.keyInput, { backgroundColor: theme.panel, color: theme.foreground }]}
          />
          <View style={[styles.row, { backgroundColor: theme.panel }]}>
            <Text style={[styles.label, { color: theme.muted }]}>Passphrase</Text>
            <TextInput
              value={passphrase}
              onChangeText={setPassphrase}
              placeholder="only if the key has one"
              placeholderTextColor={theme.placeholder}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              style={[styles.input, { color: theme.foreground }]}
            />
          </View>
        </View>
        {/* §4.1 plain English, and the one thing a user cannot see for themselves: what a
            passphrase is worth after the import. It is not engineerable away — every §4.9
            auto-reconnect needs the seed without a prompt — so it is said instead. */}
        <Text style={[styles.caption, { color: theme.muted }]}>
          A passphrase unlocks the key here, once, and is never stored. What Port22 keeps is the
          unlocked key, in the same place as the one it generates — so from the import on, the
          passphrase protects nothing on this phone. OpenSSH keys only; ed25519 only.
        </Text>
        <View style={styles.buttons}>
          <Pressable
            onPress={fromClipboard}
            disabled={busy}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.surface },
              pressed && PRESSED,
            ]}>
            <Text style={[styles.buttonLabel, { color: theme.foreground }]}>From clipboard</Text>
          </Pressable>
          <Pressable
            onPress={paste}
            disabled={busy || pasted.trim() === ''}
            style={({ pressed }) => [
              styles.button,
              { backgroundColor: theme.surface },
              pressed && PRESSED,
            ]}>
            <Text
              style={[
                styles.buttonLabel,
                { color: pasted.trim() === '' ? theme.placeholder : theme.accent },
              ]}>
              Use this key
            </Text>
          </Pressable>
        </View>

        <Text style={[styles.header, { color: theme.muted }]}>Put it on the host</Text>
        <View style={styles.fields}>
          <Pressable
            onPress={upload}
            disabled={!connected || busy || line === null}
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: theme.panel },
              pressed && PRESSED,
            ]}>
            <Text
              style={[styles.rowLabel, { color: connected ? theme.accent : theme.placeholder }]}>
              Add to authorized_keys
            </Text>
          </Pressable>
        </View>
        <Text style={[styles.caption, { color: theme.muted }]}>
          {connected
            ? 'Appends this line to ~/.ssh/authorized_keys over the session that is already up, and ' +
              'leaves the keys already in the file alone.'
            : 'Needs a session that is already up, so it cannot add the very first key — that one is ' +
              'Copy on Setup, pasted on the host by hand. Connect, then come back.'}
        </Text>

        {note !== null && (
          <Text style={[styles.note, { color: note.bad ? theme.danger : theme.muted }]}>
            {note.text}
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: SPACE.xl, gap: SPACE.md },
  back: { fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.label },
  title: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: 28 },
  header: { ...SECTION_HEADER, paddingHorizontal: SPACE.gutter, paddingBottom: 7 },
  card: { borderRadius: RADIUS.card, overflow: 'hidden' },
  // Same construction as Setup's cards: the container is the divider tint and each row covers its
  // own share of it, which is one hairline between rows and none at the edges.
  fields: {
    backgroundColor: TINT.line,
    borderRadius: RADIUS.card,
    overflow: 'hidden',
    gap: StyleSheet.hairlineWidth,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACE.gutter,
    paddingVertical: 9,
  },
  rowLabel: { fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.label },
  label: { fontFamily: SANS, includeFontPadding: false, width: 88, fontSize: TEXT.label },
  input: { fontFamily: SANS, includeFontPadding: false, flex: 1, paddingVertical: 13, fontSize: 16 },
  keyInput: {
    fontFamily: MONO,
    includeFontPadding: false,
    minHeight: 132,
    padding: SPACE.gutter,
    fontSize: 11,
    lineHeight: 16,
    textAlignVertical: 'top',
  },
  mono: { fontFamily: MONO, includeFontPadding: false, fontSize: 12, lineHeight: 17, padding: SPACE.gutter },
  caption: {
    fontFamily: SANS,
    includeFontPadding: false,
    fontSize: TEXT.base,
    lineHeight: leading(TEXT.base),
  },
  buttons: { flexDirection: 'row', gap: SPACE.md },
  button: {
    paddingHorizontal: SPACE.gutter,
    paddingVertical: SPACE.sm,
    borderRadius: RADIUS.button,
    ...CENTER,
  },
  buttonLabel: { fontFamily: SANS_SEMIBOLD, includeFontPadding: false, fontSize: 14 },
  note: { fontFamily: SANS, includeFontPadding: false, fontSize: 14, lineHeight: 19 },
});
