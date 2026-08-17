/**
 * A fixed-size promise pool and the one retry the SSH seam is allowed — `src/tmux.ts` holds the
 * instances and the channel arithmetic (see `execPool` there); this file is just the queueing and
 * the predicate, pure and testable under `bun test`.
 *
 * Nothing installed does this: there is no `p-limit`/`p-queue`/`async` in node_modules, and the
 * job is twelve lines, so a dependency for it would cost more to audit than to read.
 */

/**
 * `makePool(3)(() => fetch(…))` — at most `limit` tasks run at once, the rest wait FIFO.
 *
 * The slot is handed straight from a finishing task to the next waiter rather than released and
 * re-taken: `active--` followed by the waiter's `active++` a microtask later opens a window in
 * which a fresh caller sees a free slot and takes it too, and the pool runs `limit + 1`. A
 * handover cannot overshoot, and the `waiting.length > 0` test is what keeps a fresh caller from
 * jumping the queue while a handover is in flight.
 *
 * A rejecting task releases its slot like any other — the rejection is the caller's.
 */
export function makePool(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function pooled<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit || waiting.length > 0) {
      await new Promise<void>((resolve) => waiting.push(resolve)); // resumes already holding a slot
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * Is this sshd refusing us a channel — `Opening 'session' channel failed: open failed`?
 *
 * The distinction the retry below rests on: a refusal happens BEFORE the command is handed to the
 * remote shell, so nothing ran and re-asking cannot birth a second window or kill a second pane.
 * `Command exited 1` is the opposite — that one ran and answered — and is never retried.
 *
 * Matched on the text because that is all the transport gives us: Citadel's reason arrives as an
 * Expo module rejection whose message carries the SSH one appended after `→ Caused by:`, and there
 * is no code to switch on. `cause` is read as well for the day the chain stops being flattened.
 */
export function isChannelRefusal(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return /open failed/i.test(`${String(error)} ${cause === undefined ? '' : String(cause)}`);
}

/**
 * Run `task`; if it was refused a channel, wait a beat and run it exactly once more.
 *
 * The beat is the point — an immediate re-ask meets the same full session table it just bounced
 * off. 150ms is under half of the ~350ms a capture holds a channel for, so a slot freed by
 * anything in flight is caught, and a second refusal is reported as the caller's error rather than
 * retried again: two refusals in a row is a host that is genuinely full, not a hiccup.
 */
export async function retryRefused<T>(task: () => Promise<T>, delayMs = 150): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (!isChannelRefusal(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return task();
  }
}
