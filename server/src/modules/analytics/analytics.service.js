const mongoose = require("mongoose");
const Share = require("../shares/share.model");
const { ShareStat, SiteStat } = require("./stats.models");
const { registerOf, merge, estimate } = require("../../shared/hyperloglog");
const { categoryOf, CATEGORIES } = require("./fileCategories");
const { dayOf } = require("./visitors");

const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------- Recording (the analytics worker) ---------- */

// The $max that counts a visitor in a sketch (nothing without a token).
const countVisitor = (token) => {
    if (!token) return {};
    const { index, rank } = registerOf(token);
    return { $max: { [`visitors.${index}`]: rank } };
};

// Upsert, retrying once if two workers create the same day's document at
// the same moment (the unique index lets only one insert win).
const upsert = async (model, filter, update) => {
    try {
        await model.updateOne(filter, update, { upsert: true });
    } catch (err) {
        if (err.code !== 11000) throw err;
        await model.updateOne(filter, update, { upsert: true });
    }
};

const recordView = async ({ shareId, ownerId, visitor, at }) => {
    const day = dayOf(at);
    const update = { $inc: { views: 1 }, ...countVisitor(visitor) };
    await upsert(ShareStat, { shareId, day }, { ...update, $setOnInsert: { ownerId: ownerId ?? null } });
    await upsert(SiteStat, { day }, update);
};

const recordDownload = async ({ shareId, ownerId, visitor, size = 0, mimeType, at }) => {
    const day = dayOf(at);
    const update = {
        $inc: { downloads: 1, bytes: size, [`downloadsByType.${categoryOf(mimeType)}`]: 1 },
        ...countVisitor(visitor),
    };
    await upsert(ShareStat, { shareId, day }, { ...update, $setOnInsert: { ownerId: ownerId ?? null } });
    await upsert(SiteStat, { day }, update);
};

const recordShareCreated = async ({ files = [], at }) => {
    const inc = { sharesCreated: 1, filesUploaded: files.length, bytesUploaded: files.reduce((s, f) => s + (f.size ?? 0), 0) };
    for (const file of files) {
        const category = categoryOf(file.mimeType);
        inc[`uploadsByType.${category}.files`] = (inc[`uploadsByType.${category}.files`] ?? 0) + 1;
        inc[`uploadsByType.${category}.bytes`] = (inc[`uploadsByType.${category}.bytes`] ?? 0) + (file.size ?? 0);
    }
    await upsert(SiteStat, { day: dayOf(at) }, { $inc: inc });
};

/* ---------- Queries (dashboards, weekly summary) ---------- */

// The `days` days ending today (UTC), and the same length just before.
const periodOf = (days, now = new Date()) => {
    const to = dayOf(now);
    const from = new Date(to.getTime() - (days - 1) * DAY_MS);
    const previousFrom = new Date(from.getTime() - days * DAY_MS);
    return { from, to, previousFrom };
};

const totalsOf = (docs) => ({
    views: docs.reduce((s, d) => s + (d.views ?? 0), 0),
    downloads: docs.reduce((s, d) => s + (d.downloads ?? 0), 0),
    bytes: docs.reduce((s, d) => s + (d.bytes ?? 0), 0),
    visitors: estimate(merge(...docs.map((d) => d.visitors))),
});

// One entry per day from `from` to `to`, zeros where nothing happened.
const dailyOf = (docs, from, to) => {
    const byDay = new Map();
    for (const doc of docs) {
        const key = doc.day.toISOString();
        byDay.set(key, [...(byDay.get(key) ?? []), doc]);
    }
    const out = [];
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
        const day = new Date(t);
        out.push({ day: day.toISOString().slice(0, 10), ...totalsOf(byDay.get(day.toISOString()) ?? []) });
    }
    return out;
};

const sumByType = (docs, field) => {
    const out = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
    for (const doc of docs) for (const [c, n] of Object.entries(doc[field] ?? {})) out[c] = (out[c] ?? 0) + n;
    return out;
};

// The signed-in user's shares, over the last `days` days.
const ownerAnalytics = async (ownerId, days, now = new Date()) => {
    const { from, to, previousFrom } = periodOf(days, now);
    const owner = new mongoose.Types.ObjectId(String(ownerId));
    const stats = await ShareStat.find({ ownerId: owner, day: { $gte: previousFrom, $lte: to } }).lean();
    const current = stats.filter((s) => s.day >= from);

    // Most active shares in the period.
    const perShare = new Map();
    for (const s of current) {
        const key = String(s.shareId);
        perShare.set(key, [...(perShare.get(key) ?? []), s]);
    }
    const ranked = [...perShare.entries()]
        .map(([shareId, docs]) => ({ shareId, ...totalsOf(docs) }))
        .sort((a, b) => b.views + b.downloads - (a.views + a.downloads))
        .slice(0, 5);
    const shares = await Share.find({ _id: { $in: ranked.map((r) => r.shareId) } }, { code: 1, files: 1, text: 1 }).lean();
    const topShares = ranked.map((r) => {
        const share = shares.find((s) => String(s._id) === r.shareId);
        return {
            code: share?.code ?? null,
            label: share ? share.files.map((f) => f.originalName).join(", ") || "Text only" : "Deleted share",
            views: r.views,
            downloads: r.downloads,
            bytes: r.bytes,
            visitors: r.visitors,
        };
    });

    // What was shared in the period, by type (from the shares themselves).
    const created = await Share.find({ ownerId: owner, uploadPending: { $ne: true }, createdAt: { $gte: from } }, { files: 1 }).lean();
    const fileTypes = Object.fromEntries(CATEGORIES.map((c) => [c, { files: 0, bytes: 0 }]));
    for (const share of created) {
        for (const file of share.files) {
            const t = fileTypes[categoryOf(file.mimeType)];
            t.files++;
            t.bytes += file.size;
        }
    }

    return {
        days,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        totals: { ...totalsOf(current), sharesCreated: created.length },
        previous: totalsOf(stats.filter((s) => s.day < from)),
        daily: dailyOf(current, from, to),
        downloadsByType: sumByType(current, "downloadsByType"),
        fileTypes,
        topShares,
    };
};

// One share over the last `days` days.
const shareAnalytics = async (share, days, now = new Date()) => {
    const { from, to } = periodOf(days, now);
    const stats = await ShareStat.find({ shareId: share._id, day: { $gte: from, $lte: to } }).lean();
    return {
        days,
        totals: totalsOf(stats),
        daily: dailyOf(stats, from, to),
        files: share.files.map((f) => ({ id: f._id, name: f.originalName, downloads: f.downloads, size: f.size })),
    };
};

// The whole site (admin dashboard).
const siteAnalytics = async (days, now = new Date()) => {
    const { from, to, previousFrom } = periodOf(days, now);
    const stats = await SiteStat.find({ day: { $gte: previousFrom, $lte: to } }).lean();
    const current = stats.filter((s) => s.day >= from);
    const previous = stats.filter((s) => s.day < from);
    const uploads = (docs) => ({
        sharesCreated: docs.reduce((s, d) => s + (d.sharesCreated ?? 0), 0),
        filesUploaded: docs.reduce((s, d) => s + (d.filesUploaded ?? 0), 0),
        bytesUploaded: docs.reduce((s, d) => s + (d.bytesUploaded ?? 0), 0),
    });
    const uploadsByType = Object.fromEntries(CATEGORIES.map((c) => [c, { files: 0, bytes: 0 }]));
    for (const doc of current) {
        for (const [c, v] of Object.entries(doc.uploadsByType ?? {})) {
            uploadsByType[c].files += v.files ?? 0;
            uploadsByType[c].bytes += v.bytes ?? 0;
        }
    }
    return {
        days,
        from: from.toISOString().slice(0, 10),
        to: to.toISOString().slice(0, 10),
        totals: { ...totalsOf(current), ...uploads(current) },
        previous: { ...totalsOf(previous), ...uploads(previous) },
        daily: dailyOf(current, from, to).map((d) => {
            const doc = current.find((c) => c.day.toISOString().slice(0, 10) === d.day);
            return { ...d, sharesCreated: doc?.sharesCreated ?? 0, bytesUploaded: doc?.bytesUploaded ?? 0 };
        }),
        downloadsByType: sumByType(current, "downloadsByType"),
        uploadsByType,
    };
};

// An owner's activity in [from, to) across all their shares (weekly summary).
const ownerActivity = async (ownerId, from, to) => {
    const owner = new mongoose.Types.ObjectId(String(ownerId));
    const stats = await ShareStat.find({ ownerId: owner, day: { $gte: dayOf(from), $lt: to } }).lean();
    return totalsOf(stats);
};

module.exports = {
    recordView,
    recordDownload,
    recordShareCreated,
    ownerAnalytics,
    shareAnalytics,
    siteAnalytics,
    ownerActivity,
    periodOf,
};
