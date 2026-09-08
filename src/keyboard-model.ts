/** With an edge-to-edge KeyboardProvider, native height includes the home/gesture strip on
 * both platforms. That strip is already reserved by the key bar and terminal's bottom inset. */
export function keyboardOverlap(height: number, bottom: number): number {
  'worklet';
  return Math.max(0, height - bottom);
}
