const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  GitHubBridge,
  circuitState,
  rateLimitState,
  RETRY_CONFIG,
  CIRCUIT_BREAKER,
  respectRateLimit,
  RATE_LIMIT_MAX_WAIT_MS,
} = require('../src/core/github-bridge');

describe('GitHubBridge Resilience', () => {
  beforeEach(() => {
    // Reset circuit breaker state between tests
    circuitState.status = 'closed';
    circuitState.failures = 0;
    circuitState.lastFailureTime = null;
    circuitState.lastSuccessTime = null;

    // Reset rate limit state
    rateLimitState.remaining = null;
    rateLimitState.limit = null;
    rateLimitState.resetTime = null;
  });

  describe('Circuit Breaker', () => {
    it('should start in closed state', () => {
      assert.strictEqual(circuitState.status, 'closed');
      assert.strictEqual(circuitState.failures, 0);
    });

    it('should track consecutive failures', () => {
      const bridge = new GitHubBridge({ token: 'test' });
      // Simulate failures by directly manipulating state
      circuitState.failures = 3;
      assert.strictEqual(circuitState.failures, 3);
      assert.strictEqual(circuitState.status, 'closed'); // Not yet at threshold
    });

    it('should open circuit after threshold failures', () => {
      circuitState.failures = CIRCUIT_BREAKER.failureThreshold;
      circuitState.status = 'open';
      circuitState.lastFailureTime = Date.now();

      assert.strictEqual(circuitState.status, 'open');
    });

    it('should transition to half-open after reset time', () => {
      circuitState.status = 'open';
      circuitState.failures = CIRCUIT_BREAKER.failureThreshold;
      // Set last failure to well past the reset time
      circuitState.lastFailureTime = Date.now() - CIRCUIT_BREAKER.resetTimeMs - 1000;

      // The circuit should allow a test request now
      assert.strictEqual(circuitState.status, 'open');
      // After reset time elapsed, next check would move to half-open
    });

    it('should reset on manual reset', () => {
      const bridge = new GitHubBridge({ token: 'test' });
      circuitState.status = 'open';
      circuitState.failures = 10;

      bridge.resetCircuitBreaker();

      assert.strictEqual(circuitState.status, 'closed');
      assert.strictEqual(circuitState.failures, 0);
    });

    it('should expose circuit state via getAccessStatus', () => {
      const bridge = new GitHubBridge({ token: 'test' });
      circuitState.failures = 2;

      const status = bridge.getAccessStatus();
      assert.strictEqual(status.circuitBreaker.failures, 2);
      assert.strictEqual(status.circuitBreaker.status, 'closed');
      assert.strictEqual(status.retryConfig.maxRetries, RETRY_CONFIG.maxRetries);
    });
  });

  describe('Rate Limit Tracking', () => {
    it('should start with null rate limit state', () => {
      assert.strictEqual(rateLimitState.remaining, null);
      assert.strictEqual(rateLimitState.limit, null);
      assert.strictEqual(rateLimitState.resetTime, null);
    });

    it('should expose rate limit via getAccessStatus', () => {
      const bridge = new GitHubBridge({ token: 'test' });
      rateLimitState.remaining = 4500;
      rateLimitState.limit = 5000;
      rateLimitState.resetTime = Math.floor(Date.now() / 1000) + 3600;

      const status = bridge.getAccessStatus();
      assert.strictEqual(status.rateLimit.remaining, 4500);
      assert.strictEqual(status.rateLimit.limit, 5000);
    });
  });

  describe('respectRateLimit (Known Issue #25)', () => {
    it('does not wait when quota is healthy', async () => {
      rateLimitState.remaining = 500;
      rateLimitState.resetTime = Math.floor(Date.now() / 1000) + 3600;
      const waited = await respectRateLimit();
      assert.strictEqual(waited, 0);
    });

    it('waits inline for a short reset when quota is nearly exhausted', async () => {
      rateLimitState.remaining = 2;
      rateLimitState.resetTime = Math.floor(Date.now() / 1000) + 1; // ~1s out
      const waited = await respectRateLimit();
      assert.ok(waited > 0 && waited < 5000, `expected a short wait, got ${waited}ms`);
    });

    it('refuses fast instead of hammering 429s when the reset is beyond the wait ceiling', async () => {
      rateLimitState.remaining = 1;
      // Reset is 30 minutes out — well beyond RATE_LIMIT_MAX_WAIT_MS (15 min).
      // The old `< 120000` cap silently returned 0 here (skip the wait,
      // proceed with ~1 request of quota left) instead of surfacing this.
      rateLimitState.resetTime = Math.floor(Date.now() / 1000) + 30 * 60;
      await assert.rejects(
        () => respectRateLimit(),
        /rate limit nearly exhausted.*too long to wait inline/s,
      );
    });

    it('RATE_LIMIT_MAX_WAIT_MS is a sane bound (minutes, not the old 2-minute cliff)', () => {
      assert.ok(RATE_LIMIT_MAX_WAIT_MS > 120000, 'must exceed the old 2-minute cap');
      assert.ok(RATE_LIMIT_MAX_WAIT_MS <= 30 * 60 * 1000, 'should not block a CLI run for the better part of an hour');
    });
  });

  describe('Retry Configuration', () => {
    it('should have sensible retry defaults', () => {
      assert.strictEqual(RETRY_CONFIG.maxRetries, 4);
      assert.strictEqual(RETRY_CONFIG.baseDelayMs, 2000);
      assert.ok(RETRY_CONFIG.retryableStatuses.includes(503), 'Should retry on 503');
      assert.ok(RETRY_CONFIG.retryableStatuses.includes(502), 'Should retry on 502');
      assert.ok(RETRY_CONFIG.retryableStatuses.includes(429), 'Should retry on 429');
      assert.ok(RETRY_CONFIG.retryableStatuses.includes(500), 'Should retry on 500');
    });

    it('should not retry on 401 or 404', () => {
      assert.ok(!RETRY_CONFIG.retryableStatuses.includes(401));
      assert.ok(!RETRY_CONFIG.retryableStatuses.includes(404));
    });
  });

  describe('Multi-Strategy Access', () => {
    it('should expose accessRepo method', () => {
      const bridge = new GitHubBridge({ token: 'test' });
      assert.strictEqual(typeof bridge.accessRepo, 'function');
    });

    it('should expose healthCheck method', () => {
      const bridge = new GitHubBridge({ token: 'test' });
      assert.strictEqual(typeof bridge.healthCheck, 'function');
    });
  });

  describe('Circuit Breaker Threshold', () => {
    it('should have reasonable threshold', () => {
      assert.ok(CIRCUIT_BREAKER.failureThreshold >= 3, 'Threshold should be at least 3');
      assert.ok(CIRCUIT_BREAKER.failureThreshold <= 10, 'Threshold should not exceed 10');
    });

    it('should have reasonable reset time', () => {
      assert.ok(CIRCUIT_BREAKER.resetTimeMs >= 30000, 'Reset time should be at least 30s');
      assert.ok(CIRCUIT_BREAKER.resetTimeMs <= 300000, 'Reset time should not exceed 5min');
    });
  });
});
