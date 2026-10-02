const { z } = require("zod");
const config = require("../config");

const { limits, auth } = config;

// Multipart forms send "" for empty fields; treat that as "not provided".
const optionalField = (schema) => z.preprocess((v) => (v === "" ? undefined : v), schema);

const email = z
    .string({ error: "Email is required" })
    .trim()
    .toLowerCase()
    .max(254, "Email is too long")
    .pipe(z.email("Enter a valid email address"));

const accountPassword = z
    .string({ error: "Password is required" })
    .min(auth.minPasswordLength, `Password must be at least ${auth.minPasswordLength} characters`)
    .max(auth.maxPasswordLength, `Password must be ${auth.maxPasswordLength} characters or fewer`);

const name = z
    .string({ error: "Name is required" })
    .trim()
    .min(1, "Name is required")
    .max(auth.maxNameLength, `Name must be ${auth.maxNameLength} characters or fewer`);

const requiredString = (label) => z.string({ error: `${label} is required` }).min(1, `${label} is required`);

const expiryKeys = Object.keys(config.expiryOptions);
const viewLimitKeys = ["unlimited", ...config.viewLimitOptions.map(String)];

const createShare = z.object({
    text: optionalField(
        z
            .string()
            .max(limits.maxTextLength, `Text must be ${limits.maxTextLength.toLocaleString()} characters or fewer`)
            .optional()
    ).transform((t) => (t && t.trim() ? t : null)),
    expiresIn: optionalField(
        z.enum(expiryKeys, { error: `expiresIn must be one of: ${expiryKeys.join(", ")}` }).default(config.defaultExpiry)
    ),
    maxViews: optionalField(
        z.enum(viewLimitKeys, { error: `maxViews must be one of: ${viewLimitKeys.join(", ")}` }).default("unlimited")
    ).transform((v) => (v === "unlimited" ? null : Number(v))),
    password: optionalField(
        z
            .string()
            .min(limits.minPasswordLength, `Password must be ${limits.minPasswordLength}-${limits.maxPasswordLength} characters`)
            .max(limits.maxPasswordLength, `Password must be ${limits.minPasswordLength}-${limits.maxPasswordLength} characters`)
            .optional()
    ).transform((p) => p ?? null),
});

const openShare = z.object({
    password: z.string().max(limits.maxPasswordLength).optional(),
});

const register = z.object({ name, email, password: accountPassword });
const login = z.object({ email, password: requiredString("Password") });
const forgotPassword = z.object({ email });
const resetPassword = z.object({ token: requiredString("Reset token"), password: accountPassword });
const updateProfile = z.object({ name });
const changePassword = z.object({ currentPassword: requiredString("Current password"), newPassword: accountPassword });
const deleteAccount = z.object({ password: requiredString("Password") });

module.exports = {
    createShare,
    openShare,
    register,
    login,
    forgotPassword,
    resetPassword,
    updateProfile,
    changePassword,
    deleteAccount,
};
