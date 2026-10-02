const MAX_FILES = 10;
const MAX_FILE_SIZE = 50 * 1024 * 1024;

const $ = (id) => document.getElementById(id);

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

const showError = (el, message) => {
    el.textContent = message;
    el.hidden = !message;
};

const el = (tag, props = {}, children = []) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children);
    return node;
};

/* ---------- Tabs ---------- */

const tabs = { send: $("tab-send"), retrieve: $("tab-retrieve") };
const panels = { send: $("panel-send"), retrieve: $("panel-retrieve") };

const selectTab = (name) => {
    for (const key of Object.keys(tabs)) {
        const active = key === name;
        tabs[key].setAttribute("aria-selected", String(active));
        panels[key].hidden = !active;
    }
};

tabs.send.addEventListener("click", () => selectTab("send"));
tabs.retrieve.addEventListener("click", () => selectTab("retrieve"));

/* ---------- Copy buttons ---------- */

document.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-copy]");
    if (!button) return;
    const source = $(button.dataset.copy);
    const value = source.value ?? source.textContent;
    try {
        await navigator.clipboard.writeText(value);
        const label = button.textContent;
        button.textContent = "Copied!";
        setTimeout(() => (button.textContent = label), 1200);
    } catch (err) {
        console.error("Failed to copy:", err);
    }
});

/* ---------- Send ---------- */

let selectedFiles = [];

$("maxFiles").textContent = MAX_FILES;
$("maxSize").textContent = formatSize(MAX_FILE_SIZE);

const renderFileList = () => {
    const list = $("fileList");
    list.replaceChildren(
        ...selectedFiles.map((file, index) => {
            const remove = el("button", {
                type: "button",
                className: "remove",
                textContent: "×",
                title: `Remove ${file.name}`,
            });
            remove.setAttribute("aria-label", `Remove ${file.name}`);
            remove.addEventListener("click", () => {
                selectedFiles.splice(index, 1);
                renderFileList();
            });
            return el("li", {}, [
                el("span", { className: "file-name", textContent: file.name, title: file.name }),
                el("span", { className: "file-size", textContent: formatSize(file.size) }),
                remove,
            ]);
        })
    );
};

const addFiles = (files) => {
    const errors = [];
    for (const file of files) {
        if (selectedFiles.length >= MAX_FILES) {
            errors.push(`You can send up to ${MAX_FILES} files.`);
            break;
        }
        if (file.size > MAX_FILE_SIZE) {
            errors.push(`${file.name} is larger than ${formatSize(MAX_FILE_SIZE)}.`);
            continue;
        }
        selectedFiles.push(file);
    }
    showError($("sendError"), errors.join(" "));
    renderFileList();
};

const dropzone = $("dropzone");
const fileInput = $("fileInput");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        fileInput.click();
    }
});
fileInput.addEventListener("change", () => {
    addFiles([...fileInput.files]);
    fileInput.value = "";
});
["dragenter", "dragover"].forEach((type) =>
    dropzone.addEventListener(type, (e) => {
        e.preventDefault();
        dropzone.classList.add("dragging");
    })
);
["dragleave", "drop"].forEach((type) =>
    dropzone.addEventListener(type, () => dropzone.classList.remove("dragging"))
);
dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    addFiles([...e.dataTransfer.files]);
});

// XHR instead of fetch so we get upload progress events.
const uploadShare = (formData, onProgress) =>
    new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/shares");
        xhr.responseType = "json";
        xhr.upload.addEventListener("progress", (e) => {
            if (e.lengthComputable) onProgress(e.loaded, e.total);
        });
        xhr.addEventListener("load", () => {
            const body = xhr.response || {};
            if (xhr.status >= 200 && xhr.status < 300) resolve(body);
            else reject(new Error(body.error || `Upload failed (${xhr.status})`));
        });
        xhr.addEventListener("error", () => reject(new Error("Network error. Check your connection.")));
        xhr.send(formData);
    });

$("sendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = $("textInput").value;
    const password = $("sendPassword").value;
    const errorEl = $("sendError");

    if (!text.trim() && selectedFiles.length === 0) {
        return showError(errorEl, "Add a message or at least one file.");
    }
    if (password && password.length < 4) {
        return showError(errorEl, "Password must be at least 4 characters.");
    }
    showError(errorEl, "");

    const formData = new FormData();
    if (text.trim()) formData.append("text", text);
    formData.append("expiresIn", $("expiresIn").value);
    formData.append("maxViews", $("maxViews").value);
    if (password) formData.append("password", password);
    selectedFiles.forEach((file) => formData.append("files", file));

    const sendBtn = $("sendBtn");
    const progress = $("uploadProgress");
    sendBtn.disabled = true;
    sendBtn.textContent = "Sending…";
    progress.hidden = selectedFiles.length === 0;

    try {
        const result = await uploadShare(formData, (loaded, total) => {
            $("uploadProgressBar").style.width = `${(loaded / total) * 100}%`;
            $("uploadProgressLabel").textContent = `${formatSize(loaded)} / ${formatSize(total)}`;
        });
        showSendResult(result);
    } catch (err) {
        showError(errorEl, err.message);
    } finally {
        sendBtn.disabled = false;
        sendBtn.textContent = "Send";
        progress.hidden = true;
        $("uploadProgressBar").style.width = "0";
    }
});

const showSendResult = (result) => {
    $("shareCode").textContent = formatCode(result.code);
    $("shareLink").value = result.url;

    const details = [`Expires ${formatDate(result.expiresAt)}`];
    if (result.maxViews === 1) details.push("can be opened once");
    else if (result.maxViews) details.push(`can be opened ${result.maxViews} times`);
    if (result.passwordProtected) details.push("password protected");
    $("shareMeta").textContent = details.join(" · ");

    $("sendForm").hidden = true;
    $("sendResult").hidden = false;
};

$("newShareBtn").addEventListener("click", () => {
    $("sendForm").reset();
    selectedFiles = [];
    renderFileList();
    $("sendResult").hidden = true;
    $("sendForm").hidden = false;
});

/* ---------- Retrieve ---------- */

const codeInput = $("retrieveCode");

codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase();
    // A different code may not need a password; hide it until the server asks.
    $("passwordField").hidden = true;
    $("retrievePassword").value = "";
});

const renderPreview = (file) => {
    if (!file.previewUrl) return null;
    if (file.mimeType.startsWith("image/")) {
        return el("img", { src: file.previewUrl, alt: file.name, loading: "lazy", className: "preview" });
    }
    if (file.mimeType.startsWith("video/")) {
        return el("video", { src: file.previewUrl, controls: true, preload: "metadata", className: "preview" });
    }
    if (file.mimeType.startsWith("audio/")) {
        return el("audio", { src: file.previewUrl, controls: true, preload: "metadata", className: "preview-audio" });
    }
    return null;
};

const showRetrieveResult = (share) => {
    const hasText = Boolean(share.text);
    $("retrievedText").textContent = share.text || "";
    $("retrievedTextBlock").hidden = !hasText;

    $("retrievedFiles").replaceChildren(
        ...share.files.map((file) => {
            const preview = renderPreview(file);
            return el("li", {}, [
                ...(preview ? [preview] : []),
                el("div", { className: "file-row" }, [
                    el("span", { className: "file-name", textContent: file.name, title: file.name }),
                    el("span", { className: "file-size", textContent: formatSize(file.size) }),
                    el("a", { href: file.downloadUrl, className: "download", textContent: "Download" }),
                ]),
            ]);
        })
    );
    $("retrievedFilesBlock").hidden = share.files.length === 0;

    const minutes = Math.round(share.downloadWindowSeconds / 60);
    let meta;
    if (share.viewsRemaining === 0) {
        meta = `This share has now been used up and will be deleted. Download links work for ${minutes} minutes.`;
    } else {
        meta = `Expires ${formatDate(share.expiresAt)}`;
        if (share.viewsRemaining !== null) {
            meta += ` · ${share.viewsRemaining} more ${share.viewsRemaining === 1 ? "open" : "opens"} allowed`;
        }
        if (share.files.length) meta += ` · download links work for ${minutes} minutes`;
    }
    $("retrieveMeta").textContent = meta;
    $("retrieveResult").hidden = false;
};

$("retrieveForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const errorEl = $("retrieveError");
    const code = codeInput.value.replace(/[\s-]/g, "");
    const passwordField = $("passwordField");
    const password = $("retrievePassword").value;

    if (code.length !== 8) {
        return showError(errorEl, "Share codes are 8 characters, like 7KX9-2PMQ.");
    }
    showError(errorEl, "");
    $("retrieveResult").hidden = true;

    const button = $("retrieveBtn");
    button.disabled = true;
    button.textContent = "Opening…";

    try {
        const response = await fetch(`/api/shares/${encodeURIComponent(code)}/open`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(password ? { password } : {}),
        });
        const body = await response.json().catch(() => ({}));

        if (response.ok) {
            showRetrieveResult(body);
        } else if (body.passwordRequired) {
            const wasHidden = passwordField.hidden;
            passwordField.hidden = false;
            $("retrievePassword").focus();
            // First prompt isn't an error, just a request for the password.
            showError(errorEl, wasHidden ? "" : body.error);
        } else {
            showError(errorEl, body.error || "Something went wrong. Please try again.");
        }
    } catch {
        showError(errorEl, "Network error. Check your connection.");
    } finally {
        button.disabled = false;
        button.textContent = "Open";
    }
});

/* ---------- Share links (/s/CODE) ---------- */

const linkMatch = location.pathname.match(/^\/s\/([A-Za-z0-9-]+)$/);
if (linkMatch) {
    selectTab("retrieve");
    const code = linkMatch[1].toUpperCase().replace(/-/g, "");
    codeInput.value = code.length === 8 ? formatCode(code) : code;
    // Don't auto-open: that would use up a view of a one-time share.
    $("retrieveBtn").focus();
}
