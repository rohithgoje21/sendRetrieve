import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { PasswordInput } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/feedback";
import { useSetSession } from "@/hooks/useSession";
import { api } from "@/lib/api";
import { showServerError } from "@/lib/utils";
import type { User } from "@/lib/types";

const schema = z
    .object({
        password: z.string().min(8, "Use at least 8 characters").max(72, "Use at most 72 characters"),
        confirm: z.string(),
    })
    .refine((v) => v.password === v.confirm, { message: "The passwords don't match", path: ["confirm"] });

export default function ResetPasswordPage() {
    const [params, setParams] = useSearchParams();
    // Read the token once, then take it out of the address bar so it doesn't
    // stay in the browser history.
    const [token] = useState(() => params.get("token"));
    useEffect(() => {
        if (params.has("token")) setParams({}, { replace: true });
    }, [params, setParams]);

    const navigate = useNavigate();
    const setSession = useSetSession();
    const form = useForm({ resolver: zodResolver(schema), defaultValues: { password: "", confirm: "" } });
    const { register, handleSubmit, formState } = form;
    const { errors, isSubmitting } = formState;

    const onSubmit = handleSubmit(async ({ password }) => {
        try {
            const { user } = await api<{ user: User }>("/api/auth/reset-password", {
                method: "POST",
                body: { token: token ?? "", password },
            });
            setSession(user);
            toast.success("Password changed. You've been logged out on your other devices.");
            navigate("/shares", { replace: true });
        } catch (err) {
            showServerError(form)(err);
        }
    });

    return (
        <AuthCard
            title="Choose a new password"
            footer={
                <Link to="/forgot-password" className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100">
                    Request a new link
                </Link>
            }
        >
            {token ? (
                <form onSubmit={onSubmit} noValidate className="space-y-4">
                    <Field
                        label="New password"
                        error={errors.password?.message}
                        hint="At least 8 characters. You'll be logged out on your other devices."
                    >
                        <PasswordInput autoComplete="new-password" autoFocus {...register("password")} />
                    </Field>
                    <Field label="Confirm new password" error={errors.confirm?.message}>
                        <PasswordInput autoComplete="new-password" {...register("confirm")} />
                    </Field>
                    {errors.root && <Alert tone="error">{errors.root.message}</Alert>}
                    <Button type="submit" className="w-full" loading={isSubmitting}>
                        Set password
                    </Button>
                </form>
            ) : (
                <Alert tone="error">This reset link is incomplete. Request a new one.</Alert>
            )}
        </AuthCard>
    );
}
