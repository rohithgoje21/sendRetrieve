// Shared by every page: DOM helpers, the API client and the site nav.

const $ = (id) => document.getElementById(id);

const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};

const formatSize = (bytes) => {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
};

const formatDate = (iso) =>
    new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

// "7KX92PMQ" -> "7KX9-2PMQ" for display; the server accepts either form.
const formatCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;

const showError = (node, message) => {
    node.textContent = message;
    node.hidden = !message;
};

const setBusy = (button, busy, busyLabel) => {
    if (busy) {
        button.dataset.label = button.textContent;
        button.textContent = busyLabel;
    } else if (button.dataset.label) {
        button.textContent = button.dataset.label;
    }
    button.disabled = busy;
};

/* ---------- API client ---------- */

// Concurrent requests that all hit an expired token share one refresh.
let refreshing = null;
const refreshSession = () =>
    (refreshing ??= fetch("/api/auth/refresh", { method: "POST" })
        .then((res) => res.ok)
        .catch(() => false)
        .finally(() => (refreshing = null)));

class ApiError extends Error {
    constructor(message, status, data) {
        super(message);
        this.status = status;
        this.data = data;
    }
}

// JSON request. Refreshes the session once if the access token has expired.
const api = async (path, { method = "GET", body, retry = true } = {}) => {
    let res;
    try {
        res = await fetch(path, {
            method,
            headers: body === undefined ? {} : { "Content-Type": "application/json" },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    } catch {
        throw new ApiError("Network error. Check your connection.", 0, {});
    }
    const data = res.status === 204 ? {} : await res.json().catch(() => ({}));

    if (res.status === 401 && data.code === "token_expired" && retry) {
        await refreshSession();
        return api(path, { method, body, retry: false });
    }
    if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
    return data;
};

/* ---------- Session & nav ---------- */

const renderNav = (user) => {
    const nav = $("siteNav");
    if (!nav) return;
    const link = (href, text) =>
        el("a", { href, textContent: text, className: location.pathname === href ? "active" : "" });

    if (user) {
        const logout = el("button", { type: "button", className: "nav-button", textContent: "Log out" });
        logout.addEventListener("click", async () => {
            await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
            location.href = "/";
        });
        const account = link("/account", user.name);
        account.classList.add("nav-user");
        account.title = user.email;
        nav.replaceChildren(link("/shares", "My shares"), account, logout);
    } else {
        nav.replaceChildren(link("/login", "Log in"), link("/signup", "Sign up"));
    }
};

const loadUser = async () => {
    try {
        return (await api("/api/auth/me")).user;
    } catch {
        return null;
    }
};

const session = {
    user: null,
    ready: loadUser().then((user) => {
        session.user = user;
        renderNav(user);
        return user;
    }),
};

// Only same-site paths, so ?next= can't send people to another site.
const safeNext = (fallback = "/shares") => {
    const next = new URLSearchParams(location.search).get("next");
    return next && next.startsWith("/") && !next.startsWith("//") ? next : fallback;
};

const requireLogin = async () => {
    const user = await session.ready;
    if (!user) {
        location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
        return new Promise(() => {}); // stop the page while redirecting
    }
    return user;
};

/* ---------- Copy buttons ---------- */

// <button data-copy="elementId"> copies that element's value or text.
// <button data-copy-text="..."> copies the given text.
document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy], [data-copy-text]");
    if (!button) return;
    let value = button.dataset.copyText;
    if (value === undefined) {
        const source = $(button.dataset.copy);
        value = source.value ?? source.textContent;
    }
    try {
        await navigator.clipboard.writeText(value);
        const label = button.textContent;
        button.textContent = "Copied!";
        setTimeout(() => (button.textContent = label), 1200);
    } catch (err) {
        console.error("Failed to copy:", err);
    }
});
