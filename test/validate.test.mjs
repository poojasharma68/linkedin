import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanLinkedInUrl, idList, parseUrlList, placementPairs } from '../lib/validate.js';

const POST = 'https://www.linkedin.com/posts/mastersunion_activity-7268000000000000000-AbCd';

test('cleanLinkedInUrl', async (t) => {
  await t.test('keeps a plain post URL intact', () => {
    assert.equal(cleanLinkedInUrl(POST), POST);
  });

  await t.test('accepts linkedin subdomains', () => {
    // in.linkedin.com is what an Indian share link often carries.
    assert.equal(
      cleanLinkedInUrl('https://in.linkedin.com/posts/abc'),
      'https://in.linkedin.com/posts/abc'
    );
    assert.equal(cleanLinkedInUrl('https://linkedin.com/posts/abc'), 'https://linkedin.com/posts/abc');
  });

  await t.test('strips tracking params so one post stays one row', () => {
    // url is unique in linkedin_posts. Every share button appends different
    // params, and keeping them would insert a second row plus a second
    // screenshot for a post that is already captured.
    const tracked = `${POST}?utm_source=share&utm_medium=member_desktop&rcm=ACoAAA`;
    assert.equal(cleanLinkedInUrl(tracked), POST);
  });

  await t.test('strips the hash', () => {
    assert.equal(cleanLinkedInUrl(`${POST}#comments`), POST);
  });

  await t.test('two spellings of one post normalise to the same key', () => {
    assert.equal(
      cleanLinkedInUrl(`${POST}?utm_source=share`),
      cleanLinkedInUrl(`${POST}?rcm=ACoAAA&trk=feed`)
    );
  });

  await t.test('rejects non-https', () => {
    // Not style: the cleaned URL is handed straight to page.goto, so anything
    // that is not https is a navigation this server should refuse.
    assert.equal(cleanLinkedInUrl('http://www.linkedin.com/posts/abc'), null);
    assert.equal(cleanLinkedInUrl('file:///etc/passwd'), null);
    assert.equal(cleanLinkedInUrl('javascript:alert(1)'), null);
  });

  await t.test('rejects lookalike hostnames', () => {
    // The regex is anchored at both ends with a required dot or string start,
    // which is what keeps these out. A substring match would let all four in
    // and turn the capture endpoint into a request-forgery tool.
    for (const host of [
      'https://notlinkedin.com/posts/abc',
      'https://evil-linkedin.com/posts/abc',
      'https://linkedin.com.evil.test/posts/abc',
      'https://linkedin.co/posts/abc',
    ]) {
      assert.equal(cleanLinkedInUrl(host), null, host);
    }
  });

  await t.test('rejects internal hosts', () => {
    assert.equal(cleanLinkedInUrl('https://localhost:8080/admin'), null);
    assert.equal(cleanLinkedInUrl('https://169.254.169.254/latest/meta-data/'), null);
  });

  await t.test('returns null for anything that is not a URL', () => {
    for (const value of ['', '   ', 'not a url', '/posts/abc', null, undefined, 42, {}, []]) {
      assert.equal(cleanLinkedInUrl(value), null, JSON.stringify(value));
    }
  });
});

test('idList', async (t) => {
  await t.test('passes through positive integers', () => {
    assert.deepEqual(idList([1, 2, 3]), [1, 2, 3]);
  });

  await t.test('coerces the numeric strings a JSON body may carry', () => {
    assert.deepEqual(idList(['1', '2']), [1, 2]);
  });

  await t.test('wraps a lone value', () => {
    // One ticked checkbox can arrive as 3 rather than [3].
    assert.deepEqual(idList(3), [3]);
  });

  await t.test('de-dupes', () => {
    // A repeat would fan out into duplicate placement rows for the upsert to
    // absorb, and inflate the "filed in N places" count shown to the user.
    assert.deepEqual(idList([2, 2, '2', 3]), [2, 3]);
  });

  await t.test('drops everything that is not a positive integer', () => {
    assert.deepEqual(idList([0, -1, 2.5, NaN, 'abc', null, '', 4]), [4]);
  });

  await t.test('returns an empty list for no input', () => {
    // The routes rely on this: `!programmeIds.length` is what produces the
    // 400 rather than a crash further down.
    assert.deepEqual(idList(undefined), []);
    assert.deepEqual(idList(null), []);
    assert.deepEqual(idList([]), []);
  });
});

test('placementPairs', async (t) => {
  await t.test('2 programmes x 3 tabs files the post in 6 places', () => {
    const pairs = placementPairs([1, 2], [10, 20, 30]);
    assert.equal(pairs.length, 6);
    assert.deepEqual(pairs[0], { programme_id: 1, tab_id: 10 });
    assert.deepEqual(pairs.at(-1), { programme_id: 2, tab_id: 30 });
  });

  await t.test('every pair is unique', () => {
    // post_placements is keyed on (post_id, programme_id, tab_id), so a
    // repeat here would be a primary key collision inside one upsert.
    const pairs = placementPairs([1, 2, 3], [10, 20]);
    const keys = new Set(pairs.map((p) => `${p.programme_id}:${p.tab_id}`));
    assert.equal(keys.size, pairs.length);
  });

  await t.test('an empty side yields no pairs', () => {
    assert.deepEqual(placementPairs([], [1, 2]), []);
    assert.deepEqual(placementPairs([1, 2], []), []);
  });

  await t.test('one and one is a single placement', () => {
    assert.deepEqual(placementPairs([1], [10]), [{ programme_id: 1, tab_id: 10 }]);
  });
});

test('parseUrlList', async (t) => {
  await t.test('splits a pasted column into one URL per line', () => {
    const pasted = `${POST}\n${POST}-two\n\n  ${POST}-three  `;
    const { urls, invalid } = parseUrlList(pasted);
    assert.deepEqual(urls, [POST, `${POST}-two`, `${POST}-three`]);
    assert.deepEqual(invalid, []);
  });

  await t.test('accepts a comma-separated list, with or without spaces', () => {
    const { urls } = parseUrlList(`${POST}, ${POST}-two,${POST}-three`);
    assert.deepEqual(urls, [POST, `${POST}-two`, `${POST}-three`]);
  });

  await t.test('leaves a comma inside a URL alone', () => {
    // The split only fires where the next piece starts its own URL, so a
    // comma in a path or a tracking param does not cut the URL in half.
    const { urls, invalid } = parseUrlList(`${POST}?trk=a,b`);
    assert.deepEqual(urls, [POST]);
    assert.deepEqual(invalid, []);
  });

  await t.test('de-dupes on the cleaned URL, not the pasted text', () => {
    // The point of the whole batch: two share links of one post differ only in
    // their tracking params, and sending both would be two captures of what is
    // a single row in linkedin_posts.
    const { urls } = parseUrlList(`${POST}?utm_source=share\n${POST}?rcm=ACoAAA\n${POST}`);
    assert.deepEqual(urls, [POST]);
  });

  await t.test('reports bad entries instead of dropping them', () => {
    // Silently skipping one mistyped line in a paste of thirty is how a post
    // goes missing without anyone noticing.
    const { urls, invalid } = parseUrlList(`${POST}\nnot a url\nhttp://www.linkedin.com/posts/x`);
    assert.deepEqual(urls, [POST]);
    assert.deepEqual(invalid, ['not', 'a', 'url', 'http://www.linkedin.com/posts/x']);
  });

  await t.test('a lookalike host is invalid, not just skipped', () => {
    const { urls, invalid } = parseUrlList('https://linkedin.com.evil.test/posts/abc');
    assert.deepEqual(urls, []);
    assert.deepEqual(invalid, ['https://linkedin.com.evil.test/posts/abc']);
  });

  await t.test('empty input yields nothing at all', () => {
    // The form relies on this for its "paste at least one URL" message.
    for (const value of ['', '   \n  ', null, undefined]) {
      assert.deepEqual(parseUrlList(value), { urls: [], invalid: [] }, JSON.stringify(value));
    }
  });
});
