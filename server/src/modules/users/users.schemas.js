const { z } = require("zod");
const { accountPassword, name, requiredString } = require("../../shared/schemas");

const updateProfile = z.object({ name });
const changePassword = z.object({ currentPassword: requiredString("Current password"), newPassword: accountPassword });
const deleteAccount = z.object({ password: requiredString("Password") });

module.exports = { updateProfile, changePassword, deleteAccount };
