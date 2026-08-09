/** The two pieces of terminal protocol the app answers itself. They live outside the DOM component
 *  so `bun test` can reach them: xterm hands its handlers the raw payload and nothing else. */

import { fromBase64 } from '@/base64';

/**
 * OSC 52, the clipboard sequence. The payload is `<targets>;<base64>`, where a `?` in the data
 * slot is a *read* request — never answered (§4.7), so it comes back the same `null` as anything
 * unparseable. A yank returns the text it carried.
 */
export function parseOsc52(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator < 0) return null;
  const payload = data.slice(separator + 1);
  if (payload === '' || payload.startsWith('?')) return null;
  try {
    return new TextDecoder().decode(fromBase64(payload));
  } catch {
    return null;
  }
}

/** OSC 8 targets we are willing to open. Anything else is silently refused (§4.7) — a terminal can
 *  write a link, so the scheme is the only thing standing between a host and `javascript:`. */
export function isHttpLink(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
