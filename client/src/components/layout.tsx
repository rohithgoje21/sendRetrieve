import { Suspense, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, ScrollRestoration, useLocation } from "react-router";
import { Toaster } from "sonner";
import { ChevronDown, FolderOpen, LogOut, MailWarning, Moon, Settings, ShieldCheck, Sun } from "lucide-react";
import { useLogout, useSession } from "@/hooks/useSession";
import { useRealtimeUpdates } from "@/hooks/useRealtime";
import { useTheme } from "@/hooks/useTheme";
import { can } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import type { User } from "@/lib/types";
import { NotificationBell } from "./NotificationBell";
import { PageSpinner } from "./ui/feedback";
import { buttonClasses } from "./ui/styles";

export function Logo({ className }: { className?: string }) {
    return (
        <svg viewBox="0 0 32 32" className={className} aria-hidden>
            <rect width="32" height="32" rx="8" className="fill-zinc-900 dark:fill-white" />
            <path
                d="M10 17l6-7 6 7M16 10v13"
                fill="none"
                strokeWidth="2.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="stroke-white dark:stroke-zinc-900"
            />
        </svg>
    );
}

function ThemeToggle() {
    const { resolvedTheme, setTheme } = useTheme();
    const next = resolvedTheme === "dark" ? "light" : "dark";
    return (
        <button
            type="button"
            onClick={() => setTheme(next)}
            className={buttonClasses({ variant: "ghost", size: "icon" })}
            aria-label={`Switch to ${next} theme`}
            title={`Switch to ${next} theme`}
        >
            {resolvedTheme === "dark" ? <Sun /> : <Moon />}
        </button>
    );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    cn(buttonClasses({ variant: "ghost", size: "sm" }), isActive && "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100");

function UserMenu({ user }: { user: User }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const logout = useLogout();

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: PointerEvent) => {
            if (!ref.current?.contains(event.target as Node)) setOpen(false);
        };
        const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    const close = () => setOpen(false);
    const itemClass =
        "flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 [&_svg]:size-4 [&_svg]:text-zinc-500";

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label="Account menu"
                className="flex cursor-pointer items-center gap-2 rounded-full py-1 pr-2 pl-1 hover:bg-zinc-100 focus-visible:outline-2 focus-visible:outline-indigo-500 dark:hover:bg-zinc-800"
            >
                <span className="flex size-7 items-center justify-center rounded-full bg-indigo-600 text-xs font-semibold text-white uppercase">
                    {user.name.trim().charAt(0) || "?"}
                </span>
                <span className="hidden max-w-36 truncate text-sm font-medium sm:block">{user.name}</span>
                <ChevronDown className="size-4 text-zinc-500" aria-hidden />
            </button>

            {open && (
                <div
                    role="menu"
                    className="absolute right-0 z-20 mt-2 w-64 animate-fade-in rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-800 dark:bg-zinc-900"
                >
                    <div className="px-3 py-2">
                        <p className="truncate text-sm font-medium">{user.name}</p>
                        <p className="truncate text-xs text-zinc-500">{user.email}</p>
                    </div>
                    <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
                    <Link role="menuitem" to="/shares" onClick={close} className={itemClass}>
                        <FolderOpen /> My shares
                    </Link>
                    <Link role="menuitem" to="/account" onClick={close} className={itemClass}>
                        <Settings /> Account settings
                    </Link>
                    {can(user, "admin.access") && (
                        <Link role="menuitem" to="/admin" onClick={close} className={itemClass}>
                            <ShieldCheck /> Admin
                        </Link>
                    )}
                    <div className="my-1 h-px bg-zinc-200 dark:bg-zinc-800" />
                    <button
                        role="menuitem"
                        type="button"
                        className={itemClass}
                        onClick={() => {
                            close();
                            logout.mutate();
                        }}
                    >
                        <LogOut /> Log out
                    </button>
                </div>
            )}
        </div>
    );
}

function Header() {
    const { user, isLoading } = useSession();
    return (
        <header className="sticky top-0 z-10 border-b border-zinc-200/80 bg-white/80 backdrop-blur-md dark:border-zinc-800/80 dark:bg-zinc-950/80">
            <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-3 px-4">
                <Link to="/" className="flex items-center gap-2 rounded-lg font-semibold tracking-tight">
                    <Logo className="size-7" />
                    sendRetrieve
                </Link>
                <div className="flex items-center gap-1">
                    {user ? (
                        <>
                            <NavLink to="/shares" className={navLinkClass}>
                                <FolderOpen aria-hidden />
                                <span className="max-sm:sr-only">My shares</span>
                            </NavLink>
                            <NotificationBell />
                            <UserMenu user={user} />
                        </>
                    ) : (
                        !isLoading && (
                            <>
                                <NavLink to="/login" className={navLinkClass}>
                                    Log in
                                </NavLink>
                                <Link to="/signup" className={buttonClasses({ size: "sm" })}>
                                    Sign up
                                </Link>
                            </>
                        )
                    )}
                    <ThemeToggle />
                </div>
            </div>
        </header>
    );
}

// Shown to signed-in users until they confirm their email address.
function VerifyEmailBanner() {
    const { user } = useSession();
    const { pathname } = useLocation();
    if (!user || user.emailVerified || pathname === "/verify-email") return null;
    return (
        <div className="border-b border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200">
            <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
                <span className="flex items-center gap-2">
                    <MailWarning className="size-4 shrink-0" aria-hidden />
                    Please verify your email address, {user.email}.
                </span>
                <Link
                    to={`/verify-email?next=${encodeURIComponent(pathname)}`}
                    className="font-medium underline underline-offset-2"
                >
                    Verify now
                </Link>
            </div>
        </div>
    );
}

export function Layout() {
    const { resolvedTheme } = useTheme();
    useRealtimeUpdates();
    return (
        <div className="flex min-h-dvh flex-col">
            <Header />
            <VerifyEmailBanner />
            <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:py-12">
                <Suspense fallback={<PageSpinner />}>
                    <Outlet />
                </Suspense>
            </main>
            <footer className="border-t border-zinc-200 py-6 text-center text-xs text-zinc-500 dark:border-zinc-800">
                Shares delete themselves when they expire.
            </footer>
            <Toaster theme={resolvedTheme} position="top-center" richColors closeButton />
            <ScrollRestoration />
        </div>
    );
}
