const Share = require("../models/Share");
const { deleteFiles, listStoredFiles } = require("./storage");

// Files younger than this may belong to an upload that hasn't been saved to
// the database yet, so the orphan sweep leaves them alone.
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

const deleteExpiredShares = async () => {
    const expired = await Share.find({ expiresAt: { $lte: new Date() } }, { files: 1 }).lean();
    if (expired.length === 0) return 0;

    await deleteFiles(expired.flatMap((s) => s.files.map((f) => f.storedName)));
    await Share.deleteMany({ _id: { $in: expired.map((s) => s._id) } });
    return expired.length;
};

// Removes files on disk that no share references (e.g. left behind by the TTL
// backstop or a crashed upload).
const deleteOrphanFiles = async () => {
    const referenced = new Set(await Share.distinct("files.storedName"));
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
        console.log(`Cleanup: removed ${shares} expired share(s), ${orphans} orphan file(s)`);
    }
};

const startCleanupJob = (intervalMs) => {
    const tick = () => runCleanup().catch((err) => console.error("Cleanup failed:", err));
    tick();
    return setInterval(tick, intervalMs).unref();
};

module.exports = { deleteExpiredShares, deleteOrphanFiles, runCleanup, startCleanupJob };
