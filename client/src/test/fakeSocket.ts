// A stand-in for a Socket.IO client socket: tests read what the app emitted
// and fire server events at it, with no server involved.

type Handler = (payload?: unknown) => void;

export class FakeSocket {
    connected = false;
    emitted: { event: string; payload: unknown }[] = [];
    // What the auth callback produced on the last connect.
    lastAuth: Record<string, unknown> | null = null;
    private handlers = new Map<string, Set<Handler>>();
    private authFn: ((cb: (data: Record<string, unknown>) => void) => void) | null = null;

    constructor(options?: { auth?: (cb: (data: Record<string, unknown>) => void) => void }) {
        this.authFn = options?.auth ?? null;
    }

    on(event: string, handler: Handler) {
        if (!this.handlers.has(event)) this.handlers.set(event, new Set());
        this.handlers.get(event)!.add(handler);
        return this;
    }

    off(event: string, handler: Handler) {
        this.handlers.get(event)?.delete(handler);
        return this;
    }

    emit(event: string, payload?: unknown) {
        this.emitted.push({ event, payload });
        return this;
    }

    connect() {
        if (this.connected) return this;
        const done = (auth: Record<string, unknown>) => {
            this.lastAuth = auth;
            this.connected = true;
            this.fire("connect");
        };
        if (this.authFn) this.authFn(done);
        else done({});
        return this;
    }

    disconnect() {
        if (!this.connected) return this;
        this.connected = false;
        this.fire("disconnect");
        return this;
    }

    // Simulates an event from the server.
    fire(event: string, payload?: unknown) {
        for (const handler of [...(this.handlers.get(event) ?? [])]) handler(payload);
    }

    reset() {
        this.emitted = [];
    }
}

export const fakeSockets: FakeSocket[] = [];

// The app's single socket (created on first use).
export const appSocket = () => fakeSockets[0];
