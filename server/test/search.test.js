const request = require("supertest");
const { app, createShare, PNG, useTestDatabase } = require("./helpers");
const Share = require("../src/modules/shares/share.model");

useTestDatabase();

// An owner with a few different shares.
const setup = async () => {
    const agent = request.agent(app);
    await agent.post("/api/auth/register").send({ name: "Ada", email: "ada@example.com", password: "correct-horse" }).expect(201);
    const make = (fields, files) => createShare(agent, fields, files).then((r) => r.code);
    const codes = {
        report: await make({}, [{ name: "Quarterly Report.pdf", content: "%PDF-1.7 " + "x".repeat(500), type: "application/pdf" }]),
        photo: await make({ password: "secret-pw" }, [{ name: "beach.png", content: PNG }]),
        note: await make({ text: "Meeting notes for Monday" }),
        dotted: await make({}, [{ name: "a.b.txt", content: "dots" }]),
    };
    // Some activity, for sorting.
    await Share.updateOne({ code: codes.note }, { views: 9 });
    await Share.updateOne({ code: codes.photo }, { $set: { "files.0.downloads": 4 } });
    const list = async (query = "") => (await agent.get(`/api/me/shares?${query}`).expect(200)).body;
    return { agent, codes, list };
};

const codesOf = (body) => body.shares.map((s) => s.code);

test("search matches file names and messages, case-insensitively, and codes by their start", async () => {
    const { codes, list } = await setup();
    expect(codesOf(await list("q=quarterly"))).toEqual([codes.report]);
    expect(codesOf(await list("q=MEETING"))).toEqual([codes.note]);
    expect(codesOf(await list(`q=${codes.photo.slice(0, 4)}-${codes.photo.slice(4, 6)}`))).toEqual([codes.photo]);
    expect(codesOf(await list("q=nothing-like-this"))).toEqual([]);
});

test("search text is literal, not a pattern", async () => {
    const { codes, list } = await setup();
    expect(codesOf(await list("q=a.b"))).toEqual([codes.dotted]);
    expect(codesOf(await list(`q=${encodeURIComponent(".*")}`))).toEqual([]);
    expect(codesOf(await list(`q=${encodeURIComponent("(")}`))).toEqual([]);
});

test("filters: text-only or with files, file type, password", async () => {
    const { codes, list } = await setup();
    expect(codesOf(await list("kind=text"))).toEqual([codes.note]);
    expect(codesOf(await list("kind=files")).sort()).toEqual([codes.report, codes.photo, codes.dotted].sort());
    expect(codesOf(await list("fileType=image"))).toEqual([codes.photo]);
    expect(codesOf(await list("fileType=document")).sort()).toEqual([codes.report, codes.dotted].sort());
    expect(codesOf(await list("protected=yes"))).toEqual([codes.photo]);
    expect(codesOf(await list("protected=no&kind=files&fileType=image"))).toEqual([]);
});

test("sorting", async () => {
    const { codes, list } = await setup();
    expect(codesOf(await list("sort=oldest"))).toEqual([codes.report, codes.photo, codes.note, codes.dotted]);
    expect(codesOf(await list())).toEqual([codes.dotted, codes.note, codes.photo, codes.report]);
    expect(codesOf(await list("sort=views"))[0]).toBe(codes.note);
    expect(codesOf(await list("sort=downloads"))[0]).toBe(codes.photo);
    expect(codesOf(await list("sort=size"))[0]).toBe(codes.report);
    expect((await list("sort=bogus")).sort).toBe("newest");
});

test("tab counts follow the search", async () => {
    const { agent, codes, list } = await setup();
    await agent.delete(`/api/me/shares/${codes.report}`).expect(204);
    expect((await list("q=report")).counts).toEqual({ active: 0, expired: 0, deleted: 1 });
    expect(codesOf(await list("q=report&status=deleted"))).toEqual([codes.report]);
    expect((await list()).counts).toEqual({ active: 3, expired: 0, deleted: 1 });
});
