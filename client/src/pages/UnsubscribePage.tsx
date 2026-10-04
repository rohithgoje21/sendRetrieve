import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { MailX, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Alert, Card } from "@/components/ui/feedback";
import { api } from "@/lib/api";

// From the "turn these emails off" link in a notification email. Asks first
// (mail scanners open links; only a click here changes anything). Works
// without logging in: the link's token says who and which emails.
export default function UnsubscribePage() {
    const [params] = useSearchParams();
    const token = params.get("token");
    const [done, setDone] = useState<string | null>(null);
    const unsubscribe = useMutation({
        mutationFn: () => api<{ event: string; label: string }>("/api/notifications/unsubscribe", { method: "POST", body: { token } }),
        onSuccess: ({ label }) => setDone(label),
    });

    return (
        <Card className="mx-auto max-w-md p-6 text-center sm:p-8">
            <title>Email preferences · sendRetrieve</title>
            {done ? (
                <>
                    <MailCheck className="mx-auto size-10 text-emerald-500" aria-hidden />
                    <h1 className="mt-3 text-xl font-semibold">You won't get these emails anymore</h1>
                    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400" role="status">
                        Turned off: emails when {done.charAt(0).toLowerCase() + done.slice(1)}. You can change this any time in{" "}
                        <Link to="/account#notifications" className="font-medium underline underline-offset-2">
                            your account settings
                        </Link>
                        .
                    </p>
                </>
            ) : (
                <>
                    <MailX className="mx-auto size-10 text-zinc-400" aria-hidden />
                    <h1 className="mt-3 text-xl font-semibold">Turn off these emails?</h1>
                    <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                        You'll stop getting this kind of email from sendRetrieve. Other notifications aren't affected.
                    </p>
                    {!token && <Alert tone="error" className="mt-4">This link is incomplete. Open it again from the email.</Alert>}
                    {unsubscribe.error && <Alert tone="error" className="mt-4">{unsubscribe.error.message}</Alert>}
                    <Button className="mt-6 w-full" size="lg" disabled={!token} loading={unsubscribe.isPending} onClick={() => unsubscribe.mutate()}>
                        Turn off these emails
                    </Button>
                </>
            )}
        </Card>
    );
}
