// Email templates: template name + data -> { subject, text, html }.
// Requests ask for an email by template name (see emails.js); the
// notification worker renders and sends it.

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const formatTime = (iso) =>
    new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

const templates = {
    "new-device-login": ({ name, device, ipHint, at, accountUrl }) => ({
        subject: "New login to your sendRetrieve account",
        text:
            `Hi ${name},\n\n` +
            `Your account was just logged in to from a device it hasn't used before:\n\n` +
            `  ${device}${ipHint ? ` (network ${ipHint})` : ""}\n  ${formatTime(at)}\n\n` +
            `If this was you, there's nothing to do. If not, change your password and log out the devices you don't recognize:\n\n${accountUrl}`,
        html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Your account was just logged in to from a device it hasn't used before:</p>` +
            `<p><strong>${escapeHtml(device)}</strong>${ipHint ? ` (network ${escapeHtml(ipHint)})` : ""}<br>${escapeHtml(formatTime(at))}</p>` +
            `<p>If this was you, there's nothing to do. If not, <a href="${escapeHtml(accountUrl)}">change your password and log out the devices you don't recognize</a>.</p>`,
    }),

    "password-reset": ({ name, link, minutes }) => ({
        subject: "Reset your sendRetrieve password",
        text:
            `Hi ${name},\n\n` +
            `Someone asked to reset the password for your sendRetrieve account.\n` +
            `Open this link to choose a new one (it works for ${minutes} minutes):\n\n${link}\n\n` +
            `If you didn't ask for this, you can ignore this email.`,
        html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Someone asked to reset the password for your sendRetrieve account.</p>` +
            `<p><a href="${escapeHtml(link)}">Choose a new password</a> (this link works for ${minutes} minutes).</p>` +
            `<p>If you didn't ask for this, you can ignore this email.</p>`,
    }),

    "verify-email": ({ name, code, minutes }) => ({
        subject: `${code} is your sendRetrieve verification code`,
        text:
            `Hi ${name},\n\n` +
            `Your sendRetrieve verification code is: ${code}\n\n` +
            `It works for ${minutes} minutes. If you didn't create an account, you can ignore this email.`,
        html:
            `<p>Hi ${escapeHtml(name)},</p>` +
            `<p>Your sendRetrieve verification code is:</p>` +
            `<p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${escapeHtml(code)}</p>` +
            `<p>It works for ${minutes} minutes. If you didn't create an account, you can ignore this email.</p>`,
    }),
};

const renderEmail = (template, data) => {
    const render = templates[template];
    if (!render) throw new Error(`Unknown email template "${template}"`);
    return render(data);
};

module.exports = { renderEmail, escapeHtml, templates };
