// The pure request-shaping helpers, lifted out of the route handlers so they
// can be tested without a database or a browser. Both routes were carrying
// their own copy of idList; this is now the single one.

// A post URL is the primary key of linkedin_posts, so two spellings of the
// same post must not become two rows. Query strings are where that goes wrong:
// every share button appends its own tracking params, so the same post arrives
// as ?utm_source=..., ?rcm=..., or bare. Dropping search and hash makes those
// collapse onto one row and hit the existing-capture path.
//
// Returns null rather than throwing — a bad URL is user error, and the caller
// reports it alongside the other field checks instead of in a catch.
export function cleanLinkedInUrl(value) {
  try {
    const url = new URL(value);
    // Puppeteer will navigate anywhere it is pointed. Without these two
    // guards this is a request forgery hole: the server would happily load
    // http://internal-admin:8080 and hand back a screenshot of it.
    if (url.protocol !== 'https:') return null;
    // Anchored both ends, and a leading dot or start-of-string before the
    // domain. `foo.linkedin.com` passes; `notlinkedin.com` and
    // `linkedin.com.evil.test` do not.
    if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return null;
    return url.origin + url.pathname;
  } catch {
    return null;
  }
}

// Checkbox ids arrive as JSON from the browser, so nothing about their type is
// guaranteed. Coerce, drop anything that is not a positive integer, and
// de-dupe — a repeated id would otherwise fan out into duplicate placement
// rows that the upsert has to absorb.
//
// The concat handles a lone value as well as an array: a form with one
// programme ticked may send `3` rather than `[3]`.
export function idList(value) {
  const ids = [...new Set([].concat(value ?? []).map(Number))];
  return ids.filter((id) => Number.isInteger(id) && id > 0);
}

// Every ticked programme paired with every ticked tab — ticking 2 programmes
// and 3 tabs files the post in 6 places. Callers pass ids that have already
// been through idList, so the pairs are unique by construction.
export function placementPairs(programmeIds, tabIds) {
  return programmeIds.flatMap((programme_id) =>
    tabIds.map((tab_id) => ({ programme_id, tab_id }))
  );
}

// The form takes a whole list at once, so one paste has to survive whatever
// shape it arrives in: one URL per line out of a spreadsheet column, or a
// comma-separated run typed by hand. Splitting on whitespace covers the first.
// The comma split is deliberately narrow — it only fires where the next piece
// begins a URL of its own, because a comma is legal inside a path or query
// string and splitting on every one would cut those in half.
//
// Cleaning happens here rather than in the caller so the de-dupe is on the
// *cleaned* URL. Two share links of the same post differ only in their
// tracking params; without this they would go out as two captures of what is
// one row in linkedin_posts.
//
// Invalid entries come back rather than being dropped: silently skipping a
// mistyped line in a paste of thirty is how a post goes missing unnoticed.
export function parseUrlList(value) {
  const urls = [];
  const invalid = [];
  const seen = new Set();

  const tokens = String(value ?? '')
    .split(/\s+/)
    .flatMap((token) => token.split(/,(?=https?:\/\/)/))
    // "https://a, https://b" splits on the space and leaves the comma stuck to
    // the first token.
    .map((token) => token.replace(/[,;]+$/, ''))
    .filter(Boolean);

  for (const token of tokens) {
    const url = cleanLinkedInUrl(token);
    // One set for both lists is safe: a token that matched a cleaned URL would
    // itself have cleaned successfully, so the two can never collide.
    const entry = url ?? token;
    if (seen.has(entry)) continue;
    seen.add(entry);
    (url ? urls : invalid).push(entry);
  }

  return { urls, invalid };
}
