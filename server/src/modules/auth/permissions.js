// Role-based access control. Routes ask for permissions, not roles
// (authorize("users.disable")), so what each role may do is decided here.
//
//   user         their own shares and account
//   admin        moderation: stats, regular users, shares, background jobs
//   superadmin   everything: also roles, admins, and destructive operations
//
// Superadmins can't be changed through the API at all, only with
// scripts/set-role.js, so no admin can lock the others out.

const ADMIN = [
    "admin.access", // the admin area and site-wide stats
    "users.read",
    "users.disable", // disable/enable regular users
    "users.logout", // log a user out everywhere
    "shares.moderate",
    "queues.read",
    "queues.replay",
];

const PERMISSIONS = {
    user: [],
    admin: ADMIN,
    superadmin: [
        ...ADMIN,
        "users.roles", // change roles; manage admins
        "queues.purge",
    ],
};

const ROLES = Object.keys(PERMISSIONS);

const permissionsFor = (role) => PERMISSIONS[role] ?? [];

const can = (user, permission) => permissionsFor(user?.role).includes(permission);

module.exports = { ROLES, PERMISSIONS, permissionsFor, can };
