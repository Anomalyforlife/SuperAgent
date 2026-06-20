// ============================================================
//  RESILIENCE — Retry, Circuit Breaker, Timeout
// ============================================================

export class CircuitBreaker {
  constructor(name, threshold = 5, resetTimeout = 60000) {
    this.name = name;
    this.threshold = threshold;
    this.resetTimeout = resetTimeout;
    this.failures = 0;
    this.state = "CLOSED"; // CLOSED | OPEN | HALF_OPEN
    this.lastFailureTime = null;
  }

  async execute(fn) {
    if (this.state === "OPEN") {
      if (Date.now() - this.lastFailureTime > this.resetTimeout) {
        this.state = "HALF_OPEN";
        console.error(`  ⚡ Circuit breaker HALF_OPEN per ${this.name}`);
      } else {
        throw new Error(`Circuit breaker OPEN per ${this.name}. Riprova tra ${Math.round((this.resetTimeout - (Date.now() - this.lastFailureTime)) / 1000)}s`);
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state === "HALF_OPEN") {
      console.error(`  ✅ Circuit breaker CHIUSO per ${this.name}`);
    }
    this.failures = 0;
    this.state = "CLOSED";
  }

  _onFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = "OPEN";
      console.error(`  🚨 Circuit breaker APERTO per ${this.name} dopo ${this.failures} fallimenti`);
    }
  }

  get isOpen() {
    return this.state === "OPEN";
  }
}

export async function withRetry(fn, options = {}) {
  const {
    maxAttempts = 3,
    baseDelay = 2000,
    maxDelay = 30000,
    factor = 2,
    jitter = true,
    timeout = 300000,
    onRetry = null,
    shouldRetry = () => true,
  } = options;

  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await Promise.race([
        fn(attempt),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`Timeout dopo ${timeout / 1000}s`)),
            timeout
          )
        ),
      ]);
      return result;
    } catch (err) {
      lastError = err;
      const isLast = attempt === maxAttempts;

      if (isLast || !shouldRetry(err)) throw err;

      const expDelay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);
      const delay = jitter ? expDelay * (0.5 + Math.random() * 0.5) : expDelay;

      if (onRetry) onRetry(attempt, err, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}

// Agent-specific timeouts based on task complexity
export function getAgentTimeout(agentKey) {
  const timeouts = {
    interpreter: 60_000,
    web_researcher: 180_000,
    web_designer: 180_000,
    docs_writer: 120_000,
    tester: 180_000,
    programmer: 360_000,
    mobile_developer: 360_000,
    cybersecurity: 360_000,
  };
  return timeouts[agentKey] ?? 240_000;
}
