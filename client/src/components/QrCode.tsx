import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Download, QrCode as QrIcon } from "lucide-react";
import { formatCode } from "@/lib/format";
import { Button } from "./ui/Button";
import { Modal } from "./ui/Modal";
import { Skeleton } from "./ui/feedback";
import { buttonClasses } from "./ui/styles";

// Generated in the browser: the share link never leaves the page.
function useQrDataUrl(text: string) {
    const [dataUrl, setDataUrl] = useState<string | null>(null);
    useEffect(() => {
        let cancelled = false;
        QRCode.toDataURL(text, { width: 480, margin: 2, errorCorrectionLevel: "M" })
            .then((url) => !cancelled && setDataUrl(url))
            .catch(() => !cancelled && setDataUrl(null));
        return () => {
            cancelled = true;
        };
    }, [text]);
    return dataUrl;
}

export function QrCodeImage({ url, code }: { url: string; code: string }) {
    const dataUrl = useQrDataUrl(url);
    return (
        <div className="flex flex-col items-center gap-3">
            {dataUrl ? (
                // White background even in dark mode: scanners need the contrast.
                <img
                    src={dataUrl}
                    alt={`QR code for share ${formatCode(code)}`}
                    className="size-56 rounded-xl border border-zinc-200 bg-white p-1 dark:border-zinc-700"
                />
            ) : (
                <Skeleton className="size-56 rounded-xl" />
            )}
            <p className="text-center text-xs text-zinc-500 dark:text-zinc-400">Scan with a phone camera to open the share.</p>
            {dataUrl && (
                <a href={dataUrl} download={`sendretrieve-${code}.png`} className={buttonClasses({ variant: "secondary", size: "sm" })}>
                    <Download aria-hidden />
                    Download PNG
                </a>
            )}
        </div>
    );
}

// A "QR code" button that opens the code in a dialog.
export function QrCodeButton({ url, code, size = "sm" }: { url: string; code: string; size?: "sm" | "md" }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button variant="secondary" size={size} onClick={() => setOpen(true)}>
                <QrIcon aria-hidden />
                QR code
            </Button>
            <Modal open={open} title={`Share ${formatCode(code)}`} onClose={() => setOpen(false)}>
                {open && <QrCodeImage url={url} code={code} />}
            </Modal>
        </>
    );
}
