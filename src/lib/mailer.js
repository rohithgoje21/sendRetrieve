const config = require("../config");

// Sends email through Resend's HTTP API. Without RESEND_API_KEY the message is
// printed to the console instead, which is enough for local development.
const sendMail = async ({ to, subject, text, html }) => {
    if (!config.email.resendApiKey) {
        console.log(`\n[email] To: ${to}\n[email] Subject: ${subject}\n${text}\n`);
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

module.exports = { sendMail, sendPasswordResetEmail };
