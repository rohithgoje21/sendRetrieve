const config = require("../config");

// Base URL for links we hand out (share links, password reset emails).
const baseUrl = (req) => config.appUrl || `${req.protocol}://${req.get("host")}`;

module.exports = { baseUrl };
