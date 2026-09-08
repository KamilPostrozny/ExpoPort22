import { useKeyboardHandler } from 'react-native-keyboard-controller';
import { runOnJS, useSharedValue } from 'react-native-reanimated';

import { keyboardOverlap } from '@/keyboard-model';

/** Two clocks, deliberately: chrome follows the native animation on the UI thread; the terminal
 * gets the destination once, not every intermediate row count. Expo SDK 57 recommends keyboard-
 * controller; its KeyboardHandler.onStart carries DESTINATION values on both platforms. RN's
 * Android did-events arrive too late, and Reanimated 4.5's useAnimatedKeyboard is deprecated.
 * KeyboardProvider is edge-to-edge, so both platforms include the bottom safe area in height. */
export function useTerminalKeyboard(bottom: number, onTarget: (pad: number) => void) {
  const position = useSharedValue(0);
  useKeyboardHandler(
    {
      onStart: (e) => {
        'worklet';
        runOnJS(onTarget)(keyboardOverlap(e.height, bottom));
      },
      onMove: (e) => {
        'worklet';
        position.value = keyboardOverlap(e.height, bottom);
      },
      onInteractive: (e) => {
        'worklet';
        position.value = keyboardOverlap(e.height, bottom);
      },
      onEnd: (e) => {
        'worklet';
        const pad = keyboardOverlap(e.height, bottom);
        position.value = pad;
        // Reconcile interrupted/interactive gestures and zero-duration changes. The receiver
        // deduplicates this against onStart; an ordinary animation never lays out twice.
        runOnJS(onTarget)(pad);
      },
    },
    [bottom, onTarget],
  );
  return position;
}
