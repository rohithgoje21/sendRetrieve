const { hasCreditCard, hasAwsAccessKey, hasPrivateKeyBlock, hasApiToken } = require("../src/infrastructure/piiPatterns");
const { scanText } = require("../src/infrastructure/piiScanner");

describe("hasCreditCard", () => {
    test("a Luhn-valid card number is caught, with spaces or dashes", () => {
        expect(hasCreditCard("my card is 4111 1111 1111 1111")).toBe(true);
        expect(hasCreditCard("card: 4111-1111-1111-1111")).toBe(true);
    });

    test("a 16-digit number that fails the Luhn check is not flagged", () => {
        expect(hasCreditCard("order number 4111111111111112")).toBe(false);
    });

    test("plain prose with no digits is not flagged", () => {
        expect(hasCreditCard("just some ordinary text about cards and numbers")).toBe(false);
    });
});

describe("hasAwsAccessKey", () => {
    test("an AWS access key id is caught", () => {
        expect(hasAwsAccessKey("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE")).toBe(true);
    });

    test("something that merely starts with AKIA but is the wrong shape is not flagged", () => {
        expect(hasAwsAccessKey("AKIA is a word I made up")).toBe(false);
    });
});

describe("hasPrivateKeyBlock", () => {
    test("a PEM private key header is caught", () => {
        expect(hasPrivateKeyBlock("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----")).toBe(true);
        expect(hasPrivateKeyBlock("-----BEGIN PRIVATE KEY-----")).toBe(true);
    });

    test("a public key is not flagged", () => {
        expect(hasPrivateKeyBlock("-----BEGIN PUBLIC KEY-----")).toBe(false);
    });
});

describe("hasApiToken", () => {
    test("a Bearer token is caught", () => {
        expect(hasApiToken("Authorization: Bearer not-a-real-token-just-a-test-fixture-value")).toBe(true);
    });

    test("a labeled api key is caught", () => {
        expect(hasApiToken("API_KEY=abcdefghijklmnopqrstuvwxyz0123456789")).toBe(true);
    });

    test("an ordinary short word near 'key' is not flagged", () => {
        expect(hasApiToken("the key to success is hard work")).toBe(false);
    });
});

describe("scanText", () => {
    test("combines every category found", () => {
        const text = "card 4111 1111 1111 1111 and AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";
        expect(scanText(text).categories.sort()).toEqual(["aws_access_key", "credit_card"]);
    });

    test("no text means no categories", () => {
        expect(scanText(null)).toEqual({ categories: [] });
        expect(scanText("")).toEqual({ categories: [] });
    });

    test("clean text has no categories", () => {
        expect(scanText("hey, here are the meeting notes from today")).toEqual({ categories: [] });
    });
});
