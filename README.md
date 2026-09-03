# LinkedIn Posts

Capture a LinkedIn post as a screenshot and file it under one or more
programmes and tabs.

## Setup

1. `npm install`
2. Run `schema.sql` in the Supabase SQL editor. It creates the tables, the
   storage bucket, and seeds the programmes and tabs.
3. Copy `.env.example` to `.env.local` and fill in the Supabase URL and the
   **secret** key (`sb_secret_...`, or the legacy `service_role` JWT). The
   publishable key will not work — RLS is on with no policies, so only the
   service role can read or write.
4. `npm run dev`

`LINKEDIN_LI_AT` is optional. Without it LinkedIn serves the logged-out view of
a post, which works but renders some author avatars as grey placeholders.

## Tests

```
npm test        # unit tests, no network, no browser
npm run preflight -- "<post url>" ["<post url>" ...]
```

`npm test` covers the pure request-shaping in `lib/validate.js` — URL
normalisation, id coercion, the pasted-list parsing, and the programme x tab
fan-out. Worth knowing what
`cleanLinkedInUrl` is actually holding: `url` is unique in `linkedin_posts`, so
stripping the query string is what stops one post arriving twice under two
different share links; and the cleaned URL goes straight to `page.goto`, so the
https and hostname checks are what stop this endpoint being pointed at an
internal address.

`npm run preflight` is the one that answers "will captures work once this is
deployed". It loads each URL, reports what LinkedIn actually served — public
page, logged-in markup, or a sign-in wall — and then runs the real
`capturePost`, exiting non-zero if any fail.

**Run it on the deployed server, not on a laptop.** That is the whole point of
it. A laptop sits on a residential IP that LinkedIn treats as an ordinary
visitor; a cloud host sits in a datacenter range LinkedIn recognises, and gets
the sign-in wall far more readily. Passing locally says nothing about
production, and the app reports both a dead URL and a blocked one as the same
`Post not found on that page` — the preflight is what tells them apart.

If it reports a sign-in wall, that is the case `LINKEDIN_LI_AT` exists for.
Nothing is mocked in either command: the thing under test in the preflight is
LinkedIn's real response to this machine, so a stub would only test the stub.

## How posts are filed

Three ideas, kept apart on purpose:

- `programmes` — UG, PG, Executive Education, PGP Bharat.
- `tabs` — the shared vocabulary: Life, Faculty, Curriculum, Careers,
  Entrepreneurship, Dropshipping. There is exactly one "Life" row.
- `programme_tabs` — which tabs a programme shows. A programme has many tabs,
  and a tab is reused by many programmes.

Because "Life" is a single row that every programme links to, filtering on
**All programmes + Life** collects Life posts from every programme in one
query. If each programme owned a private copy of "Life", that would have to
match on name instead.

A post is one row in `linkedin_posts`, keyed by its URL. Where it appears lives
in `post_placements` — one row per programme/tab pair. That is what lets a
single URL show up under several programmes and several tabs at once without
capturing it more than once.

The form takes a whole list of URLs at once. Paste them one per line (commas
work too), tick the programmes and tabs, and every post in the list is filed in
the same places. Duplicates collapse before anything is sent, because the
de-dupe runs on the *cleaned* URL — two share links of one post are one
capture.

Ticking two programmes and three tabs on the form creates six placements per
post. Add the same URL again later with different boxes ticked and it reuses
the existing screenshot and just adds the new placements. Filing a post under a programme
that doesn't have that tab yet links the tab to the programme first, so the
pair always exists before a post points at it.

Programmes and tabs can be added from the form via the "+ New programme" /
"+ New tab" links. A new tab is linked to whichever programmes are ticked at
the time; a new programme starts with the full tab list. To take a tab away
from one programme, delete its `programme_tabs` row — the posts filed under
that pair go with it.

## Feed API

`GET /api/feed` returns everything the display site needs in one call. It sends
permissive CORS headers, so a site on another origin can call it directly.

Query parameters, all optional: `programme` and `tab` take ids, `limit`
defaults to 60 and caps at 200.

```
GET /api/feed
GET /api/feed?tab=1              // Life posts across every programme
GET /api/feed?programme=2&tab=1  // Life posts in PG Programmes
```

```jsonc
{
  "programmes": [
    { "id": 1, "name": "UG Programmes", "tabs": [{ "id": 1, "name": "Life" }] }
  ],
  "tabs": [{ "id": 1, "name": "Life" }],
  "filter": { "programme_id": null, "tab_id": null },
  "posts": [
    {
      "id": 1,
      "url": "https://www.linkedin.com/posts/...",
      "screenshot_url": "https://....supabase.co/storage/v1/object/public/...",
      "created_at": "2026-09-01T07:03:04.211337+00:00",
      "placements": [
        { "programme_id": 1, "programme": "UG Programmes", "tab_id": 2, "tab": "Faculty" }
      ]
    }
  ]
}
```

Each programme carries its own `tabs` array, so the tab strip can be rendered
per programme without a second call. The top-level `tabs` is the full list, for
the "All programmes" state. Every post lists all of its `placements`, even when
the response is filtered, so you can tell where else a post appears.

## Capture notes

Screenshots are taken with Puppeteer. Two things that matter and are easy to
regress:

- LinkedIn ships collage images with **no `src` at all**, only a
  `data-delayed-url`. An image with no source reports `complete === true`, so
  waiting on `complete` skips them entirely. `capture.js` promotes those URLs
  and then waits on `decode()`, which resolves only once pixels are paintable.
- Chrome rasterises roughly a viewport's worth of content. A post card taller
  than the window screenshots with everything below the fold blank even though
  the images loaded. `capture.js` grows the viewport to the full card height
  before taking the shot.

Tick "Take a fresh screenshot even if this URL is already saved" on the form to
redo a bad capture; the old file is deleted from storage.

A pasted list is sent one URL per request, from the browser, rather than as one
call to `/api/posts` carrying the list. `maxDuration` on that route is 60s and a
single capture can spend most of that on `page.goto` alone, so a batch in one
request would be killed part-way through with no way to tell which posts had
been saved. One request each also keeps a dead URL from costing anything but
itself: the run carries on, the failures go back into the box with their
reasons, and clicking again retries only those.

## Serving screenshots from UnionStack

By default screenshots live in the public Supabase bucket. Setting
`UNIONSTACK_API_KEY` sends them to UnionStack instead and stores the returned
CDN URL on the row. Nothing downstream changes, because the feed API and the
display site only ever read `screenshot_url`.

Uploads happen **on the server**, in `lib/cdn.js`, using the Node entry point of
the official SDK:

```js
import { UnionStack } from '@masters-union/union-stack/node';

const client = UnionStack.init({ apiKey: process.env.UNIONSTACK_API_KEY });
const file = await client.upload(buffer, { filename, mimeType: 'image/png' });
// file.url -> https://files.unionstack.in/f/V1StGXR8_Z5jdHi6B-myT
```

The screenshot is a Buffer produced by Puppeteer, never a file on disk and
never a browser file input, so `filename` and `mimeType` are passed explicitly —
the SDK only infers them when uploading from a path.

`UNIONSTACK_API_KEY` must be a **server key**: leave its allowed-origins list
empty in the UnionStack dashboard. A browser key would be rejected with code
`AUTH`, since these uploads come from the Next.js server and carry no `Origin`
header. No key is ever sent to the client — the browser never uploads anything
in this app.

A failed upload falls back to Supabase and logs the reason rather than failing
the request: the browser run is the expensive part of a capture, so a CDN
outage should not throw away a screenshot that already cost seconds to take.
Errors carry a stable `code` (`AUTH`, `VALIDATION`, `QUOTA`, `NETWORK`, …) which
is included in the log line. Existing rows keep whatever URL they were stored
with — nothing is migrated — and on re-capture only Supabase-hosted files are
deleted, since this app does not own the UnionStack store.
