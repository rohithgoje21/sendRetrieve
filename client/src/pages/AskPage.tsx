import { Sparkles } from "lucide-react";
import { AgentChat } from "@/components/AgentChat";

export default function AskPage() {
    return (
        <div className="space-y-6">
            <title>Ask · sendRetrieve</title>
            <div>
                <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
                    <Sparkles className="size-6" aria-hidden /> Ask
                </h1>
                <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
                    Ask about your own shares, activity or notifications.
                </p>
            </div>
            <AgentChat endpoint="/api/agent/me/ask" placeholder="e.g. Which of my shares expire soonest?" />
        </div>
    );
}
