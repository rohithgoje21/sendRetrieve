const crypto = require("crypto");
const os = require("os");
const { promisify } = require("util");
const bcrypt = require("bcryptjs");
const config = require("../config");

// Password hashing (accounts and password-protected shares).
//
// scrypt, from Node's crypto module, runs on libuv's thread pool. Hashing is
// slow on purpose, and doing it on the main thread (bcryptjs, until the load
// tests showed it) stalled every other request: at 2 logins a second the
// event loop lagged over a second and unrelated pages took seconds.
//
// Parameters: N=2^15, r=8, p=3 (32 MiB), one of OWASP's equivalent scrypt
// settings. Stored as "scrypt$N$r$p$salt$hash" (base64), so parameters can
// change later. Hashes made with bcrypt still verify; accounts are re-hashed
// on their next login (needsRehash).

// At most this many hashes at once; the rest wait their turn. Hashing is pure
// CPU: unbounded, a burst of logins takes every core (and libuv thread) and
// slows every other request with it. Bounded, only logins slow down under
// overload. (The load tests: 3x traffic with 16 threads hashing made share
// opens 20x slower.)
const MAX_CONCURRENT = Math.max(1, Math.min(3, os.availableParallelism() - 1));
let active = 0;
const waiting = [];
const limited = async (fn) => {
    if (active >= MAX_CONCURRENT) await new Promise((resolve) => waiting.push(resolve));
    active++;
    try {
        return await fn();
    } finally {
        active--;
        waiting.shift()?.();
    }
};

const scryptAsync = promisify(crypto.scrypt);
const scrypt = (...args) => limited(() => scryptAsync(...args));
const KEY_LENGTH = 64;
// Tests use cheap parameters, as they did with bcrypt.
const PARAMS = config.env === "test" ? { N: 2 ** 10, r: 8, p: 1 } : { N: 2 ** 15, r: 8, p: 3 };
const maxmem = (N, r) => 128 * N * r * 2;

const hashPassword = async (password) => {
    const salt = crypto.randomBytes(16);
    const { N, r, p } = PARAMS;
    const key = await scrypt(password, salt, KEY_LENGTH, { N, r, p, maxmem: maxmem(N, r) });
    return `scrypt$${N}$${r}$${p}$${salt.toString("base64")}$${key.toString("base64")}`;
};

const verifyPassword = async (password, stored) => {
    if (typeof password !== "string" || typeof stored !== "string") return false;
    if (stored.startsWith("$2")) return bcrypt.compare(password, stored); // older bcrypt hash
    const [scheme, N, r, p, salt, hash] = stored.split("$");
    if (scheme !== "scrypt" || !hash) return false;
    const expected = Buffer.from(hash, "base64");
    const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, {
        N: Number(N),
        r: Number(r),
        p: Number(p),
        maxmem: maxmem(Number(N), Number(r)),
    });
    return crypto.timingSafeEqual(key, expected);
};

// Made with an older scheme or weaker parameters than today's.
const needsRehash = (stored) => {
    const [scheme, N, r, p] = String(stored).split("$");
    return scheme !== "scrypt" || Number(N) !== PARAMS.N || Number(r) !== PARAMS.r || Number(p) !== PARAMS.p;
};

// For comparing against when an account doesn't exist, so a login for an
// unknown email takes as long as one with a wrong password.
let dummy = null;
const dummyHash = () => (dummy ??= hashPassword("not-a-real-password"));

module.exports = { hashPassword, verifyPassword, needsRehash, dummyHash };
