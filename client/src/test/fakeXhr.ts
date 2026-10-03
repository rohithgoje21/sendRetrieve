// A stand-in for XMLHttpRequest (used for uploads): records each request
// instead of sending it. `respond` decides each outcome: a status code,
// "error" (network failure) or "hold" (never finishes until aborted).
// Progress is reported in two halves.

export interface SentRequest {
    method: string;
    url: string;
    headers: Record<string, string>;
    body: Blob;
}

type Outcome = number | "error" | "hold";

export class FakeXHR {
    static sent: SentRequest[] = [];
    static respond: (request: SentRequest) => Outcome = () => 200;
    static aborted = 0;

    static reset() {
        FakeXHR.sent = [];
        FakeXHR.respond = () => 200;
        FakeXHR.aborted = 0;
    }

    // The bytes of each request body, as text.
    static async bodies() {
        return Promise.all(FakeXHR.sent.map((s) => s.body.text()));
    }

    upload: { onprogress: ((e: { loaded: number; total: number }) => void) | null } = { onprogress: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    status = 0;
    private method = "";
    private url = "";
    private headers: Record<string, string> = {};
    private done = false;

    open(method: string, url: string) {
        this.method = method;
        this.url = url;
    }
    setRequestHeader(name: string, value: string) {
        this.headers[name] = value;
    }
    send(body: Blob) {
        const request = { method: this.method, url: this.url, headers: this.headers, body };
        FakeXHR.sent.push(request);
        const outcome = FakeXHR.respond(request);
        if (outcome === "hold") return;
        setTimeout(() => {
            if (this.done) return;
            this.done = true;
            if (outcome === "error") return this.onerror?.();
            this.upload.onprogress?.({ loaded: body.size / 2, total: body.size });
            this.upload.onprogress?.({ loaded: body.size, total: body.size });
            this.status = outcome;
            this.onload?.();
        }, 2);
    }
    abort() {
        if (this.done) return;
        this.done = true;
        FakeXHR.aborted++;
        this.onabort?.();
    }
}
