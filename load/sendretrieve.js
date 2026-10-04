// Load test (k6): a realistic mix of traffic against a running stack.
//
//   RATE_LIMITS=off docker compose up -d --build        (rate limits off: one machine sends everything)
//   docker run --rm --network sendretrieve_default -v "$PWD/load:/scripts" \
//     -e BASE_URL=http://app:8080 grafana/k6:0.57.0 run /scripts/sendretrieve.js
//
// Scenarios run side by side, each at a fixed arrival rate (requests per
// second, independent of how fast the server answers):
//   browse   the home page and the app config
//   open     recipients opening shares (the hottest path)
//   create   guests creating text shares
//   login    users logging in (password hashing: CPU-heavy by design)
// Results: p50/p95/p99 latency, throughput and error rate, per scenario and
// overall, printed and saved to load/results/summary.json (SUMMARY_PATH when
// k6 runs outside Docker).

import http from "k6/http";
import { check } from "k6";

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";
const DURATION = __ENV.DURATION || "1m";
const SCALE = Number(__ENV.SCALE || 1); // multiply every rate
const JSON_HEADERS = { headers: { "Content-Type": "application/json" } };

const rate = (n) => Math.max(1, Math.round(n * SCALE));
const scenario = (exec, perSecond) => ({
    executor: "constant-arrival-rate",
    exec,
    rate: rate(perSecond),
    timeUnit: "1s",
    duration: DURATION,
    preAllocatedVUs: rate(perSecond) * 2,
    maxVUs: rate(perSecond) * 10,
});

export const options = {
    scenarios: {
        browse: scenario("browse", 20),
        open: scenario("open", 30),
        create: scenario("create", 5),
        login: scenario("login", 2),
    },
    thresholds: {
        http_req_failed: ["rate<0.01"],
        http_req_duration: ["p(95)<500", "p(99)<1500"],
        "http_req_duration{scenario:open}": ["p(95)<300"],
        "http_req_duration{scenario:browse}": ["p(95)<200"],
        "http_req_duration{scenario:create}": ["p(95)<500"],
        // Password hashing takes ~0.3 s by design.
        "http_req_duration{scenario:login}": ["p(95)<1500"],
        checks: ["rate>0.99"],
    },
    summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// Shares to open and accounts to log in with, made once before the test.
export function setup() {
    const codes = [];
    for (let i = 0; i < 20; i++) {
        const res = http.post(`${BASE_URL}/api/shares`, JSON.stringify({ text: `load test share ${i}`, expiresIn: "1h" }), JSON_HEADERS);
        if (res.status === 201) codes.push(res.json("code"));
    }
    const users = [];
    const run = Date.now();
    for (let i = 0; i < 5; i++) {
        const user = { email: `load-${run}-${i}@example.com`, password: "load-test-password" };
        const res = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify({ name: `Load ${i}`, ...user }), JSON_HEADERS);
        if (res.status === 201) users.push(user);
    }
    if (!codes.length || !users.length) throw new Error(`Setup failed: ${codes.length} shares, ${users.length} users (are rate limits off?)`);
    return { codes, users };
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function browse() {
    check(http.get(`${BASE_URL}/`, { tags: { name: "GET /" } }), { "home 200": (r) => r.status === 200 });
    check(http.get(`${BASE_URL}/api/config`, { tags: { name: "GET /api/config" } }), { "config 200": (r) => r.status === 200 });
}

export function open(data) {
    const res = http.post(`${BASE_URL}/api/shares/${pick(data.codes)}/open`, "{}", { ...JSON_HEADERS, tags: { name: "POST /api/shares/:code/open" } });
    check(res, { "open 200": (r) => r.status === 200 });
}

export function create() {
    const res = http.post(`${BASE_URL}/api/shares`, JSON.stringify({ text: "created under load", expiresIn: "1h" }), {
        ...JSON_HEADERS,
        tags: { name: "POST /api/shares" },
    });
    check(res, { "create 201": (r) => r.status === 201 });
}

export function login(data) {
    const user = pick(data.users);
    // A fresh cookie jar each time, like a new browser.
    const res = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify(user), { ...JSON_HEADERS, jar: new http.CookieJar(), tags: { name: "POST /api/auth/login" } });
    check(res, { "login 200": (r) => r.status === 200 });
}

// A compact report: per scenario and overall.
export function handleSummary(data) {
    const ms = (v) => (v === undefined ? "-" : `${v.toFixed(1)} ms`);
    const row = (label, trend, reqs, failed) =>
        `${label.padEnd(10)} p50 ${ms(trend?.values.med).padStart(9)}  p95 ${ms(trend?.values["p(95)"]).padStart(9)}  p99 ${ms(trend?.values["p(99)"]).padStart(9)}` +
        (reqs ? `  ${reqs.values.rate.toFixed(1).padStart(6)} req/s` : "") +
        (failed ? `  errors ${(failed.values.rate * 100).toFixed(2)}%` : "");
    const m = data.metrics;
    const lines = [
        "",
        `sendRetrieve load test: ${DURATION} at ${SCALE}x (${BASE_URL})`,
        row("overall", m.http_req_duration, m.http_reqs, m.http_req_failed),
        ...["browse", "open", "create", "login"].map((s) => row(s, m[`http_req_duration{scenario:${s}}`])),
        "",
        "thresholds: " +
            Object.entries(m)
                .filter(([, v]) => v.thresholds)
                .map(([k, v]) => `${k} ${Object.values(v.thresholds).every((t) => t.ok) ? "ok" : "FAILED"}`)
                .join(", "),
        "",
    ];
    return { stdout: lines.join("\n"), [__ENV.SUMMARY_PATH || "/scripts/results/summary.json"]: JSON.stringify(data, null, 2) };
}
