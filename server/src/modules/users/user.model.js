const mongoose = require("mongoose");
const { ROLES, permissionsFor } = require("../auth/permissions");

const userSchema = new mongoose.Schema(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        name: { type: String, required: true, trim: true },
        passwordHash: { type: String, required: true },
        role: { type: String, enum: ROLES, default: "user" },
        // Set once the user proves they own the address (one-time code by email).
        emailVerifiedAt: { type: Date, default: null },
        // Disabled accounts can't log in; their sessions are revoked.
        disabledAt: { type: Date, default: null },
        // Embedded in access tokens; bumping it (on password change/reset or
        // when disabling) invalidates every access token issued before.
        sessionVersion: { type: Number, default: 0 },
        passwordResetTokenHash: { type: String, default: null },
        passwordResetExpiresAt: { type: Date, default: null },
    },
    { timestamps: true }
);

userSchema.methods.toPublic = function () {
    return {
        id: this._id,
        email: this.email,
        name: this.name,
        role: this.role ?? "user",
        // What the role allows (the client shows or hides features with it)
        permissions: permissionsFor(this.role ?? "user"),
        emailVerified: Boolean(this.emailVerifiedAt),
        createdAt: this.createdAt,
    };
};

module.exports = mongoose.model("User", userSchema);
module.exports.ROLES = ROLES;
