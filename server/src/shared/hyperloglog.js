// HyperLogLog: estimates how many distinct items were seen, in a fixed small
// space, without keeping the items. There are 2^P registers; each item's hash
// picks one register and a "rank" (how many leading zero bits follow), and the
// register keeps the largest rank it has seen. Sketches merge by taking the
// largest value of each register, so per-day sketches add up to a range.
//
// With P = 10 (1024 registers) the typical error is about 3%; small counts
// are nearly exact (linear counting).
//
// Registers are stored sparsely as { [index]: rank }: in MongoDB an update is
// a single atomic { $max: { "visitors.<index>": rank } }, which is safe with
// concurrent workers and harmless if a message is processed twice.

const P = 10;
const M = 1 << P;
const ALPHA = 0.7213 / (1 + 1.079 / M);
const REST_BITS = 64 - P;

// From a 64-bit hash (16 hex characters): which register, and its rank.
const registerOf = (hashHex) => {
    const value = BigInt(`0x${hashHex.slice(0, 16).padStart(16, "0")}`);
    const index = Number(value >> BigInt(REST_BITS));
    const rest = value & ((1n << BigInt(REST_BITS)) - 1n);
    let rank = 1;
    for (let bit = BigInt(REST_BITS - 1); bit >= 0n && ((rest >> bit) & 1n) === 0n; bit--) rank++;
    return { index, rank };
};

// Register-wise maximum of any number of sketches.
const merge = (...sketches) => {
    const out = {};
    for (const sketch of sketches) {
        for (const [index, rank] of Object.entries(sketch ?? {})) {
            if (!(out[index] >= rank)) out[index] = rank;
        }
    }
    return out;
};

const estimate = (sketch) => {
    let sum = 0;
    let zeros = M;
    for (const rank of Object.values(sketch ?? {})) {
        if (rank > 0) {
            sum += 2 ** -rank;
            zeros--;
        }
    }
    sum += zeros; // empty registers count 2^0
    let e = (ALPHA * M * M) / sum;
    // Small counts: linear counting is more accurate.
    if (e <= 2.5 * M && zeros > 0) e = M * Math.log(M / zeros);
    return Math.round(e);
};

module.exports = { registerOf, merge, estimate, REGISTERS: M };
