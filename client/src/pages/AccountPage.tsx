import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { BadgeCheck, LogOut, Monitor, MonitorSmartphone, Smartphone, Tablet } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input, PasswordInput } from "@/components/ui/inputs";
import { Alert, Badge, Card, Skeleton } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { NotificationSettings } from "@/components/NotificationSettings";
import { useSession, useSetSession } from "@/hooks/useSession";
import { api } from "@/lib/api";
import { formatDate, formatRelative } from "@/lib/format";
import { devicesKey } from "@/lib/queryClient";
import { cn, showServerError } from "@/lib/utils";
import type { DeviceSession, User } from "@/lib/types";

function Section({
    id,
    title,
    description,
    children,
    danger,
}: {
    id?: string;
    title: string;
    description?: string;
    children: ReactNode;
    danger?: boolean;
}) {
    return (
        <Card id={id} className={cn("scroll-mt-20 p-5 sm:p-6", danger && "border-red-200 dark:border-red-900/60")}>
            <h2 className={cn("text-lg font-semibold", danger && "text-red-700 dark:text-red-400")}>{title}</h2>
            {description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{description}</p>}
            <div className="mt-5">{children}</div>
        </Card>
    );
}

const profileSchema = z.object({ name: z.string().trim().min(1, "Enter your name").max(60, "Use at most 60 characters") });

function ProfileForm({ user }: { user: User }) {
    const setSession = useSetSession();
    const form = useForm({ resolver: zodResolver(profileSchema), defaultValues: { name: user.name } });
    const { register, handleSubmit, formState, reset } = form;

    const onSubmit = handleSubmit(async (values) => {
        try {
            const { user: updated } = await api<{ user: User }>("/api/me", { method: "PATCH", body: values });
            setSession(updated);
            reset({ name: updated.name });
            toast.success("Profile saved");
        } catch (err) {
            showServerError(form)(err);
        }
    });

    return (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
            <Field label="Name" error={formState.errors.name?.message}>
                <Input autoComplete="name" {...register("name")} />
            </Field>
            <Field
                label="Email"
                hint={`Member since ${formatDate(user.createdAt)}`}
                action={
                    user.emailVerified ? (
                        <Badge tone="success">
                            <BadgeCheck className="size-3" aria-hidden /> Verified
                        </Badge>
                    ) : (
                        <Link to="/verify-email?next=/account" className="text-xs font-medium text-amber-700 underline underline-offset-2 dark:text-amber-400">
                            Not verified · Verify now
                        </Link>
                    )
                }
            >
                <Input type="email" value={user.email} readOnly />
            </Field>
            {formState.errors.root && <Alert tone="error">{formState.errors.root.message}</Alert>}
            <Button type="submit" loading={formState.isSubmitting} disabled={!formState.isDirty}>
                Save changes
            </Button>
        </form>
    );
}

const passwordSchema = z.object({
    currentPassword: z.string().min(1, "Enter your current password"),
    newPassword: z.string().min(8, "Use at least 8 characters").max(72, "Use at most 72 characters"),
});

function PasswordForm() {
    const form = useForm({ resolver: zodResolver(passwordSchema), defaultValues: { currentPassword: "", newPassword: "" } });
    const { register, handleSubmit, formState, reset } = form;

    const onSubmit = handleSubmit(async (values) => {
        try {
            await api("/api/me/password", { method: "POST", body: values });
            reset();
            toast.success("Password changed. You've been logged out on your other devices.");
        } catch (err) {
            showServerError(form)(err);
        }
    });

    return (
        <form onSubmit={onSubmit} noValidate className="space-y-4">
            <Field label="Current password" error={formState.errors.currentPassword?.message}>
                <PasswordInput autoComplete="current-password" {...register("currentPassword")} />
            </Field>
            <Field label="New password" error={formState.errors.newPassword?.message} hint="At least 8 characters.">
                <PasswordInput autoComplete="new-password" {...register("newPassword")} />
            </Field>
            {formState.errors.root && <Alert tone="error">{formState.errors.root.message}</Alert>}
            <Button type="submit" loading={formState.isSubmitting}>
                Change password
            </Button>
        </form>
    );
}

const DEVICE_ICONS = { desktop: Monitor, mobile: Smartphone, tablet: Tablet, unknown: MonitorSmartphone };

// Where the account is logged in, and logging devices out.
function Devices() {
    const queryClient = useQueryClient();
    const navigate = useNavigate();
    const setSession = useSetSession();
    const [confirmAll, setConfirmAll] = useState(false);
    const { data, error } = useQuery({
        queryKey: devicesKey,
        queryFn: () => api<{ sessions: DeviceSession[] }>("/api/me/sessions"),
        refetchInterval: 60_000,
    });
    const refresh = () => queryClient.invalidateQueries({ queryKey: devicesKey });

    const logOut = useMutation({
        mutationFn: (session: DeviceSession) => api(`/api/me/sessions/${session.id}`, { method: "DELETE" }),
        onSuccess: (_, session) => {
            toast.success(`Logged out ${session.device.label}`);
            refresh();
        },
        onError: (err) => toast.error(err.message),
    });
    const logOutOthers = useMutation({
        mutationFn: () => api<{ revoked: number }>("/api/me/sessions/revoke-others", { method: "POST" }),
        onSuccess: ({ revoked }) => {
            toast.success(revoked === 1 ? "Logged out 1 other device" : `Logged out ${revoked} other devices`);
            refresh();
        },
        onError: (err) => toast.error(err.message),
    });
    const logOutEverywhere = useMutation({
        mutationFn: () => api("/api/me/sessions/revoke-all", { method: "POST" }),
        onSuccess: () => {
            setSession(null);
            toast.success("Logged out everywhere");
            navigate("/login", { replace: true });
        },
        onError: (err) => toast.error(err.message),
    });

    if (error) return <Alert tone="error">{error.message}</Alert>;
    if (!data) return <Skeleton className="h-28 w-full" />;
    const others = data.sessions.filter((s) => !s.current);

    return (
        <div className="space-y-4">
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" aria-label="Logged-in devices">
                {data.sessions.map((session) => {
                    const Icon = DEVICE_ICONS[session.device.type] ?? MonitorSmartphone;
                    return (
                        <li key={session.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                            <Icon className="size-5 shrink-0 text-zinc-500 dark:text-zinc-400" aria-hidden />
                            <div className="min-w-0 flex-1">
                                <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                                    {session.device.label}
                                    {session.current && <Badge tone="success">This device</Badge>}
                                </p>
                                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                                    {session.current ? "Active now" : `Last active ${formatRelative(session.lastSeenAt)}`} · logged in{" "}
                                    {formatDate(session.createdAt)}
                                    {session.ipHint && <> · network {session.ipHint}</>}
                                </p>
                            </div>
                            {!session.current && (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    loading={logOut.isPending && logOut.variables?.id === session.id}
                                    onClick={() => logOut.mutate(session)}
                                    aria-label={`Log out ${session.device.label}`}
                                >
                                    Log out
                                </Button>
                            )}
                        </li>
                    );
                })}
            </ul>
            <div className="flex flex-wrap gap-2">
                <Button variant="secondary" disabled={others.length === 0} loading={logOutOthers.isPending} onClick={() => logOutOthers.mutate()}>
                    Log out other devices
                </Button>
                <Button variant="ghost" onClick={() => setConfirmAll(true)}>
                    <LogOut aria-hidden />
                    Log out everywhere
                </Button>
            </div>
            <ConfirmDialog
                open={confirmAll}
                title="Log out everywhere?"
                description="Every device, this one included, will need to log in again."
                confirmLabel="Log out everywhere"
                destructive
                busy={logOutEverywhere.isPending}
                onConfirm={() => logOutEverywhere.mutate()}
                onCancel={() => setConfirmAll(false)}
            />
        </div>
    );
}

const deleteSchema = z.object({ password: z.string().min(1, "Enter your password") });

function DeleteAccount() {
    const [open, setOpen] = useState(false);
    const navigate = useNavigate();
    const setSession = useSetSession();
    const form = useForm({ resolver: zodResolver(deleteSchema), defaultValues: { password: "" } });
    const { register, handleSubmit, formState, reset } = form;

    const onSubmit = handleSubmit(async (values) => {
        try {
            await api("/api/me", { method: "DELETE", body: values });
            setSession(null);
            toast.success("Your account has been deleted");
            navigate("/", { replace: true });
        } catch (err) {
            showServerError(form)(err);
        }
    });

    return (
        <>
            <Button variant="danger" onClick={() => setOpen(true)}>
                Delete my account
            </Button>
            <ConfirmDialog
                open={open}
                title="Delete your account?"
                description="This deletes your account and every share you've created, including their files. It can't be undone."
                confirmLabel="Delete account"
                destructive
                busy={formState.isSubmitting}
                formId="delete-account-form"
                onCancel={() => {
                    setOpen(false);
                    reset();
                }}
            >
                <form id="delete-account-form" onSubmit={onSubmit} noValidate className="space-y-3">
                    <Field label="Enter your password to confirm" error={formState.errors.password?.message}>
                        <PasswordInput autoComplete="current-password" {...register("password")} />
                    </Field>
                    {formState.errors.root && <Alert tone="error">{formState.errors.root.message}</Alert>}
                </form>
            </ConfirmDialog>
        </>
    );
}

export default function AccountPage() {
    const { user } = useSession();
    const { hash } = useLocation();
    // Links like /account#notifications go straight to that section.
    useEffect(() => {
        if (hash) document.getElementById(hash.slice(1))?.scrollIntoView();
    }, [hash]);
    if (!user) return null; // guarded by <RequireAuth>

    return (
        <div className="mx-auto max-w-xl space-y-6">
            <title>Account · sendRetrieve</title>
            <h1 className="text-2xl font-bold tracking-tight">Account settings</h1>
            <Section title="Profile">
                <ProfileForm user={user} />
            </Section>
            <Section title="Password" description="Changing it logs you out everywhere except this browser.">
                <PasswordForm />
            </Section>
            <Section id="notifications" title="Notifications" description="What you hear about, and where: in the app, by email, or as browser notifications.">
                <NotificationSettings />
            </Section>
            <Section title="Devices" description="Where your account is logged in. Log out any device you don't recognize, then change your password.">
                <Devices />
            </Section>
            <Section title="Delete account" description="Permanently delete your account and all your shares." danger>
                <DeleteAccount />
            </Section>
        </div>
    );
}
