// Browser push needs VAPID keys, read when the config loads.
const webpush = require("web-push");
const vapid = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

const request = require("supertest");
const { app, createShare, settle, useTestDatabase } = require("./helpers");
const mailer = require("../src/infrastructure/mailer");
const scanner = require("../src/infrastructure/clamav");
const User = require("../src/modules/users/user.model");
const Share = require("../src/modules/shares/share.model");
const Notification = require("../src/modules/notifications/notification.model");
const PushSubscription = require("../src/modules/notifications/pushSubscription.model");
const { deleteExpiredShares, requeueStuckDeletions } = require("../src/workers/scheduler");
const { queueWeeklySummaries } = require("../src/modules/notifications/weeklySummary");
const { createKeyValueStore } = require("../src/infrastructure/kv");
const { recordView, recordDownload } = require("../src/modules/analytics/analytics.service");

useTestDatabase();

let sendMail;
let sendPush;
beforeEach(() => {
    sendMail = jest.spyOn(mailer, "sendMail").mockResolvedValue();
    sendPush = jest.spyOn(webpush, "sendNotification").mockResolvedValue({ statusCode: 201 });
});
afterEach(() => jest.restoreAllMocks());

const PASSWORD = "correct-horse";
const register = async (email = "ada@example.com", { verified = true } = {}) => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: "Ada", email, password: PASSWORD }).expect(201);
    if (verified) await User.updateOne({ email }, { emailVerifiedAt: new Date() });
    return agent;
};
const notificationsOf = async (agent) => (await agent.get("/api/notifications").expect(200)).body;
const setPreferences = (agent, preferences) => agent.put("/api/notifications/preferences").send({ preferences }).expect(200);
const emails = (subject) => sendMail.mock.calls.map(([m]) => m).filter((m) => subject.test(m.subject));

// An owned share with one file; returns a function that downloads it.
const sharedFile = async (owner, name = "report.txt") => {
    const { code } = await createShare(owner, {}, [{ name, content: "numbers" }]);
    const opened = await request(app).post(`/api/shares/${code}/open`).send({}).expect(200);
    const download = async () => {
        await request(app).get(opened.body.files[0].downloadUrl).expect(200);
        await settle();
    };
    return { code, download };
};

const subscribe = (agent, endpoint = "https://push.example.com/send/abc") =>
    agent
        .post("/api/notifications/push-subscriptions")
        .send({ endpoint, keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" } })
        .expect(201);

describe("preferences", () => {
    test("defaults, the events that exist, and which channels are available", async () => {
        const agent = await register();
        const { body } = await agent.get("/api/notifications/preferences").expect(200);
        expect(body.preferences).toEqual({
            fileDownloaded: { inApp: true, email: false, push: true },
            shareEnded: { inApp: true, email: false, push: false },
            shareBlocked: { inApp: true, email: true, push: true },
            newDevice: { inApp: true, email: true, push: true },
            weeklySummary: { inApp: true, email: true, push: false },
        });
        expect(body.events.map((e) => e.key)).toEqual(Object.keys(body.preferences));
        expect(body.events.find((e) => e.key === "newDevice").security).toBe(true);
        expect(body.channels).toEqual({ email: { verified: true }, push: { available: true, publicKey: vapid.publicKey } });
    });

    test("changes are merged into the current choices; unknown events and channels are refused", async () => {
        const agent = await register();
        const { body } = await setPreferences(agent, { fileDownloaded: { email: true }, weeklySummary: { inApp: false, email: false } });
        expect(body.preferences.fileDownloaded).toEqual({ inApp: true, email: true, push: true });
        expect(body.preferences.weeklySummary).toEqual({ inApp: false, email: false, push: false });
        await agent.put("/api/notifications/preferences").send({ preferences: { fileShared: { email: true } } }).expect(400);
        await agent.put("/api/notifications/preferences").send({ preferences: { fileDownloaded: { sms: true } } }).expect(400);
        await request(app).get("/api/notifications/preferences").expect(401);
    });
});

describe("in-app notifications", () => {
    test("downloads of a share become one notification, merged until it's read", async () => {
        const owner = await register();
        const { download } = await sharedFile(owner);

        await download();
        let { notifications, unread } = await notificationsOf(owner);
        expect(unread).toBe(1);
        expect(notifications[0]).toMatchObject({ event: "fileDownloaded", title: '"report.txt" was downloaded', read: false, link: "/shares" });

        await download();
        ({ notifications, unread } = await notificationsOf(owner));
        expect(notifications).toHaveLength(1);
        expect(notifications[0].title).toMatch(/were downloaded 2 times/);

        expect((await owner.post("/api/notifications/read").send({ all: true }).expect(200)).body).toEqual({ unread: 0 });
        await download();
        ({ notifications, unread } = await notificationsOf(owner));
        expect(notifications).toHaveLength(2);
        expect(unread).toBe(1);
    });

    test("guest shares notify nobody", async () => {
        const { code } = await createShare(app, {}, [{ name: "a.txt", content: "a" }]);
        const opened = await request(app).post(`/api/shares/${code}/open`).send({}).expect(200);
        await request(app).get(opened.body.files[0].downloadUrl).expect(200);
        await settle();
        expect(await Notification.countDocuments()).toBe(0);
    });

    test("an expired share is reported once; deleting your own share isn't", async () => {
        const owner = await register();
        const expiring = await createShare(owner, { text: "x" });
        const deleted = await createShare(owner, { text: "y" });
        await owner.delete(`/api/me/shares/${deleted.code}`).expect(204);
        await Share.updateOne({ code: expiring.code }, { expiresAt: new Date(Date.now() - 1000) });
        await deleteExpiredShares();
        await settle();
        // A re-queued deletion event doesn't notify again.
        await Share.updateMany({}, { endedAt: new Date(Date.now() - 60 * 60 * 1000), filesState: "pending_deletion" });
        await requeueStuckDeletions();
        await settle();

        const { notifications } = await notificationsOf(owner);
        expect(notifications.map((n) => n.title)).toEqual([`Share ${expiring.code.slice(0, 4)}-${expiring.code.slice(4)} expired`]);
    });

    test("marking some as read, and nobody else's", async () => {
        const ada = await register("ada@example.com");
        const bob = await register("bob@example.com");
        const { download } = await sharedFile(ada);
        await download();
        const [notification] = (await notificationsOf(ada)).notifications;

        expect((await bob.post("/api/notifications/read").send({ ids: [notification.id] }).expect(200)).body).toEqual({ unread: 0 });
        expect((await notificationsOf(ada)).unread).toBe(1);
        expect((await ada.post("/api/notifications/read").send({ ids: [notification.id, "junk"] }).expect(200)).body).toEqual({ unread: 0 });
        await ada.post("/api/notifications/read").send({}).expect(400);
        await request(app).get("/api/notifications").expect(401);
    });

    test("turned off in-app, nothing shows up", async () => {
        const owner = await register();
        await setPreferences(owner, { fileDownloaded: { inApp: false } });
        const { download } = await sharedFile(owner);
        await download();
        expect((await notificationsOf(owner)).notifications).toEqual([]);
    });
});

describe("email", () => {
    test("download emails are opt-in, at most one per share per hour, and only to verified addresses", async () => {
        const owner = await register();
        const { download } = await sharedFile(owner);
        await download();
        expect(emails(/was downloaded/)).toHaveLength(0);

        await setPreferences(owner, { fileDownloaded: { email: true } });
        await download();
        await download();
        expect(emails(/was downloaded/)).toHaveLength(1);
        expect(emails(/was downloaded/)[0]).toMatchObject({ to: "ada@example.com", subject: '"report.txt" was downloaded' });

        const unverified = await register("new@example.com", { verified: false });
        await setPreferences(unverified, { fileDownloaded: { email: true } });
        await (await sharedFile(unverified, "other.txt")).download();
        expect(emails(/"other.txt"/)).toHaveLength(0);
    });

    test("a malware block is emailed and shown in the app", async () => {
        jest.spyOn(scanner, "enabled").mockReturnValue(true);
        jest.spyOn(scanner, "scanStream").mockResolvedValue({ infected: true, signature: "Eicar-Test-Signature" });
        const owner = await register();
        await createShare(owner, {}, [{ name: "eicar.txt", content: "x" }]);
        await settle();

        const [email] = emails(/blocked: malware found/);
        expect(email.text).toMatch(/"eicar.txt" \(Eicar-Test-Signature\)/);
        const { notifications } = await notificationsOf(owner);
        expect(notifications.map((n) => n.event)).toEqual(["shareBlocked"]);
    });

    test("every email can be turned off from its own link, or in one click from the mail app", async () => {
        const owner = await register();
        await setPreferences(owner, { fileDownloaded: { email: true } });
        await (await sharedFile(owner)).download();
        const [email] = emails(/was downloaded/);

        expect(email.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
        const oneClick = email.headers["List-Unsubscribe"].match(/<(.+)>/)[1];
        const pageToken = email.text.match(/unsubscribe\?token=([\w.-]+)/)[1];

        const { body } = await request(app).post("/api/notifications/unsubscribe").send({ token: pageToken }).expect(200);
        expect(body).toMatchObject({ event: "fileDownloaded", label: expect.stringMatching(/downloaded/) });
        expect((await owner.get("/api/notifications/preferences")).body.preferences.fileDownloaded).toEqual({ inApp: true, email: false, push: true });

        // A mail app's one-click unsubscribe: form-encoded, token in the URL.
        await setPreferences(owner, { fileDownloaded: { email: true } });
        await request(app)
            .post(new URL(oneClick, "http://x").pathname + new URL(oneClick, "http://x").search)
            .type("form")
            .send("List-Unsubscribe=One-Click")
            .expect(200);
        expect((await owner.get("/api/notifications/preferences")).body.preferences.fileDownloaded.email).toBe(false);

        await request(app).post("/api/notifications/unsubscribe").send({ token: `${pageToken}x` }).expect(400);
    });

    test("if the email fails, the retry sends it without repeating the in-app notification", async () => {
        const owner = await register();
        await setPreferences(owner, { fileDownloaded: { email: true } });
        const { download } = await sharedFile(owner);
        await settle(); // (the sign-up email)
        sendMail.mockRejectedValueOnce(new Error("provider down"));
        await download();
        expect(emails(/was downloaded/)).toHaveLength(2); // failed, then sent
        expect((await notificationsOf(owner)).notifications).toHaveLength(1);
    });
});

describe("browser push", () => {
    test("goes to every subscribed browser, at most every few minutes per share", async () => {
        const owner = await register();
        await subscribe(owner, "https://push.example.com/send/laptop");
        await subscribe(owner, "https://push.example.com/send/phone");
        const { download } = await sharedFile(owner);
        await download();
        await download();

        expect(sendPush).toHaveBeenCalledTimes(2);
        const [subscription, payload] = sendPush.mock.calls[0];
        expect(subscription.endpoint).toBe("https://push.example.com/send/laptop");
        expect(JSON.parse(payload)).toMatchObject({ title: '"report.txt" was downloaded', url: "/shares", tag: expect.stringMatching(/^download:/) });
        expect(await PushSubscription.countDocuments({ lastSuccessAt: { $ne: null } })).toBe(2);
    });

    test("browsers that unsubscribed are forgotten", async () => {
        sendPush.mockRejectedValueOnce(Object.assign(new Error("Gone"), { statusCode: 410 }));
        const owner = await register();
        await subscribe(owner, "https://push.example.com/send/old");
        await (await sharedFile(owner)).download();
        expect(await PushSubscription.countDocuments()).toBe(0);
    });

    test("subscriptions must be https push endpoints, and can be removed", async () => {
        const owner = await register();
        await owner
            .post("/api/notifications/push-subscriptions")
            .send({ endpoint: "http://insecure.example.com/x", keys: { p256dh: "a", auth: "b" } })
            .expect(400);
        await subscribe(owner);
        await owner.delete("/api/notifications/push-subscriptions").send({ endpoint: "https://push.example.com/send/abc" }).expect(204);
        expect(await PushSubscription.countDocuments()).toBe(0);
    });

    test("deleting the account removes its notifications and push subscriptions", async () => {
        const owner = await register();
        await subscribe(owner);
        await (await sharedFile(owner)).download();
        await owner.delete("/api/me").send({ password: PASSWORD }).expect(204);
        expect(await Notification.countDocuments()).toBe(0);
        expect(await PushSubscription.countDocuments()).toBe(0);
    });
});

describe("weekly summary", () => {
    const monday = new Date("2030-01-07T09:00:00Z"); // a Monday, after 08:00 UTC

    test("goes out once a week, on Monday morning", async () => {
        const kv = createKeyValueStore(null);
        await register("ada@example.com");
        const optedOut = await register("bob@example.com");
        await setPreferences(optedOut, { weeklySummary: { inApp: false, email: false } });

        expect(await queueWeeklySummaries({ kv, now: new Date("2030-01-08T09:00:00Z") })).toBe(0); // Tuesday
        expect(await queueWeeklySummaries({ kv, now: new Date("2030-01-07T07:00:00Z") })).toBe(0); // too early
        expect(await queueWeeklySummaries({ kv, now: monday })).toBe(1);
        expect(await queueWeeklySummaries({ kv, now: new Date("2030-01-07T15:00:00Z") })).toBe(0); // already sent
        await settle();
    });

    test("tells each user about their week, and skips users with nothing to tell", async () => {
        const kv = createKeyValueStore(null);
        const ada = await register("ada@example.com");
        const idle = await register("idle@example.com");
        await sharedFile(ada);
        await settle();
        // Activity in the week ending on that Monday morning: two people
        // opened the share (one of them twice), one downloaded.
        // (raw update: Mongoose won't change createdAt)
        await Share.collection.updateMany({}, { $set: { createdAt: new Date("2030-01-05T12:00:00Z") } });
        const share = await Share.findOne();
        const event = { shareId: share._id, ownerId: share.ownerId, at: new Date("2030-01-05T13:00:00Z"), size: 100, mimeType: "text/plain" };
        await recordView({ ...event, visitor: "aaaaaaaaaaaaaaaa" });
        await recordView({ ...event, visitor: "aaaaaaaaaaaaaaaa" });
        await recordView({ ...event, visitor: "0123456789abcdef" });
        await recordDownload({ ...event, visitor: "0123456789abcdef" });

        await queueWeeklySummaries({ kv, now: monday });
        await settle();

        const summary = (await notificationsOf(ada)).notifications.find((n) => n.event === "weeklySummary");
        expect(summary).toMatchObject({
            title: "Your week on sendRetrieve",
            body: "1 new share · 3 views · ~2 visitors · 1 download · 1 active",
        });
        const [email] = emails(/Your week/);
        expect(email).toMatchObject({ to: "ada@example.com" });
        expect(email.text).toMatch(/Your shares were opened 3 times by about 2 people, with 1 download\./);
        expect((await notificationsOf(idle)).notifications).toEqual([]);
    });
});
