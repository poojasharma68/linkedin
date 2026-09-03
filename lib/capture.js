import puppeteer from 'puppeteer';

// A logged-out visitor and a logged-in one get different markup for the same
// post URL. Ordered outermost-card first — see the pick below.
const POST_SELECTORS = [
  'div.feed-shared-update-v2',
  'article.main-feed-activity-card',
  'div[data-id^="urn:li:activity"]',
];

// Everything that is page chrome rather than the post. The sticky site header
// matters most: it paints over the top of the card and hides the author row.
const STRIP_SELECTORS = [
  'header.base-detail-page__header',
  '.top-level-modal-container',
  '#public_post_contextual-sign-in',
  '.modal__overlay',
  '.authwall',
  '.cta-modal',
  'section.comment',
  '.social-action-bar',
  '.feed-cta-banner__text',
  '.main-feed-activity-card__ellipsis-menu',
];

const VIEWPORT_WIDTH = 1000;
// Chrome cannot rasterise a surface taller than roughly 16k device pixels; at
// deviceScaleFactor 2 that caps the usable card height here.
const MAX_VIEWPORT_HEIGHT = 8000;

// The API route this runs behind gives a request 60s. Every wait below is
// clamped to what is left of this budget, so a slow page fails with its own
// message instead of being cut off mid-screenshot by the platform.
const CAPTURE_BUDGET_MS = 45000;
// How long the post's media gets to finish once the card itself is up.
const MEDIA_TIMEOUT_MS = 20000;
const MEDIA_POLL_MS = 250;
// Nothing in flight is not the same as nothing left to come: LinkedIn sets a
// src a beat after its loader decides an image is in view, so the card has to
// look unchanged for a stretch before it counts as done.
const MEDIA_STABLE_MS = 1500;
// Longer when something visible still has no URL at all, since that is what an
// image about to be asked for looks like. Placeholders that never get one cost
// this much and no more.
const MEDIA_MISSING_GRACE_MS = 3000;
// A loaded-but-broken image only fails the capture if it is big enough to show
// as a hole in the shot; a 16px reaction icon is not worth a retry.
const MEDIA_MIN_AREA = 1024;

let browserPromise = null;

async function getBrowser() {
  if (browserPromise) {
    const browser = await browserPromise;
    if (browser.connected) return browser;
  }
  browserPromise = puppeteer.launch({ args: ['--no-sandbox'] });
  browserPromise.catch(() => { browserPromise = null; });
  return browserPromise;
}

// The singleton above is deliberately never closed during a request — reusing
// one Chrome is most of the speed. But an open browser keeps the event loop
// alive, so anything that calls capturePost outside the server (a script, a
// SIGTERM handler) needs a way to let the process end.
export async function closeBrowser() {
  if (!browserPromise) return;
  const pending = browserPromise;
  browserPromise = null;
  await pending.then((browser) => browser.close()).catch(() => {});
}

// Runs in the page, once per poll. Promotes whatever LinkedIn has left lazy,
// then reports what the screenshot would still be missing if it fired now.
//
// `complete` is the trap: it means the fetch settled, and it is true for an
// image that was never given a URL at all. So each image is sorted by why it
// has no pixels — still in flight (worth waiting for), fetched and failed, or
// never asked for (waiting cannot help either of those).
function inspectMedia(root, minArea) {
  const report = { total: 0, loading: 0, broken: 0, missing: 0 };

  for (const img of root.querySelectorAll('img')) {
    // Post media, reaction icons and badges ship with an empty src and a
    // data-delayed-url that LinkedIn's own lazy loader only swaps in on
    // scroll. Promote them by hand and drop native lazy loading, or they
    // screenshot blank. Repeated every poll, because the loader keeps adding
    // more of them as the card grows.
    const delayed = img.dataset.delayedUrl ?? img.dataset.src;
    if (delayed && img.src !== delayed) img.src = delayed;
    img.loading = 'eager';

    const src = img.currentSrc || img.getAttribute('src');

    // Checked before the size filter below: an image still in flight often
    // measures 0x0 because nothing has told the layout how big it will be, and
    // those are precisely the ones that pop in just after the shot.
    if (src && !img.complete) {
      report.total++;
      report.loading++;
      continue;
    }

    const rect = img.getBoundingClientRect();
    if (rect.width * rect.height < minArea) continue;
    report.total++;

    if (!src) report.missing++;
    else if (!img.naturalWidth) report.broken++;
  }

  return report;
}

export async function capturePost(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  const deadline = Date.now() + CAPTURE_BUDGET_MS;
  // Puppeteer reads a timeout of 0 as "wait forever", so never hand it a spent
  // budget as one.
  const budget = (ms) => Math.max(1, Math.min(ms, deadline - Date.now()));

  try {
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 900, deviceScaleFactor: 2 });
    if (process.env.LINKEDIN_LI_AT) {
      await browser.setCookie({
        name: 'li_at',
        value: process.env.LINKEDIN_LI_AT,
        domain: '.linkedin.com',
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: budget(30000) });

    // Wait for any known container to render, then pick by list order rather
    // than by whichever resolved first: early in the load a narrower selector
    // can match an inner block (a video wrapper) that React later replaces.
    await Promise.any(
      POST_SELECTORS.map((selector) => page.waitForSelector(selector, { timeout: budget(20000) }))
    ).catch(() => {});

    let post = null;
    for (const selector of POST_SELECTORS) {
      post = await page.$(selector);
      if (post) break;
    }
    if (!post) throw new Error('Post not found on that page');

    // The card keeps filling in after it first appears (video player, the
    // truncation toggle), and the tidy-up below needs those to exist. Proceed
    // anyway if LinkedIn's polling never lets the page go fully idle — the
    // media loop further down is what actually waits for the images.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: budget(5000) }).catch(() => {});

    await page.evaluate(async (selectors) => {
      // Long posts are truncated behind a "...more" toggle. The class covers
      // the logged-out page, the aria-label the logged-in one.
      document
        .querySelectorAll('.attributed-text-segment-list__btn-truncation, button[aria-label*="see more" i]')
        .forEach((button) => button.click());

      // A video player screenshots as a black rectangle, so show its poster
      // frame instead.
      document.querySelectorAll('video[poster]').forEach((video) => {
        const poster = document.createElement('img');
        poster.src = video.poster;
        poster.style.width = '100%';
        (video.closest('.share-native-video') ?? video).replaceWith(poster);
      });

      document.querySelectorAll(selectors.join(',')).forEach((el) => el.remove());
      // Left behind once the comments themselves are gone. Matched on text
      // because it shares its classes with the comment-count link we keep.
      document.querySelectorAll('a').forEach((a) => {
        if (/^\s*see more comments\s*$/i.test(a.textContent)) a.remove();
      });
      document.body.style.overflow = 'visible';

      // Some lazy loaders listen for scroll rather than intersection, so give
      // them the event too — the viewport grown below only covers the case
      // where they use an IntersectionObserver.
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);
    }, STRIP_SELECTORS);

    // Grow the viewport to the whole card, check the media, grow again. Chrome
    // only fetches and rasterises what is near the viewport, so a card taller
    // than the window screenshots with everything below the fold left blank —
    // which is what turned a multi-photo collage into empty grey cells. And
    // every image that lands makes the card taller, pushing more media into a
    // region that has never been near the viewport, so a single pass is not
    // enough. Loop until nothing is in flight: that, rather than any fixed
    // wait, is what "the post has finished loading" means.
    const mediaDeadline = Math.min(Date.now() + MEDIA_TIMEOUT_MS, deadline);
    let media = { total: 0, loading: 0, broken: 0, missing: 0 };
    let viewportHeight = 0;
    let previous = '';
    let unchangedSince = Date.now();

    while (true) {
      const box = await post.boundingBox();
      const height = Math.min(Math.ceil(box?.height ?? 0) + 200, MAX_VIEWPORT_HEIGHT);
      // Only ever grow. Shrinking mid-load would undo the reason for resizing.
      if (height > viewportHeight) {
        viewportHeight = height;
        await page.setViewport({ width: VIEWPORT_WIDTH, height, deviceScaleFactor: 2 });
      }

      media = await page.evaluate(inspectMedia, post, MEDIA_MIN_AREA);

      // The height rides along in the fingerprint so a card that is still
      // getting taller counts as moving, whatever its images say.
      const state = `${viewportHeight}:${media.total}:${media.loading}:${media.broken}:${media.missing}`;
      if (state !== previous) {
        previous = state;
        unchangedSince = Date.now();
      }

      const quietFor = Date.now() - unchangedSince;
      const needed = media.missing ? MEDIA_MISSING_GRACE_MS : MEDIA_STABLE_MS;
      if ((!media.loading && quietFor >= needed) || Date.now() >= mediaDeadline) break;
      await new Promise((resolve) => setTimeout(resolve, MEDIA_POLL_MS));
    }

    // Better no screenshot than a half-painted one. The image this produces is
    // the post as far as every later reader is concerned, and it is stored
    // once — so a capture that raced the images has to fail loudly rather than
    // be filed. Re-running it is cheap: the API route takes `recapture` for
    // exactly this.
    if (media.loading) {
      throw new Error(
        `Post images did not finish loading — ${media.loading} of ${media.total} still ` +
          `in flight after ${(MEDIA_TIMEOUT_MS / 1000).toFixed(0)}s. Try again.`
      );
    }

    // These two cannot be waited out: the URL 404s, or LinkedIn never filled
    // one in. Say so and take the shot, since a retry would do the same thing.
    if (media.broken || media.missing) {
      console.warn(
        `Capture of ${url}: ${media.broken} image(s) failed to load and ` +
          `${media.missing} never got a URL — screenshotting without them.`
      );
    }

    // Loaded is still not painted: decode() resolves once the pixels are ready,
    // where the `complete` check above only proves the bytes arrived. Each
    // image gets its own deadline so one slow decode cannot hang the capture.
    await page.evaluate(async (timeout) => {
      await Promise.all(
        [...document.images].map((img) =>
          Promise.race([
            img.decode().catch(() => {}),
            new Promise((done) => setTimeout(done, timeout)),
          ])
        )
      );
      // A webfont landing after the shot reflows the text under it.
      await document.fonts.ready;
    }, budget(8000));

    // Everything that just landed changed the card's height, and Chrome
    // rasterises only what the viewport covers — so measure once more, after
    // the last thing that can move the layout.
    const box = await post.boundingBox();
    if (box) {
      await page.setViewport({
        width: VIEWPORT_WIDTH,
        height: Math.min(Math.ceil(box.height) + 200, MAX_VIEWPORT_HEIGHT),
        deviceScaleFactor: 2,
      });
    }

    // Promoting the delayed URLs kicked off a fresh round of requests. Let
    // those settle before the shot rather than racing them.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: budget(5000) }).catch(() => {});

    return await post.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}
