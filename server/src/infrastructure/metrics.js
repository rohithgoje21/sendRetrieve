const http = require("http");
const client = require("prom-client");
const { getBus } = require("./queue");
const { allBreakers } = require("../shared/circuitBreaker");
const { logger } = require("./logger");

// Prometheus metrics. Each process (API, worker) has its own registry and
// serves it at GET /metrics on a separate internal port (METRICS_PORT), never
// on the public site; Prometheus scrapes both (docker/monitoring).
//
//   sr_http_requests_total{method,route,status}          throughput, error rate
//   sr_http_request_duration_seconds{method,route,...}   latency (p50/p95/p99)
//   sr_jobs_total{queue,type,outcome}                    worker throughput, failures
//   sr_job_duration_seconds{queue}
//   sr_queue_messages{queue,state}                       depth: ready / retrying / dead
//   sr_circuit_breaker_state{name}                       0 closed, 1 half open, 2 open
//   sr_redis_keyspace_{hits,misses}_total                Redis hit rate
//   sr_realtime_connections                              open Socket.IO connections
//   sr_shares_created_total, sr_downloads_total, sr_download_bytes_total, sr_upload_bytes_total
// plus Node.js process metrics (CPU, memory, event loop lag, GC).

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry });

const httpRequests = new client.Counter({
    name: "sr_http_requests_total",
    help: "HTTP requests, by route pattern and status",
    labelNames: ["method", "route", "status"],
    registers: [registry],
});

const httpDuration = new client.Histogram({
    name: "sr_http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["method", "route", "status_class"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
});

const jobs = new client.Counter({
    name: "sr_jobs_total",
    help: "Background jobs handled, by outcome (success, failed, duplicate)",
    labelNames: ["queue", "type", "outcome"],
    registers: [registry],
});

const jobDuration = new client.Histogram({
    name: "sr_job_duration_seconds",
    help: "Background job duration",
    labelNames: ["queue"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
});

const sharesCreated = new client.Counter({ name: "sr_shares_created_total", help: "Shares that went live", registers: [registry] });
const downloads = new client.Counter({ name: "sr_downloads_total", help: "Files downloaded", registers: [registry] });
const downloadBytes = new client.Counter({ name: "sr_download_bytes_total", help: "Bytes of files downloaded (bandwidth)", registers: [registry] });
const uploadBytes = new client.Counter({ name: "sr_upload_bytes_total", help: "Bytes of files uploaded", registers: [registry] });

// Read at scrape time.
const watched = { redis: null, realtime: null, queues: false };

new client.Gauge({
    name: "sr_queue_messages",
    help: "Messages in each queue: ready, retrying (waiting for a retry), dead (dead-lettered)",
    labelNames: ["queue", "state"],
    registers: [registry],
    async collect() {
        if (!watched.queues) return;
        try {
            for (const q of await getBus().stats()) {
                this.set({ queue: q.name, state: "ready" }, q.ready);
                this.set({ queue: q.name, state: "retrying" }, q.retrying ?? 0);
                this.set({ queue: q.name, state: "dead" }, q.deadLettered);
            }
        } catch {
            // Broker unreachable: leave the last values; sr_queue_up says so.
        }
    },
});

new client.Gauge({
    name: "sr_queue_up",
    help: "1 if the message broker is reachable",
    registers: [registry],
    async collect() {
        if (!watched.queues) return;
        this.set((await getBus().health()) === "down" ? 0 : 1);
    },
});

const BREAKER_STATES = { closed: 0, half_open: 1, open: 2 };
new client.Gauge({
    name: "sr_circuit_breaker_state",
    help: "Circuit breaker state: 0 closed, 1 half open, 2 open",
    labelNames: ["name"],
    registers: [registry],
    collect() {
        for (const breaker of allBreakers()) this.set({ name: breaker.name }, BREAKER_STATES[breaker.state] ?? 0);
    },
});

new client.Gauge({
    name: "sr_realtime_connections",
    help: "Open Socket.IO connections",
    registers: [registry],
    collect() {
        if (watched.realtime) this.set(watched.realtime());
    },
});

// Redis's own hit/miss counters (INFO stats), as counters.
const redisHits = new client.Counter({ name: "sr_redis_keyspace_hits_total", help: "Redis key lookups that found the key", registers: [registry] });
const redisMisses = new client.Counter({ name: "sr_redis_keyspace_misses_total", help: "Redis key lookups that missed", registers: [registry] });
const lastRedis = { hits: 0, misses: 0 };
const advance = (counter, key, value) => {
    // A smaller value means Redis restarted (its counters reset).
    const delta = value >= lastRedis[key] ? value - lastRedis[key] : value;
    if (delta > 0) counter.inc(delta);
    lastRedis[key] = value;
};
new client.Gauge({
    name: "sr_redis_up",
    help: "1 if Redis is reachable (absent without Redis)",
    registers: [registry],
    async collect() {
        if (!watched.redis) return;
        try {
            const info = await watched.redis.info("stats");
            advance(redisHits, "hits", Number(/keyspace_hits:(\d+)/.exec(info)?.[1] ?? 0));
            advance(redisMisses, "misses", Number(/keyspace_misses:(\d+)/.exec(info)?.[1] ?? 0));
            this.set(1);
        } catch {
            this.set(0);
        }
    },
});

/* ---------- Recording ---------- */

// Express middleware: one count and one timing per request, labelled with
// the route's pattern (/api/shares/:code/open), never the actual URL, so the
// number of series stays small and codes don't end up in metrics.
const httpMetrics = (req, res, next) => {
    const end = httpDuration.startTimer();
    // The router sets req.route when a route matches; note the mount path
    // (req.baseUrl) at that moment: by the time an error response finishes,
    // the routers have unwound and baseUrl is empty again.
    let matched = null;
    Object.defineProperty(req, "route", {
        configurable: true,
        enumerable: true,
        get: () => matched?.route,
        set(route) {
            matched = route ? { route, base: req.baseUrl } : null;
        },
    });
    res.on("finish", () => {
        let route = "unmatched";
        if (matched) route = `${matched.base}${matched.route.path}`;
        else if (!req.originalUrl.startsWith("/api") && req.method === "GET") route = res.statusCode === 404 ? "not_found" : "page";
        const status = String(res.statusCode);
        httpRequests.inc({ method: req.method, route, status });
        end({ method: req.method, route, status_class: `${status[0]}xx` });
    });
    next();
};

// Wraps a job handler's run: counts it and times it.
const recordJob = (queue, type, outcome, seconds) => {
    jobs.inc({ queue, type, outcome });
    if (seconds !== undefined) jobDuration.observe({ queue }, seconds);
};

// What to read at scrape time in this process.
const watch = ({ redis, realtime, queues } = {}) => {
    if (redis !== undefined) watched.redis = redis;
    if (realtime !== undefined) watched.realtime = realtime;
    if (queues !== undefined) watched.queues = queues;
};

// GET /metrics on its own port. Returns the server (to close on shutdown).
const startMetricsServer = (port) => {
    const server = http.createServer(async (req, res) => {
        if (req.method !== "GET" || req.url !== "/metrics") {
            res.statusCode = 404;
            return res.end();
        }
        try {
            const body = await registry.metrics();
            res.setHeader("Content-Type", registry.contentType);
            res.end(body);
        } catch (err) {
            res.statusCode = 500;
            res.end(String(err.message));
        }
    });
    server.listen(port, () => logger.info({ event: "metrics.started", port }, `Metrics on port ${port}`));
    return server;
};

module.exports = {
    registry,
    httpMetrics,
    recordJob,
    watch,
    startMetricsServer,
    counters: { sharesCreated, downloads, downloadBytes, uploadBytes },
};
