/**
 * The breaker is made of clock reads: isOpen() is `state === OPEN && Date.now() < nextAttemptTime`.
 *
 * So these run on fake timers, and time moves only when a test says so. They used to wait for real,
 * which forced resetTimeout down to 50ms to keep the suite quick - and that made "record two
 * failures, assert it is open" a race the test could lose: under load the assertion arrived more
 * than 50ms after the failures, the window had passed, and isOpen() was correctly false. It failed
 * about one run in six with nine suites running at once, and never once running alone.
 *
 * That flake was not confined to this file. A static mutant is tested by running the WHOLE suite,
 * and stryker counts any failure as the mutant being caught - so this test failing at random handed
 * out kills nothing earned. src/lib/circuitBreakerConfig.ts read 60% against a real 40% because of
 * it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CircuitBreaker, CircuitState } from '../../src/lib/circuitBreaker';
import { Logger } from '../../src/lib/logger';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    circuitBreaker = new CircuitBreaker('Test Circuit', {
      failureThreshold: 2,
      // A real minute, because nothing waits for it: the clock is ours now.
      resetTimeout: 60_000,
      successThreshold: 2,
    });
  });

  afterEach(() => vi.useRealTimers());

  describe('Initial State', () => {
    it('should start in CLOSED state', () => {
      const state = circuitBreaker.getState();
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
    });

    it('should allow requests when CLOSED', () => {
      expect(circuitBreaker.canProceed()).toBe(true);
    });

    it('should not be open initially', () => {
      expect(circuitBreaker.isOpen()).toBe(false);
    });
  });

  describe('Failure Handling', () => {
    it('should remain CLOSED after single failure below threshold', () => {
      circuitBreaker.recordFailure();
      const state = circuitBreaker.getState();
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(1);
      expect(circuitBreaker.canProceed()).toBe(true);
    });

    it('should open after reaching failure threshold', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      const state = circuitBreaker.getState();
      expect(state.state).toBe(CircuitState.OPEN);
      expect(circuitBreaker.isOpen()).toBe(true);
      expect(circuitBreaker.canProceed()).toBe(false);
    });

    it('should reset failure count after opening', () => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      const state = circuitBreaker.getState();
      expect(state.failureCount).toBe(0);
    });
  });

  describe('Success Handling', () => {
    it('should reset failure count on success', () => {
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState().failureCount).toBe(1);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState().failureCount).toBe(0);
    });

    it('should remain CLOSED after success in CLOSED state', () => {
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState().state).toBe(CircuitState.CLOSED);
    });
  });

  describe('OPEN State', () => {
    beforeEach(() => {
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
    });

    it('should reject requests when OPEN', () => {
      expect(circuitBreaker.canProceed()).toBe(false);
    });

    it('should have a future nextAttemptTime when OPEN', () => {
      const state = circuitBreaker.getState();
      expect(state.nextAttemptTime).toBeGreaterThan(Date.now());
    });

    it('should transition to HALF_OPEN after timeout', async () => {
      // Wait for reset timeout
      vi.advanceTimersByTime(60_001);

      expect(circuitBreaker.canProceed()).toBe(true);
      const state = circuitBreaker.getState();
      expect(state.state).toBe(CircuitState.HALF_OPEN);
    });
  });

  describe('HALF_OPEN State', () => {
    beforeEach(async () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();

      // Wait for reset timeout to enter HALF_OPEN
      vi.advanceTimersByTime(60_001);
      circuitBreaker.canProceed(); // Trigger transition to HALF_OPEN
    });

    it('should allow requests in HALF_OPEN state', () => {
      expect(circuitBreaker.canProceed()).toBe(true);
    });

    it('should close after sufficient successes', () => {
      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState().state).toBe(CircuitState.HALF_OPEN);

      circuitBreaker.recordSuccess();
      expect(circuitBreaker.getState().state).toBe(CircuitState.CLOSED);
    });

    it('should reopen immediately on failure', () => {
      circuitBreaker.recordFailure();

      const state = circuitBreaker.getState();
      expect(state.state).toBe(CircuitState.OPEN);
      expect(circuitBreaker.canProceed()).toBe(false);
    });
  });

  describe('Manual Control', () => {
    it('should force open when open() is called', () => {
      expect(circuitBreaker.getState().state).toBe(CircuitState.CLOSED);

      circuitBreaker.open('quota exhausted');

      expect(circuitBreaker.getState().state).toBe(CircuitState.OPEN);
      expect(circuitBreaker.isOpen()).toBe(true);
    });

    it('should force close when close() is called', async () => {
      // Open the circuit
      circuitBreaker.recordFailure();
      circuitBreaker.recordFailure();
      expect(circuitBreaker.getState().state).toBe(CircuitState.OPEN);

      circuitBreaker.close();

      const state = circuitBreaker.getState();
      expect(state.state).toBe(CircuitState.CLOSED);
      expect(state.failureCount).toBe(0);
      expect(state.nextAttemptTime).toBe(0);
    });
  });

  describe('Quota Error Scenario', () => {
    it('should immediately open on quota error', () => {
      circuitBreaker.open('quota exhausted');

      expect(circuitBreaker.isOpen()).toBe(true);
      expect(circuitBreaker.canProceed()).toBe(false);
    });

    it('should prevent further requests until timeout', () => {
      circuitBreaker.open('quota exhausted');

      // Multiple calls should all be rejected
      expect(circuitBreaker.canProceed()).toBe(false);
      expect(circuitBreaker.canProceed()).toBe(false);
      expect(circuitBreaker.canProceed()).toBe(false);
    });

    it('should allow retry after timeout period', async () => {
      circuitBreaker.open('quota exhausted');
      expect(circuitBreaker.canProceed()).toBe(false);

      // Wait for timeout
      vi.advanceTimersByTime(60_001);

      expect(circuitBreaker.canProceed()).toBe(true);
    });
  });

  describe('Configuration', () => {
    it('should respect custom failure threshold', () => {
      const customBreaker = new CircuitBreaker('Custom', { failureThreshold: 5 });

      // Should stay closed through 4 failures
      for (let i = 0; i < 4; i++) {
        customBreaker.recordFailure();
        expect(customBreaker.getState().state).toBe(CircuitState.CLOSED);
      }

      // Should open on 5th failure
      customBreaker.recordFailure();
      expect(customBreaker.getState().state).toBe(CircuitState.OPEN);
    });

    it('should respect custom success threshold in HALF_OPEN', () => {
      const customBreaker = new CircuitBreaker('Custom', {
        failureThreshold: 2,
        resetTimeout: 100,
        successThreshold: 3,
      });

      // Open and wait for HALF_OPEN
      customBreaker.open('quota exhausted');
      vi.advanceTimersByTime(101);
      customBreaker.canProceed();

      // Should need 3 successes to close
      customBreaker.recordSuccess();
      expect(customBreaker.getState().state).toBe(CircuitState.HALF_OPEN);
      customBreaker.recordSuccess();
      expect(customBreaker.getState().state).toBe(CircuitState.HALF_OPEN);
      customBreaker.recordSuccess();
      expect(customBreaker.getState().state).toBe(CircuitState.CLOSED);
    });
  });

  // The boundaries and the state guards: the exact instant the window opens, and the fact that
  // success/failure counting only happens in the states that should count them.
  describe('boundaries and state guards', () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
      cb = new CircuitBreaker('Guarded', {
        failureThreshold: 2,
        resetTimeout: 60_000,
        successThreshold: 2,
      });
    });

    afterEach(() => vi.restoreAllMocks());

    // >= not >: at the exact reset instant the breaker may probe again, it does not wait a tick more.
    it('transitions to HALF_OPEN at exactly the reset time', () => {
      cb.open('quota exhausted');
      vi.advanceTimersByTime(60_000); // now === nextAttemptTime

      expect(cb.canProceed()).toBe(true);
      expect(cb.getState().state).toBe(CircuitState.HALF_OPEN);
    });

    // recordSuccess only counts toward closing in HALF_OPEN - a success while OPEN must not close it.
    it('does not count successes toward closing while OPEN', () => {
      cb.open('quota exhausted');

      cb.recordSuccess();
      cb.recordSuccess();

      expect(cb.getState().state).toBe(CircuitState.OPEN);
    });

    // The threshold-open only fires from CLOSED; failures while already OPEN must not re-arm the timer.
    it('does not re-arm the reset timer on failures while already OPEN', () => {
      cb.open('quota exhausted');
      const armed = cb.getState().nextAttemptTime;
      vi.advanceTimersByTime(10_000);

      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState().nextAttemptTime).toBe(armed);
    });

    // isOpen is `state===OPEN && now < nextAttemptTime`: past the window it is NOT open (the || and
    // the &&-true mutants would keep it open).
    it('is not open once an OPEN breaker is past its reset window', () => {
      cb.open('quota exhausted');
      vi.advanceTimersByTime(60_001);

      expect(cb.isOpen()).toBe(false);
    });

    // The window is exclusive at the top: AT nextAttemptTime it is already not open (the <= mutant
    // would keep it open one instant too long).
    it('is not open at the exact reset instant', () => {
      cb.open('quota exhausted');
      vi.advanceTimersByTime(60_000);

      expect(cb.isOpen()).toBe(false);
    });

    it('logs the reset window in whole minutes when opening', () => {
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);

      cb.open('quota exhausted'); // resetTimeout 60_000ms -> 1 minute

      expect(warn).toHaveBeenCalledWith(
        'Circuit breaker OPEN',
        expect.objectContaining({ name: 'Guarded', resetInMinutes: 1 }),
      );
    });

    it('logs Unknown error for a non-Error failure in HALF_OPEN', () => {
      cb.open('quota exhausted');
      vi.advanceTimersByTime(60_001);
      cb.canProceed(); // -> HALF_OPEN
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);

      cb.recordFailure('a string, not an Error');

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('HALF_OPEN'),
        expect.objectContaining({ error: 'Unknown error' }),
      );
    });
  });
});

/**
 * What the breaker records about its own state, which is what every downstream message is built
 * from. A refusal that cannot say why it is refusing, or when it stops, is the "please try again
 * later" that sends people back every fifteen minutes all night.
 */
describe('what it records about being open', () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = new CircuitBreaker('Recorder', {
      failureThreshold: 2,
      resetTimeout: 60_000,
      successThreshold: 2,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts with nothing recorded, so a stale reason cannot leak into a message', () => {
    const state = cb.getState();

    expect(state.openReason).toBe('');
    expect(state.openClearsAt).toBeNull();
  });

  // Opened by a run of failures, not by a caller who knew a cause - so the reason has to say that,
  // rather than the "quota exceeded" every refusal used to claim.
  it('names the failure count when the threshold opens it', () => {
    cb.recordFailure();
    cb.recordFailure();

    expect(cb.getState().openReason).toBe('2 consecutive request failures');
  });

  it('says a probe failed when reopening from HALF_OPEN', () => {
    cb.open('quota exhausted');
    vi.advanceTimersByTime(60_001);
    cb.canProceed(); // -> HALF_OPEN

    cb.recordFailure(new Error('still broken'));

    expect(cb.getState().openReason).toContain('a probe request failed while recovering');
  });

  /**
   * The log carries the clear time explicitly as null when there isn't one. Leaving the key off
   * entirely reads the same as a breaker that was never given one and one whose caller forgot.
   */
  it('logs a null clear time when the caller did not know one', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);

    cb.open('2 consecutive request failures');

    expect(warn).toHaveBeenCalledWith(
      'Circuit breaker OPEN',
      expect.objectContaining({ clearsAt: null }),
    );
  });

  it('logs the clear time when there is one', () => {
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => undefined);
    const clearsAt = new Date('2026-09-03T07:00:00.000Z');

    cb.open('the daily YouTube API quota is exhausted', clearsAt);

    expect(warn).toHaveBeenCalledWith(
      'Circuit breaker OPEN',
      expect.objectContaining({ clearsAt: '2026-09-03T07:00:00.000Z' }),
    );
  });
});
