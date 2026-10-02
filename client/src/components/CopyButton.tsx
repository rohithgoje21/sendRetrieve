import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/Button";
import type { ButtonSize, ButtonVariant } from "./ui/styles";

interface CopyButtonProps {
    value: string;
    label?: string;
    variant?: ButtonVariant;
    size?: ButtonSize;
    className?: string;
}

export function CopyButton({ value, label = "Copy", variant = "secondary", size = "sm", className }: CopyButtonProps) {
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), 1500);
        return () => clearTimeout(timer);
    }, [copied]);

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
        } catch {
            toast.error("Couldn't copy to the clipboard");
        }
    };

    return (
        <Button variant={variant} size={size} onClick={copy} className={className}>
            {copied ? <Check className="text-emerald-600" aria-hidden /> : <Copy aria-hidden />}
            <span aria-live="polite">{copied ? "Copied" : label}</span>
        </Button>
    );
}
