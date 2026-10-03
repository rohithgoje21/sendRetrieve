const { app, createShare, storedFiles, settle, useTestDatabase } = require("./helpers");
const request = require("supertest");
const User = require("../src/modules/users/user.model");
const Share = require("../src/modules/shares/share.model");
const mailer = require("../src/infrastructure/mailer");
const { getBus, publish } = require("../src/infrastructure/queue");
const { requeueStuckDeletions, deleteExpiredShares } = require("../src/workers/scheduler");

useTestDatabase();

afterEach(() => jest.restoreAllMocks());

const admin = async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: "Root", email: `root-${Date.now()}@example.com`, password: "correct-horse" }).expect(201);
    await User.updateMany({}, { role: "admin" });
    return agent;
};

describe("emails go through the queue", () => {
    test("the request doesn't wait for the email; the worker sends it", async () => {
        const sendMail = jest.spyOn(mailer, "sendMail").mockResolvedValue();
        await request(app).post("/api/auth/register").send({ name: "Ada", email: "ada@example.com", password: "correct-horse" }).expect(201);
        await settle();
        expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com", subject: expect.stringMatching(/verification code/) }));
    });

    test("a temporary email failure is retried until it goes through", async () => {
        const sendMail = jest
            .spyOn(mailer, "sendMail")
            .mockRejectedValueOnce(new Error("provider timeout"))
            .mockRejectedValueOnce(new Error("provider timeout"))
            .mockResolvedValue();
        await request(app).post("/api/auth/register").send({ name: "Ada", email: "ada@example.com", password: "correct-horse" }).expect(201);
        await settle();
        expect(sendMail).toHaveBeenCalledTimes(3);
        expect((await getBus().stats()).find((q) => q.name === "sr.notifications").deadLettered).toBe(0);
    });

    test("an email that fails every retry is dead-lettered; an admin can see and replay it", async () => {
        const agent = await admin();
        await settle();
        const sendMail = jest.spyOn(mailer, "sendMail").mockRejectedValue(new Error("invalid API key"));
        await request(app).post("/api/auth/forgot-password").send({ email: (await User.findOne()).email }).expect(200);
        await settle();
        expect(sendMail).toHaveBeenCalledTimes(4); // first try + 3 retries

        const { body: overview } = await agent.get("/api/admin/queues").expect(200);
        expect(overview.broker).toBe("memory");
        expect(overview.queues.find((q) => q.name === "sr.notifications")).toMatchObject({ deadLettered: 1, consumers: 1 });
        expect(overview.circuitBreakers).toEqual([expect.objectContaining({ name: "email" })]);

        const { body: dead } = await agent.get("/api/admin/queues/sr.notifications/dead-letters").expect(200);
        expect(dead.messages[0]).toMatchObject({ error: "invalid API key", message: { type: "email.requested", data: { template: "password-reset" } } });

        sendMail.mockResolvedValue(); // "fixed the API key"
        expect((await agent.post("/api/admin/queues/sr.notifications/dead-letters/replay").expect(200)).body).toEqual({ replayed: 1 });
        await settle();
        expect(sendMail).toHaveBeenCalledTimes(5);
        expect((await agent.get("/api/admin/queues/sr.notifications/dead-letters").expect(200)).body.messages).toEqual([]);

        await agent.get("/api/admin/queues/nope/dead-letters").expect(404);
    });

    test("the queue admin pages are for admins only", async () => {
        await request(app).get("/api/admin/queues").expect(401);
    });
});

describe("cleanup worker and scheduler", () => {
    test("a redelivered message is only handled once", async () => {
        const sendMail = jest.spyOn(mailer, "sendMail").mockResolvedValue();
        const message = await publish("email.requested", { template: "verify-email", to: "x@example.com", data: { name: "X", code: "123456", minutes: 10 } });
        await settle();
        // Simulate the broker delivering the same message again.
        getBus().deliver("sr.notifications", message, 0, 0);
        await settle();
        expect(sendMail).toHaveBeenCalledTimes(1);
    });

    test("deletions whose event was lost are re-queued by the sweep (self-healing)", async () => {
        const { code } = await createShare(app, {}, [{ name: "a.txt", content: "a" }]);
        // Pretend the share ended long ago and its share.ended event never arrived.
        await Share.updateOne({ code }, { endedAt: new Date(Date.now() - 60 * 60 * 1000), endedReason: "expired", filesState: "pending_deletion" });
        expect(storedFiles()).toHaveLength(1);

        expect(await requeueStuckDeletions()).toBe(1);
        await settle();
        expect(storedFiles()).toHaveLength(0);
        expect(await Share.countDocuments()).toBe(0); // guest share: record removed too
    });

    test("health reports the queue", async () => {
        const res = await request(app).get("/healthz").expect(200);
        expect(res.body.queue).toBe("memory");
    });

    test("ending is immediate even if file deletion fails; the worker retries", async () => {
        const { storage } = require("../src/infrastructure/storage");
        const realDelete = storage.delete;
        let failures = 0;
        jest.spyOn(storage, "delete").mockImplementation(async (keys) => {
            if (failures++ < 2) throw new Error("storage unavailable");
            return realDelete(keys);
        });
        const { code } = await createShare(app, {}, [{ name: "a.txt", content: "a" }]);
        await Share.updateOne({ code }, { expiresAt: new Date(Date.now() - 1000) });
        await deleteExpiredShares();
        await request(app).post(`/api/shares/${code}/open`).expect(404); // already ended
        await settle();
        expect(failures).toBe(3);
        expect(storedFiles()).toHaveLength(0);
    });
});
