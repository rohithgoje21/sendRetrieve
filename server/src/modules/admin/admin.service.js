const Share = require("../shares/share.model");
const User = require("../users/user.model");
const { liveFilter } = require("../shares/shares.service");

const DAY_MS = 24 * 60 * 60 * 1000;

// Shared by GET /api/admin/stats and the admin "ask" tool, so they can never
// drift apart.
const getSiteStats = async () => {
    const now = Date.now();
    const live = liveFilter();
    const [users, verified, disabled, admins, newUsers, activeShares, uploading, sharesToday, storageTotals, activity] =
        await Promise.all([
            User.countDocuments(),
            User.countDocuments({ emailVerifiedAt: { $ne: null } }),
            User.countDocuments({ disabledAt: { $ne: null } }),
            User.countDocuments({ role: { $in: ["admin", "superadmin"] } }),
            User.countDocuments({ createdAt: { $gte: new Date(now - 7 * DAY_MS) } }),
            Share.countDocuments(live),
            Share.countDocuments({ uploadPending: true }),
            Share.countDocuments({ uploadPending: { $ne: true }, createdAt: { $gte: new Date(now - DAY_MS) } }),
            // Files currently held in storage: live shares and uploads in progress.
            Share.aggregate([
                { $match: { endedAt: null } },
                { $unwind: "$files" },
                { $group: { _id: null, bytes: { $sum: "$files.size" }, files: { $sum: 1 } } },
            ]),
            Share.aggregate([
                { $match: { uploadPending: { $ne: true } } },
                {
                    $group: {
                        _id: null,
                        views: { $sum: "$views" },
                        downloads: { $sum: { $sum: "$files.downloads" } },
                    },
                },
            ]),
        ]);

    return {
        users: { total: users, verified, disabled, admins, newThisWeek: newUsers },
        shares: { active: activeShares, uploading, createdToday: sharesToday },
        storage: { bytes: storageTotals[0]?.bytes ?? 0, files: storageTotals[0]?.files ?? 0 },
        // Totals across shares still in the database (guest shares are
        // deleted when they end, so this undercounts older activity).
        activity: { views: activity[0]?.views ?? 0, downloads: activity[0]?.downloads ?? 0 },
    };
};

module.exports = { getSiteStats };
