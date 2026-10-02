import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ThemeContext, type Theme } from "@/lib/theme";

const STORAGE_KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const readSavedTheme = (): Theme => {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        return saved === "light" || saved === "dark" ? saved : "system";
    } catch {
        return "system";
    }
};

const systemPrefersDark = () => window.matchMedia?.(DARK_QUERY).matches ?? false;

// Light/dark theme: follows the OS until the user picks one. public/theme.js
// applies the saved choice before React loads, so there's no flash.
export function ThemeProvider({ children }: { children: ReactNode }) {
    const [theme, setThemeState] = useState<Theme>(readSavedTheme);
    const [systemDark, setSystemDark] = useState(systemPrefersDark);

    useEffect(() => {
        const media = window.matchMedia?.(DARK_QUERY);
        if (!media) return;
        const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
    }, []);

    const resolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

    useEffect(() => {
        document.documentElement.classList.toggle("dark", resolvedTheme === "dark");
    }, [resolvedTheme]);

    const setTheme = useCallback((next: Theme) => {
        setThemeState(next);
        try {
            if (next === "system") localStorage.removeItem(STORAGE_KEY);
            else localStorage.setItem(STORAGE_KEY, next);
        } catch {
            // storage blocked: the choice lasts for this visit only
        }
    }, []);

    const value = useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
    return <ThemeContext value={value}>{children}</ThemeContext>;
}
