import { useRef, useState, type FormEvent } from "react";
import { useParams } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { Clock, Eye, KeyRound, Timer } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input, PasswordInput } from "@/components/ui/inputs";
import { Alert, Badge, Card } from "@/components/ui/feedback";
import { SharedContent } from "@/components/SharedContent";
import { api, ApiError } from "@/lib/api";
import { CODE_LENGTH, formatDateTime, formatRelative, normalizeCodeInput, stripCode } from "@/lib/format";
import type { OpenedShare } from "@/lib/types";

function OpenedShareView({ share, onDone }: { share: OpenedShare; onDone: () => void }) {
    const minutes = Math.round(share.downloadWindowSeconds / 60);
    return (
        <Card className="animate-fade-in space-y-5 p-5 sm:p-6">
            {share.viewsRemaining === 0 && (
                <Alert tone="warning">
                    That was the last allowed view, so the share is now closed.
                    {share.files.length > 0 && ` Download the files within ${minutes} minutes.`}
                </Alert>
            )}

            <SharedContent text={share.text} files={share.files} />

            <div className="flex flex-wrap gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                {share.viewsRemaining !== 0 && (
                    <Badge>
                        <Clock className="size-3" aria-hidden />
                        <span title={formatDateTime(share.expiresAt)}>Expires {formatRelative(share.expiresAt)}</span>
                    </Badge>
                )}
                {share.viewsRemaining !== null && share.viewsRemaining > 0 && (
                    <Badge>
                        <Eye className="size-3" aria-hidden />
                        {share.viewsRemaining === 1 ? "1 more open allowed" : `${share.viewsRemaining} more opens allowed`}
                    </Badge>
                )}
                {share.files.length > 0 && (
                    <Badge>
                        <Timer className="size-3" aria-hidden />
                        Download links work for {minutes} minutes
                    </Badge>
                )}
            </div>

            <Button variant="ghost" className="w-full" onClick={onDone}>
                Open another code
            </Button>
        </Card>
    );
}

function RetrieveForm({ initialCode }: { initialCode: string }) {
    const [code, setCode] = useState(() => normalizeCodeInput(initialCode));
    const [password, setPassword] = useState("");
    const [needsPassword, setNeedsPassword] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [share, setShare] = useState<OpenedShare | null>(null);
    const passwordRef = useRef<HTMLInputElement>(null);

    const open = useMutation({
        mutationFn: () =>
            api<OpenedShare>(`/api/shares/${stripCode(code)}/open`, {
                method: "POST",
                body: needsPassword ? { password } : {},
            }),
        onSuccess: (opened) => {
            setShare(opened);
            setError(null);
        },
        onError: (err) => {
            if (err instanceof ApiError && err.data.passwordRequired) {
                // The first time, it's a prompt rather than an error.
                setError(needsPassword ? err.message : null);
                setNeedsPassword(true);
                requestAnimationFrame(() => passwordRef.current?.focus());
            } else {
                setError(err.message);
            }
        },
    });

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        if (stripCode(code).length !== CODE_LENGTH) {
            setError("Share codes are 8 characters, like 7KX9-2PMQ.");
            return;
        }
        open.mutate();
    };

    if (share) {
        return (
            <OpenedShareView
                share={share}
                onDone={() => {
                    setShare(null);
                    setCode("");
                    setPassword("");
                    setNeedsPassword(false);
                }}
            />
        );
    }

    return (
        <Card className="p-5 sm:p-6">
            <form onSubmit={onSubmit} noValidate className="space-y-5">
                <Field label="Share code" hint="You'll find it in the message or link you were sent.">
                    <Input
                        value={code}
                        onChange={(e) => {
                            setCode(normalizeCodeInput(e.target.value));
                            // A different code may not need a password.
                            setNeedsPassword(false);
                            setPassword("");
                            setError(null);
                        }}
                        placeholder="XXXX-XXXX"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        autoFocus={!initialCode}
                        className="h-14 text-center font-mono text-2xl tracking-[0.2em] uppercase placeholder:tracking-[0.2em]"
                    />
                </Field>

                {needsPassword && (
                    <div className="animate-fade-in space-y-3">
                        <Alert tone="info">
                            <span className="inline-flex items-center gap-1.5">
                                <KeyRound className="size-4" aria-hidden /> This share is password protected.
                            </span>
                        </Alert>
                        <Field label="Password">
                            <PasswordInput
                                ref={passwordRef}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                autoComplete="off"
                            />
                        </Field>
                    </div>
                )}

                {error && <Alert tone="error">{error}</Alert>}

                <Button type="submit" size="lg" className="w-full" loading={open.isPending}>
                    {open.isPending ? "Opening…" : "Open share"}
                </Button>
                <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">
                    Opening a share counts as a view. Some shares can only be opened once.
                </p>
            </form>
        </Card>
    );
}

// /open and /s/:code. Keyed by code so following another link starts fresh.
export default function RetrievePage() {
    const { code = "" } = useParams();
    return (
        <>
            <title>Retrieve · sendRetrieve</title>
            <RetrieveForm key={code} initialCode={code} />
        </>
    );
}
