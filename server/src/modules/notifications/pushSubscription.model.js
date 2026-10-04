const mongoose = require("mongoose");

// A browser that agreed to receive push notifications for an account. The
// endpoint is the browser vendor's push service URL for that browser; the
// keys encrypt messages so only that browser can read them.
const pushSubscriptionSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
        endpoint: { type: String, required: true, unique: true },
        keys: {
            p256dh: { type: String, required: true },
            auth: { type: String, required: true },
        },
        // e.g. "Edge on Windows", to list where push is on
        deviceLabel: { type: String, default: null },
        lastSuccessAt: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("PushSubscription", pushSubscriptionSchema);
