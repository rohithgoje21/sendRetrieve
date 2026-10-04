const { recordView, recordDownload, recordShareCreated } = require("../modules/analytics/analytics.service");

// sr.analytics: daily statistics per share and for the whole site, from
// share.created, share.opened and file.downloaded events. Each event counts
// on the day it happened (not when it was processed), so a backlog or a retry
// lands on the right day. Redelivered messages are skipped by the job wrapper
// (workers/index.js).
const handle = async (message) => {
    const data = { ...message.data, at: new Date(message.occurredAt) };
    switch (message.type) {
        case "share.opened":
            return recordView(data);
        case "file.downloaded":
            return recordDownload(data);
        case "share.created":
            return recordShareCreated(data);
        default:
    }
};

module.exports = { queue: "sr.analytics", handle };
