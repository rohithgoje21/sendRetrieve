import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input, PasswordInput } from "@/components/ui/inputs";
import { Alert, Card } from "@/components/ui/feedback";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useSession, useSetSession } from "@/hooks/useSession";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { cn, showServerError } from "@/lib/utils";
import type { User } from "@/lib/types";

function Section({ title, description, children, danger }: { title: string; description?: string; children: ReactNode; danger?: boolean }) {
    return (
        <Card className={cn("p-5 sm:p-6", danger && "border-red-200 dark:border-red-900/60")}>
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
            <Field label="Email" hint={`Member since ${formatDate(user.createdAt)}`}>
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
            <Section title="Delete account" description="Permanently delete your account and all your shares." danger>
                <DeleteAccount />
            </Section>
        </div>
    );
}
