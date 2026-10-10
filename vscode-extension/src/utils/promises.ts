/**
 * Promise utility helpers.
 */

/** Give pending extension-host messages and timers a chance to run between file parses. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

export class TimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Wraps a promise with a timeout to prevent indefinite hangs.
 * The timeout handle is cleared via `.finally()` to prevent memory leaks when
 * the promise settles before the timeout fires.
 *
 * @param promise - The promise to wrap
 * @param timeoutMs - Timeout in milliseconds
 * @param operation - Description of the operation (used in the rejection error message)
 * @returns A promise that rejects with a descriptive error if `timeoutMs` elapses before `promise` settles
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeoutHandle: NodeJS.Timeout | undefined;
  return Promise.race([
    promise.finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }),
    new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new TimeoutError(operation, timeoutMs)),
        timeoutMs,
      );
    }),
  ]);
}

/** A one-shot, multi-waiter notification gate used to wake parked async workers. */
export interface WakeupGate {
  /** Resolves once the next `signal()` is called after this `wait()`. */
  wait(): Promise<void>;
  /** Wakes every currently parked waiter. No-op when nobody is waiting. */
  signal(): void;
}

/**
 * Creates an event-driven wakeup gate for producer/consumer pipelines.
 *
 * Consumers that find no work available call `await gate.wait()` to park until the
 * producer calls `gate.signal()`. This replaces timer-based polling (e.g.
 * `setTimeout(..., 20)` spin loops) so idle workers consume no CPU while waiting.
 *
 * The waiter is registered synchronously inside `wait()` (the Promise executor runs
 * before the returned promise is awaited), so a consumer can safely check its
 * condition and then `await gate.wait()` in the same synchronous tick without a
 * `signal()` slipping in unobserved between the two.
 */
export function createWakeupGate(): WakeupGate {
  let waiters: Array<() => void> = [];
  return {
    wait(): Promise<void> {
      return new Promise<void>((resolve) => { waiters.push(resolve); });
    },
    signal(): void {
      if (waiters.length === 0) { return; }
      const pending = waiters;
      waiters = [];
      for (const wake of pending) { wake(); }
    },
  };
}

/** A counting semaphore bounding how many holders may be admitted at once. */
export interface Semaphore {
  /**
   * Resolves `true` once a permit is acquired. If `timeoutMs` is given and elapses first,
   * resolves `false` instead and this waiter is removed from the queue — unlike racing a plain
   * `setTimeout` against a WakeupGate.wait(), the losing attempt does not linger.
   */
  acquire(timeoutMs?: number): Promise<boolean>;
  /** Releases a permit, handing it directly to the longest-waiting acquirer if any (FIFO), else returning it to the pool. */
  release(): void;
}

/**
 * Creates a counting semaphore with `permits` concurrent holders.
 *
 * Distinct from WakeupGate above: `signal()`/`wait()` there wakes *every* parked waiter on one
 * event, which is the right shape for "work is available, whoever's free can take it" but the
 * wrong one for "exactly N holders at a time" — every waiter can see the same just-freed slot and
 * proceed together, letting the count of concurrent holders drift past N. `release()` here wakes
 * at most one waiter per freed permit, so admissions are bounded by the number of releases, not
 * by however many happened to be parked.
 */
export function createSemaphore(permits: number): Semaphore {
  // Rejected at 0, not just negative/non-integer: release() below hands a freed permit directly
  // to the longest-waiting acquire() without re-checking the cap, so a semaphore with zero
  // capacity would still let a waiter through on any release() (legitimate or an over-release bug)
  // — silently defeating the "zero concurrent holders" invariant a caller asking for 0 would want.
  // No call site needs a zero-capacity semaphore, so it is simpler to disallow it here than to add
  // a capacity check to release()'s hot path for a configuration nothing uses.
  if (!Number.isFinite(permits) || !Number.isInteger(permits) || permits < 1) {
    throw new RangeError('createSemaphore permits must be a finite positive integer');
  }
  let available = permits;
  const waiters: Array<(acquired: boolean) => void> = [];
  return {
    acquire(timeoutMs?: number): Promise<boolean> {
      // NaN/negative/Infinity would otherwise reach setTimeout() uncaught: Node coerces an
      // invalid delay to 0, so a caller error here would surface as a confusing immediate
      // false timeout (or, for Infinity, a delay so large it behaves as if never passed) rather
      // than a clear failure at the call site that got it wrong. Returned as a rejection rather
      // than thrown: acquire() is typed as always returning a Promise, so a synchronous throw here
      // would force every caller to handle both a sync exception and an async rejection instead of
      // just awaiting and catching one consistent failure mode.
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
        return Promise.reject(new RangeError('acquire() timeoutMs must be a finite non-negative number'));
      }
      if (available > 0) {
        available--;
        return Promise.resolve(true);
      }
      return new Promise<boolean>((resolve) => {
        let timeoutHandle: NodeJS.Timeout | undefined;
        const settle = (acquired: boolean) => {
          if (timeoutHandle) { clearTimeout(timeoutHandle); }
          resolve(acquired);
        };
        waiters.push(settle);
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            const idx = waiters.indexOf(settle);
            if (idx !== -1) { waiters.splice(idx, 1); }
            settle(false);
          }, timeoutMs);
        }
      });
    },
    release(): void {
      // Hand the permit directly to the next waiter rather than incrementing `available` and
      // letting it re-acquire — that would leave a window where a *different* concurrent
      // acquire() could grab the just-freed permit first, starving the longest-waiting caller.
      //
      // KNOWN LIMITATION: this does not by itself stop an over-release from admitting an extra
      // holder when a waiter is already parked — release() has no way to tell a legitimate
      // release (matching a real, currently-held permit) apart from a spurious/duplicate one, so
      // handing a parked waiter's `settle(true)` here can grant a permit backed by nothing. Fixing
      // that fully needs each acquire() to return a single-use release token that release() checks
      // against, rejecting an already-consumed or never-issued one — a breaking change to this
      // module's public API that no call site in this codebase currently needs (see the over-release
      // test below and its own note). What the clamp a few lines down *does* close is the simpler,
      // realistic case: a caller bug that calls release() extra times with no waiter parked (e.g.
      // forgetting it already released) cannot widen how many holders `available` alone admits.
      const next = waiters.shift();
      if (next) {
        next(true);
        return;
      }
      // Clamped rather than incremented unconditionally: a caller bug that releases more times
      // than it successfully acquired (a double-release on one code path, say) would otherwise
      // silently admit more concurrent holders than `permits` ever allows — exactly the unbounded
      // concurrency this primitive exists to prevent. This can only be reached with no waiters
      // parked, so clamping here never withholds a permit a genuine acquire() is waiting on.
      available = Math.min(permits, available + 1);
    },
  };
}
