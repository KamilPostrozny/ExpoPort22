/**
 * The terminal's view settings — the follow-the-system switch, the theme lists it decides between,
 * and the font-size stepper — as one card, because two screens ask the same question.
 *
 * It was the settings sheet's APPEARANCE section first (§4.8) and still is; Setup shows the same
 * card so the terminal can be dressed before there is a session to dress. The rows write straight
 * to the settings store, so a change made on either surface is the same change.
 *
 * The switch comes before the lists rather than sitting inside them because it changes what the
 * lists *are*: following the system asks for two answers, one per appearance, and most schemes ship
 * only one cut — so the alternative, one list with a leading "Auto" row, would be asking the system
 * to flip between a light Gruvbox that does not exist and the dark one that does.
 */

import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { clampFontSize, getSettings, updateSettings, useSettings } from '@/settings';
import { CENTER, PRESSED, RADIUS, SPACE, TEXT, TINT } from '@/style';
import {
  ALL_THEMES,
  DARK_THEMES,
  LIGHT_THEMES,
  MONO,
  resolveTheme,
  SANS,
  type Theme,
  type ThemeName,
} from '@/theme';

/** The swatch strip's six chips, in the prototype's order — now ANSI slots rather than Catppuccin
 *  names, because those six are the one thing every scheme is guaranteed to have. */
const SWATCHES = [1, 2, 3, 4, 5, 6];

/**
 * The switch's three colours, so both platforms take them from the theme instead of from whatever
 * the OS picks.
 *
 * `Switch` is a native control — UISwitch on iOS, Material's on Android — and it is meant to be:
 * its proportions are the platform's business and are NOT a divergence to chase (a hand-rolled
 * switch would be, and is explicitly not wanted). What IS ours is the palette, and left alone
 * Android took its thumb from the Material default — a teal that appears nowhere in this app,
 * measured against iOS's white on 2026-08-16.
 *
 * Only `trackColor.true` had ever been set, so both the off-track and the grip were the OS's.
 * `thumbColor` is the pale end of the scheme on both appearances, which is what UISwitch draws on
 * every flavour; `onAccent` would have been the tidy-looking role and is wrong here — it is
 * `base`, so on a dark scheme it paints a dark grip on a light accent track, the inverse of iOS.
 *
 * Setting `thumbColor` costs iOS the grip's drop shadow (RN documents this). That is accepted: one
 * prop set the same way on both beats a branch, and it moves the two builds closer, not further.
 */
export const switchColors = (theme: Theme) => ({
  trackColor: { false: TINT.track, true: theme.accent },
  thumbColor: theme.isDark ? theme.foreground : theme.background,
  /** Android ignores this; iOS paints the off-track's ground behind `trackColor.false`. */
  ios_backgroundColor: TINT.track,
});

export default function AppearanceCard({
  theme,
  /** What the card is drawn on: `surface` over the sheet's `panel` ground, `panel` over Setup's
   *  `background`. One step up from whatever is behind it, which is not the same colour twice. */
  card,
}: {
  theme: Theme;
  card: string;
}) {
  const settings = useSettings();
  /** Which theme list is expanded, if any — one at a time, so the surface never has two long lists
   *  in it at once. */
  const [open, setOpen] = useState<'theme' | 'themeDark' | 'themeLight' | null>(null);

  /** §4.8: restyles the live session, no reconnect. */
  const pickTheme = (field: 'theme' | 'themeDark' | 'themeLight', name: ThemeName) => {
    console.log(`[settings] ${field} →`, name);
    updateSettings({ [field]: name });
  };

  const toggleFollow = (on: boolean) => {
    console.log('[settings] followSystem →', on);
    setOpen(null); // the rows the switch swaps in are different rows; none of them was the open one
    updateSettings({ followSystem: on });
  };

  const stepFont = (delta: number) => {
    const next = clampFontSize(getSettings().fontSize + delta);
    if (next === settings.fontSize) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    console.log('[settings] fontSize →', next);
    updateSettings({ fontSize: next }); // applied live through the terminal's fontSize prop
  };

  //  is the Nerd Font tick, pinned to MONO so both platforms draw the same one — the switcher's
  // Done tick is the same glyph in the same family, and the two must not drift apart.
  const check = (
    <Text style={{ fontFamily: MONO, includeFontPadding: false, fontSize: 13, color: theme.accent }}>
      {''}
    </Text>
  );

  /**
   * A disclosure row naming the theme in that slot, and its list underneath while it is open.
   * Collapsed by default: twenty-six rows pushed the switch this row belongs with off one end of
   * the sheet and the font stepper off the other (user, 2026-08-14: "follow system and themes
   * should be close to each other… make theme lists collapsed, they take too much space").
   *
   * Picking does not close it — the log of an evening with this sheet is a dozen themes tried in a
   * row, and a list that shut after each one would be a dozen extra taps.
   */
  const themeRow = (label: string, list: Theme[], field: 'theme' | 'themeDark' | 'themeLight') => {
    const isOpen = open === field;
    return (
      <>
        <Pressable
          onPress={() => setOpen(isOpen ? null : field)}
          style={({ pressed }) => [
            styles.row,
            styles.rowLine,
            { borderTopColor: theme.border },
            pressed && { backgroundColor: theme.surface },
          ]}>
          <Text style={[styles.label, { color: theme.foreground }]}>{label}</Text>
          <Text style={[styles.value, { color: theme.muted }]} numberOfLines={1}>
            {resolveTheme(settings[field]).label}
          </Text>
          {/*  / , the Nerd Font chevrons, in MONO: the U+2304 this used to fall back to is in
              neither Roboto nor Noto Sans, so it drew a tofu box on Android. */}
          <Text style={{ fontFamily: MONO, includeFontPadding: false, fontSize: 12, color: theme.muted }}>
            {isOpen ? '' : ''}
          </Text>
        </Pressable>
        {isOpen &&
          list.map((t) => (
            <Pressable
              key={t.name}
              onPress={() => pickTheme(field, t.name)}
              style={({ pressed }) => [
                styles.row,
                styles.subRow,
                styles.rowLine,
                { borderTopColor: theme.border },
                pressed && { backgroundColor: theme.surface },
              ]}>
              <Text style={[styles.label, { color: theme.foreground }]} numberOfLines={1}>
                {t.label}
              </Text>
              {/* The scheme's own background under its own six hues: the row is a sample of the
                  terminal it would produce, which a name like "Kanagawa" is not. */}
              <View style={[styles.swatch, { backgroundColor: t.background }]}>
                {SWATCHES.map((slot) => (
                  <View key={slot} style={[styles.chip, { backgroundColor: t.ansi[slot] }]} />
                ))}
              </View>
              <View style={styles.checkSlot}>{settings[field] === t.name && check}</View>
            </Pressable>
          ))}
      </>
    );
  };

  return (
    <View style={[styles.card, { backgroundColor: card }]}>
      <View style={styles.row}>
        <Text style={[styles.label, { color: theme.foreground }]}>Follow system</Text>
        <Switch value={settings.followSystem} onValueChange={toggleFollow} {...switchColors(theme)} />
      </View>
      {/* Straight under the switch that decides how many of these rows there are — the font stepper
          used to sit between them, which put the answer two scrolls from the question. */}
      {settings.followSystem ? (
        <>
          {themeRow('Dark theme', DARK_THEMES, 'themeDark')}
          {themeRow('Light theme', LIGHT_THEMES, 'themeLight')}
        </>
      ) : (
        themeRow('Theme', ALL_THEMES, 'theme')
      )}
      <View style={[styles.row, styles.rowLine, { borderTopColor: theme.border }]}>
        <Text style={[styles.label, { color: theme.foreground }]}>Font size</Text>
        <Text style={[styles.value, { color: theme.muted }]}>{settings.fontSize} pt</Text>
        <View style={[styles.stepper, { backgroundColor: theme.surface }]}>
          <Pressable
            onPress={() => stepFont(-1)}
            style={({ pressed }) => [styles.stepKey, pressed && PRESSED]}>
            <Text style={[styles.stepGlyph, { color: theme.foreground }]}>−</Text>
          </Pressable>
          <View style={[styles.stepDivider, { backgroundColor: theme.border }]} />
          <Pressable
            onPress={() => stepFont(1)}
            style={({ pressed }) => [styles.stepKey, pressed && PRESSED]}>
            <Text style={[styles.stepGlyph, { color: theme.foreground }]}>+</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: RADIUS.card, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    // The row's own padding computes to about 33; this lifts it to the 44pt tap target.
    minHeight: 44,
    paddingHorizontal: SPACE.gutter,
    paddingVertical: 7,
  },
  /** The rule's colour is `theme.border`, passed at each call site: a fixed overlay grey is the
   *  wrong grey on most of twenty-six schemes, and invisible on some. */
  rowLine: { borderTopWidth: StyleSheet.hairlineWidth },
  /** A theme inside an expanded list, indented off the disclosure row that opened it. */
  subRow: { paddingLeft: SPACE.xxl },
  label: { flex: 1, fontFamily: SANS, includeFontPadding: false, fontSize: TEXT.label },
  value: { fontFamily: MONO, includeFontPadding: false, fontSize: TEXT.base, marginRight: SPACE.md },
  // The swatch strip and its chips are the prototype's own one-off geometry (gap:3, padding:3,
  // 9×13 chips at 2.5) — a single element's numbers, deliberately not in the shared vocabulary.
  swatch: {
    flexDirection: 'row',
    gap: 3,
    borderRadius: RADIUS.small,
    padding: 3,
    marginRight: SPACE.md,
  },
  chip: { width: 9, height: 13, borderRadius: 2.5 },
  checkSlot: { width: 18, alignItems: 'flex-end' },
  // Likewise the stepper: a 9pt track around 38×30 keys, the prototype's alone. Its track and
  // divider are roles, passed at the call site.
  stepper: { flexDirection: 'row', borderRadius: 9, overflow: 'hidden' },
  stepKey: { width: 38, height: 30, ...CENTER },
  // MONO not for the shape but for the picker: − (U+2212) and + are both in the bundled font,
  // and pinning the family is what stops each platform choosing its own fallback face.
  stepGlyph: { fontFamily: MONO, includeFontPadding: false, fontSize: 20, lineHeight: 24 },
  stepDivider: { width: 1 },
});
