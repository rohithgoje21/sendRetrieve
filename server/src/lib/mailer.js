const config = require("../config");
const { logger } = require("./logger");

// Sends email through Resend's HTTP API. Without RESEND_API_KEY the message is
// written to the log instead, which is enough for local development (the
// server warns about this at startup in production).
const sendMail = async ({ to, subject, text, html }) => {
    if (!config.email.resendApiKey) {
        logger.info({ event: "email.logged", to, subject }, `Email not sent (no RESEND_API_KEY):\n${text}`);
        return;
    }

    const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.email.resendApiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: config.email.from, to, subject, text, html }),
    });
    if (!res.ok) {
        throw new Error(`Resend returned ${res.status}: ${await res.text()}`);
    }
};

const escapeHtml = (s) =>
    s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const sendPasswordResetEmail = (user, link) => {
    const minutes = Math.round(config.auth.passwordResetTtlSeconds / 60);
    return module.exports.sendMail({
        to: user.email,
        subject: "Reset your sendRetrieve password",
        text:
            `Hi ${user.name},\n\n` +
            `Someone asked to reset the password for your sendRetrieve account.\n` +
            `Open this link to choose a new one (it works for ${minutes} minutes):\n\n${link}\n\n` +
            `If you didn't ask for this, you can ignore this email.`,
        html:
            `<p>Hi ${escapeHtml(user.name)},</p>` +
            `<p>Someone asked to reset the password for your sendRetrieve account.</p>` +
            `<p><a href="${escapeHtml(link)}">Choose a new password</a> (this link works for ${minutes} minutes).</p>` +
            `<p>If you didn't ask for this, you can ignore this email.</p>`,
    });
};

const sendVerificationEmail = (user, code, expiresInSeconds) => {
    const minutes = Math.round(expiresInSeconds / 60);
    return module.exports.sendMail({
        to: user.email,
        subject: `${code} is your sendRetrieve verification code`,
        text:
            `Hi ${user.name},\n\n` +
            `Your sendRetrieve verification code is: ${code}\n\n` +
            `It works for ${minutes} minutes. If you didn't create an account, you can ignore this email.`,
        html:
            `<p>Hi ${escapeHtml(user.name)},</p>` +
            `<p>Your sendRetrieve verification code is:</p>` +
            `<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${code}</p>` +
            `<p>It works for ${minutes} minutes. If you didn't create an account, you can ignore this email.</p>`,
    });
};

module.exports = { sendMail, sendPasswordResetEmail, sendVerificationEmail };
