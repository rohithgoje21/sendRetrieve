const mongoose = require("mongoose");

// One document per refresh token. Tokens are rotated on every use; all tokens
// descended from one login share a familyId, so if an already-used token is
// presented again (a sign it was stolen) the whole family can be revoked.
const refreshTokenSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    revokedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
});

refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RefreshToken", refreshTokenSchema);
