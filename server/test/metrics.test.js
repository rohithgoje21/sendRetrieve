const request = require("supertest");
const { app, createShare, settle, useTestDatabase } = require("./helpers");
const mailer = require("../src/infrastructure/mailer");
const metrics = require("../src/infrastructure/metrics");
const { connectRedis } = require("../src/infrastructure/redis");

useTestDatabase();
afterEach(() => jest.restoreAllMocks());

// Current values of a metric, as { "label=value,...": number }.
const valuesOf = async (name) => {
    const metric = await metrics.registry.getSingleMetric(name).get();
    return Object.fromEntries(
        metric.values.map((v) => [
            Object.entries(v.labels)
                .map(([k, val]) => `${k}=${val}`)
                .join(","),
            v.value,
        ])
    );
};
const exposition = () => metrics.registry.metrics();

test("requests are counted and timed by route pattern, never by actual URL", async () => {
    await request(app).get("/api/config").expect(200);
    await request(app).post("/api/shares/ABCD2345/open").send({}).expect(404);
    await request(app).get("/").expect(200);
    await request(app).get("/missing.png").expect(404);

    const counts = await valuesOf("sr_http_requests_total");
    expect(counts["method=GET,route=/api/config,status=200"]).toBeGreaterThanOrEqual(1);
    expect(counts["method=POST,route=/api/shares/:code/open,status=404"]).toBeGreaterThanOrEqual(1);
    expect(counts["method=GET,route=page,status=200"]).toBeGreaterThanOrEqual(1);
    expect(counts["method=GET,route=not_found,status=404"]).toBeGreaterThanOrEqual(1);
    const text = await exposition();
    expect(text).not.toContain("ABCD2345");
    expect(text).toMatch(/sr_http_request_duration_seconds_bucket\{le="0\.005",method="GET",route="\/api\/config",status_class="2xx"\}/);
});

test("background jobs are counted by outcome, with their duration", async () => {
    const before = (await valuesOf("sr_jobs_total"))["queue=sr.analytics,type=share.created,outcome=success"] ?? 0;
    await createShare(app, { text: "hello" });
    await settle();
    const after = await valuesOf("sr_jobs_total");
    expect(after["queue=sr.analytics,type=share.created,outcome=success"]).toBe(before + 1);
    expect(await exposition()).toMatch(/sr_job_duration_seconds_count\{queue="sr\.analytics"\} \d+/);

    // A failing email: failed attempts, then dead-lettered.
    jest.spyOn(mailer, "sendMail").mockRejectedValue(new Error("provider down"));
    await request(app).post("/api/auth/register").send({ name: "Ada", email: "ada@example.com", password: "correct-horse" }).expect(201);
    await settle();
    expect((await valuesOf("sr_jobs_total"))["queue=sr.notifications,type=email.requested,outcome=failed"]).toBeGreaterThanOrEqual(4);

    metrics.watch({ queues: true });
    const depth = await valuesOf("sr_queue_messages");
    expect(depth["queue=sr.notifications,state=dead"]).toBeGreaterThanOrEqual(1);
    expect(depth["queue=sr.notifications,state=retrying"]).toBe(0);
    expect((await valuesOf("sr_queue_up"))[""]).toBe(1);
});

test("circuit breakers and domain counters", async () => {
    const states = await valuesOf("sr_circuit_breaker_state");
    expect(states).toMatchObject({ "name=email": 0, "name=virus-scanner": 0, "name=web-push": 0 });

    const before = (await valuesOf("sr_shares_created_total"))[""] ?? 0;
    const { code } = await createShare(app, {}, [{ name: "a.txt", content: "12345" }]);
    const opened = await request(app).post(`/api/shares/${code}/open`).send({}).expect(200);
    await request(app).get(opened.body.files[0].downloadUrl).expect(200);
    expect((await valuesOf("sr_shares_created_total"))[""]).toBe(before + 1);
    expect((await valuesOf("sr_download_bytes_total"))[""]).toBeGreaterThanOrEqual(5);
});

test("served on their own port, at /metrics only", async () => {
    const server = metrics.startMetricsServer(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const res = await fetch(`${base}/metrics`);
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
        const text = await res.text();
        expect(text).toContain("# TYPE sr_http_requests_total counter");
        expect(text).toContain("process_cpu_user_seconds_total"); // Node.js process metrics
        expect((await fetch(`${base}/`)).status).toBe(404);
    } finally {
        server.close();
    }
});

// Runs only with a Redis to talk to (see infrastructure.test.js).
(process.env.TEST_REDIS_URL ? test : test.skip)("Redis hit and miss counters, for the hit rate", async () => {
    const redis = await connectRedis(process.env.TEST_REDIS_URL);
    try {
        metrics.watch({ redis });
        await valuesOf("sr_redis_up"); // first scrape: baseline
        const before = await valuesOf("sr_redis_keyspace_misses_total");
        await redis.get(`missing-${Date.now()}`);
        await redis.set("metrics-test", "1");
        await redis.get("metrics-test");
        expect((await valuesOf("sr_redis_up"))[""]).toBe(1);
        expect((await valuesOf("sr_redis_keyspace_misses_total"))[""]).toBeGreaterThan(before[""] ?? 0);
        expect((await valuesOf("sr_redis_keyspace_hits_total"))[""]).toBeGreaterThan(0);
    } finally {
        metrics.watch({ redis: null });
        await redis.close();
    }
});
