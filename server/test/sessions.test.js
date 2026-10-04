const request = require("supertest");
const { app, settle, useTestDatabase } = require("./helpers");
const mailer = require("../src/infrastructure/mailer");
const User = require("../src/modules/users/user.model");
const RefreshToken = require("../src/modules/auth/refreshToken.model");
const Session = require("../src/modules/auth/session.model");
const { describeDevice, deviceLabel, maskIp } = require("../src/modules/auth/devices");
const { hashToken, randomToken } = require("../src/shared/crypto");

useTestDatabase();

afterEach(() => jest.restoreAllMocks());

const PASSWORD = "correct-horse";
const EDGE_WINDOWS =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
const SAFARI_IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const FIREFOX_LINUX = "Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0";

// A browser: its own cookie jar and User-Agent.
const browser = (userAgent = EDGE_WINDOWS) => request.agent(app).set("User-Agent", userAgent);

const register = async (agent = browser(), email = "ada@example.com") => {
    await agent.post("/api/auth/register").send({ name: "Ada", email, password: PASSWORD }).expect(201);
    return agent;
};
const login = async (agent, email = "ada@example.com") => {
    await agent.post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
    return agent;
};
const sessionsOf = async (agent) => (await agent.get("/api/me/sessions").expect(200)).body.sessions;

describe("devices", () => {
    test.each([
        [EDGE_WINDOWS, { browser: "Edge", os: "Windows", type: "desktop" }, "Edge on Windows"],
        [SAFARI_IPHONE, { browser: "Safari", os: "iOS", type: "mobile" }, "Safari on iOS"],
        [FIREFOX_LINUX, { browser: "Firefox", os: "Linux", type: "desktop" }, "Firefox on Linux"],
        [
            "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
            { browser: "Chrome", os: "Android", type: "tablet" },
            "Chrome on Android",
        ],
        ["curl/8.4.0", { browser: null, os: null, type: "desktop" }, "Unknown device"],
        ["", { browser: null, os: null, type: "unknown" }, "Unknown device"],
    ])("%s", (ua, device, label) => {
        expect(describeDevice(ua)).toEqual(device);
        expect(deviceLabel(describeDevice(ua))).toBe(label);
    });

    test("only the network part of an address is kept", () => {
        expect(maskIp("203.0.113.42")).toBe("203.0.113.*");
        expect(maskIp("::ffff:198.51.100.7")).toBe("198.51.100.*");
        expect(maskIp("2001:db8:85a3:8d3:1319:8a2e:370:7348")).toBe("2001:db8:85a3::*");
        expect(maskIp("2001:db8::1")).toBe("2001:db8::*");
        expect(maskIp(undefined)).toBeNull();
    });
});

describe("where you're logged in", () => {
    test("each login is listed with its device and network, this one first", async () => {
        const laptop = await register(browser(EDGE_WINDOWS));
        await login(browser(SAFARI_IPHONE));

        const sessions = await sessionsOf(laptop);
        expect(sessions).toHaveLength(2);
        expect(sessions[0]).toMatchObject({
            current: true,
            device: { browser: "Edge", os: "Windows", type: "desktop", label: "Edge on Windows" },
            ipHint: "127.0.0.*",
            createdAt: expect.any(String),
            lastSeenAt: expect.any(String),
        });
        expect(sessions[1]).toMatchObject({ current: false, device: { label: "Safari on iOS", type: "mobile" } });
        // Nothing more identifying than that.
        expect(JSON.stringify(sessions)).not.toMatch(/127\.0\.0\.1|Mozilla/);
    });

    test("logging out another device takes effect immediately", async () => {
        const laptop = await register(browser(EDGE_WINDOWS));
        const phone = await login(browser(SAFARI_IPHONE));
        await phone.get("/api/auth/me").expect(200);

        const [, phoneSession] = await sessionsOf(laptop);
        await laptop.delete(`/api/me/sessions/${phoneSession.id}`).expect(204);

        // Its access token hasn't expired, but the session it names is gone.
        expect((await phone.get("/api/auth/me").expect(401)).body.code).toBe("auth_required");
        await phone.post("/api/auth/refresh").expect(401);
        expect(await sessionsOf(laptop)).toHaveLength(1);
        await laptop.delete(`/api/me/sessions/${phoneSession.id}`).expect(404);
    });

    test("log out every other device, or everywhere", async () => {
        const laptop = await register(browser(EDGE_WINDOWS));
        const phone = await login(browser(SAFARI_IPHONE));
        const desktop = await login(browser(FIREFOX_LINUX));

        expect((await laptop.post("/api/me/sessions/revoke-others").expect(200)).body).toEqual({ revoked: 2 });
        await phone.get("/api/auth/me").expect(401);
        await desktop.get("/api/auth/me").expect(401);
        await laptop.get("/api/auth/me").expect(200);

        const again = await login(browser(SAFARI_IPHONE));
        await laptop.post("/api/me/sessions/revoke-all").expect(204);
        await laptop.get("/api/auth/me").expect(401);
        await again.get("/api/auth/me").expect(401);
        expect(await Session.countDocuments({ revokedAt: null })).toBe(0);
    });

    test("logging out ends this session; a device can log itself out from the list too", async () => {
        const laptop = await register(browser(EDGE_WINDOWS));
        const phone = await login(browser(SAFARI_IPHONE));
        await phone.post("/api/auth/logout").expect(204);
        expect(await sessionsOf(laptop)).toHaveLength(1);

        const [current] = await sessionsOf(laptop);
        const res = await laptop.delete(`/api/me/sessions/${current.id}`).expect(204);
        expect(res.headers["set-cookie"].join(";")).toMatch(/sr_at=;/);
        await laptop.get("/api/auth/me").expect(401);
    });

    test("refreshing tokens keeps the same session", async () => {
        const laptop = await register(browser(EDGE_WINDOWS));
        const [before] = await sessionsOf(laptop);
        await laptop.post("/api/auth/refresh").expect(200);
        await laptop.post("/api/auth/refresh").expect(200);
        const after = await sessionsOf(laptop);
        expect(after).toHaveLength(1);
        expect(after[0]).toMatchObject({ id: before.id, current: true });
        expect(Date.parse(after[0].lastSeenAt)).toBeGreaterThanOrEqual(Date.parse(before.lastSeenAt));
    });

    test("changing the password logs out other devices and keeps this one", async () => {
        const laptop = await register(browser(EDGE_WINDOWS));
        const phone = await login(browser(SAFARI_IPHONE));
        await laptop.post("/api/me/password").send({ currentPassword: PASSWORD, newPassword: "new-correct-horse" }).expect(200);
        await phone.get("/api/auth/me").expect(401);
        const sessions = await sessionsOf(laptop);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].current).toBe(true);
        expect(await Session.countDocuments({ revokedReason: "password_changed" })).toBe(2);
    });

    test("sessions are private to their account", async () => {
        const ada = await register(browser(), "ada@example.com");
        const bob = await register(browser(), "bob@example.com");
        const [bobSession] = await sessionsOf(bob);
        await ada.delete(`/api/me/sessions/${bobSession.id}`).expect(404);
        await bob.get("/api/auth/me").expect(200);
        await request(app).get("/api/me/sessions").expect(401);
    });

    test("a login from before sessions were recorded gets recorded on its next refresh", async () => {
        await register(browser());
        const user = await User.findOne();
        const token = randomToken();
        await RefreshToken.create({
            userId: user._id,
            tokenHash: hashToken(token),
            familyId: "legacy-family",
            expiresAt: new Date(Date.now() + 60_000),
        });
        const legacy = browser(FIREFOX_LINUX);
        await legacy.post("/api/auth/refresh").set("Cookie", `sr_rt=${token}`).expect(200);
        expect(await Session.findOne({ familyId: "legacy-family" })).toMatchObject({ device: { browser: "Firefox" } });
        expect(await sessionsOf(legacy)).toHaveLength(2);
    });
});

describe("new-device alerts", () => {
    const alerts = (sendMail) => sendMail.mock.calls.map(([m]) => m).filter((m) => /New login/.test(m.subject));

    test("a login from a browser the account hasn't used before is emailed to the owner", async () => {
        const sendMail = jest.spyOn(mailer, "sendMail").mockResolvedValue();
        const laptop = await register(browser(EDGE_WINDOWS));
        await laptop.post("/api/auth/logout").expect(204);
        await login(laptop); // same browser: known
        await settle();
        expect(alerts(sendMail)).toEqual([]);

        await login(browser(SAFARI_IPHONE)); // never seen
        await settle();
        const [alert] = alerts(sendMail);
        expect(alert).toMatchObject({ to: "ada@example.com" });
        expect(alert.text).toMatch(/Safari on iOS \(network 127\.0\.0\.\*\)/);
        expect(alert.text).toMatch(/\/account/);
        expect(alerts(sendMail)).toHaveLength(1);
    });

    test("no alert for the first login an account has ever had", async () => {
        const sendMail = jest.spyOn(mailer, "sendMail").mockResolvedValue();
        await register(browser());
        await Session.deleteMany({}); // as if the account predates sessions
        await login(browser(SAFARI_IPHONE));
        await settle();
        expect(alerts(sendMail)).toEqual([]);
    });
});
