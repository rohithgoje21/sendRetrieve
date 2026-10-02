import { Outlet, useLocation } from "react-router";
import { Download, Upload } from "lucide-react";
import { SegmentedControl } from "@/components/ui/SegmentedControl";

// Shared header and Send/Retrieve switch for the home page's two modes.
export default function HomeShell() {
    const { pathname } = useLocation();
    const retrieving = pathname === "/open" || pathname.startsWith("/s/");

    return (
        <div className="mx-auto max-w-xl">
            <div className="mb-8 text-center">
                <h1 className="text-3xl font-bold tracking-tight text-balance sm:text-4xl">Share text and files</h1>
                <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                    Get a short code. Shares delete themselves when they expire.
                </p>
            </div>
            <SegmentedControl
                label="Send or retrieve"
                items={[
                    { key: "send", label: "Send", icon: Upload, to: "/", active: !retrieving },
                    { key: "retrieve", label: "Retrieve", icon: Download, to: "/open", active: retrieving },
                ]}
            />
            <div className="mt-4">
                <Outlet />
            </div>
        </div>
    );
}
