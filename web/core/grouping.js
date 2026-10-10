// Bulk import: which photos (pages) belong to the same game?
//
// Every photo is read on its own. A page continues the game before it when it
// looks like a later page of the same scoresheet:
//   - no player names on it (or the same names as the game before), and
//   - its first move number continues where the previous page stopped
//     (41 after 40), or it restarts at 1 after a full previous page, and
//   - the game before hasn't ended ("uppg.", "remi", "tid" or a result).
// Any number of pages can be chained. The user can always join or split.

const FULL_PAGE = 20;   // a page that ends at move 20 or later is "full"
const NUMBER_SLACK = 2; // a continuing page may skip a row or two

const firstRow = (reading) => (reading.pages[0] && reading.pages[0].rows[0]) || null;
const lastRow = (reading) => {
  const rows = (reading.pages[0] && reading.pages[0].rows) || [];
  return rows[rows.length - 1] || null;
};
const names = (reading) => [reading.headers.white, reading.headers.black].map((n) => (n || "").trim().toLowerCase());

/** Does `page` look like the next page of the game whose pages are `game`?
 *  Both are normalized single-page readings. Returns [yes, reason]. */
export function continues(game, page) {
  const first = game[0], last = game[game.length - 1];
  const row = firstRow(page);
  if (!row) return [false, "nothing read on this photo"];
  if (game.some((p) => p.end_marker)) return [false, "the game before has ended"];
  const [w, b] = names(page);
  const [gw, gb] = names(first);
  const unnamed = !w && !b;
  const sameNames = !unnamed && w === gw && b === gb;
  if (!unnamed && !sameNames) return [false, "other players"];
  const prev = lastRow(last);
  const prevNumber = prev && prev.number;
  const number = row.number;
  if (number && prevNumber && number > 1 && Math.abs(number - (prevNumber + 1)) <= NUMBER_SLACK) {
    return [true, `moves continue (${prevNumber} → ${number})`];
  }
  if (number === 1 && prevNumber >= FULL_PAGE && (unnamed || sameNames)) {
    return [true, "numbering restarts on a new page"];
  }
  return [false, "moves don't continue"];
}

/** Photos in order -> games: [[page index, ...], ...] plus why each page was
 *  joined, for showing the suggestion to the user. */
export function groupPages(readings) {
  const groups = [];
  const reasons = [];
  readings.forEach((reading, i) => {
    const current = groups[groups.length - 1];
    const [yes, why] = current ? continues(current.map((j) => readings[j]), reading) : [false, "first photo"];
    if (yes) current.push(i);
    else groups.push([i]);
    reasons[i] = why;
  });
  return { groups, reasons };
}
