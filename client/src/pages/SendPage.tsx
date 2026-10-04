import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { CheckCircle2, Clock, Eye, FolderOpen, Lock, Send, ShieldAlert, ShieldCheck, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input, PasswordInput, Select, Textarea } from "@/components/ui/inputs";
import { Alert, Badge, Card, PageSpinner } from "@/components/ui/feedback";
import { Dropzone, FileIcon, SelectedFileList } from "@/components/files";
import { UploadPanel } from "@/components/UploadPanel";
import { CopyButton } from "@/components/CopyButton";
import { QrCodeButton } from "@/components/QrCode";
import { ShareActivity } from "@/components/ShareActivity";
import { useShareActivity, type LiveShareStatus } from "@/hooks/useRealtime";
import { useUpload } from "@/hooks/useUpload";
import { useConfig } from "@/hooks/useConfig";
import { fetchSession, useSession } from "@/hooks/useSession";
import { ApiError, isAbortError } from "@/lib/api";
import { formatCode, formatDateTime, formatRelative, formatSize } from "@/lib/format";
import { sessionKey, sharesKey } from "@/lib/queryClient";
import { discardUpload, matchFiles, type PendingUpload } from "@/lib/upload";
import { clearPendingUpload, loadPendingUpload } from "@/lib/pendingUpload";
import type { AppConfig, CreatedShare } from "@/lib/types";

const makeSchema = (config: AppConfig) =>
    z.object({
        text: z.string().max(config.maxTextLength, `Keep the message under ${config.maxTextLength.toLocaleString()} characters`),
        expiresIn: z.string(),
        maxViews: z.string(),
        password: z
            .string()
            .max(config.sharePassword.max, `Use at most ${config.sharePassword.max} characters`)
            .refine((p) => p === "" || p.length >= config.sharePassword.min, {
                message: `Use at least ${config.sharePassword.min} characters`,
            }),
    });

type SendValues = z.infer<ReturnType<typeof makeSchema>>;

const opensLabel = (n: number) => (n === 1 ? "Once" : `${n} times`);

function SendForm({ config, onSent }: { config: AppConfig; onSent: (share: CreatedShare) => void }) {
    const { user } = useSession();
    const queryClient = useQueryClient();
    const schema = useMemo(() => makeSchema(config), [config]);
    const form = useForm<SendValues>({
        resolver: zodResolver(schema),
        defaultValues: { text: "", expiresIn: config.defaultExpiry, maxViews: "unlimited", password: "" },
    });
    const { register, handleSubmit, setError, formState } = form;
    const { errors, isSubmitting } = formState;

    const [files, setFiles] = useState<File[]>([]);
    const [fileErrors, setFileErrors] = useState<string[]>([]);
    const upload = useUpload(
        useCallback(
            (share: CreatedShare) => {
                if (share.owned) queryClient.invalidateQueries({ queryKey: sharesKey });
                onSent(share);
            },
            [queryClient, onSent]
        )
    );
    // Once an upload has started, the form belongs to that share.
    const busy = isSubmitting || upload.state.phase !== "idle";

    const showError = (err: unknown) => {
        if (isAbortError(err)) return;
        const field = err instanceof ApiError ? err.data.field : undefined;
        const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
        if (field === "password" || field === "text") setError(field, { message });
        else setError("root", { message });
    };

    const addFiles = (incoming: File[]) => {
        const next = [...files];
        const problems: string[] = [];
        for (const file of incoming) {
            if (next.length >= config.maxFiles) {
                problems.push(`You can send up to ${config.maxFiles} files at once.`);
                break;
            }
            if (file.size > config.maxFileSizeBytes) {
                problems.push(`${file.name} is larger than ${formatSize(config.maxFileSizeBytes)}.`);
                continue;
            }
            const duplicate = next.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified);
            if (!duplicate) next.push(file);
        }
        setFiles(next);
        setFileErrors(problems);
    };

    const onSubmit = handleSubmit(async (values) => {
        if (!values.text.trim() && files.length === 0) {
            setError("root", { message: "Add a message or at least one file." });
            return;
        }

        try {
            // Signed in? Make sure the session is fresh, so the share is saved
            // to the account rather than created as a guest share.
            if (user) await queryClient.fetchQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 0 });

            await upload.start({
                text: values.text,
                expiresIn: values.expiresIn,
                maxViews: values.maxViews === "unlimited" ? null : Number(values.maxViews),
                password: values.password,
                files,
            });
        } catch (err) {
            showError(err);
        }
    });

    return (
        <Card className="p-5 sm:p-6">
            <form onSubmit={onSubmit} noValidate>
                <fieldset disabled={busy} className="space-y-5">
                    <Field label="Message" optional error={errors.text?.message}>
                        <Textarea rows={5} placeholder="Type or paste text" {...register("text")} />
                    </Field>

                    <div className="space-y-2">
                        <span className="text-sm font-medium">
                            Files <span className="font-normal text-zinc-500 dark:text-zinc-400">(optional)</span>
                        </span>
                        <Dropzone
                            onFiles={addFiles}
                            disabled={busy}
                            hint={`Up to ${config.maxFiles} files, ${formatSize(config.maxFileSizeBytes)} each`}
                        />
                        {fileErrors.length > 0 && <Alert tone="warning">{fileErrors.join(" ")}</Alert>}
                        <SelectedFileList
                            files={files}
                            disabled={busy}
                            onRemove={(index) => setFiles((current) => current.filter((_, i) => i !== index))}
                        />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Expires after">
                            <Select {...register("expiresIn")}>
                                {config.expiryOptions.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {option.label}
                                    </option>
                                ))}
                            </Select>
                        </Field>
                        <Field label="Can be opened">
                            <Select {...register("maxViews")}>
                                <option value="unlimited">Unlimited times</option>
                                {config.viewLimitOptions.map((n) => (
                                    <option key={n} value={String(n)}>
                                        {opensLabel(n)}
                                    </option>
                                ))}
                            </Select>
                        </Field>
                    </div>

                    <Field
                        label="Password"
                        optional
                        error={errors.password?.message}
                        hint="Anyone opening the share will need it."
                    >
                        <PasswordInput autoComplete="new-password" placeholder="No password" {...register("password")} />
                    </Field>

                    {errors.root && <Alert tone="error">{errors.root.message}</Alert>}
                </fieldset>

                <div className="mt-6">
                    {upload.state.phase !== "idle" && files.length > 0 ? (
                        <UploadPanel
                            state={upload.state}
                            onPause={upload.pause}
                            onResume={() => upload.resume().catch(showError)}
                            onCancel={() => {
                                upload.cancel();
                                toast("Upload cancelled");
                            }}
                        />
                    ) : (
                        <Button type="submit" size="lg" className="w-full" loading={isSubmitting}>
                            {!isSubmitting && <Send aria-hidden />}
                            {isSubmitting ? "Sending…" : "Create share"}
                        </Button>
                    )}
                </div>

                <p className="mt-4 text-center text-xs text-zinc-500 dark:text-zinc-400">
                    {user ? (
                        <>
                            Signed in: this share will appear in{" "}
                            <Link to="/shares" className="font-medium underline underline-offset-2">
                                My shares
                            </Link>
                            .
                        </>
                    ) : (
                        <>
                            <Link to="/login" className="font-medium underline underline-offset-2">
                                Log in
                            </Link>{" "}
                            to keep track of your shares and delete them early.
                        </>
                    )}
                </p>
            </form>
        </Card>
    );
}

function BlockedResult({ status, onReset }: { status: Extract<LiveShareStatus, { status: "blocked" }>; onReset: () => void }) {
    return (
        <Card className="animate-fade-in p-6 text-center sm:p-8">
            <title>Share blocked · sendRetrieve</title>
            <ShieldAlert className="mx-auto size-10 text-red-500" aria-hidden />
            <h2 className="mt-3 text-xl font-semibold">Share blocked</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400" role="alert">
                {status.fileName ? `"${status.fileName}"` : "One of the files"} contains malware
                {status.signature && <span className="font-mono text-xs"> ({status.signature})</span>}. The share was removed and
                its files deleted, so nobody can download them.
            </p>
            <Button variant="secondary" className="mt-6" onClick={onReset}>
                Send something else
            </Button>
        </Card>
    );
}

function SendResult({ share, onReset }: { share: CreatedShare; onReset: () => void }) {
    const code = formatCode(share.code);
    const { activity, connected, status } = useShareActivity(share.code, share.manageToken, share.status);
    const scanning = status.status === "processing";

    if (status.status === "blocked") return <BlockedResult status={status} onReset={onReset} />;

    return (
        <Card className="animate-fade-in p-6 text-center sm:p-8">
            <title>Share created · sendRetrieve</title>
            {scanning ? (
                <>
                    <ShieldCheck className="mx-auto size-10 animate-pulse text-indigo-500" aria-hidden />
                    <h2 className="mt-3 text-xl font-semibold">Checking your files…</h2>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400" role="status">
                        Scanning for malware. You can send the code now: it opens as soon as the scan is done, usually in seconds.
                    </p>
                </>
            ) : (
                <>
                    <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden />
                    <h2 className="mt-3 text-xl font-semibold">Your share is ready</h2>
                    <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400" role="status">
                        Send the code or the link to whoever needs it.
                    </p>
                </>
            )}

            <div className="mt-6 rounded-xl bg-zinc-50 px-4 py-5 dark:bg-zinc-800/50">
                <p className="text-xs font-medium tracking-wide text-zinc-500 dark:text-zinc-400 uppercase">Share code</p>
                <p className="mt-1 font-mono text-4xl font-bold tracking-[0.15em] sm:text-5xl" data-testid="share-code">
                    {code}
                </p>
                <CopyButton value={code} label="Copy code" className="mt-3" />
            </div>

            <div className="mt-4 flex gap-2">
                <Input readOnly value={share.url} aria-label="Share link" onFocus={(e) => e.target.select()} />
                <CopyButton value={share.url} label="Copy link" size="md" />
            </div>

            <div className="mt-3 flex justify-center">
                <QrCodeButton url={share.url} code={share.code} />
            </div>

            <div className="mt-4 flex flex-wrap justify-center gap-2">
                <Badge>
                    <Clock className="size-3" aria-hidden />
                    <span title={formatDateTime(share.expiresAt)}>Expires {formatRelative(share.expiresAt)}</span>
                </Badge>
                <Badge>
                    <Eye className="size-3" aria-hidden />
                    {share.maxViews === null ? "Unlimited opens" : share.maxViews === 1 ? "Can be opened once" : `Can be opened ${share.maxViews} times`}
                </Badge>
                {share.passwordProtected && (
                    <Badge>
                        <Lock className="size-3" aria-hidden />
                        Password protected
                    </Badge>
                )}
            </div>

            <div className="mt-6">
                <ShareActivity activity={activity} connected={connected} />
            </div>

            <p className="mt-6 text-sm text-zinc-600 dark:text-zinc-400">
                {share.owned ? (
                    <>
                        Saved to{" "}
                        <Link to="/shares" className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100">
                            My shares
                        </Link>
                        , where you can track or delete it.
                    </>
                ) : (
                    <>
                        <Link to="/signup" className="font-medium text-zinc-900 underline underline-offset-2 dark:text-zinc-100">
                            Create an account
                        </Link>{" "}
                        to track your shares and delete them early.
                    </>
                )}
            </p>

            <Button variant="ghost" className="mt-4" onClick={onReset}>
                Send something else
            </Button>
        </Card>
    );
}

// An upload this browser started earlier and didn't finish (closed tab,
// lost connection). The browser can't reopen files by itself, so the user
// picks the same files again; only what the server doesn't have is sent.
function ResumeUploadCard({
    pending,
    onDone,
    onDiscarded,
}: {
    pending: PendingUpload;
    onDone: (share: CreatedShare) => void;
    onDiscarded: () => void;
}) {
    const upload = useUpload(onDone);
    const input = useRef<HTMLInputElement>(null);
    const [error, setError] = useState<string | null>(null);
    const total = pending.files.reduce((sum, f) => sum + f.size, 0);

    // Errors that end the upload for good (e.g. it expired): back to the form.
    const giveUp = (err: unknown) => {
        if (isAbortError(err)) return;
        toast.error(err instanceof Error ? err.message : "This upload can't be resumed.");
        onDiscarded();
    };

    const choose = (chosen: File[]) => {
        const match = matchFiles(pending, chosen);
        if ("missing" in match) {
            setError(`Choose the same files you started with. Missing: ${match.missing.join(", ")}.`);
            return;
        }
        setError(null);
        upload.resume({ pending, files: match.files }).catch(giveUp);
    };

    const discard = () => {
        if (upload.state.phase !== "idle") upload.cancel();
        else {
            discardUpload(pending);
            clearPendingUpload();
        }
        toast("Upload discarded");
        onDiscarded();
    };

    return (
        <Card className="animate-fade-in p-5 sm:p-6">
            <title>Finish your upload · sendRetrieve</title>
            <div className="flex items-start gap-3">
                <UploadCloud className="mt-0.5 size-6 shrink-0 text-indigo-500" aria-hidden />
                <div className="min-w-0">
                    <h2 className="text-lg font-semibold">Finish your upload</h2>
                    <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                        Share {formatCode(pending.code)} · started {formatRelative(pending.startedAt)} ·{" "}
                        {formatSize(total)}
                    </p>
                </div>
            </div>

            <ul className="mt-4 space-y-1.5" aria-label="Files in this upload">
                {pending.files.map((f) => (
                    <li key={`${f.name}-${f.size}`} className="flex items-center gap-2.5 text-sm">
                        <FileIcon mimeType={f.type} />
                        <span className="min-w-0 flex-1 truncate">{f.name}</span>
                        <span className="shrink-0 text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">{formatSize(f.size)}</span>
                    </li>
                ))}
            </ul>

            <div className="mt-5">
                {upload.state.phase === "idle" ? (
                    <div className="space-y-3">
                        <p className="text-sm text-zinc-600 dark:text-zinc-400">
                            Choose the same files again to pick up where the upload stopped. What's already uploaded
                            isn't sent twice.
                        </p>
                        {error && <Alert tone="error">{error}</Alert>}
                        <input
                            ref={input}
                            type="file"
                            multiple
                            hidden
                            aria-label="Choose the same files"
                            onChange={(e) => {
                                choose(Array.from(e.target.files ?? []));
                                e.target.value = "";
                            }}
                        />
                        <div className="flex gap-2">
                            <Button size="lg" className="flex-1" onClick={() => input.current?.click()}>
                                <FolderOpen aria-hidden />
                                Choose files
                            </Button>
                            <Button size="lg" variant="ghost" onClick={discard}>
                                Discard
                            </Button>
                        </div>
                    </div>
                ) : (
                    <UploadPanel
                        state={upload.state}
                        onPause={upload.pause}
                        onResume={() => upload.resume().catch(giveUp)}
                        onCancel={discard}
                    />
                )}
            </div>
        </Card>
    );
}

export default function SendPage() {
    const { data: config, error } = useConfig();
    const [result, setResult] = useState<CreatedShare | null>(null);
    // An unfinished upload from an earlier visit, if any.
    const [pending, setPending] = useState(loadPendingUpload);

    if (error) return <Alert tone="error">Couldn't load the app's settings. Refresh to try again.</Alert>;
    if (!config) return <PageSpinner />;
    if (result) return <SendResult share={result} onReset={() => setResult(null)} />;
    if (pending) {
        return (
            <ResumeUploadCard
                pending={pending}
                onDone={(share) => {
                    setPending(null);
                    setResult(share);
                }}
                onDiscarded={() => setPending(null)}
            />
        );
    }
    return <SendForm config={config} onSent={setResult} />;
}
