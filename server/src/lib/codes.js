const crypto = require("crypto");

// Uppercase only, without look-alikes (0/O, 1/I/L), so codes are easy to read
// aloud and type. 31^8 ≈ 850 billion combinations.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 8;
const CODE_PATTERN = new RegExp(`^[${ALPHABET}]{${CODE_LENGTH}}$`);

const generateCode = () => {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += ALPHABET[crypto.randomInt(ALPHABET.length)];
    }
    return code;
};

// Accepts "abcd-2345", " ABCD 2345 " etc. Returns null if it can't be a code.
const normalizeCode = (input) => {
    if (typeof input !== "string") return null;
    const code = input.replace(/[\s-]/g, "").toUpperCase();
    return CODE_PATTERN.test(code) ? code : null;
};

module.exports = { generateCode, normalizeCode, CODE_LENGTH };
