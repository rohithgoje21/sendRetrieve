import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/inputs";
import { Alert, Card } from "@/components/ui/feedback";
import { api } from "@/lib/api";
import type { AgentAskResponse } from "@/lib/types";

interface Exchange {
    question: string;
    answer: string;
    toolCalls: AgentAskResponse["toolCalls"];
}

// A question -> answer assistant shared by the user-facing "Ask" page and the
// admin panel's version of it: same component, different endpoint and tool
// set server-side. Stateless per question (no persisted history): the
// exchange list below only lives for this page view.
export function AgentChat({ endpoint, placeholder }: { endpoint: string; placeholder: string }) {
    const [question, setQuestion] = useState("");
    const [exchanges, setExchanges] = useState<Exchange[]>([]);

    const ask = useMutation({
        mutationFn: (q: string) => api<AgentAskResponse>(endpoint, { method: "POST", body: { question: q } }),
        onSuccess: (result, q) => setExchanges((prev) => [{ question: q, ...result }, ...prev]),
    });

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        const trimmed = question.trim();
        if (!trimmed || ask.isPending) return;
        ask.mutate(trimmed);
        setQuestion("");
    };

    return (
        <Card className="p-4">
            <h2 className="flex items-center gap-2 font-semibold">
                <Sparkles className="size-4" aria-hidden /> Ask
            </h2>
            <form onSubmit={onSubmit} className="mt-3 flex flex-col gap-2 sm:flex-row">
                <Textarea
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    placeholder={placeholder}
                    rows={1}
                    className="min-h-10 flex-1"
                    aria-label="Ask a question"
                />
                <Button type="submit" loading={ask.isPending} disabled={!question.trim()}>
                    Ask
                </Button>
            </form>
            {ask.error && (
                <Alert tone="error" className="mt-3">
                    {ask.error.message}
                </Alert>
            )}
            {exchanges.length > 0 && (
                <ul className="mt-4 space-y-3">
                    {exchanges.map((exchange, i) => (
                        <li key={i} className="rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                            <p className="font-medium">{exchange.question}</p>
                            <p className="mt-1.5 text-zinc-700 dark:text-zinc-300">{exchange.answer}</p>
                            {exchange.toolCalls.length > 0 && (
                                <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                                    Looked at: {exchange.toolCalls.map((t) => t.name.replace(/_/g, " ")).join(", ")}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}
