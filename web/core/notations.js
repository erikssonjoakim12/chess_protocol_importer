// Notation profiles: the piece letters a scoresheet is written in, and the
// handwriting slips typical for those letters. The matching logic (notation.js,
// resolver.js) is the same for every language; only these tables differ.
//
// To add a language: add a profile here (and its letters to the AI prompt in
// gemini.js if they're new), then add tests in web/tests/notation.test.js.

// Look-alike characters that don't depend on the language: digits, files.
const COMMON_LOOKALIKES = [
  "49", "4y", "9y", "9g", "9q", "gq", "17", "1l", "1i",
  "38", "35", "56", "6b", "6G", "0O", "0o", "Oo",
  "ce", "ae", "ad", "ag", "hb", "hk", "hn", "ft", "fl", "28", "2z", "uh",
];

export const NOTATIONS = {
  swedish: {
    id: "swedish",
    name: "Swedish",
    note: "also German, Danish, Norwegian",
    // English SAN piece letter -> the letter used on this kind of sheet.
    pieces: { K: "K", Q: "D", R: "T", B: "L", N: "S" },
    // Letters from other notations that may turn up on a mixed sheet.
    foreign: { K: "K", Q: "D", R: "T", B: "L", N: "S" },
    // Lower-case letters that can't be files, so must be a sloppy piece letter.
    lowercasePieces: "stlk",
    lookalikes: [...COMMON_LOOKALIKES, "7T", "1L", "3S", "5S", "DP", "Dd", "KR", "Kk", "Ss", "Ll", "Tt"],
  },
  english: {
    id: "english",
    name: "English",
    note: "",
    pieces: { K: "K", Q: "Q", R: "R", B: "B", N: "N" },
    foreign: { D: "Q", T: "R", L: "B", S: "N" },
    lowercasePieces: "nrqk",  // not "b": that is a file
    lookalikes: [...COMMON_LOOKALIKES, "8B", "3B", "0Q", "OQ", "9Q", "HN", "KR", "Kk", "Rr", "Nn", "Qq"],
  },
};

export const DEFAULT_NOTATION = "swedish";

export function notation(id) {
  return NOTATIONS[id] || NOTATIONS[DEFAULT_NOTATION];
}
