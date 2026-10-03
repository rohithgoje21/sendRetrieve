const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const mongoose = require("mongoose");
const { app, storedFiles, createShare, PNG, useTestDatabase } = require("./helpers");
const request = require("supertest");
const User = require("../src/modules/users/user.model");
const Share = require("../src/modules/shares/share.model");

useTestDatabase();

const PASSWORD = "correct-horse";

const register = async (email, { role } = {}) => {
    const agent = request.agent(app);
    const res = await agent.post("/api/auth/register").send({ name: email.split("@")[0], email, password: PASSWORD }).expect(201);
    if (role) await User.updateOne({ email }, { role });
    return { agent, user: res.body.user };
};

const loginAgent = async (email) => {
    const agent = request.agent(app);
    await agent.post("/api/auth/login").send({ email, password: PASSWORD }).expect(200);
    return agent;
};

describe("access", () => {
    test("guests get 401 and regular users 403", async () => {
        await request(app).get("/api/admin/stats").expect(401);
        const { agent } = await register("user@example.com");
        const res = await agent.get("/api/admin/stats").expect(403);
        expect(res.body.error).toMatch(/permission/);
    });

    test("the role is part of the public user", async () => {
        const { agent } = await register("boss@example.com", { role: "admin" });
        expect((await agent.get("/api/auth/me")).body.user.role).toBe("admin");
    });
});

describe("stats", () => {
    test("counts users, shares, storage and activity", async () => {
        const { agent: admin } = await register("boss@example.com", { role: "admin" });
        const { agent: user } = await register("user@example.com");
        await createShare(user, { text: "hi" }, [{ name: "a.png", content: PNG }]);
        const { code } = await createShare(app, { text: "guest" });
        await request(app).post(`/api/shares/${code}/open`).expect(200);
        await createShare(app, {}, [{ name: "pending.txt", content: "x" }], { complete: false });

        const res = await admin.get("/api/admin/stats").expect(200);
        expect(res.body).toEqual({
            users: { total: 2, verified: 0, disabled: 0, admins: 1, newThisWeek: 2 },
            shares: { active: 2, uploading: 1, createdToday: 2 },
            storage: { bytes: PNG.length + 1, files: 2 },
            activity: { views: 1, downloads: 0 },
        });
    });
});

describe("users", () => {
    test("lists users with search and their active share counts", async () => {
        const { agent: admin } = await register("boss@example.com", { role: "admin" });
        const { agent: ada } = await register("ada@example.com");
        await register("grace@example.com");
        await createShare(ada, { text: "one" });
        await createShare(ada, { text: "two" });

        const all = await admin.get("/api/admin/users").expect(200);
        expect(all.body).toMatchObject({ page: 1, total: 3, hasMore: false });

        const found = await admin.get("/api/admin/users?search=ADA").expect(200);
        expect(found.body.users).toEqual([
            expect.objectContaining({ email: "ada@example.com", role: "user", disabled: false, activeShares: 2 }),
        ]);
        // Search text is matched literally, not as a regular expression.
        expect((await admin.get("/api/admin/users?search=.*").expect(200)).body.users).toHaveLength(0);
    });

    test("disabling a user logs them out everywhere and blocks login; enabling restores it", async () => {
        const { agent: admin } = await register("boss@example.com", { role: "admin" });
        const { agent: target, user } = await register("target@example.com");

        const res = await admin.patch(`/api/admin/users/${user.id}`).send({ disabled: true }).expect(200);
        expect(res.body.user.disabled).toBe(true);

        await target.get("/api/auth/me").expect(401);
        await target.post("/api/auth/refresh").expect(401);
        const login = await request(app).post("/api/auth/login").send({ email: "target@example.com", password: PASSWORD }).expect(403);
        expect(login.body.code).toBe("account_disabled");
        // A wrong password still gets the generic error, so this doesn't reveal disabled accounts.
        await request(app).post("/api/auth/login").send({ email: "target@example.com", password: "nope-nope" }).expect(401);

        await admin.patch(`/api/admin/users/${user.id}`).send({ disabled: false }).expect(200);
        await loginAgent("target@example.com");
    });

    test("roles can be granted and revoked", async () => {
        const { agent: admin } = await register("boss@example.com", { role: "admin" });
        const { user } = await register("helper@example.com");
        await admin.patch(`/api/admin/users/${user.id}`).send({ role: "admin" }).expect(200);
        const helper = await loginAgent("helper@example.com");
        await helper.get("/api/admin/stats").expect(200);
        await admin.patch(`/api/admin/users/${user.id}`).send({ role: "user" }).expect(200);
        await helper.get("/api/admin/stats").expect(403);
    });

    test("admins can't change themselves, and bad input is rejected", async () => {
        const { agent: admin, user } = await register("boss@example.com", { role: "admin" });
        await admin.patch(`/api/admin/users/${user.id}`).send({ disabled: true }).expect(400);
        await admin.patch(`/api/admin/users/${user.id}`).send({ role: "user" }).expect(400);
        await admin.patch(`/api/admin/users/${new mongoose.Types.ObjectId()}`).send({ disabled: true }).expect(404);
        await admin.patch("/api/admin/users/not-an-id").send({ disabled: true }).expect(404);
        const { user: other } = await register("other@example.com");
        await admin.patch(`/api/admin/users/${other.id}`).send({ role: "owner" }).expect(400);
        await admin.patch(`/api/admin/users/${other.id}`).send({}).expect(400);
    });
});

describe("share moderation", () => {
    test("an admin sees a share's metadata and owner, never its content", async () => {
        const { agent: admin } = await register("boss@example.com", { role: "admin" });
        const { agent: owner } = await register("owner@example.com");
        const { code } = await createShare(owner, { text: "private message" }, [{ name: "a.txt", content: "a" }]);

        const res = await admin.get(`/api/admin/shares/${code}`).expect(200);
        expect(res.body.share).toMatchObject({ code, status: "active", owner: { email: "owner@example.com" } });
        expect(JSON.stringify(res.body)).not.toContain("private message");
        expect(res.body.share.files[0].downloadUrl).toBeUndefined();
    });

    test("removing a share takes it down and tells the owner why", async () => {
        const { agent: admin } = await register("boss@example.com", { role: "admin" });
        const { agent: owner } = await register("owner@example.com");
        const { code } = await createShare(owner, { text: "x" }, [{ name: "a.txt", content: "a" }]);

        await admin.delete(`/api/admin/shares/${code}`).expect(204);
        await request(app).post(`/api/shares/${code}/open`).expect(404);
        expect(storedFiles()).toHaveLength(0);

        const deleted = (await owner.get("/api/me/shares?status=deleted").expect(200)).body.shares;
        expect(deleted).toEqual([expect.objectContaining({ code, status: "deleted", endedReason: "removed" })]);
        await admin.delete(`/api/admin/shares/${code}`).expect(409);
    });

    test("guest shares and unfinished uploads can be removed too", async () => {
        const { agent: admin } = await register("boss@example.com", { role: "admin" });
        const guest = await createShare(app, { text: "guest" });
        const pending = await createShare(app, {}, [{ name: "p.txt", content: "p" }], { complete: false });
        await admin.delete(`/api/admin/shares/${guest.code}`).expect(204);
        await admin.delete(`/api/admin/shares/${pending.code}`).expect(204);
        expect(await Share.countDocuments()).toBe(0);
        expect(storedFiles()).toHaveLength(0);
        await admin.get("/api/admin/shares/ABCD2345").expect(404);
    });
});

describe("set-role script", () => {
    test("grants a role by email", async () => {
        await register("first@example.com");
        const script = path.join(__dirname, "..", "scripts", "set-role.js");
        const env = { ...process.env, MONGODB_URI: mongoose.connection.getClient().options.hosts.map((h) => `mongodb://${h}`)[0] + "/" + mongoose.connection.name };
        const { stdout } = await promisify(execFile)(process.execPath, [script, "FIRST@example.com", "admin"], { env });
        expect(stdout).toMatch(/first@example.com is now admin/);
        expect((await User.findOne({ email: "first@example.com" })).role).toBe("admin");

        await expect(promisify(execFile)(process.execPath, [script, "nobody@example.com", "admin"], { env })).rejects.toMatchObject({
            stderr: expect.stringMatching(/No account/),
        });
        await expect(promisify(execFile)(process.execPath, [script, "first@example.com", "owner"], { env })).rejects.toMatchObject({
            stderr: expect.stringMatching(/Usage/),
        });
    });
});
