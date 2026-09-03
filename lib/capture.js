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

export async function capturePost(url) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: VIEWPORT_WIDTH, height: 900, deviceScaleFactor: 2 });
    if (process.env.LINKEDIN_LI_AT) {
      await browser.setCookie({
        name: 'li_at',
        value: process.env.LINKEDIN_LI_AT,
        domain: '.linkedin.com',
      });
    }
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for any known container to render, then pick by list order rather
    // than by whichever resolved first: early in the load a narrower selector
    // can match an inner block (a video wrapper) that React later replaces.
    await Promise.any(
      POST_SELECTORS.map((selector) => page.waitForSelector(selector, { timeout: 20000 }))
    ).catch(() => {});

    let post = null;
    for (const selector of POST_SELECTORS) {
      post = await page.$(selector);
      if (post) break;
    }
    if (!post) throw new Error('Post not found on that page');

    // The card keeps filling in after it first appears (video player, the
    // truncation toggle), and the tidy-up below needs those to exist. Proceed
    // anyway if LinkedIn's polling never lets the page go fully idle.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10000 }).catch(() => {});

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

      // Post media, reaction icons and badges ship with an empty src and a
      // data-delayed-url that LinkedIn's own lazy loader only swaps in on
      // scroll. Promote them by hand and drop native lazy loading, or they
      // screenshot blank.
      document.querySelectorAll('img').forEach((img) => {
        const delayed = img.dataset.delayedUrl ?? img.dataset.src;
        if (delayed && img.src !== delayed) img.src = delayed;
        img.loading = 'eager';
      });

      // Anything below the fold of a tall post is never fetched until it is
      // scrolled to, and the screenshot captures the whole card regardless of
      // the viewport. Walk to the bottom and back to trigger those loads.
      window.scrollTo(0, document.body.scrollHeight);
      window.scrollTo(0, 0);

    }, STRIP_SELECTORS);

    // Chrome only rasterises what is near the viewport, so a card taller than
    // the window screenshots with everything below the fold left blank — which
    // is what turned a multi-photo collage into empty grey cells even though
    // its images had loaded. Grow the viewport to the whole card first.
    const box = await post.boundingBox();
    if (box) {
      await page.setViewport({
        width: VIEWPORT_WIDTH,
        height: Math.min(Math.ceil(box.height) + 200, MAX_VIEWPORT_HEIGHT),
        deviceScaleFactor: 2,
      });
    }

    // Wait here rather than before the resize: `complete` only means the fetch
    // settled — it is true for a LinkedIn collage image that has no src at all
    // — whereas decode() resolves once the pixels are ready to paint. Each
    // image gets its own deadline so one dead CDN URL cannot hang the capture.
    await page.evaluate(async () => {
      await Promise.all(
        [...document.images].map((img) =>
          Promise.race([
            img.decode().catch(() => {}),
            new Promise((done) => setTimeout(done, 8000)),
          ])
        )
      );
      // A webfont landing after the shot reflows the text under it.
      await document.fonts.ready;
    });

    // Promoting the delayed URLs kicked off a fresh round of requests. Let
    // those settle before the shot rather than racing them.
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});

    return await post.screenshot({ type: 'png' });
  } finally {
    await page.close();
  }
}
