import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { useTheme } from '@/hooks/use-theme';
import { hydrateSettings } from '@/settings';
import { MONO, MONO_BOLD } from '@/theme';

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    [MONO]: require('../../assets/fonts/JetBrainsMonoNerdFontMono-Regular.ttf'),
    [MONO_BOLD]: require('../../assets/fonts/JetBrainsMonoNerdFontMono-Bold.ttf'),
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  useEffect(() => {
    hydrateSettings().then(() => setSettingsLoaded(true));
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
  return (
    <>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      />
    </>
  );
}
