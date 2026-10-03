const { HttpError } = require("./errors");

// Parses `data` with a Zod schema, or throws a 400 with the first problem.
const parse = (schema, data) => {
    const result = schema.safeParse(data ?? {});
    if (!result.success) {
        const issue = result.error.issues[0];
        const field = issue.path.join(".");
        throw new HttpError(400, issue.message, field ? { field } : {});
    }
    return result.data;
};

const validateBody = (schema) => (req, res, next) => {
    req.body = parse(schema, req.body);
    next();
};

module.exports = { parse, validateBody };
