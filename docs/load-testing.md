# Load testing

[k6](https://k6.io) scripts in [`load/`](../load) drive a realistic mix of traffic against a running stack
and report latency percentiles (p50/p95/p99), throughput and error rate, per scenario and overall.

## Running it

```bash
# The stack, with per-IP rate limits off (every request comes from one machine)
RATE_LIMITS=off docker compose up -d --build

# k6 from its Docker image, on the stack's network (no install needed)
docker run --rm --network sendretrieve_default -v "$PWD/load:/scripts" \
  -e BASE_URL=http://app:8080 grafana/k6:0.57.0 run /scripts/sendretrieve.js

# Heavier: SCALE multiplies every rate; DURATION sets the length
docker run ... -e SCALE=3 -e DURATION=2m grafana/k6:0.57.0 run /scripts/sendretrieve.js
```

The full k6 summary is saved to `load/results/summary.json`. With the monitoring profile running
(`docker compose --profile monitoring up`), watch the Grafana dashboard during a run: latency per
route, event loop lag, queue depth.

## The traffic

Four scenarios run side by side, each at a constant arrival rate (new requests per second, however
fast the server answers, so a slow server builds a backlog instead of being sent less work):

| Scenario | Rate (1x) | Requests                                        |
| -------- | --------- | ----------------------------------------------- |
| browse   | 20/s      | `GET /` (the app) and `GET /api/config`         |
| open     | 30/s      | `POST /api/shares/:code/open` (recipients)      |
| create   | 5/s       | `POST /api/shares` (text shares)                |
| login    | 2/s       | `POST /api/auth/login` (password check)         |

About 77 requests per second in all. Thresholds: under 1% errors, p95 under 500 ms overall,
open p95 under 300 ms, browse p95 under 200 ms, create p95 under 500 ms, login p95 under 1.5 s
(password hashing is slow on purpose).

## Results

One API instance and one worker in Docker Desktop (WSL 2) on a 14-core laptop, with MongoDB, Redis,
RabbitMQ, MinIO and ClamAV alongside. Latencies are p50 / p95 / p99 in milliseconds; absolute numbers
depend on the machine, the comparison is the point.

### What the first run found

| 1x (77 req/s target)  | Overall              | open                  | browse              | login           | Throughput |
| --------------------- | -------------------- | --------------------- | ------------------- | --------------- | ---------- |
| bcryptjs (before)     | 1729 / 5627 / 17439  | 2116 / 4248 / 17606   | 1018 / 4207 / 15362 | (backlogged)    | 64.5/s     |
| scrypt (after)        | 8.6 / 24 / 461       | 11.6 / 23 / 32        | 2.5 / 9.2 / 14.5    | 456 / 522 / 565 | 74.3/s     |

No errors in either run. The first run failed every latency threshold, and Prometheus showed why:
**event loop lag p99 of 1.1 s**. Passwords were hashed with bcryptjs, a pure JavaScript bcrypt that
runs on Node's main thread, so two logins a second stalled every other request: opening a share
(a database read) took seconds because it waited behind password hashing.

The fix: hash with **scrypt from Node's `crypto` module**, which runs on libuv's thread pool, with
OWASP-equivalent parameters (N=2^15, r=8, p=3). Older bcrypt hashes still verify, and accounts are
re-hashed on their next login ([`shared/passwords.js`](../server/src/shared/passwords.js)).
Everything else got 200x faster at p50, and the server kept up with the full target rate.

### Pushing to 3x (~230 req/s target)

| 3x                                     | Overall             | open                 | browse            | login                | Throughput |
| -------------------------------------- | ------------------- | -------------------- | ----------------- | -------------------- | ---------- |
| scrypt, 4 threads                      | 61 / 9797 / 12144   | 66 / 1635 / 2209     | 47 / 11650 / 12256| 2659 / 4185 / 4744   | 197.7/s    |
| + index.html in memory, 16 threads     | 666 / 3726 / 22382  | 1418 / 4500 / 22849  | 459 / 1052 / 2367 | 3776 / 16730 / 24496 | 206.9/s    |
| + index.html in memory, hashing capped | 76 / 1074 / 7818    | 130 / 1213 / 1377    | 44 / 382 / 468    | 7588 / 10399 / 10583 | 195.4/s    |

Two more findings:

- **Page loads queued behind logins.** Serving `index.html` with `res.sendFile` reads it through
  libuv's thread pool (4 threads by default), the same pool scrypt uses. Now it's kept in memory.
- **More threads made it worse.** Raising `UV_THREADPOOL_SIZE` to 16 let 16 hashes run at once;
  hashing is pure CPU, so they took the cores from the main thread and share opens got slower.
  Instead, concurrent hashes are capped (at most 3, and fewer than the CPU count), with the rest
  queued. Under overload, logins wait; the rest of the site stays responsive.

At 3x a single API instance is saturated (about 195 req/s here): logins queue by design, other
requests degrade to about 1 s p95, and nothing fails. Beyond that, run more API instances: they share
sessions, rate limits and live updates through Redis and MongoDB already.
