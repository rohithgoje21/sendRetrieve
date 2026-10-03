const { z } = require("zod");
const config = require("../../config");
const { email, accountPassword, name, requiredString } = require("../../shared/schemas");

const register = z.object({ name, email, password: accountPassword });
const login = z.object({ email, password: requiredString("Password") });
const forgotPassword = z.object({ email });
const resetPassword = z.object({ token: requiredString("Reset token"), password: accountPassword });

const verifyEmail = z.object({
    code: z
        .string({ error: "Enter the code from the email" })
        .trim()
        .regex(new RegExp(`^\\d{${config.otp.length}}$`), `Enter the ${config.otp.length}-digit code from the email`),
});

module.exports = { register, login, forgotPassword, resetPassword, verifyEmail };
