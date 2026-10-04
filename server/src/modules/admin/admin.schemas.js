const { z } = require("zod");

const updateUser = z
    .object({
        role: z.enum(["user", "admin", "superadmin"], { error: "role must be user, admin or superadmin" }).optional(),
        disabled: z.boolean({ error: "disabled must be true or false" }).optional(),
    })
    .refine((v) => v.role !== undefined || v.disabled !== undefined, { message: "Nothing to change" });

module.exports = { updateUser };
