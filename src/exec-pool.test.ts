import { expect, test } from 'bun:test';

import { isChannelRefusal, makePool, retryRefused } from '@/exec-pool';

/** A task whose settling this test controls, plus a live count of how many are running. */
function deferred() {
  let resolve!: (v: string) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('never more than `limit` tasks run at once, however many are queued', async () => {
  const pool = makePool(4);
  let running = 0;
  let peak = 0;
  const gates = Array.from({ length: 24 }, deferred);
  const all = gates.map((g) =>
    pool(() => {
      running += 1;
      peak = Math.max(peak, running);
      return g.promise.finally(() => {
        running -= 1;
      });
    }),
  );
  // Everything that could start has started: the fan-out is 24 windows, the channels are 4.
  await Promise.resolve();
  expect(peak).toBe(4);
  expect(running).toBe(4);
  for (const g of gates) g.resolve('ok');
  expect(await Promise.all(all)).toHaveLength(24);
  expect(peak).toBe(4); // and stayed 4 the whole way down the queue
  expect(running).toBe(0);
});

test('the queue is FIFO and a finished task hands its slot to exactly one waiter', async () => {
  const pool = makePool(2);
  const order: number[] = [];
  const gates = Array.from({ length: 5 }, deferred);
  const all = gates.map((g, i) =>
    pool(() => {
      order.push(i);
      return g.promise;
    }),
  );
  await Promise.resolve();
  expect(order).toEqual([0, 1]);
  gates[0].resolve('a');
  await gates[0].promise;
  await Promise.resolve();
  expect(order).toEqual([0, 1, 2]); // one out, one in — not two
  for (const g of gates) g.resolve('a');
  await Promise.all(all);
  expect(order).toEqual([0, 1, 2, 3, 4]);
});

test('a rejecting task releases its slot and only its own caller sees the error', async () => {
  const pool = makePool(1);
  const bad = pool(() => Promise.reject(new Error('open failed')));
  const good = pool(() => Promise.resolve('captured'));
  await expect(bad).rejects.toThrow('open failed');
  expect(await good).toBe('captured');
  // The pool is not poisoned: a later task still runs.
  expect(await pool(() => Promise.resolve('still here'))).toBe('still here');
});

/** What the transport actually hands back — an Expo module rejection with the SSH reason appended
 *  after `→ Caused by:` (BUGS.md quotes it verbatim). */
const REFUSED = new Error(
  "Call to function 'ExpoSSH.exec' has been rejected.\n" +
    '→ Caused by: Opening `session` channel failed: open failed',
);
const RAN_AND_FAILED = new Error('Citadel.SSHClient.CommandFailed error 1');

test('a channel refusal is told apart from a command that ran and exited 1', () => {
  expect(isChannelRefusal(REFUSED)).toBe(true);
  expect(isChannelRefusal(RAN_AND_FAILED)).toBe(false);
  expect(isChannelRefusal(new Error('boom'))).toBe(false);
  expect(isChannelRefusal(undefined)).toBe(false);
  // The day the chain stops being flattened into the message.
  expect(isChannelRefusal(Object.assign(new Error('rejected'), { cause: REFUSED }))).toBe(true);
});

test('a refusal is retried exactly once; anything else is the caller`s straight away', async () => {
  let calls = 0;
  const flaky = await retryRefused(() => {
    calls += 1;
    return calls === 1 ? Promise.reject(REFUSED) : Promise.resolve('captured');
  }, 0);
  expect(flaky).toBe('captured');
  expect(calls).toBe(2);

  // Two refusals in a row is a host that is genuinely full: the second is the caller's error.
  let twice = 0;
  await expect(
    retryRefused(() => {
      twice += 1;
      return Promise.reject(REFUSED);
    }, 0),
  ).rejects.toThrow('open failed');
  expect(twice).toBe(2);

  // A command that RAN is never re-run — that is what keeps a retried `new-window` from birthing two.
  let ran = 0;
  await expect(
    retryRefused(() => {
      ran += 1;
      return Promise.reject(RAN_AND_FAILED);
    }, 0),
  ).rejects.toThrow('CommandFailed');
  expect(ran).toBe(1);
});

test('a retry spends its pool slot rather than a new channel', async () => {
  const pool = makePool(1);
  let peak = 0;
  let running = 0;
  const attempt = (fail: boolean) => {
    running += 1;
    peak = Math.max(peak, running);
    return (fail ? Promise.reject(REFUSED) : Promise.resolve('ok')).finally(() => {
      running -= 1;
    });
  };
  let n = 0;
  const [a, b] = await Promise.all([
    pool(() => retryRefused(() => attempt(++n === 1), 0)),
    pool(() => retryRefused(() => attempt(false), 0)),
  ]);
  expect([a, b]).toEqual(['ok', 'ok']);
  expect(peak).toBe(1); // the second attempt is inside the slot, not beside it
});

test('a synchronously throwing task does not wedge the pool', async () => {
  const pool = makePool(1);
  const boom = pool(() => {
    throw new Error('nope');
  });
  await expect(boom).rejects.toThrow('nope');
  expect(await pool(() => Promise.resolve('ok'))).toBe('ok');
});
