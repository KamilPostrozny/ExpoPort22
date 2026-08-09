/** Base64 both ways, in the two lines it takes. Every byte crossing a bridge in this app is a
 *  base64 string — SSH payloads, the seed, OSC 52 — and this file has no native imports so the
 *  DOM terminal can use it too. */

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
