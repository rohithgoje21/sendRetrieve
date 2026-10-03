const { z } = require("zod");
const config = require("../config");

// Field schemas shared by several modules. Each module defines its request
// schemas next to its routes (e.g. modules/shares/shares.schemas.js).

const { auth } = config;

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

module.exports = { optionalField, email, accountPassword, name, requiredString };
