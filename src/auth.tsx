/**
 * T15's one row: the lock that stands in front of `connect()`. Shared, because two screens ask the
 * same question — the settings sheet's SESSION section, and Setup, which is the only screen a
 * first-time user sees. Same shape as `AppearanceCard`: it draws its own card on whatever ground
 * the caller names, and writes straight to the settings store.
 *
 * The gate itself is in `session.ts`; this is only the switch that arms it.
 */

import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

import { switchColors } from '@/appearance';
import { updateSettings, useSettings } from '@/settings';
import { leading, RADIUS, SPACE, TEXT } from '@/style';
import { SANS, type Theme } from '@/theme';

export default function RequireAuthRow({
  theme,
  /** What the card is drawn on — `surface` over the sheet's `panel`, `panel` over Setup's ground. */
  card,
}: {
  theme: Theme;
  card: string;
}) {
  const settings = useSettings();
  /** `null` until the probe answers; only `NONE` — no biometric *and* no passcode — is a device
   *  with nothing to ask with. */
  const [level, setLevel] = useState<LocalAuthentication.SecurityLevel | null>(null);
  useEffect(() => {
    LocalAuthentication.getEnrolledLevelAsync().then(setLevel, () => setLevel(null));
  }, []);
  const nothingToAskWith = level === LocalAuthentication.SecurityLevel.NONE;
  // Disabled-with-a-reason rather than hidden — but never disabled while it is ON, or a user who
  // armed the lock and then removed their passcode would be looking at a switch they cannot turn
  // off in front of a connect they cannot pass.
  const locked = nothingToAskWith && !settings.requireAuth;

  const toggle = (on: boolean) => {
    console.log('[settings] requireAuth →', on);
    updateSettings({ requireAuth: on });
  };

  return (
    <>
      <View style={[styles.card, { backgroundColor: card }]}>
        <View style={styles.row}>
          <Text style={[styles.label, { color: locked ? theme.placeholder : theme.foreground }]}>
            Require authentication
          </Text>
          {/* ponytail: a UI gate and nothing more — it stops someone holding an unlocked phone, not
              someone holding the filesystem. The SSH seed is deliberately NOT behind SecureStore's
              `requireAuthentication`: iOS's `.biometryCurrentSet` has no passcode fallback (the
              exact case this feature exists for) and dies when the enrolled set changes, and
              Android's `assertBiometricsSupport` refuses to store or read at all on a PIN-only
              phone — so one new fingerprint would destroy the user's SSH identity. What protects
              the seed at rest is `WHEN_UNLOCKED_THIS_DEVICE_ONLY` in `keys.ts`. If the filesystem
              threat ever matters, the upgrade is `requireAuthentication` on a re-derivable secret
              plus a written recovery path, not on the seed. */}
          <Switch
            value={settings.requireAuth}
            onValueChange={toggle}
            disabled={locked}
            {...switchColors(theme)}
          />
        </View>
      </View>
      <Text style={[styles.note, { color: theme.placeholder }]}>
        {nothingToAskWith
          ? 'Set a passcode on this phone first.'
          : 'Face ID, a fingerprint or your passcode before a session opens. One unlock covers the next five minutes.'}
      </Text>
    </>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: RADIUS.card, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // The 44pt tap target every other settings row is lifted to.
    minHeight: 44,
    paddingHorizontal: SPACE.gutter,
    paddingVertical: 7,
  },
  label: { flex: 1, fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.label },
  note: {
    fontFamily: SANS,
    includeFontPadding: false,
    fontSize: TEXT.caption,
    lineHeight: leading(TEXT.caption),
    paddingHorizontal: SPACE.gutter,
    paddingTop: 6,
  },
});
