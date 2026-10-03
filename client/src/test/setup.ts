import "@testing-library/jest-dom/vitest";
import { FakeSocket, fakeSockets } from "./fakeSocket";

// No real Socket.IO connections in tests: see fakeSocket.ts.
vi.mock("socket.io-client", () => ({
    io: (_url: unknown, options?: ConstructorParameters<typeof FakeSocket>[0]) => {
        const socket = new FakeSocket(options);
        fakeSockets.push(socket);
        return socket;
    },
}));

// jsdom doesn't implement these browser APIs.
if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function () {
        this.open = true;
    };
    HTMLDialogElement.prototype.close = function () {
        this.open = false;
        this.dispatchEvent(new Event("close"));
    };
}

if (!window.matchMedia) {
    window.matchMedia = (query: string) =>
        ({
            matches: false,
            media: query,
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => false,
        }) as MediaQueryList;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

// Used by React Router's <ScrollRestoration>; jsdom doesn't implement it.
window.scrollTo = () => {};
