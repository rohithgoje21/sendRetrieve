const { z } = require("zod");
const config = require("../../config");
const { optionalField, requiredString } = require("../../shared/schemas");

const { limits } = config;
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

const openShare = z.object({
    password: z.string().max(limits.maxPasswordLength).optional(),
});

module.exports = { createShare, manageShare, openShare };
