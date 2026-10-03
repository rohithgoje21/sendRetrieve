const { hashToken, randomToken, tokenMatchesHash } = require("../../shared/crypto");

// A share's manage token is given to whoever created it, guest or not. It
// lets them finish or cancel the upload and watch the share live. Stored hashed.

const createManageToken = () => {
    const token = randomToken();
    return { token, hash: hashToken(token) };
};

const manageTokenMatches = (share, token) => tokenMatchesHash(token, share?.manageTokenHash);

module.exports = { createManageToken, manageTokenMatches };
