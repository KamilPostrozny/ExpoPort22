/** `bun test` — T16's two decisions, both pure: what a pasted OpenSSH container is (read off real
 *  `ssh-keygen` output, not a hand-built blob), and what appending the public line to a host's
 *  `authorized_keys` has to run.
 *
 *  The keys below are throwaway fixtures, generated for this file on 2026-08-17 and never used to
 *  authenticate anything. They are here rather than synthesised because the point of the parser is
 *  that it agrees with `ssh-keygen`, and a blob we wrote ourselves cannot show that. */

/// <reference types="bun" />
import { expect, test } from 'bun:test';

import {
  APPEND_OK,
  NOT_OPENSSH,
  appendPlan,
  inspectOpenSSHKey,
  notEd25519,
} from '@/keys-model';

/** `ssh-keygen -t ed25519 -N '' -C port22-test` */
const ED25519_PLAIN = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACDbdGhcAPfvHQtFbI2TZ+ty5TjypMM0mWENMYcDrqWKcQAAAJC+JRQ6viUU
OgAAAAtzc2gtZWQyNTUxOQAAACDbdGhcAPfvHQtFbI2TZ+ty5TjypMM0mWENMYcDrqWKcQ
AAAEAuBI8J7rahTuxABYtweLFkOtkiWoly4AKcUa3s/JBUktt0aFwA9+8dC0VsjZNn63Ll
OPKkwzSZYQ0xhwOupYpxAAAAC3BvcnQyMi10ZXN0AQI=
-----END OPENSSH PRIVATE KEY-----`;

const ED25519_LINE =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAINt0aFwA9+8dC0VsjZNn63LlOPKkwzSZYQ0xhwOupYpx port22-test';

/** The same command with `-N 'hunter2'`: `aes256-ctr` + `bcrypt`, which is what makes it encrypted. */
const ED25519_LOCKED = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAACmFlczI1Ni1jdHIAAAAGYmNyeXB0AAAAGAAAABBfzPWwOR
70jj97qNqIzf4CAAAAGAAAAAEAAAAzAAAAC3NzaC1lZDI1NTE5AAAAIHr2oCyw9EaHMCZj
+HERgNbuNshl0JzUeEATzBz786G2AAAAkNiQ4eLeez8HX2fwSfdvtXCvgDzLSe3SlmcBq+
0eMd9DY7AapvKDSR8ZR3lrNamkI24WDoFkmy5uZzRcBDCCgbcqaREVek5r0Tdw79+KweqB
wL/+PSTdr+gs1SXx1HYC3bB4UuEly3PYRMnDHHERSC05IazRZINMemsRLon5cKmTk2Inr6
UxikGnry4rD+Vrtg==
-----END OPENSSH PRIVATE KEY-----`;

/** `ssh-keygen -t rsa` — still an OpenSSH v1 container, and still refused, by name. */
const RSA = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAABFwAAAAdzc2gtcn
NhAAAAAwEAAQAAAQEAxaep4UhBUy9JfvJxlaRwPJrutPFlt855O21yYwkygBkFqx7ltdvI
ktoAJutZQ/vhSO+Ca25ruvJM5aDbUOXAJO6EttZvtzVm3S2G42sY2V8Ujrrd2Ie4qnlGtp
GkA2YIVp6xcOikr8dU/2WymlQfsH3r04r0vWJppH6UpbiuXZ9u0jZC3hOiaTX3bsPm5BKO
vulLDA6yj3AeyQ2maZEi3iEN8Ex17wJ4NrcVM28L4xs9OUFvwXvTXi9nEIgvaUfGR99pbC
AGLPS/btEg4NeNvjhe8lKqSG3eTOAlnmYlhYhemTRmH8K6hp8KLnitcmlGG5+hC9dfJcVl
C5bKTgBH9QAAA8ikwV7ZpMFe2QAAAAdzc2gtcnNhAAABAQDFp6nhSEFTL0l+8nGVpHA8mu
608WW3znk7bXJjCTKAGQWrHuW128iS2gAm61lD++FI74Jrbmu68kzloNtQ5cAk7oS21m+3
NWbdLYbjaxjZXxSOut3Yh7iqeUa2kaQDZghWnrFw6KSvx1T/ZbKaVB+wfevTivS9Ymmkfp
SluK5dn27SNkLeE6JpNfduw+bkEo6+6UsMDrKPcB7JDaZpkSLeIQ3wTHXvAng2txUzbwvj
Gz05QW/Be9NeL2cQiC9pR8ZH32lsIAYs9L9u0SDg142+OF7yUqpIbd5M4CWeZiWFiF6ZNG
YfwrqGnwoueK1yaUYbn6EL118lxWULlspOAEf1AAAAAwEAAQAAAQATVD8nudIxmVk9oeX7
tVYIhzo61bSV0gpHBn/+MWMP5eKJBn9+Vlz6B3mmVLOpE1PHtyxw5x5/7LwaZK2t7pnowq
6V1sicCQvjK1WandmTQFoZTyrsxvEHMs74gauhbXP5TJGbshSQ4BRu2Xoq33kt4FKUoG0o
rBwaqwpMXpAmtYm12q+j4Mm7AEV+1iqkbNKtz1sNErjHGEdC8YvXs1QojCt6UIiwJvVWud
ryGU7Avdl2sQ6GO5l2DDfhQAllASSGXUFksqOU9sGciVmLjVJQH+Q3RQ36xNWLKL8u3nJr
n5l+tbsxu/yPc3nMa+RLKdye5JwZTSV2Ktv7MlKfNGctAAAAgQCdllpz0LJ0k4Goj/NjGV
2nAIzM5N5z+3MqWDAMh26BqbdehW0aYZG271GLKk1p6TJHPuj4QOPQP8uVxWUjunnH+Sm4
SYeTJno02qTXfiUNVtyNgFPBBQiHKKfOCYjPiemZBCfimLIZUC3WbycZcHqZKh+B11UCj7
LccgTxu4gaWwAAAIEA5jlCTSi6NHCDsPf6PF9e0qJxBGL91pYCqJS/iOr+GGii+4nIvUe/
s/31Ovvp/lwAVmLTqIg1eJFyJJKCJy2biLzPkkKUWls6InkQG+Kd+PbdZXfI5CHHQO7f5q
/SWJ6gZ2ho1Fqi8sD9hSXpD8YFmv4D2+xIaGseNLt03GxuI4cAAACBANvI6OAn+JTYYbqJ
Vc9SrIA1yvcdeKOpLZ4E+riWImenISlZSuvLQ6pkAjcMVJEkBTQ6JdSsWRm+z8vrl8LtzQ
NdX/o8HkD8QXDFOUmAKuMhdeIQrR1GiJCBa2bFczHWVCD1oRzqbKkT4SPk503SzyA9olxv
HeRsHFaJes++D0+jAAAAC3BvcnQyMi10ZXN0AQIDBAUGBw==
-----END OPENSSH PRIVATE KEY-----`;

/** `ssh-keygen -t ecdsa` — the other type Citadel cannot open either, named the same way. */
const ECDSA = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAaAAAABNlY2RzYS
1zaGEyLW5pc3RwMjU2AAAACG5pc3RwMjU2AAAAQQSIiTS/JfgIeL1V0tNK52HHERsVa7DV
dhDREp/p37Wyj0YZwA02/r1PjO6tTeq00UU7zWz4DyClOSeG9VSNfMnBAAAAqBdTgWgXU4
FoAAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBIiJNL8l+Ah4vVXS
00rnYccRGxVrsNV2ENESn+nftbKPRhnADTb+vU+M7q1N6rTRRTvNbPgPIKU5J4b1VI18yc
EAAAAgGIQGZ5ZX21zMFS9cnXIPjUPoVOgPzXVg8BIM5HGcvPAAAAALcG9ydDIyLXRlc3QB
AgMEBQ==
-----END OPENSSH PRIVATE KEY-----`;

test('an unencrypted ed25519 key is taken as it is', () => {
  expect(inspectOpenSSHKey(ED25519_PLAIN)).toEqual({ ok: true, encrypted: false });
  // Whatever the pasteboard adds around it.
  expect(inspectOpenSSHKey(`\n  ${ED25519_PLAIN}\n\n`)).toEqual({ ok: true, encrypted: false });
});

test('a passphrase-protected ed25519 key is read as encrypted without being opened', () => {
  expect(inspectOpenSSHKey(ED25519_LOCKED)).toEqual({ ok: true, encrypted: true });
});

test('RSA and ECDSA are refused by name, not by a stack trace', () => {
  expect(inspectOpenSSHKey(RSA)).toEqual({ ok: false, problem: notEd25519('ssh-rsa') });
  expect(inspectOpenSSHKey(ECDSA)).toEqual({
    ok: false,
    problem: notEd25519('ecdsa-sha2-nistp256'),
  });
  expect(notEd25519('ssh-rsa').startsWith('Port22 uses ed25519 keys')).toBe(true);
});

test('anything that is not an OpenSSH v1 container names the conversion', () => {
  const refusal = { ok: false as const, problem: NOT_OPENSSH };
  expect(inspectOpenSSHKey('-----BEGIN RSA PRIVATE KEY-----\nMIIE…\n-----END RSA PRIVATE KEY-----')).toEqual(refusal);
  expect(inspectOpenSSHKey('')).toEqual(refusal);
  expect(inspectOpenSSHKey(ED25519_LINE)).toEqual(refusal); // the PUBLIC half, a plausible slip
  // Right boundary, wrong contents: the base64 is fine and the magic is not.
  expect(inspectOpenSSHKey(`-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAAAAA\n-----END OPENSSH PRIVATE KEY-----`)).toEqual(refusal);
  // Right boundary and magic, truncated body — the length runs off the end.
  expect(
    inspectOpenSSHKey(
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${ED25519_PLAIN.split('\n')[1]}\n-----END OPENSSH PRIVATE KEY-----`,
    ),
  ).toEqual(refusal);
  expect(NOT_OPENSSH).toContain('ssh-keygen -p -f <key>');
});

test('a key already in the file appends nothing', () => {
  const file = `ssh-ed25519 AAAAB other@laptop\n${ED25519_LINE}\nssh-rsa AAAAB3 third@box\n`;
  expect(appendPlan(file, ED25519_LINE)).toEqual({ present: true });
  // Same key, different comment: still the same key, and a second copy would be noise.
  expect(appendPlan(file, ED25519_LINE.replace('port22-test', 'port22'))).toEqual({ present: true });
  // Commented out is not present — the host does not read it either.
  expect(appendPlan(`#${ED25519_LINE}\n`, ED25519_LINE).present).toBe(false);
});

test('a file that does not end in a newline gets one before the key', () => {
  const glued = appendPlan('ssh-rsa AAAAB3 other@laptop', ED25519_LINE);
  expect(glued.present).toBe(false);
  if (glued.present) return;
  expect(glued.command).toContain(`printf '\\n%s\\n'`);

  const tidy = appendPlan('ssh-rsa AAAAB3 other@laptop\n', ED25519_LINE);
  if (tidy.present) return;
  expect(tidy.command).toContain(`printf '%s\\n'`);
  // No file at all reads back as nothing, and nothing needs no leading newline either.
  const fresh = appendPlan('', ED25519_LINE);
  if (fresh.present) return;
  expect(fresh.command).toContain(`printf '%s\\n'`);
});

test('the append chain is one && chain, quoted, with the sentinel last', () => {
  const plan = appendPlan('', ED25519_LINE);
  if (plan.present) throw new Error('unreachable');
  expect(plan.command).toBe(
    `mkdir -p ~/.ssh && chmod 700 ~/.ssh && printf '%s\\n' '${ED25519_LINE}' ` +
      `>> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo ${APPEND_OK}`,
  );
  // Nothing in the chain runs if the step before it did not.
  expect(plan.command.split('&&').length).toBe(5);
  // fish has no `{ …; }`, so there is none.
  expect(plan.command).not.toContain('{');
});

test('a key line with a shell metacharacter in its comment cannot break out', () => {
  const nasty = `ssh-ed25519 AAAAC3Nz port22'; rm -rf ~; echo '`;
  const plan = appendPlan('', nasty);
  if (plan.present) throw new Error('unreachable');
  expect(plan.command).toContain(`'ssh-ed25519 AAAAC3Nz port22'\\''; rm -rf ~; echo '\\'''`);
});
