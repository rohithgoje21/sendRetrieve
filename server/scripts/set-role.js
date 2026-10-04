// Gives a user a role, e.g. to create the first superadmin (who can then
// manage admins from the admin page):
//
//   npm run set-role -w server -- ada@example.com superadmin
//   docker compose exec app node scripts/set-role.js ada@example.com superadmin
//
// The only way to change a superadmin's role.
//
// Uses the same MONGODB_URI as the server (server/.env or the environment).

const mongoose = require("mongoose");
const config = require("../src/config");
const User = require("../src/modules/users/user.model");

const [email, role] = process.argv.slice(2);

const main = async () => {
    if (!email || !User.ROLES.includes(role)) {
        console.error(`Usage: node scripts/set-role.js <email> <${User.ROLES.join("|")}>`);
        process.exitCode = 1;
        return;
    }
    await mongoose.connect(config.mongoUri);
    try {
        const user = await User.findOneAndUpdate({ email: email.trim().toLowerCase() }, { role }, { new: true });
        if (!user) {
            console.error(`No account with email ${email}`);
            process.exitCode = 1;
            return;
        }
        console.log(`${user.email} is now ${user.role}. They may need to log out and back in to see the change.`);
    } finally {
        await mongoose.disconnect();
    }
};

main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
