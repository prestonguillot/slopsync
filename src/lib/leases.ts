/**
 * Leases: mutual exclusion for work that must not run twice at once.
 *
 * A lease is a lock that expires. The holder renews it while it is still working, so a worker that
 * dies frees its key within the TTL rather than holding it for the length of a job it is no longer
 * running. Renewal is driven by real progress, never by a bare timer: a timer proves the process is
 * alive, which a hung worker also is.
 *
 * Every operation is an atomic compare-and-set with an expiry, because that is the one primitive
 * both backings can do in a single uninterruptible step - `SET NX PX` and two compare-and-swap Lua
 * scripts in Redis, a synchronous block here. Designing to that intersection is what lets the
 * backing change without the callers changing.
 *
 * The interface is async even though this implementation never waits. That is paid for Redis: an
 * interface that is synchronous today cannot be backed by a network call tomorrow without rewriting
 * every caller.
 *
 * There is deliberately no `isHeld`. Every operation here is a complete decision, because a
 * read-then-act pair is a race however atomic each half is - `if (!await isHeld(k)) await
 * acquire(k)` has a window between the two calls. The only way to learn whether a key is free is to
 * try to take it, and the only way to keep one is `touch`, never release-then-reacquire.
 */

import crypto from 'crypto';
import { sleep } from './delay';
import { Logger } from './logger';

/**
 * A held lease. Carries no expiry of its own: the store owns the clock.
 *
 * A holder that cached "mine until T" and reasoned from it would be confidently wrong after any
 * pause it did not measure - a serverless freeze/thaw, a long stop-the-world - and would act on a
 * lease it no longer holds. Asking the store is the only answer that survives that.
 */
export interface Lease {
  readonly key: string;
  /** Extend the lease. False means it is gone: expired, or taken by someone else. */
  touch(): Promise<boolean>;
  /** Give the lease up. A no-op once it has expired or been taken. */
  release(): Promise<void>;
}

export interface LeaseStore {
  /** Take `key` for `ttlMs`, or null if someone else holds it. Never waits. */
  acquire(key: string, ttlMs: number): Promise<Lease | null>;
}

interface Held {
  token: string;
  expiresAt: number;
}

/**
 * A lease store held in one process's memory.
 *
 * Correct for a single instance and nothing more. Across processes it coordinates nothing, and in
 * a serverless runtime the map can be empty on every invocation - so the guard silently does
 * nothing while appearing to work. Choose it deliberately; do not let a multi-instance deployment
 * fall back to it.
 */
export class InMemoryLeaseStore implements LeaseStore {
  private readonly held = new Map<string, Held>();

  /**
   * Synchronous on purpose, and the reason is structural rather than stylistic: this is the
   * critical section, and in a synchronous method an `await` between the read and the write is a
   * compile error rather than a silent race. Node runs it to completion before any other code sees
   * the event loop, which is what makes it atomic - and that guarantee lasts exactly as long as
   * nothing suspends inside it.
   */
  private claim(key: string, ttlMs: number): string | null {
    const now = Date.now();
    const current = this.held.get(key);
    if (current && current.expiresAt > now) return null;

    const token = crypto.randomUUID();
    this.held.set(key, { token, expiresAt: now + ttlMs });
    return token;
  }

  /** Extends only our own live lease. See `claim` for why this is synchronous. */
  private extend(key: string, token: string, ttlMs: number): boolean {
    const now = Date.now();
    const current = this.held.get(key);
    if (!current || current.token !== token || current.expiresAt <= now) return false;

    current.expiresAt = now + ttlMs;
    return true;
  }

  /**
   * Drops only our own lease. See `claim` for why this is synchronous.
   *
   * The token comparison is the point: a holder whose lease expired mid-job still runs its release
   * afterwards, and without the check it would delete whichever successor had since taken the key.
   * An expired entry still carrying our token is ours to remove.
   */
  private drop(key: string, token: string): void {
    if (this.held.get(key)?.token === token) this.held.delete(key);
  }

  async acquire(key: string, ttlMs: number): Promise<Lease | null> {
    const token = this.claim(key, ttlMs);
    if (!token) return null;

    return {
      key,
      touch: async () => this.extend(key, token, ttlMs),
      release: async () => this.drop(key, token),
    };
  }
}

/** Raised when a lease could not be taken before the caller's patience ran out. */
export class LeaseTimeoutError extends Error {
  constructor(
    readonly key: string,
    readonly waitedMs: number,
  ) {
    super(`Timed out after ${waitedMs}ms waiting for the lease on ${key}`);
    this.name = 'LeaseTimeoutError';
  }
}

export interface WithLeaseOptions {
  /** How long the lease lives between renewals. */
  ttlMs: number;
  /** How long to keep retrying before giving up. */
  waitMs: number;
  /** Gap between attempts. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 100;

/**
 * Run `work` holding `key`, waiting for it if someone else has it.
 *
 * Built on `acquire` rather than as a store method, so it needs nothing from a backing that Redis
 * cannot offer: Redis has no blocking acquire for this pattern, and a primitive only one backing
 * can implement is not portable.
 *
 * This is for short critical sections that callers must not skip - a check-and-create, where the
 * loser needs to wait and then see what the winner did. Work that should refuse rather than queue
 * wants `acquire` directly.
 */
export async function withLease<T>(
  store: LeaseStore,
  key: string,
  options: WithLeaseOptions,
  work: (lease: Lease) => Promise<T>,
): Promise<T> {
  const { ttlMs, waitMs, pollMs = DEFAULT_POLL_MS } = options;
  const deadline = Date.now() + waitMs;

  for (;;) {
    const lease = await store.acquire(key, ttlMs);
    if (lease) {
      try {
        return await work(lease);
      } finally {
        await lease.release();
      }
    }

    if (Date.now() >= deadline) throw new LeaseTimeoutError(key, waitMs);
    Logger.debug('Waiting for a lease', { key });
    await sleep(pollMs);
  }
}

/**
 * The process-wide store.
 *
 * Swapping this for a Redis-backed one is the whole reason the interface exists, and is the only
 * change a distributed deployment should need here.
 */
export const syncLeases: LeaseStore = new InMemoryLeaseStore();
