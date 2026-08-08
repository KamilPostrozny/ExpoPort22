import { useColorScheme } from 'react-native';

import { useSettings } from '@/settings';
import { resolveTheme, type Theme } from '@/theme';

/** The live flavour. `auto` follows the system appearance without a reconnect or a remount —
 *  `useColorScheme` re-renders on the appearance change, `useSettings` on a picker tap. */
export function useTheme(): Theme {
  const { theme } = useSettings();
  const scheme = useColorScheme();
  return resolveTheme(theme, scheme === 'dark');
}
