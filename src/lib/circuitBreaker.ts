import { Logger } from './logger';
import {
  youtubeCircuitBreakerConfig,
  spotifyCircuitBreakerConfig,
} from '../lib/circuitBreakerConfig';

/**
 * Circuit Breaker for YouTube API quota management
 *
 * States:
 * - CLOSED: Normal operation, requests go through
 * - OPEN: Too many failures, all requests are rejected immediately
 * - HALF_OPEN: Testing if the API has recovered
 */

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitBreakerConfig {
  failureThreshold: number; // Number of failures before opening circuit
  resetTimeout: number; // Time in ms before attempting to close circuit
  successThreshold: number; // Number of successes in HALF_OPEN before closing
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private nextAttemptTime: number = 0;
  private openReason: string = '';
  /** When the cause lifts, for callers that know it. Null means only the probe window is known. */
  private openClearsAt: Date | null = null;
  private config: CircuitBreakerConfig;
  private name: string;

  constructor(name: string, config: Partial<CircuitBreakerConfig> = {}) {
    this.name = name;
    this.config = {
      failureThreshold: config.failureThreshold || 3,
      resetTimeout: config.resetTimeout || 60000, // 1 minute default
      successThreshold: config.successThreshold || 2,
    };

    Logger.info(`Circuit breaker initialized`, {
      name: this.name,
      config: this.config,
    });
  }

  /**
   * Check if a request can proceed
   */
  canProceed(): boolean {
    const now = Date.now();

    switch (this.state) {
      case CircuitState.CLOSED:
        return true;

      case CircuitState.OPEN:
        if (now >= this.nextAttemptTime) {
          Logger.info(`Circuit breaker transitioning to HALF_OPEN`, {
            name: this.name,
            previousState: this.state,
          });
          this.state = CircuitState.HALF_OPEN;
          this.successCount = 0;
          return true;
        }
        return false;

      case CircuitState.HALF_OPEN:
        return true;

      default:
        return false;
    }
  }

  /**
   * Record a successful request
   */
  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        Logger.info(`Circuit breaker closing after successful recovery`, {
          name: this.name,
          successCount: this.successCount,
        });
        this.close();
      }
    }
  }

  /**
   * Record a failed request
   */
  recordFailure(error?: unknown): void {
    this.failureCount++;

    if (this.state === CircuitState.HALF_OPEN) {
      const detail = error instanceof Error ? error.message : 'Unknown error';
      Logger.warn(`Circuit breaker opening after failure in HALF_OPEN state`, {
        name: this.name,
        error: detail,
      });
      this.open(`a probe request failed while recovering: ${detail}`);
    } else if (
      this.state === CircuitState.CLOSED &&
      this.failureCount >= this.config.failureThreshold
    ) {
      Logger.warn(`Circuit breaker opening after ${this.failureCount} failures`, {
        name: this.name,
        threshold: this.config.failureThreshold,
      });
      this.open(`${this.failureCount} consecutive request failures`);
    }
  }

  /**
   * Force the circuit open (e.g., quota exceeded).
   *
   * `reason` is not decoration. The breaker opens two ways that mean opposite things - a real daily
   * quota exhaustion, or `failureThreshold` unrelated failures - and once it is open every refusal
   * looks identical. Without the reason recorded here, the only honest thing a caller can say is
   * "blocked", and the tempting thing to say is "quota exceeded", which is wrong half the time.
   *
   * `clearsAt` is when the CAUSE lifts, which is not `nextAttemptTime`. That is when to probe again
   * in case this was a blip, and is the right schedule for the breaker and the wrong number for a
   * person: a daily quota is still gone when a fifteen-minute window elapses, so showing it tells
   * someone to come back four times an hour, all night. Callers that know better say so; the rest
   * leave it null and the probe window is the best answer available.
   */
  open(reason: string, clearsAt: Date | null = null): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = Date.now() + this.config.resetTimeout;
    this.openReason = reason;
    this.openClearsAt = clearsAt;
    this.failureCount = 0;
    this.successCount = 0;

    const resetDate = new Date(this.nextAttemptTime);
    Logger.warn(`Circuit breaker OPEN`, {
      name: this.name,
      reason,
      resetTime: resetDate.toISOString(),
      resetInMinutes: Math.round(this.config.resetTimeout / 60000),
      clearsAt: clearsAt?.toISOString() ?? null,
    });
  }

  /**
   * Force the circuit closed
   */
  close(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = 0;
    this.openReason = '';
    this.openClearsAt = null;

    Logger.info(`Circuit breaker CLOSED`, {
      name: this.name,
    });
  }

  /**
   * Get current state information
   */
  getState(): {
    state: CircuitState;
    nextAttemptTime: number;
    failureCount: number;
    openReason: string;
    openClearsAt: Date | null;
  } {
    return {
      state: this.state,
      nextAttemptTime: this.nextAttemptTime,
      failureCount: this.failureCount,
      openReason: this.openReason,
      openClearsAt: this.openClearsAt,
    };
  }

  /**
   * Check if circuit is open
   */
  isOpen(): boolean {
    return this.state === CircuitState.OPEN && Date.now() < this.nextAttemptTime;
  }
}

// YouTube API circuit breaker - configuration loaded from config/circuitBreaker.ts
export const youtubeCircuitBreaker = new CircuitBreaker('YouTube API', youtubeCircuitBreakerConfig);

// Spotify API circuit breaker - configuration loaded from config/circuitBreaker.ts
export const spotifyCircuitBreaker = new CircuitBreaker('Spotify API', spotifyCircuitBreakerConfig);

// Export class for testing
export { CircuitBreaker, CircuitState };
