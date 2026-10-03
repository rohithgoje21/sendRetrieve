import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { MailCheck } from "lucide-react";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/feedback";
import { useSession, useSetSession } from "@/hooks/useSession";
import { api, ApiError } from "@/lib/api";
import { safeNextPath } from "@/lib/utils";
import type { User } from "@/lib/types";

const CODE_LENGTH = 6;

// Counts down to zero, one second at a time.
function useCountdown(initialSeconds: number) {
    const [seconds, setSeconds] = useState(initialSeconds);
    useEffect(() => {
        if (seconds <= 0) return;
        const timer = setTimeout(() => setSeconds((s) => s - 1), 1000);
        return () => clearTimeout(timer);
    }, [seconds]);
    return [seconds, setSeconds] as const;
}

export default function VerifyEmailPage() {
    const { user } = useSession();
    const setSession = useSetSession();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const next = safeNextPath(params.get("next"));

    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    // A code is sent at sign-up, so resending starts on a cooldown.
    const [resendIn, setResendIn] = useCountdown(params.has("new") ? 60 : 0);

    const verify = useMutation({
        mutationFn: () => api<{ user: User }>("/api/auth/verify-email", { method: "POST", body: { code } }),
        onSuccess: ({ user: verified }) => {
            setSession(verified);
            toast.success("Email verified");
            navigate(next, { replace: true });
        },
        onError: (err) => setError(err.message),
    });

    const resend = useMutation({
        mutationFn: () => api<{ message: string; resendAfterSeconds: number }>("/api/auth/verify-email/send", { method: "POST" }),
        onSuccess: ({ message, resendAfterSeconds }) => {
            toast.success(message);
            setResendIn(resendAfterSeconds);
            setError(null);
            setCode("");
        },
        onError: (err) => {
            if (err instanceof ApiError && err.data.retryAfterSeconds) setResendIn(err.data.retryAfterSeconds);
            setError(err.message);
        },
    });

    if (!user) return null; // guarded by <RequireAuth>
    if (user.emailVerified) return <Navigate to={next} replace />;

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (code.length !== CODE_LENGTH) return setError(`Enter the ${CODE_LENGTH}-digit code from the email.`);
        setError(null);
        verify.mutate();
    };

    return (
        <AuthCard
            title="Verify your email"
            description={
                <>
                    We sent a {CODE_LENGTH}-digit code to <span className="font-medium text-zinc-900 dark:text-zinc-100">{user.email}</span>.
                </>
            }
            footer={
                <button
                    type="button"
                    onClick={() => navigate(next, { replace: true })}
                    className="cursor-pointer font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100"
                >
                    Do this later
                </button>
            }
        >
            <form onSubmit={onSubmit} noValidate className="space-y-4">
                <Field label="Verification code" hint="The code works for 10 minutes.">
                    <Input
                        value={code}
                        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        autoFocus
                        placeholder="••••••"
                        className="h-14 text-center font-mono text-2xl tracking-[0.5em]"
                    />
                </Field>
                {error && <Alert tone="error">{error}</Alert>}
                <Button type="submit" className="w-full" loading={verify.isPending}>
                    <MailCheck aria-hidden />
                    Verify email
                </Button>
                <Button
                    variant="ghost"
                    className="w-full"
                    loading={resend.isPending}
                    disabled={resendIn > 0}
                    onClick={() => resend.mutate()}
                >
                    {resendIn > 0 ? `Send a new code in ${resendIn}s` : "Send a new code"}
                </Button>
            </form>
        </AuthCard>
    );
}
