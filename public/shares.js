// "My shares" dashboard. Helpers come from common.js.

const EMPTY_MESSAGES = {
    active: "No active shares. Anything you send while logged in shows up here.",
    expired: "No expired shares.",
    deleted: "No deleted shares.",
};

const ENDED_LABELS = { used_up: "Used up", expired: "Expired", deleted: "Deleted" };

const state = { status: "active", page: 1 };

const statusBadge = (share) => {
    const label = share.status === "active"
        ? (share.endedReason === "used_up" ? "Used up" : "Active")
        : ENDED_LABELS[share.endedReason] || "Expired";
    return el("span", { className: `badge badge-${share.status}`, textContent: label });
};

const viewsSummary = (share) => {
    const views = `${share.views} ${share.views === 1 ? "view" : "views"}`;
    if (share.maxViews === null) return views;
    return `${views} of ${share.maxViews}`;
};

const summaryLine = (share) => {
    const parts = [];
    if (share.files.length) {
        parts.push(`${share.files.length} ${share.files.length === 1 ? "file" : "files"} · ${formatSize(share.totalSize)}`);
    }
    if (share.status === "active" && share.hasText) parts.push("Message");
    const downloads = share.files.reduce((sum, f) => sum + f.downloads, 0);
    parts.push(viewsSummary(share));
    if (share.files.length) parts.push(`${downloads} ${downloads === 1 ? "download" : "downloads"}`);
    if (share.passwordProtected) parts.push("Password");
    return parts.join(" · ");
};

const datesLine = (share) => {
    const created = `Created ${formatDate(share.createdAt)}`;
    if (share.status === "active") return `${created} · Expires ${formatDate(share.expiresAt)}`;
    return `${created} · Ended ${formatDate(share.endedAt || share.expiresAt)}`;
};

const renderDetail = (container, share, downloadWindowSeconds) => {
    const children = [];
    if (share.text) {
        children.push(
            el("div", { className: "result-header" }, [
                el("p", { className: "label", textContent: "Message" }),
                el("button", { type: "button", className: "secondary small", textContent: "Copy" }),
            ]),
            el("pre", { className: "retrieved-text", textContent: share.text })
        );
        children[0].querySelector("button").dataset.copyText = share.text;
    }
    if (share.files.length) {
        children.push(
            el("p", { className: "label", textContent: "Files" }),
            el(
                "ul",
                { className: "retrieved-files" },
                share.files.map((file) =>
                    el("li", {}, [
                        el("div", { className: "file-row" }, [
                            el("span", { className: "file-name", textContent: file.name, title: file.name }),
                            el("span", { className: "file-size", textContent: `${formatSize(file.size)} · ${file.downloads} ↓` }),
                            el("a", { href: file.downloadUrl, className: "download", textContent: "Download" }),
                        ]),
                    ])
                )
            ),
            el("p", {
                className: "hint",
                textContent: `Viewing your own share doesn't count as a view. Download links work for ${Math.round(downloadWindowSeconds / 60)} minutes.`,
            })
        );
    }
    container.replaceChildren(...children);
};

const renderShare = (share) => {
    const actions = el("div", { className: "share-actions" });
    const detail = el("div", { className: "share-detail", hidden: true });
    const item = el("li", { className: "share-item" }, [
        el("div", { className: "share-top" }, [
            el("code", { className: "share-code small", textContent: formatCode(share.code) }),
            statusBadge(share),
        ]),
        ...(share.textPreview
            ? [el("p", { className: "share-preview", textContent: share.textPreview })]
            : []),
        ...(share.files.length
            ? [el("p", { className: "share-files", textContent: share.files.map((f) => f.name).join(", ") })]
            : []),
        el("p", { className: "meta", textContent: summaryLine(share) }),
        el("p", { className: "meta", textContent: datesLine(share) }),
        actions,
        detail,
    ]);

    const button = (label, className, onClick) => {
        const b = el("button", { type: "button", className, textContent: label });
        b.addEventListener("click", () => onClick(b));
        actions.append(b);
        return b;
    };

    if (share.status === "active") {
        actions.append(el("button", { type: "button", className: "secondary small", textContent: "Copy link" }));
        actions.lastChild.dataset.copyText = share.url;

        button("View", "secondary small", async (b) => {
            if (!detail.hidden) {
                detail.hidden = true;
                b.textContent = "View";
                return;
            }
            setBusy(b, true, "Loading…");
            try {
                const res = await api(`/api/me/shares/${share.code}`);
                renderDetail(detail, res.share, res.downloadWindowSeconds);
                detail.hidden = false;
                setBusy(b, false);
                b.textContent = "Hide";
            } catch (err) {
                setBusy(b, false);
                alert(err.message);
            }
        });

        button("Delete", "danger small", async (b) => {
            if (!confirm(`Delete share ${formatCode(share.code)}? It stops working immediately and its files are removed.`)) return;
            await removeShare(b, share);
        });
    } else {
        button("Remove from list", "secondary small", (b) => removeShare(b, share));
    }

    return item;
};

const removeShare = async (button, share) => {
    setBusy(button, true, "Removing…");
    try {
        await api(`/api/me/shares/${share.code}`, { method: "DELETE" });
        await load({ reset: true });
    } catch (err) {
        setBusy(button, false);
        alert(err.message);
    }
};

const load = async ({ reset = false } = {}) => {
    if (reset) state.page = 1;
    showError($("listError"), "");
    try {
        const res = await api(`/api/me/shares?status=${state.status}&page=${state.page}`);
        const items = res.shares.map(renderShare);
        if (reset || state.page === 1) $("shareList").replaceChildren(...items);
        else $("shareList").append(...items);

        for (const [status, count] of Object.entries(res.counts)) {
            document.querySelector(`[data-count="${status}"]`).textContent = count;
        }
        const empty = $("shareList").children.length === 0;
        $("emptyState").textContent = EMPTY_MESSAGES[state.status];
        $("emptyState").hidden = !empty;
        $("loadMore").hidden = !res.hasMore;
        $("retentionNote").hidden = state.status === "active" || empty;
    } catch (err) {
        showError($("listError"), err.message);
    }
};

document.querySelectorAll(".tab[data-status]").forEach((tab) =>
    tab.addEventListener("click", () => {
        document.querySelectorAll(".tab[data-status]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
        state.status = tab.dataset.status;
        load({ reset: true });
    })
);

$("loadMore").addEventListener("click", () => {
    state.page += 1;
    load();
});

requireLogin().then(() => load({ reset: true }));
