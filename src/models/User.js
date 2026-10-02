const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        name: { type: String, required: true, trim: true },
        passwordHash: { type: String, required: true },
        // Embedded in access tokens; bumping it (on password change/reset)
        // invalidates every access token issued before.
        sessionVersion: { type: Number, default: 0 },
        passwordResetTokenHash: { type: String, default: null },
        passwordResetExpiresAt: { type: Date, default: null },
    },
    { timestamps: true }
);

userSchema.methods.toPublic = function () {
    return { id: this._id, email: this.email, name: this.name, createdAt: this.createdAt };
};

module.exports = mongoose.model("User", userSchema);
