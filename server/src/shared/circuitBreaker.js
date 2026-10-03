const config = require("../config");

// A circuit breaker for calls to an outside service (email provider, virus
// scanner). It keeps a failing service from tying up every request or job
// with timeouts:
//
//   closed     calls go through; consecutive failures are counted
//   open       after `failureThreshold` failures in a row: calls fail at once
//              (CircuitOpenError) for `resetTimeoutMs`
//   half_open  after the cool-down, one trial call goes through: success
//              closes the circuit, failure opens it again
//
// Every call also gets a timeout, so a hanging service counts as failing.

class CircuitOpenError extends Error {
    constructor(name, retryAfterMs) {
        super(`${name} is unavailable (circuit open); retry in ${Math.ceil(retryAfterMs / 1000)}s`);
        this.name = "CircuitOpenError";
        this.retryAfterMs = retryAfterMs;
    }
}

class TimeoutError extends Error {
    constructor(name, ms) {
        super(`${name} didn't respond within ${ms}ms`);
        this.name = "TimeoutError";
    }
}

const withTimeout = (promise, ms, name) => {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(name, ms)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

class CircuitBreaker {
    constructor(name, options = {}) {
        this.name = name;
        this.failureThreshold = options.failureThreshold ?? config.circuitBreaker.failureThreshold;
        this.resetTimeoutMs = options.resetTimeoutMs ?? config.circuitBreaker.resetTimeoutMs;
        this.callTimeoutMs = options.callTimeoutMs ?? config.circuitBreaker.callTimeoutMs;
        this.onStateChange = options.onStateChange ?? (() => {});
        this.state = "closed";
        this.failures = 0;
        this.openedAt = 0;
        this.trialInFlight = false;
    }

    setState(state) {
        if (state === this.state) return;
        const previous = this.state;
        this.state = state;
        this.onStateChange(state, previous);
    }

    async exec(fn) {
        if (this.state === "open") {
            const waited = Date.now() - this.openedAt;
            if (waited < this.resetTimeoutMs) throw new CircuitOpenError(this.name, this.resetTimeoutMs - waited);
            this.setState("half_open");
        }
        if (this.state === "half_open") {
            // Only one trial call at a time; others keep failing fast.
            if (this.trialInFlight) throw new CircuitOpenError(this.name, this.resetTimeoutMs);
            this.trialInFlight = true;
        }

        try {
            const result = await withTimeout(Promise.resolve().then(fn), this.callTimeoutMs, this.name);
            this.failures = 0;
            this.setState("closed");
            return result;
        } catch (err) {
            this.failures += 1;
            if (this.state === "half_open" || this.failures >= this.failureThreshold) {
                this.openedAt = Date.now();
                this.setState("open");
            }
            throw err;
        } finally {
            if (this.trialInFlight) this.trialInFlight = false;
        }
    }

    snapshot() {
        return { name: this.name, state: this.state, failures: this.failures };
    }
}

// Exponential backoff with jitter: base * 2^attempt, +/- 20%.
const backoffDelay = (attempt, baseMs = 200, maxMs = 10_000) => {
    const delay = Math.min(maxMs, baseMs * 2 ** attempt);
    return Math.round(delay * (0.8 + Math.random() * 0.4));
};

// Retries `fn` on failure, waiting longer each time. For quick, transient
// failures inside one operation; jobs get queue-level retries instead.
const retryWithBackoff = async (fn, { attempts = 3, baseMs = 200, shouldRetry = () => true } = {}) => {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn(attempt);
        } catch (err) {
            if (attempt + 1 >= attempts || !shouldRetry(err)) throw err;
            await new Promise((resolve) => setTimeout(resolve, backoffDelay(attempt, baseMs)));
        }
    }
};

module.exports = { CircuitBreaker, CircuitOpenError, TimeoutError, withTimeout, backoffDelay, retryWithBackoff };
