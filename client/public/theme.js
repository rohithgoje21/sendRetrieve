// Runs before the app loads so the page doesn't flash the wrong theme.
(function () {
    try {
        var saved = localStorage.getItem("theme");
        var dark = saved === "dark" || (saved !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
        document.documentElement.classList.toggle("dark", dark);
    } catch (e) {
        // storage blocked: fall back to the light theme
    }
})();
