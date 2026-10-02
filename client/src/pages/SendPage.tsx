import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { toast } from "sonner";
import { CheckCircle2, Clock, Eye, Lock, Send } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Field } from "@/components/ui/Field";
import { Input, PasswordInput, Select, Textarea } from "@/components/ui/inputs";
import { Alert, Badge, Card, PageSpinner, Progress } from "@/components/ui/feedback";
import { Dropzone, SelectedFileList } from "@/components/files";
import { CopyButton } from "@/components/CopyButton";
import { useConfig } from "@/hooks/useConfig";
import { fetchSession, useSession } from "@/hooks/useSession";
import { ApiError, isAbortError } from "@/lib/api";
import { formatCode, formatDateTime, formatRelative, formatSize } from "@/lib/format";
import { sessionKey, sharesKey } from "@/lib/queryClient";
import { createShare } from "@/lib/upload";
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
    const [progress, setProgress] = useState<{ loaded: number; total: number } | null>(null);
    // Set while an upload is running, so it can be cancelled.
    const [upload, setUpload] = useState<AbortController | null>(null);

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

        const body = new FormData();
        if (values.text.trim()) body.append("text", values.text);
        body.append("expiresIn", values.expiresIn);
        body.append("maxViews", values.maxViews);
        if (values.password) body.append("password", values.password);
        files.forEach((file) => body.append("files", file));

        const controller = new AbortController();
        setUpload(controller);
        if (files.length) setProgress({ loaded: 0, total: files.reduce((sum, f) => sum + f.size, 0) });

        try {
            // Signed in? Refresh the session now, so a long upload isn't
            // rejected (or saved as a guest share) because it expired.
            if (user) await queryClient.fetchQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 0 });

            const share = await createShare(body, {
                signal: controller.signal,
                onProgress: (loaded, total) => setProgress({ loaded, total }),
            });
            if (share.owned) queryClient.invalidateQueries({ queryKey: sharesKey });
            onSent(share);
        } catch (err) {
            if (isAbortError(err)) {
                toast("Upload cancelled");
            } else {
                const field = err instanceof ApiError ? err.data.field : undefined;
                const message = err instanceof Error ? err.message : "Something went wrong. Please try again.";
                if (field === "password" || field === "text") setError(field, { message });
                else setError("root", { message });
            }
        } finally {
            setProgress(null);
            setUpload(null);
        }
    });

    const percent = progress && progress.total > 0 ? (progress.loaded / progress.total) * 100 : 0;

    return (
        <Card className="p-5 sm:p-6">
            <form onSubmit={onSubmit} noValidate>
                <fieldset disabled={isSubmitting} className="space-y-5">
                    <Field label="Message" optional error={errors.text?.message}>
                        <Textarea rows={5} placeholder="Type or paste text" {...register("text")} />
                    </Field>

                    <div className="space-y-2">
                        <span className="text-sm font-medium">
                            Files <span className="font-normal text-zinc-500">(optional)</span>
                        </span>
                        <Dropzone
                            onFiles={addFiles}
                            disabled={isSubmitting}
                            hint={`Up to ${config.maxFiles} files, ${formatSize(config.maxFileSizeBytes)} each`}
                        />
                        {fileErrors.length > 0 && <Alert tone="warning">{fileErrors.join(" ")}</Alert>}
                        <SelectedFileList
                            files={files}
                            disabled={isSubmitting}
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

                    {progress && (
                        <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs text-zinc-600 dark:text-zinc-400">
                                <span>Uploading… {Math.round(percent)}%</span>
                                <span className="tabular-nums">
                                    {formatSize(progress.loaded)} / {formatSize(progress.total)}
                                </span>
                            </div>
                            <Progress value={percent} label="Upload progress" />
                        </div>
                    )}
                </fieldset>

                <div className="mt-6 flex gap-2">
                    <Button type="submit" size="lg" className="flex-1" loading={isSubmitting}>
                        {!isSubmitting && <Send aria-hidden />}
                        {isSubmitting ? "Sending…" : "Create share"}
                    </Button>
                    {upload && progress && (
                        <Button size="lg" variant="secondary" onClick={() => upload.abort()}>
                            Cancel
                        </Button>
                    )}
                </div>

                <p className="mt-4 text-center text-xs text-zinc-500">
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

function SendResult({ share, onReset }: { share: CreatedShare; onReset: () => void }) {
    const code = formatCode(share.code);
    return (
        <Card className="animate-fade-in p-6 text-center sm:p-8">
            <title>Share created · sendRetrieve</title>
            <CheckCircle2 className="mx-auto size-10 text-emerald-500" aria-hidden />
            <h2 className="mt-3 text-xl font-semibold">Your share is ready</h2>
            <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Send the code or the link to whoever needs it.</p>

            <div className="mt-6 rounded-xl bg-zinc-50 px-4 py-5 dark:bg-zinc-800/50">
                <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">Share code</p>
                <p className="mt-1 font-mono text-4xl font-bold tracking-[0.15em] sm:text-5xl" data-testid="share-code">
                    {code}
                </p>
                <CopyButton value={code} label="Copy code" className="mt-3" />
            </div>

            <div className="mt-4 flex gap-2">
                <Input readOnly value={share.url} aria-label="Share link" onFocus={(e) => e.target.select()} />
                <CopyButton value={share.url} label="Copy link" size="md" />
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

export default function SendPage() {
    const { data: config, error } = useConfig();
    const [result, setResult] = useState<CreatedShare | null>(null);

    if (error) return <Alert tone="error">Couldn't load the app's settings. Refresh to try again.</Alert>;
    if (!config) return <PageSpinner />;
    return result ? (
        <SendResult share={result} onReset={() => setResult(null)} />
    ) : (
        <SendForm config={config} onSent={setResult} />
    );
}
