// Login, sign-up, forgot-password and reset-password pages. Each page has one
// of the forms below; helpers come from common.js.

const errorEl = $("formError");

// Runs `action` on submit with the button busy and errors shown in the form.
const handleForm = (form, busyLabel, action) => {
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const button = form.querySelector("button[type=submit]");
        showError(errorEl, "");
        setBusy(button, true, busyLabel);
        try {
            await action();
        } catch (err) {
            showError(errorEl, err.message);
            if (err.data?.field && $(err.data.field)) $(err.data.field).focus();
        } finally {
            setBusy(button, false);
        }
    });
};

const value = (id) => $(id).value;

// Keep ?next= when switching between log in and sign up.
const switchLink = $("switchLink");
if (switchLink && location.search) switchLink.href += location.search;

const loginForm = $("loginForm");
if (loginForm) {
    session.ready.then((user) => user && location.replace(safeNext()));
    handleForm(loginForm, "Logging in…", async () => {
        await api("/api/auth/login", { method: "POST", body: { email: value("email"), password: value("password") } });
        location.replace(safeNext());
    });
}

const signupForm = $("signupForm");
if (signupForm) {
    session.ready.then((user) => user && location.replace(safeNext()));
    handleForm(signupForm, "Creating account…", async () => {
        await api("/api/auth/register", {
            method: "POST",
            body: { name: value("name"), email: value("email"), password: value("password") },
        });
        location.replace(safeNext());
    });
}

const forgotForm = $("forgotForm");
if (forgotForm) {
    handleForm(forgotForm, "Sending…", async () => {
        const { message } = await api("/api/auth/forgot-password", { method: "POST", body: { email: value("email") } });
        forgotForm.hidden = true;
        $("formSuccess").textContent = message;
        $("formSuccess").hidden = false;
    });
}

const resetForm = $("resetForm");
if (resetForm) {
    // Take the token out of the address bar so it doesn't linger in history.
    const token = new URLSearchParams(location.search).get("token");
    history.replaceState(null, "", location.pathname);
    if (!token) showError(errorEl, "This reset link is incomplete. Request a new one.");

    handleForm(resetForm, "Saving…", async () => {
        if (value("password") !== value("confirmPassword")) throw new Error("The passwords don't match.");
        await api("/api/auth/reset-password", { method: "POST", body: { token: token || "", password: value("password") } });
        location.replace("/shares");
    });
}
