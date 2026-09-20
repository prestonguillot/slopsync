/**
 * Leases are made of clock reads, so the clock is ours here: a test that really waits out a TTL is
 * slow, and one that races a real expiry fails under load for reasons that have nothing to do with
 * the code.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryLeaseStore, LeaseTimeoutError, withLease, type Lease } from '../../src/lib/leases';
import { Logger } from '../../src/lib/logger';

describe('InMemoryLeaseStore', () => {
  let store: InMemoryLeaseStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryLeaseStore();
  });

  afterEach(() => vi.useRealTimers());

  describe('acquire', () => {
    it('takes a free key', async () => {
      expect(await store.acquire('playlist-1', 1000)).not.toBeNull();
    });

    it('refuses a key someone else holds', async () => {
      await store.acquire('playlist-1', 1000);

      expect(await store.acquire('playlist-1', 1000)).toBeNull();
    });

    it('does not refuse a different key', async () => {
      await store.acquire('playlist-1', 1000);

      expect(await store.acquire('playlist-2', 1000)).not.toBeNull();
    });

    it('takes a key whose lease has expired', async () => {
      await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(1001);

      expect(await store.acquire('playlist-1', 1000)).not.toBeNull();
    });

    // The lease is live right up to its expiry instant, not one tick less.
    it('still refuses at the instant before expiry', async () => {
      await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(999);

      expect(await store.acquire('playlist-1', 1000)).toBeNull();
    });

    it('frees the key at exactly the expiry instant', async () => {
      await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(1000);

      expect(await store.acquire('playlist-1', 1000)).not.toBeNull();
    });
  });

  describe('touch', () => {
    // The whole point of renewal: a worker that keeps reporting progress keeps its key past the
    // original expiry, so the TTL can be short enough that a dead worker frees it quickly.
    it('keeps the key held past the original expiry', async () => {
      const lease = await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(600);

      expect(await lease!.touch()).toBe(true);
      vi.advanceTimersByTime(600); // 1200 total: past the first TTL, inside the renewed one

      expect(await store.acquire('playlist-1', 1000)).toBeNull();
    });

    it('reports false once the lease has expired', async () => {
      const lease = await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(1001);

      expect(await lease!.touch()).toBe(false);
    });

    // A stalled worker must not be able to renew its way back on top of its successor.
    it('reports false once someone else holds the key', async () => {
      const first = await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(1001);
      await store.acquire('playlist-1', 1000);

      expect(await first!.touch()).toBe(false);
    });

    it('does not extend a lease it could not renew', async () => {
      const first = await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(1001);
      const second = await store.acquire('playlist-1', 1000);
      await first!.touch();

      // The key still belongs to the second holder, on the second holder's clock.
      expect(await second!.touch()).toBe(true);
    });
  });

  describe('release', () => {
    it('frees the key', async () => {
      const lease = await store.acquire('playlist-1', 1000);
      await lease!.release();

      expect(await store.acquire('playlist-1', 1000)).not.toBeNull();
    });

    /**
     * The reason leases carry a token at all. A holder whose lease expired mid-job still runs its
     * release afterwards; without the ownership check that release deletes whichever successor has
     * since taken the key, and two workers proceed believing they are alone.
     */
    it('does not free a key that has since been taken by someone else', async () => {
      const first = await store.acquire('playlist-1', 1000);
      vi.advanceTimersByTime(1001);
      await store.acquire('playlist-1', 1000);

      await first!.release();

      expect(await store.acquire('playlist-1', 1000)).toBeNull();
    });

    it('is safe to call twice', async () => {
      const lease = await store.acquire('playlist-1', 1000);
      await lease!.release();
      await lease!.release();

      expect(await store.acquire('playlist-1', 1000)).not.toBeNull();
    });

    it('does not free a key a later holder took after a clean release', async () => {
      const first = await store.acquire('playlist-1', 1000);
      await first!.release();
      await store.acquire('playlist-1', 1000);

      await first!.release();

      expect(await store.acquire('playlist-1', 1000)).toBeNull();
    });
  });
});

describe('withLease', () => {
  let store: InMemoryLeaseStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryLeaseStore();
  });

  afterEach(() => vi.useRealTimers());

  it('runs the work and returns its result', async () => {
    const result = await withLease(
      store,
      'playlist-1',
      { ttlMs: 1000, waitMs: 1000 },
      async () => 'done',
    );

    expect(result).toBe('done');
  });

  it('frees the key afterwards', async () => {
    await withLease(store, 'playlist-1', { ttlMs: 1000, waitMs: 1000 }, async () => undefined);

    expect(await store.acquire('playlist-1', 1000)).not.toBeNull();
  });

  // A throw inside the critical section must not strand the key until its TTL.
  it('frees the key when the work throws', async () => {
    await expect(
      withLease(store, 'playlist-1', { ttlMs: 1000, waitMs: 1000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(await store.acquire('playlist-1', 1000)).not.toBeNull();
  });

  it('holds the key for the duration of the work', async () => {
    let heldDuringWork: Lease | null = null;
    await withLease(store, 'playlist-1', { ttlMs: 1000, waitMs: 1000 }, async () => {
      heldDuringWork = await store.acquire('playlist-1', 1000);
    });

    expect(heldDuringWork).toBeNull();
  });

  it('gives up once the wait is exhausted', async () => {
    await store.acquire('playlist-1', 60_000);

    const attempt = withLease(
      store,
      'playlist-1',
      { ttlMs: 1000, waitMs: 500, pollMs: 100 },
      async () => 'never',
    );
    const assertion = expect(attempt).rejects.toBeInstanceOf(LeaseTimeoutError);
    await vi.advanceTimersByTimeAsync(600);

    await assertion;
  });

  // The waiting case that matters: the loser does not fail, it waits and then gets its turn - which
  // is what lets it re-read what the winner did.
  it('waits for the holder and then proceeds', async () => {
    const holder = await store.acquire('playlist-1', 60_000);

    const attempt = withLease(
      store,
      'playlist-1',
      { ttlMs: 1000, waitMs: 5000, pollMs: 100 },
      async () => 'second',
    );
    await vi.advanceTimersByTimeAsync(200);
    await holder!.release();
    await vi.advanceTimersByTimeAsync(200);

    expect(await attempt).toBe('second');
  });
});

/**
 * The exact instants, and what a failure tells whoever reads the log. A lease is a clock read, so
 * every boundary here is one a caller can land on.
 */
describe('lease boundaries and diagnostics', () => {
  let store: InMemoryLeaseStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryLeaseStore();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Expiry is exclusive at the top, the same way acquire treats it: at the expiry instant the key
  // is already free, so renewing it then would hand back a lease someone else can hold too.
  it('refuses to renew at exactly the expiry instant', async () => {
    const lease = await store.acquire('playlist-1', 1000);
    vi.advanceTimersByTime(1000);

    expect(await lease!.touch()).toBe(false);
  });

  it('gives up at the wait, not a poll after it', async () => {
    await store.acquire('playlist-1', 60_000);

    const attempt = withLease(
      store,
      'playlist-1',
      { ttlMs: 1000, waitMs: 500, pollMs: 100 },
      async () => 'never',
    );
    const assertion = expect(attempt).rejects.toBeInstanceOf(LeaseTimeoutError);
    await vi.advanceTimersByTimeAsync(500);

    await assertion;
  });

  // Which key timed out is the whole diagnostic: "a lease timed out" names nothing to look at.
  it('names the key and the wait in the timeout', async () => {
    await store.acquire('playlist-1', 60_000);

    const attempt = withLease(
      store,
      'playlist-1',
      { ttlMs: 1000, waitMs: 500, pollMs: 100 },
      async () => 'never',
    );
    const assertion = expect(attempt).rejects.toMatchObject({
      name: 'LeaseTimeoutError',
      key: 'playlist-1',
      message: expect.stringContaining('playlist-1'),
    });
    await vi.advanceTimersByTimeAsync(600);

    await assertion;
  });

  it('says which key it is waiting on', async () => {
    const debug = vi.spyOn(Logger, 'debug').mockImplementation(() => undefined);
    const holder = await store.acquire('playlist-1', 60_000);

    const attempt = withLease(
      store,
      'playlist-1',
      { ttlMs: 1000, waitMs: 5000, pollMs: 100 },
      async () => 'second',
    );
    await vi.advanceTimersByTimeAsync(200);
    await holder!.release();
    await vi.advanceTimersByTimeAsync(200);
    await attempt;

    expect(debug).toHaveBeenCalledWith('Waiting for a lease', { key: 'playlist-1' });
  });
});
