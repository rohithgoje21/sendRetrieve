const Share = require("../models/Share");
const { deleteFiles, listStoredFiles } = require("./storage");
const { endShares } = require("./shares");

// Files younger than this may belong to an upload that hasn't been saved to
// the database yet, so the orphan sweep leaves them alone.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

// Ends shares whose time is up: files and content are deleted; guest shares
// disappear entirely, owned shares stay in the owner's history.
const deleteExpiredShares = async () => {
    const expired = await Share.find(
        { endedAt: null, expiresAt: { $lte: new Date() } },
        { files: 1, ownerId: 1, viewsRemaining: 1 }
    ).lean();
    await endShares(expired);
    return expired.length;
};

// Removes files on disk that no live share references (e.g. left behind by
// the TTL backstop or a crashed upload).
const deleteOrphanFiles = async () => {
    const referenced = new Set(await Share.distinct("files.storedName", { endedAt: null }));
    const cutoff = Date.now() - ORPHAN_MIN_AGE_MS;
    const orphans = (await listStoredFiles())
        .filter((f) => !referenced.has(f.name) && f.modifiedAt.getTime() < cutoff)
        .map((f) => f.name);
    await deleteFiles(orphans);
    return orphans.length;
};

const runCleanup = async () => {
    const shares = await deleteExpiredShares();
    const orphans = await deleteOrphanFiles();
    if (shares || orphans) {
        console.log(`Cleanup: ended ${shares} expired share(s), removed ${orphans} orphan file(s)`);
    }
};

const startCleanupJob = (intervalMs) => {
    const tick = () => runCleanup().catch((err) => console.error("Cleanup failed:", err));
    tick();
    return setInterval(tick, intervalMs).unref();
};

module.exports = { deleteExpiredShares, deleteOrphanFiles, runCleanup, startCleanupJob };
