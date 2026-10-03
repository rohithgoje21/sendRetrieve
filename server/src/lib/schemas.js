const { z } = require("zod");
const config = require("../config");

const { limits, auth } = config;

// Forms may send "" for empty fields; treat that as "not provided".
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
const maxFileMb = Math.round(limits.maxFileSize / 1024 / 1024);

// What the browser tells us about a file before uploading it. The size is
// enforced by storage (it's part of the signed upload URL) and re-checked
// after upload; the type is replaced by the type detected from the contents.
const fileInput = z.object({
    name: z.string({ error: "Each file needs a name" }).trim().min(1, "Each file needs a name").max(1000),
    size: z
        .number({ error: "Each file needs a size" })
        .int()
        .min(0)
        .max(limits.maxFileSize, `Each file must be ${maxFileMb} MB or smaller`),
    type: z.string().max(255).optional().default(""),
});

const createShare = z.object({
    text: optionalField(
        z
            .string()
            .max(limits.maxTextLength, `Text must be ${limits.maxTextLength.toLocaleString()} characters or fewer`)
            .nullable()
            .optional()
    ).transform((t) => (t && t.trim() ? t : null)),
    expiresIn: optionalField(
        z.enum(expiryKeys, { error: `expiresIn must be one of: ${expiryKeys.join(", ")}` }).default(config.defaultExpiry)
    ),
    // null, "unlimited", or one of the allowed limits (number or numeric string)
    maxViews: z
        .preprocess(
            (v) => (v === "" || v === "unlimited" || v === undefined ? null : typeof v === "string" ? Number(v) : v),
            z.number().int().nullable()
        )
        .refine((v) => v === null || config.viewLimitOptions.includes(v), {
            message: `maxViews must be one of: unlimited, ${config.viewLimitOptions.join(", ")}`,
        }),
    password: optionalField(
        z
            .string()
            .min(limits.minPasswordLength, `Password must be ${limits.minPasswordLength}-${limits.maxPasswordLength} characters`)
            .max(limits.maxPasswordLength, `Password must be ${limits.minPasswordLength}-${limits.maxPasswordLength} characters`)
            .nullable()
            .optional()
    ).transform((p) => p ?? null),
    files: z
        .array(fileInput)
        .max(limits.maxFiles, `You can send up to ${limits.maxFiles} files at once`)
        .default([]),
});

const manageShare = z.object({ manageToken: requiredString("Manage token") });

const verifyEmail = z.object({
    code: z
        .string({ error: "Enter the code from the email" })
        .trim()
        .regex(new RegExp(`^\\d{${config.otp.length}}$`), `Enter the ${config.otp.length}-digit code from the email`),
});

const adminUpdateUser = z
    .object({
        role: z.enum(["user", "admin"], { error: "role must be user or admin" }).optional(),
        disabled: z.boolean({ error: "disabled must be true or false" }).optional(),
    })
    .refine((v) => v.role !== undefined || v.disabled !== undefined, { message: "Nothing to change" });

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
    manageShare,
    verifyEmail,
    adminUpdateUser,
    openShare,
    register,
    login,
    forgotPassword,
    resetPassword,
    updateProfile,
    changePassword,
    deleteAccount,
};
