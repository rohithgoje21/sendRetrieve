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
    name: z.string().trim().min(1, "Enter your name").max(60, "Use at most 60 characters"),
    email: z.email("Enter a valid email address"),
    password: z.string().min(8, "Use at least 8 characters").max(72, "Use at most 72 characters"),
});

export default function SignupPage() {
    const [params] = useSearchParams();
    const { search } = useLocation();
    const navigate = useNavigate();
    const setSession = useSetSession();
    const form = useForm({ resolver: zodResolver(schema), defaultValues: { name: "", email: "", password: "" } });
    const { register, handleSubmit, formState } = form;
    const { errors, isSubmitting } = formState;

    const onSubmit = handleSubmit(async (values) => {
        try {
            const { user } = await api<{ user: User }>("/api/auth/register", { method: "POST", body: values });
            setSession(user);
            toast.success("Account created");
            navigate(safeNextPath(params.get("next")), { replace: true });
        } catch (err) {
            showServerError(form)(err);
        }
    });

    return (
        <AuthCard
            title="Create an account"
            description="Track what you share, see views and downloads, and delete shares early. You can still share without one."
            footer={
                <>
                    Already have an account?{" "}
                    <Link to={`/login${search}`} className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100">
                        Log in
                    </Link>
                </>
            }
        >
            <form onSubmit={onSubmit} noValidate className="space-y-4">
                <Field label="Name" error={errors.name?.message}>
                    <Input autoComplete="name" autoFocus {...register("name")} />
                </Field>
                <Field label="Email" error={errors.email?.message}>
                    <Input type="email" autoComplete="email" {...register("email")} />
                </Field>
                <Field label="Password" error={errors.password?.message} hint="At least 8 characters.">
                    <PasswordInput autoComplete="new-password" {...register("password")} />
                </Field>
                {errors.root && <Alert tone="error">{errors.root.message}</Alert>}
                <Button type="submit" className="w-full" loading={isSubmitting}>
                    Create account
                </Button>
            </form>
        </AuthCard>
    );
}
