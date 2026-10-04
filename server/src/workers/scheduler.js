const config = require("../config");
const Share = require("../modules/shares/share.model");
const { storage } = require("../infrastructure/storage");
const { publish } = require("../infrastructure/queue");
const scanner = require("../infrastructure/clamav");
const { endShares, discardShares, fileKeys } = require("../modules/shares/shares.service");
const { queueWeeklySummaries } = require("../modules/notifications/weeklySummary");

// Periodic jobs. With several worker instances, each sweep is guarded by a
// lock in Redis so only one instance runs it per interval.
//
//   every minute   end expired shares and discard abandoned uploads;
//                  re-queue file deletions and scans that seem to have been lost;
//                  once a week, queue the users' weekly summaries
//   every hour     delete stored files that no share references (orphans),
//                  and parts of uploads abandoned long ago (disk storage)

// Stored files younger than this may belong to an upload that hasn't been
// recorded yet, so the orphan sweep leaves them alone.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;
// A deletion still pending after this long probably lost its event.
const STUCK_DELETION_MS = 10 * 60 * 1000;
// Likewise a scan (or one that gave up while the scanner was down).
const STUCK_PROCESSING_MS = 10 * 60 * 1000;
const ORPHAN_SWEEP_EVERY_MS = 60 * 60 * 1000;

// Shares whose time is up: uploads never completed are discarded; the rest
// are ended (the cleanup worker then deletes their files).
const deleteExpiredShares = async () => {
    const expired = await Share.find(
        { endedAt: null, expiresAt: { $lte: new Date() } },
        { code: 1, files: 1, ownerId: 1, viewsRemaining: 1, uploadPending: 1 }
    ).lean();
    await discardShares(expired.filter((s) => s.uploadPending));
    await endShares(expired.filter((s) => !s.uploadPending));
    return expired.length;
};

// Self-healing: if a share.ended event was lost (e.g. the broker was down when
// it was published), publish it again.
const requeueStuckDeletions = async () => {
    const stuck = await Share.find(
        { filesState: "pending_deletion", endedAt: { $lte: new Date(Date.now() - STUCK_DELETION_MS) } },
        { code: 1, files: 1, ownerId: 1, endedReason: 1 }
    ).lean();
    for (const share of stuck) {
        await publish("share.ended", {
            shareId: String(share._id),
            code: share.code,
            ownerId: share.ownerId ? String(share.ownerId) : null,
            reason: share.endedReason,
            keys: fileKeys([share]),
            requeued: true,
        });
    }
    return stuck.length;
};

// Shares still waiting for their scan: the job was lost, or dead-lettered
// while the scanner was unreachable. Re-queued once the scanner is back.
const requeueStuckProcessing = async () => {
    const stuck = await Share.find(
        { processing: true, endedAt: null, updatedAt: { $lte: new Date(Date.now() - STUCK_PROCESSING_MS) } },
        { code: 1 }
    ).lean();
    if (stuck.length === 0 || (scanner.enabled() && (await scanner.health()) !== "up")) return 0;
    for (const share of stuck) {
        await publish("share.uploaded", { shareId: String(share._id), code: share.code, scan: true, requeued: true });
        // Restart the clock, so it isn't re-queued again while being scanned.
        await Share.updateOne({ _id: share._id }, { $currentDate: { updatedAt: true } });
    }
    return stuck.length;
};

// Deletes stored files that no share references (e.g. uploaded after their
// share was discarded). Files younger than `minAgeMs` are left alone.
const deleteOrphanFiles = async ({ minAgeMs = ORPHAN_MIN_AGE_MS } = {}) => {
    const live = { filesState: { $ne: "deleted" } };
    const referenced = new Set([
        ...(await Share.distinct("files.storedName", live)),
        ...(await Share.distinct("files.thumbnailKey", live)),
    ]);
    const cutoff = Date.now() - minAgeMs;
    const orphans = [];
    for await (const { key, modifiedAt } of storage.list()) {
        if (!referenced.has(key) && modifiedAt.getTime() < cutoff) orphans.push(key);
    }
    await storage.delete(orphans);
    return orphans.length;
};

const startScheduler = ({ locks, kv, log }) => {
    const sweep = () =>
        locks
            .runExclusive("sweep", config.cleanupIntervalMs, async () => {
                const ended = await deleteExpiredShares();
                const requeued = (await requeueStuckDeletions()) + (await requeueStuckProcessing());
                const summaries = await queueWeeklySummaries({ kv });
                if (ended || requeued || summaries) log.info({ event: "sweep.completed", ended, requeued, summaries }, "Sweep completed");
            })
            .catch((err) => log.error({ err, event: "sweep.failed" }, "Sweep failed"));

    const orphanSweep = () =>
        locks
            .runExclusive("orphan-sweep", ORPHAN_SWEEP_EVERY_MS, async () => {
                const removed = await deleteOrphanFiles();
                if (removed) log.info({ event: "sweep.orphans_removed", removed }, "Removed orphaned files");
                // No upload can still be going on after its maximum window.
                const aborted = (await storage.abortStaleUploads?.((config.maxUploadWindowSeconds + 3600) * 1000)) ?? 0;
                if (aborted) log.info({ event: "sweep.stale_uploads_aborted", aborted }, "Removed abandoned upload parts");
            })
            .catch((err) => log.error({ err, event: "sweep.failed" }, "Orphan sweep failed"));

    sweep();
    const timers = [setInterval(sweep, config.cleanupIntervalMs), setInterval(orphanSweep, ORPHAN_SWEEP_EVERY_MS)];
    timers.forEach((t) => t.unref());
    return () => timers.forEach(clearInterval);
};

module.exports = { deleteExpiredShares, requeueStuckDeletions, requeueStuckProcessing, deleteOrphanFiles, startScheduler };
