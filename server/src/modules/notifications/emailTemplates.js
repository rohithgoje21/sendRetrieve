// Email templates: template name + data -> { subject, text, html }.
// Requests ask for an email by template name (see emails.js); the
// notification worker renders and sends it.

const escapeHtml = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const formatTime = (iso) =>
    new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Notification emails: a few paragraphs, a link to act on, and a footer to
// turn this kind of email off. `paragraphs` are plain text.
const notificationEmail = ({ subject, name, paragraphs, action, unsubscribeUrl }) => ({
    subject,
    text:
        `Hi ${name},\n\n` +
        paragraphs.join("\n\n") +
        (action ? `\n\n${action.label}: ${action.url}` : "") +
        (unsubscribeUrl ? `\n\n--\nDon't want these emails? ${unsubscribeUrl}` : ""),
    html:
        `<p>Hi ${escapeHtml(name)},</p>` +
        paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("") +
        (action ? `<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>` : "") +
        (unsubscribeUrl
            ? `<hr><p style="color:#71717a;font-size:12px">Don't want these emails? <a href="${escapeHtml(unsubscribeUrl)}">Turn them off</a>.</p>`
            : ""),
});

const ENDED = {
    expired: (code) => [`Share ${code} expired`, "Its time ran out, and its files have been deleted."],
    used_up: (code) => [`Share ${code} was used up`, "It reached its view limit, and its files have been deleted."],
    removed: (code) => [
        `Share ${code} was removed by an administrator`,
        "It no longer works, and its files have been deleted. If you think this is a mistake, contact the site's administrator.",
    ],
};

const templates = {
    "new-device-login": ({ name, device, ipHint, at, accountUrl, unsubscribeUrl }) =>
        notificationEmail({
            subject: "New login to your sendRetrieve account",
            name,
            paragraphs: [
                "Your account was just logged in to from a device it hasn't used before:",
                `${device}${ipHint ? ` (network ${ipHint})` : ""}, ${formatTime(at)}`,
                "If this was you, there's nothing to do. If not, change your password and log out the devices you don't recognize.",
            ],
            action: { label: "Review your devices", url: accountUrl },
            unsubscribeUrl,
        }),

    "file-downloaded": ({ name, fileName, code, downloads, sharesUrl, unsubscribeUrl }) =>
        notificationEmail({
            subject: `"${fileName}" was downloaded`,
            name,
            paragraphs: [
                `"${fileName}" from your share ${code} was just downloaded (${plural(downloads, "download")} so far).`,
                "You'll get at most one email an hour about each share.",
            ],
            action: { label: "See your shares", url: sharesUrl },
            unsubscribeUrl,
        }),

    "share-ended": ({ name, code, reason, sharesUrl, unsubscribeUrl }) => {
        const [subject, detail] = ENDED[reason](code);
        return notificationEmail({ subject, name, paragraphs: [`${subject}. ${detail}`], action: { label: "See your shares", url: sharesUrl }, unsubscribeUrl });
    },

    "share-blocked": ({ name, code, fileName, signature, sharesUrl, unsubscribeUrl }) =>
        notificationEmail({
            subject: `Share ${code} was blocked: malware found`,
            name,
            paragraphs: [
                `The virus scanner found malware in "${fileName}" (${signature}), a file in your share ${code}.`,
                "The share was removed and its files deleted, so nobody can download them. If you didn't expect this file to be infected, scan the computer it came from.",
            ],
            action: { label: "See your shares", url: sharesUrl },
            unsubscribeUrl,
        }),

    "weekly-summary": ({ name, sharesCreated, views, downloads, activeShares, sharesUrl, unsubscribeUrl }) =>
        notificationEmail({
            subject: "Your week on sendRetrieve",
            name,
            paragraphs: [
                sharesCreated
                    ? `This week you created ${plural(sharesCreated, "share")}: opened ${plural(views, "time")}, with ${downloads ? plural(downloads, "download") : "no downloads yet"}.`
                    : "You didn't create any shares this week.",
                activeShares ? `${plural(activeShares, "share")} ${activeShares === 1 ? "is" : "are"} still active.` : "None of your shares are active right now.",
            ],
            action: { label: "See your shares", url: sharesUrl },
            unsubscribeUrl,
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
