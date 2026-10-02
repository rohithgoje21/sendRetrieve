// Account settings page. Helpers come from common.js.

const onSubmit = (formId, errorId, busyLabel, action) => {
    const form = $(formId);
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button[type=submit]");
        showError($(errorId), "");
        form.querySelectorAll(".success").forEach((s) => (s.hidden = true));
        setBusy(button, true, busyLabel);
        try {
            await action();
        } catch (err) {
            showError($(errorId), err.message);
        } finally {
            setBusy(button, false);
        }
    });
};

const flash = (id, message) => {
    $(id).textContent = message;
    $(id).hidden = false;
};

requireLogin().then((user) => {
    $("name").value = user.name;
    $("email").value = user.email;
    $("memberSince").textContent = `Member since ${formatDate(user.createdAt)}`;
});

onSubmit("profileForm", "profileError", "Saving…", async () => {
    const { user } = await api("/api/me", { method: "PATCH", body: { name: $("name").value } });
    renderNav(user);
    flash("profileSuccess", "Saved.");
});

onSubmit("passwordForm", "passwordError", "Saving…", async () => {
    await api("/api/me/password", {
        method: "POST",
        body: { currentPassword: $("currentPassword").value, newPassword: $("newPassword").value },
    });
    $("passwordForm").reset();
    flash("passwordSuccess", "Password changed. Other devices have been logged out.");
});

onSubmit("deleteForm", "deleteError", "Deleting…", async () => {
    if (!confirm("Delete your account and all your shares? This can't be undone.")) return;
    await api("/api/me", { method: "DELETE", body: { password: $("deletePassword").value } });
    location.replace("/");
});
