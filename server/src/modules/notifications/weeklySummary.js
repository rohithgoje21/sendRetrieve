const mongoose = require("mongoose");
const config = require("../../config");
const Share = require("../shares/share.model");
const User = require("../users/user.model");
const { liveFilter } = require("../shares/shares.service");
const { resolvePreferences } = require("./preferences");
const { publish } = require("../../infrastructure/queue");

const DAY_MS = 24 * 60 * 60 * 1000;

// A user's week: shares created in [from, to), how much they were opened and
// downloaded, and how many shares are active now. Exact numbers from the
// shares themselves (the analytics module adds activity on older shares).
const summarizeWeek = async (userId, from, to) => {
    const ownerId = new mongoose.Types.ObjectId(String(userId));
    const [created] = await Share.aggregate([
        { $match: { ownerId, uploadPending: { $ne: true }, createdAt: { $gte: from, $lt: to } } },
        {
            $group: {
                _id: null,
                sharesCreated: { $sum: 1 },
                views: { $sum: "$views" },
                downloads: { $sum: { $sum: "$files.downloads" } },
            },
        },
    ]);
    const activeShares = await Share.countDocuments({ ownerId, ...liveFilter() });
    return {
        sharesCreated: created?.sharesCreated ?? 0,
        views: created?.views ?? 0,
        downloads: created?.downloads ?? 0,
        activeShares,
    };
};

// Once a week (config.notifications.weeklySummary, UTC), queues one summary
// job per user who wants one. Called by the scheduler's sweep, which can run
// on several workers: a marker in the shared store makes it once per week.
// Returns how many were queued.
const queueWeeklySummaries = async ({ kv, now = new Date() }) => {
    const { weekday, hourUtc } = config.notifications.weeklySummary;
    if (now.getUTCDay() !== weekday || now.getUTCHours() < hourUtc) return 0;

    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUtc));
    const week = to.toISOString().slice(0, 10);
    const marker = `weekly-summary:${week}`;
    if (await kv.get(marker)) return 0;
    await kv.set(marker, "1", 8 * 24 * 60 * 60);

    const from = new Date(to.getTime() - 7 * DAY_MS);
    let queued = 0;
    for await (const user of User.find({ disabledAt: null }, { notificationPreferences: 1 }).lean().cursor()) {
        const wants = resolvePreferences(user).weeklySummary;
        if (!wants.inApp && !wants.email && !wants.push) continue;
        await publish("summary.weekly", { userId: String(user._id), from, to, week });
        queued++;
    }
    return queued;
};

module.exports = { summarizeWeek, queueWeeklySummaries };
