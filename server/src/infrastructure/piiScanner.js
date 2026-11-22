const { hasCreditCard, hasAwsAccessKey, hasPrivateKeyBlock, hasApiToken } = require("./piiPatterns");

// A share's text, checked for commonly-leaked secrets. Advisory only: the
// caller decides what to do with the result (sendRetrieve warns, never
// blocks — unlike malware, sharing your own card number or a key with a
// teammate can be intentional). Not exhaustive: a clean result means
// "nothing obvious was found", not "this is safe to share".
const DETECTORS = [
    ["credit_card", hasCreditCard],
    ["aws_access_key", hasAwsAccessKey],
    ["private_key", hasPrivateKeyBlock],
    ["api_token", hasApiToken],
];

const scanText = (text) => {
    if (!text) return { categories: [] };
    return { categories: DETECTORS.filter(([, test]) => test(text)).map(([category]) => category) };
};

module.exports = { scanText };
