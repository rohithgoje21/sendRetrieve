/// <reference types="vite/client" />

interface ImportMetaEnv {
    // The API's origin, for the Socket.IO connection, when the frontend is
    // hosted separately from it (e.g. https://sendretrieve-api.onrender.com).
    readonly VITE_REALTIME_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
