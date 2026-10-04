import type { Permission, User } from "./types";

// What the signed-in user's role allows (the server sends the list; it also
// enforces it, so this only decides what to show).
export const can = (user: User | null | undefined, permission: Permission): boolean =>
    Boolean(user?.permissions?.includes(permission));

export const ADMIN_PERMISSIONS: Permission[] = [
    "admin.access",
    "users.read",
    "users.disable",
    "users.logout",
    "shares.moderate",
    "queues.read",
    "queues.replay",
];
export const SUPERADMIN_PERMISSIONS: Permission[] = [...ADMIN_PERMISSIONS, "users.roles", "queues.purge"];
