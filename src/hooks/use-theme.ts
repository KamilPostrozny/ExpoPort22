import { useMemo } from 'react';
import { useColorScheme } from 'react-native';

import { useSettings } from '@/settings';
import { resolveTheme, type Theme } from '@/theme';

/** The live flavour. `auto` follows the system appearance without a reconnect or a remount —
 *  `useColorScheme` re-renders on the appearance change, `useSettings` on a picker tap. */
export function useTheme(): Theme {
  const { theme } = useSettings();
  const scheme = useColorScheme();
  // One object per flavour, not per render: it is a prop of every snapshot span, and a fresh
  // object each time defeats every memo downstream — which is most of the cost of mounting a
  // page card at the instant a swipe begins (user, 2026-08-10: "a slight hitch at the beginning").
  return useMemo(() => resolveTheme(theme, scheme === 'dark'), [theme, scheme]);
}
