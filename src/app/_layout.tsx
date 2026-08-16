import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { hydratePins } from '@/clipboard';
import { useTheme } from '@/hooks/use-theme';
import { hydrateSettings } from '@/settings';
import { MONO, MONO_BOLD, SANS, SANS_BOLD, SANS_MEDIUM, SANS_SEMIBOLD } from '@/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  // One face per registered family — see `src/fonts.ts`. A numeric `fontWeight` beside a one-face
  // custom family fake-bolds on Android and no-ops on iOS, so weight is picked by family name and
  // the four Inter faces are registered separately rather than as one `Inter` with an axis.
  const [fontsLoaded] = useFonts({
    [MONO]: require('../../assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf'),
    [MONO_BOLD]: require('../../assets/fonts/JetBrainsMonoNerdFontMono-Bold.ttf'),
    [SANS]: Inter_400Regular,
    [SANS_MEDIUM]: Inter_500Medium,
    [SANS_SEMIBOLD]: Inter_600SemiBold,
    [SANS_BOLD]: Inter_700Bold,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    // Pins ride along (§4.4): they must be back before the first Paste tap can ask for a top slot.
    Promise.all([hydrateSettings(), hydratePins()]).then(() => setSettingsLoaded(true));
  }, []);

  const ready = fontsLoaded && settingsLoaded;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  // Splash stays up until the persisted flavour is known, so `auto` never flashes the wrong one.
  return ready ? <Root /> : null;
}

function Root() {
  const theme = useTheme();

  // Which app is in front decides what a screenshot from the laptop will actually contain, and the
  // person switching apps is holding the same phone — so the app says it itself.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) =>
      console.log('[app]', state),
    );
    return () => subscription.remove();
  }, []);

  // GestureHandlerRootView: T7's bar swipes run on react-native-gesture-handler, which needs
  // exactly one of these above every GestureDetector.
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      />
    </GestureHandlerRootView>
  );
}
