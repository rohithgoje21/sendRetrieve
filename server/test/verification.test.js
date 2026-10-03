const { app, useTestDatabase } = require("./helpers");
const request = require("supertest");
const User = require("../src/models/User");
const mailer = require("../src/lib/mailer");

useTestDatabase();

let sendMail;
beforeEach(() => {
    sendMail = jest.spyOn(mailer, "sendMail").mockResolvedValue();
});
afterEach(() => {
    sendMail.mockRestore();
    jest.restoreAllMocks();
});

const codeEmails = () => sendMail.mock.calls.map(([mail]) => mail).filter((mail) => /verification code/.test(mail.subject));
const lastCode = () => codeEmails().at(-1).text.match(/code is: (\d{6})/)[1];

let counter = 0;
const register = async () => {
    const agent = request.agent(app);
    const email = `verify-${++counter}@example.com`;
    const res = await agent.post("/api/auth/register").send({ name: "Vera", email, password: "correct-horse" }).expect(201);
    return { agent, user: res.body.user, email };
};

// Moves the clock forward for code expiry and resend cooldowns.
const advance = (seconds) => {
    const now = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(now + seconds * 1000);
};

const verify = (agent, code) => agent.post("/api/auth/verify-email").send({ code });

test("sign-up emails a 6-digit code, and the account starts unverified", async () => {
    const { user, email } = await register();
    expect(user.emailVerified).toBe(false);
    expect(codeEmails()).toHaveLength(1);
    expect(codeEmails()[0]).toMatchObject({ to: email, subject: expect.stringMatching(/^\d{6} is your/) });
});

test("the right code verifies the email", async () => {
    const { agent } = await register();
    const res = await verify(agent, lastCode()).expect(200);
    expect(res.body.user.emailVerified).toBe(true);
    expect((await agent.get("/api/auth/me")).body.user.emailVerified).toBe(true);
    expect((await User.findOne().lean()).emailVerifiedAt).toBeInstanceOf(Date);
});

test("a wrong code says how many tries are left", async () => {
    const { agent } = await register();
    const wrong = lastCode() === "000000" ? "111111" : "000000";
    const res = await verify(agent, wrong).expect(400);
    expect(res.body).toMatchObject({ field: "code", error: "That code isn't right. 4 tries left." });
});

test("after 5 wrong codes the code is discarded; a new one must be requested", async () => {
    const { agent } = await register();
    const code = lastCode();
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) await verify(agent, wrong).expect(400);
    await verify(agent, wrong).expect(429);
    const res = await verify(agent, code).expect(400);
    expect(res.body.error).toMatch(/expired. Request a new one/);
});

test("codes expire after 10 minutes", async () => {
    const { agent } = await register();
    const code = lastCode();
    advance(10 * 60 + 1);
    await verify(agent, code).expect(400);
});

test("a new code can be requested after a minute; it replaces the old one", async () => {
    const { agent } = await register();
    const first = lastCode();

    const tooSoon = await agent.post("/api/auth/verify-email/send").expect(429);
    expect(tooSoon.headers["retry-after"]).toBeTruthy();

    advance(61);
    const sent = await agent.post("/api/auth/verify-email/send").expect(200);
    expect(sent.body).toMatchObject({ resendAfterSeconds: 60 });
    const second = lastCode();
    if (second !== first) await verify(agent, first).expect(400);
    await verify(agent, second).expect(200);
});

test("verified accounts can't request more codes", async () => {
    const { agent } = await register();
    await verify(agent, lastCode()).expect(200);
    advance(61);
    await agent.post("/api/auth/verify-email/send").expect(400);
});

test("codes must look like codes, and verification needs a session", async () => {
    const { agent } = await register();
    const res = await verify(agent, "12ab56").expect(400);
    expect(res.body.error).toMatch(/6-digit code/);
    await request(app).post("/api/auth/verify-email").send({ code: "123456" }).expect(401);
    await request(app).post("/api/auth/verify-email/send").expect(401);
});

test("one user's code doesn't verify another user", async () => {
    const alice = await register();
    const aliceCode = lastCode();
    const bob = await register();
    const bobCode = lastCode();
    if (aliceCode !== bobCode) await verify(bob.agent, aliceCode).expect(400);
    await verify(alice.agent, aliceCode).expect(200);
});
