import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { AuthCard } from "@/components/AuthCard";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input, PasswordInput } from "@/components/ui/inputs";
import { Alert } from "@/components/ui/feedback";
import { useSetSession } from "@/hooks/useSession";
import { api } from "@/lib/api";
import { safeNextPath, showServerError } from "@/lib/utils";
import type { User } from "@/lib/types";

const schema = z.object({
    email: z.email("Enter a valid email address"),
    password: z.string().min(1, "Enter your password"),
});

export default function LoginPage() {
    const [params] = useSearchParams();
    const { search } = useLocation();
    const navigate = useNavigate();
    const setSession = useSetSession();
    const form = useForm({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });
    const { register, handleSubmit, formState } = form;
    const { errors, isSubmitting } = formState;

    const onSubmit = handleSubmit(async (values) => {
        try {
            const { user } = await api<{ user: User }>("/api/auth/login", { method: "POST", body: values });
            setSession(user);
            toast.success(`Welcome back, ${user.name}`);
            navigate(safeNextPath(params.get("next")), { replace: true });
        } catch (err) {
            showServerError(form)(err);
        }
    });

    return (
        <AuthCard
            title="Log in"
            description="Welcome back to sendRetrieve."
            footer={
                <>
                    New here?{" "}
                    <Link to={`/signup${search}`} className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100">
                        Create an account
                    </Link>
                </>
            }
        >
            <form onSubmit={onSubmit} noValidate className="space-y-4">
                <Field label="Email" error={errors.email?.message}>
                    <Input type="email" autoComplete="email" autoFocus {...register("email")} />
                </Field>
                <Field
                    label="Password"
                    error={errors.password?.message}
                    action={
                        <Link to="/forgot-password" className="text-xs text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100">
                            Forgot password?
                        </Link>
                    }
                >
                    <PasswordInput autoComplete="current-password" {...register("password")} />
                </Field>
                {errors.root && <Alert tone="error">{errors.root.message}</Alert>}
                <Button type="submit" className="w-full" loading={isSubmitting}>
                    Log in
                </Button>
            </form>
        </AuthCard>
    );
}
