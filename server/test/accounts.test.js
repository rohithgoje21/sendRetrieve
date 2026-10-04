const crypto = require("crypto");
const { app, storedFiles, createShare, settle, useTestDatabase } = require("./helpers");
const request = require("supertest");
const jwt = require("jsonwebtoken");
const Share = require("../src/modules/shares/share.model");
const User = require("../src/modules/users/user.model");
const RefreshToken = require("../src/modules/auth/refreshToken.model");
const mailer = require("../src/infrastructure/mailer");
const { deleteExpiredShares } = require("../src/workers/scheduler");

useTestDatabase();

const PASSWORD = "correct-horse";

const register = async (overrides = {}) => {
    const agent = request.agent(app);
    const body = { name: "Ada", email: "ada@example.com", password: PASSWORD, ...overrides };
    const res = await agent.post("/api/auth/register").send(body).expect(201);
    return { agent, user: res.body.user, res };
};

const login = async (email = "ada@example.com", password = PASSWORD) => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email, password }).expect(200);
    return agent;
};

const cookieValue = (res, name) =>
    res.headers["set-cookie"].find((c) => c.startsWith(`${name}=`))?.split(";")[0].split("=")[1];

const expiredAccessToken = (userId, sessionVersion = 0) => {
    const key = crypto.createHmac("sha256", "test-secret").update("access-token").digest();
    return jwt.sign({ v: sessionVersion }, key, { subject: String(userId), expiresIn: -10 });
};

describe("registration and login", () => {
    test("register starts a session with httpOnly, SameSite=Strict cookies", async () => {
        const { agent, user, res } = await register({ email: "  Ada@Example.COM " });
        expect(user).toMatchObject({ name: "Ada", email: "ada@example.com" });
        expect(user.passwordHash).toBeUndefined();

        const cookies = res.headers["set-cookie"];
        expect(cookies.find((c) => c.startsWith("sr_at="))).toMatch(/HttpOnly.*SameSite=Strict|SameSite=Strict.*HttpOnly/);
        expect(cookies.find((c) => c.startsWith("sr_rt="))).toMatch(/Path=\/api\/auth/);

        const me = await agent.get("/api/auth/me").expect(200);
        expect(me.body.user.email).toBe("ada@example.com");
    });

    test("stores a scrypt hash, not the password", async () => {
        await register();
        const user = await User.findOne().lean();
        expect(user.passwordHash).toMatch(/^scrypt\$\d+\$\d+\$\d+\$[\w+/=]+\$[\w+/=]+$/);
        expect(JSON.stringify(user)).not.toContain(PASSWORD);
    });

    test("accounts from before (bcrypt hashes) still log in, and are upgraded to scrypt", async () => {
        await register();
        await User.updateOne({}, { passwordHash: require("bcryptjs").hashSync(PASSWORD, 4) });
        await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: "wrong-password" }).expect(401);
        expect((await User.findOne().lean()).passwordHash).toMatch(/^\$2/);
        await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: PASSWORD }).expect(200);
        expect((await User.findOne().lean()).passwordHash).toMatch(/^scrypt\$/);
        await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: PASSWORD }).expect(200);
    });

    test("password-protected shares from before (bcrypt hashes) still open", async () => {
        const { code } = await createShare(app, { text: "old secret", password: "open-sesame" });
        await Share.updateOne({ code }, { passwordHash: require("bcryptjs").hashSync("open-sesame", 4) });
        await request(app).post(`/api/shares/${code}/open`).send({ password: "nope" }).expect(401);
        expect((await request(app).post(`/api/shares/${code}/open`).send({ password: "open-sesame" }).expect(200)).body.text).toBe("old secret");
    });

    test("rejects duplicate emails, regardless of case", async () => {
        await register();
        const res = await request(app)
            .post("/api/auth/register")
            .send({ name: "Other", email: "ADA@example.com", password: PASSWORD })
            .expect(409);
        expect(res.body.error).toMatch(/already exists/);
    });

    test("validates input and names the field", async () => {
        const short = await request(app)
            .post("/api/auth/register")
            .send({ name: "Ada", email: "ada@example.com", password: "short" })
            .expect(400);
        expect(short.body).toMatchObject({ field: "password" });

        const email = await request(app)
            .post("/api/auth/register")
            .send({ name: "Ada", email: "not-an-email", password: PASSWORD })
            .expect(400);
        expect(email.body).toMatchObject({ field: "email", error: "Enter a valid email address" });
    });

    test("login with the wrong password or an unknown email gives the same error", async () => {
        await register();
        const wrong = await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: "nope-nope" }).expect(401);
        const unknown = await request(app).post("/api/auth/login").send({ email: "who@example.com", password: PASSWORD }).expect(401);
        expect(wrong.body.error).toBe(unknown.body.error);
    });

    test("logout ends the session", async () => {
        const { agent } = await register();
        await agent.post("/api/auth/logout").expect(204);
        await agent.get("/api/auth/me").expect(401);
        await agent.post("/api/auth/refresh").expect(401);
    });

    test("requests from another site are blocked", async () => {
        const { agent } = await register();
        await agent.post("/api/auth/logout").set("Origin", "https://evil.example").expect(403);
        await agent.get("/api/auth/me").expect(200);
    });
});

describe("session refresh", () => {
    test("an expired access token is reported so the client can refresh", async () => {
        const { user, res: registered } = await register();
        const expired = `sr_at=${expiredAccessToken(user.id)}`;

        const res = await request(app).get("/api/auth/me").set("Cookie", expired).expect(401);
        expect(res.body.code).toBe("token_expired");

        const refreshed = await request(app)
            .post("/api/auth/refresh")
            .set("Cookie", `sr_rt=${cookieValue(registered, "sr_rt")}`)
            .expect(200);
        await request(app).get("/api/auth/me").set("Cookie", `sr_at=${cookieValue(refreshed, "sr_at")}`).expect(200);
    });

    test("creating a share with an expired token asks for a refresh instead of acting as a guest", async () => {
        const { user } = await register();
        const res = await request(app)
            .post("/api/shares")
            .set("Cookie", `sr_at=${expiredAccessToken(user.id)}`)
            .send({ text: "hi" })
            .expect(401);
        expect(res.body.code).toBe("token_expired");
        expect(await Share.countDocuments()).toBe(0);
    });

    test("refresh tokens rotate, and replaying an old one revokes the whole login", async () => {
        const { res: registered } = await register();
        const first = cookieValue(registered, "sr_rt");

        const refreshed = await request(app).post("/api/auth/refresh").set("Cookie", `sr_rt=${first}`).expect(200);
        const second = cookieValue(refreshed, "sr_rt");
        expect(second).not.toBe(first);

        // Pretend the first token was rotated away a while ago, then replay it.
        await RefreshToken.updateMany({ revokedAt: { $ne: null } }, { revokedAt: new Date(Date.now() - 60_000) });
        await request(app).post("/api/auth/refresh").set("Cookie", `sr_rt=${first}`).expect(401);

        // The legitimate newer token is now revoked too.
        await request(app).post("/api/auth/refresh").set("Cookie", `sr_rt=${second}`).expect(401);
    });

    test("a token reused within seconds (two tabs refreshing) doesn't log everyone out", async () => {
        const { res: registered } = await register();
        const first = cookieValue(registered, "sr_rt");
        const a = await request(app).post("/api/auth/refresh").set("Cookie", `sr_rt=${first}`).expect(200);
        await request(app).post("/api/auth/refresh").set("Cookie", `sr_rt=${first}`).expect(401);
        await request(app).post("/api/auth/refresh").set("Cookie", `sr_rt=${cookieValue(a, "sr_rt")}`).expect(200);
    });
});

describe("password reset", () => {
    let sendMail;
    beforeEach(() => {
        sendMail = jest.spyOn(mailer, "sendMail").mockResolvedValue();
    });
    afterEach(() => sendMail.mockRestore());

    // Emails go out through the queue; wait for the worker to send them.
    const requestReset = async (email) => {
        const res = await request(app).post("/api/auth/forgot-password").send({ email }).expect(200);
        await settle();
        return res;
    };
    // Sign-up also sends a verification email; these tests look at reset emails only.
    const resetEmails = () => sendMail.mock.calls.map(([mail]) => mail).filter((mail) => /Reset/.test(mail.subject));
    const tokenFromEmail = () => resetEmails().at(-1).text.match(/token=([\w-]+)/)[1];

    test("same response for known and unknown emails; only real accounts get mail", async () => {
        await register();
        const known = await requestReset("ada@example.com");
        const unknown = await requestReset("nobody@example.com");
        expect(known.body).toEqual(unknown.body);
        expect(resetEmails()).toHaveLength(1);
        expect(resetEmails()[0].to).toBe("ada@example.com");
    });

    test("reset sets the new password, logs out other sessions, and works only once", async () => {
        const { agent: oldSession } = await register();
        await requestReset("ada@example.com");
        const token = tokenFromEmail();

        const resetAgent = request.agent(app);
        await resetAgent.post("/api/auth/reset-password").send({ token, password: "new-password-1" }).expect(200);
        await resetAgent.get("/api/auth/me").expect(200);

        await oldSession.get("/api/auth/me").expect(401);
        await oldSession.post("/api/auth/refresh").expect(401);

        await request(app).post("/api/auth/login").send({ email: "ada@example.com", password: PASSWORD }).expect(401);
        await login("ada@example.com", "new-password-1");

        await request(app).post("/api/auth/reset-password").send({ token, password: "another-one-2" }).expect(400);
    });

    test("expired reset links are rejected", async () => {
        await register();
        await requestReset("ada@example.com");
        await User.updateOne({}, { passwordResetExpiresAt: new Date(Date.now() - 1000) });
        await request(app).post("/api/auth/reset-password").send({ token: tokenFromEmail(), password: "new-password-1" }).expect(400);
    });
});

describe("profile", () => {
    test("update name", async () => {
        const { agent } = await register();
        const res = await agent.patch("/api/me").send({ name: "  Ada Lovelace " }).expect(200);
        expect(res.body.user.name).toBe("Ada Lovelace");
    });

    test("change password keeps this session and ends the others", async () => {
        const { agent } = await register();
        const other = await login();

        await agent.post("/api/me/password").send({ currentPassword: "wrong-pass", newPassword: "new-password-1" }).expect(401);
        await agent.post("/api/me/password").send({ currentPassword: PASSWORD, newPassword: "new-password-1" }).expect(200);

        await agent.get("/api/auth/me").expect(200);
        await other.get("/api/auth/me").expect(401);
        await other.post("/api/auth/refresh").expect(401);
    });

    test("delete account removes the user, their shares and files", async () => {
        const { agent } = await register();
        expect((await createShare(agent, {}, [{ name: "a.txt", content: "a" }])).res.status).toBe(200);

        await agent.delete("/api/me").send({ password: "wrong-pass" }).expect(401);
        await agent.delete("/api/me").send({ password: PASSWORD }).expect(204);

        expect(await User.countDocuments()).toBe(0);
        expect(await Share.countDocuments()).toBe(0);
        await settle();
        expect(storedFiles()).toHaveLength(0);
        await agent.get("/api/auth/me").expect(401);
    });

    test("profile endpoints need a session", async () => {
        await request(app).get("/api/me/shares").expect(401);
        await request(app).patch("/api/me").send({ name: "x" }).expect(401);
    });
});

describe("my shares", () => {
    test("shares created while logged in are owned; guest shares are not", async () => {
        const { agent } = await register();
        const owned = await createShare(agent, { text: "mine" });
        expect(owned.res.status).toBe(201);
        expect(owned.body.owned).toBe(true);
        const guest = await createShare(app, { text: "guest" });
        expect(guest.body.owned).toBe(false);

        const res = await agent.get("/api/me/shares").expect(200);
        expect(res.body.shares.map((s) => s.code)).toEqual([owned.body.code]);
        expect(res.body.counts).toEqual({ active: 1, expired: 0, deleted: 0 });
    });

    test("shares still uploading aren't listed until the upload completes", async () => {
        const { agent } = await register();
        const { code, manageToken } = await createShare(agent, {}, [{ name: "a.txt", content: "a" }], { complete: false });
        const before = await agent.get("/api/me/shares").expect(200);
        expect(before.body.shares).toHaveLength(0);
        expect(before.body.counts.active).toBe(0);
        await agent.get(`/api/me/shares/${code}`).expect(404);

        await agent.post(`/api/shares/${code}/complete`).send({ manageToken }).expect(200);
        expect((await agent.get("/api/me/shares").expect(200)).body.shares.map((s) => s.code)).toEqual([code]);
    });

    test("list shows views and download counts", async () => {
        const { agent } = await register();
        const { body } = await createShare(agent, { maxViews: "5" }, [{ name: "a.txt", content: "abc" }]);
        const opened = await request(app).post(`/api/shares/${body.code}/open`).expect(200);
        await request(app).get(opened.body.files[0].downloadUrl).expect(200);

        const [share] = (await agent.get("/api/me/shares").expect(200)).body.shares;
        expect(share).toMatchObject({ views: 1, viewsRemaining: 4, maxViews: 5, totalSize: 3, status: "active" });
        expect(share.files[0]).toMatchObject({ name: "a.txt", downloads: 1 });
        expect(share.files[0].downloadUrl).toBeUndefined();
    });

    test("owner can view content without using up a view", async () => {
        const { agent } = await register();
        const { body } = await createShare(agent, { text: "secret", maxViews: "1" }, [{ name: "a.txt", content: "a" }]);

        const detail = await agent.get(`/api/me/shares/${body.code}`).expect(200);
        expect(detail.body.share.text).toBe("secret");
        await agent.get(detail.body.share.files[0].downloadUrl).expect(200);

        await request(app).post(`/api/shares/${body.code}/open`).expect(200);
    });

    test("other users can't see or delete your shares", async () => {
        const { agent } = await register();
        const { body } = await createShare(agent, { text: "mine" });
        const { agent: mallory } = await register({ email: "mallory@example.com" });

        await mallory.get(`/api/me/shares/${body.code}`).expect(404);
        await mallory.delete(`/api/me/shares/${body.code}`).expect(404);
        expect((await mallory.get("/api/me/shares").expect(200)).body.shares).toHaveLength(0);
        await request(app).post(`/api/shares/${body.code}/open`).expect(200);
    });

    test("deleting an active share stops it and moves it to Deleted; deleting again removes it", async () => {
        const { agent } = await register();
        const { body } = await createShare(agent, { text: "bye" }, [{ name: "a.txt", content: "a" }]);

        await agent.delete(`/api/me/shares/${body.code}`).expect(204);
        await request(app).post(`/api/shares/${body.code}/open`).expect(404);
        await settle();
        expect(storedFiles()).toHaveLength(0);

        const deleted = await agent.get("/api/me/shares?status=deleted").expect(200);
        expect(deleted.body.shares).toHaveLength(1);
        expect(deleted.body.shares[0]).toMatchObject({ status: "deleted", hasText: false, endedReason: "deleted" });
        expect(deleted.body.shares[0].files[0].name).toBe("a.txt");

        await agent.delete(`/api/me/shares/${body.code}`).expect(204);
        expect(await Share.countDocuments()).toBe(0);
    });

    test("expired owned shares keep their metadata but lose their content", async () => {
        const { agent } = await register();
        const { body } = await createShare(agent, { text: "old" }, [{ name: "a.txt", content: "a" }]);
        await createShare(app, { text: "guest" });
        await Share.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });

        expect(await deleteExpiredShares()).toBe(2);
        await settle();
        expect(await Share.countDocuments()).toBe(1); // the guest share is gone
        expect(storedFiles()).toHaveLength(0);

        const res = await agent.get("/api/me/shares?status=expired").expect(200);
        expect(res.body.shares[0]).toMatchObject({ code: body.code, status: "expired", endedReason: "expired", hasText: false });
        const stored = await Share.findOne().lean();
        expect(stored.text).toBeNull();
        expect(stored.purgeAt).toBeTruthy();
        expect(stored.filesState).toBe("deleted"); // lifecycle: stored -> pending_deletion -> deleted
    });

    test("used-up shares are labelled as such", async () => {
        const { agent } = await register();
        const { body } = await createShare(agent, { text: "once", maxViews: "1" });
        await request(app).post(`/api/shares/${body.code}/open`).expect(200);
        await Share.updateMany({}, { expiresAt: new Date(Date.now() - 1000) });
        await deleteExpiredShares();

        const res = await agent.get("/api/me/shares?status=expired").expect(200);
        expect(res.body.shares[0].endedReason).toBe("used_up");
    });
});
