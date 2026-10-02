import { useState } from "react";
import { Link } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { MailCheck } from "lucide-react";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/feedback";
import { api } from "@/lib/api";
import { showServerError } from "@/lib/utils";

const schema = z.object({ email: z.email("Enter a valid email address") });

export default function ForgotPasswordPage() {
    const [sentMessage, setSentMessage] = useState<string | null>(null);
    const form = useForm({ resolver: zodResolver(schema), defaultValues: { email: "" } });
    const { register, handleSubmit, formState } = form;
    const { errors, isSubmitting } = formState;

    const onSubmit = handleSubmit(async (values) => {
        try {
            const { message } = await api<{ message: string }>("/api/auth/forgot-password", { method: "POST", body: values });
            setSentMessage(message);
        } catch (err) {
            showServerError(form)(err);
        }
    });

    return (
        <AuthCard
            title="Reset your password"
            description="Enter your account's email and we'll send you a link to choose a new password."
            footer={
                <Link to="/login" className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100">
                    Back to log in
                </Link>
            }
        >
            {sentMessage ? (
                <div className="text-center">
                    <MailCheck className="mx-auto size-10 text-emerald-500" aria-hidden />
                    <p className="mt-3 text-sm text-zinc-700 dark:text-zinc-300" role="status">
                        {sentMessage}
                    </p>
                    <p className="mt-2 text-xs text-zinc-500">The link works for 30 minutes.</p>
                </div>
            ) : (
                <form onSubmit={onSubmit} noValidate className="space-y-4">
                    <Field label="Email" error={errors.email?.message}>
                        <Input type="email" autoComplete="email" autoFocus {...register("email")} />
                    </Field>
                    {errors.root && <Alert tone="error">{errors.root.message}</Alert>}
                    <Button type="submit" className="w-full" loading={isSubmitting}>
                        Send reset link
                    </Button>
                </form>
            )}
        </AuthCard>
    );
}
