import { requireNativeView } from 'expo';
import { type Ref } from 'react';
import { type StyleProp, type ViewStyle } from 'react-native';

/** One key as the field reports it: text that was typed (or dictated, as a whole chunk), or the
 *  delete key — including every repeat of a held one, which iOS drives itself. */
export type KeyEvent = { text?: string; delete?: boolean };

/**
 * The hold-space trackpad, in points travelled since the drag began (positive right). `begin` and
 * `end` carry a `dx` of 0 and exist so a listener can reset — the drag is reported absolutely, not
 * as increments, so a dropped frame cannot make the cursor drift.
 */
export type CursorEvent = { dx: number; phase: 'begin' | 'move' | 'end' };

export type ExpoKeyInputProps = {
  /** iOS's `keyboardAppearance` — the keys follow the flavour's light/dark. */
  keyboardAppearance: boolean;
  onKey: (event: { nativeEvent: KeyEvent }) => void;
  onCursor: (event: { nativeEvent: CursorEvent }) => void;
  style?: StyleProp<ViewStyle>;
};

/** Imperative half: focus is asked for (a tap on the terminal, the switcher closing), never tapped
 *  for — the view itself takes no touches. */
export type ExpoKeyInputRef = {
  focus: () => Promise<void>;
  blur: () => Promise<void>;
};

export const ExpoKeyInput = requireNativeView<ExpoKeyInputProps & { ref?: Ref<ExpoKeyInputRef> }>(
  'ExpoKeyInput',
);
