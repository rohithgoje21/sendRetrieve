const Share = require("../models/Share");
const { storage } = require("./storage");
const { endShares, discardShares } = require("./shares");
const log = require("./logger").logger.child({ component: "cleanup" });

// Files younger than this may belong to an upload that hasn't been recorded
// yet, so the orphan sweep leaves them alone.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

// Shares whose time is up:
//   - uploads never completed: discarded (files and record)
//   - everything else: ended; files and content deleted, guest shares removed,
//     owned shares kept (without content) in the owner's history
const deleteExpiredShares = async () => {
    const expired = await Share.find(
        { endedAt: null, expiresAt: { $lte: new Date() } },
        { code: 1, files: 1, ownerId: 1, viewsRemaining: 1, uploadPending: 1 }
    ).lean();
    await discardShares(expired.filter((s) => s.uploadPending));
    await endShares(expired.filter((s) => !s.uploadPending));
    return expired.length;
};

// Removes stored files that no live share (or upload in progress) references,
// e.g. left behind by the database's TTL backstop or an upload to a share that
// was already discarded. Files younger than `minAgeMs` are left alone.
const deleteOrphanFiles = async ({ minAgeMs = ORPHAN_MIN_AGE_MS } = {}) => {
    const referenced = new Set(await Share.distinct("files.storedName", { endedAt: null }));
    const cutoff = Date.now() - minAgeMs;
    const orphans = [];
    for await (const { key, modifiedAt } of storage.list()) {
        if (!referenced.has(key) && modifiedAt.getTime() < cutoff) orphans.push(key);
    }
    await storage.delete(orphans);
    return orphans.length;
};

const runCleanup = async () => {
    const shares = await deleteExpiredShares();
    const orphans = await deleteOrphanFiles();
    if (shares || orphans) {
        log.info({ event: "cleanup.completed", sharesEnded: shares, orphanFilesRemoved: orphans }, "Cleanup completed");
    }
};

const startCleanupJob = (intervalMs) => {
    const tick = () => runCleanup().catch((err) => log.error({ err, event: "cleanup.failed" }, "Cleanup failed"));
    tick();
    return setInterval(tick, intervalMs).unref();
};

module.exports = { deleteExpiredShares, deleteOrphanFiles, runCleanup, startCleanupJob };
