// Answers one question: will this machine capture LinkedIn posts?
//
// Run it ON THE DEPLOYED SERVER, not on a laptop. That is the whole point.
// A laptop sits on a residential IP that LinkedIn treats as a human; a cloud
// host sits in a datacenter range LinkedIn knows, and serves the sign-in wall
// there far more readily. Passing locally proves nothing about production.
//
//   node --env-file-if-exists=.env.local scripts/capture-preflight.mjs <url>...
//
// Nothing is mocked. The thing under test is LinkedIn's real response to this
// IP, so a stub would only test the stub.
import puppeteer from 'puppeteer';
import { capturePost, closeBrowser } from '../lib/capture.js';

// Same list capture.js picks from, kept in the same order so a match here
// names the markup the real capture will find.
const POST_SELECTORS = [
  ['div.feed-shared-update-v2', 'logged-in markup'],
  ['article.main-feed-activity-card', 'logged-out public page'],
  ['div[data-id^="urn:li:activity"]', 'activity card'],
];

// Present only for visitors LinkedIn wants to sign in. Their absence is the
// signal that the public page was served intact.
const WALL_SELECTORS = [
  '.authwall',
  '#public_post_contextual-sign-in',
  '.cta-modal',
  '.modal__overlay',
];

const urls = process.argv.slice(2);

if (!urls.length) {
  console.error(
    `Pass at least one real LinkedIn post URL:

  npm run preflight -- "https://www.linkedin.com/posts/..." "https://..."

Use posts you actually intend to file — a URL that captures fine is not
evidence for one that renders differently.`
  );
  process.exitCode = 1;
}

// Phase one loads the page with its own browser and reports what LinkedIn
// served. Phase two runs the real capturePost, so the code path that ships is
// the code path that gets tested — the diagnosis explains a failure, it does
// not stand in for one.
async function diagnose(browser, url) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1000, height: 900 });
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    await Promise.any(
      POST_SELECTORS.map(([selector]) => page.waitForSelector(selector, { timeout: 20000 }))
    ).catch(() => {});

    return await page.evaluate(
      (postSelectors, wallSelectors, status, finalUrl) => {
        const matched = postSelectors.find(([selector]) => document.querySelector(selector));
        const card = matched ? document.querySelector(matched[0]) : null;
        const images = [...document.images];

        return {
          status,
          // A bounce to /authwall or /login is the bluntest possible refusal:
          // LinkedIn decided this visitor does not get the public page at all.
          redirected: /\/(authwall|login|uas\/login|checkpoint)/.test(finalUrl),
          finalUrl,
          markup: matched ? matched[1] : null,
          selector: matched ? matched[0] : null,
          wall: wallSelectors.filter((selector) => document.querySelector(selector)),
          height: card ? Math.ceil(card.getBoundingClientRect().height) : 0,
          // The collage bug in capture.js: these report complete === true while
          // holding no pixels, so a high count here is what a blank-cell
          // screenshot looks like before it is taken.
          delayed: images.filter((img) => !img.getAttribute('src') && img.dataset.delayedUrl).length,
          images: images.length,
        };
      },
      POST_SELECTORS,
      WALL_SELECTORS,
      response?.status() ?? 0,
      page.url()
    );
  } finally {
    await page.close();
  }
}

function report(index, url, diagnosis, capture) {
  console.log(`\n[${index + 1}/${urls.length}] ${url}`);

  if (diagnosis.redirected) {
    console.log(`      served      : AUTH WALL — redirected to ${diagnosis.finalUrl}`);
  } else if (!diagnosis.markup) {
    console.log(`      served      : no post card found (HTTP ${diagnosis.status})`);
  } else {
    console.log(`      served      : ${diagnosis.markup}  (${diagnosis.selector})`);
  }

  console.log(
    `      sign-in UI  : ${diagnosis.wall.length ? diagnosis.wall.join(', ') : 'none'}`
  );
  if (diagnosis.height) {
    const tall = diagnosis.height > 900 ? '  (taller than one viewport)' : '';
    console.log(`      card height : ${diagnosis.height}px${tall}`);
  }
  console.log(`      images      : ${diagnosis.images} total, ${diagnosis.delayed} lazy/no-src`);
  console.log(
    capture.ok
      ? `      capture     : OK — ${(capture.bytes / 1024).toFixed(0)} KB in ${capture.ms}ms`
      : `      capture     : FAILED — ${capture.error}`
  );
}

async function main() {
  const usingCookie = Boolean(process.env.LINKEDIN_LI_AT);

  console.log('LinkedIn capture preflight');
  console.log(`  li_at       : ${usingCookie ? 'set (authenticated visitor)' : 'NOT set (anonymous visitor)'}`);
  console.log(`  urls        : ${urls.length}`);

  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const results = [];

  try {
    for (const [index, url] of urls.entries()) {
      const diagnosis = await diagnose(browser, url).catch((error) => ({
        status: 0,
        redirected: false,
        finalUrl: url,
        markup: null,
        selector: null,
        wall: [],
        height: 0,
        delayed: 0,
        images: 0,
        error: error.message,
      }));

      const started = Date.now();
      const capture = await capturePost(url).then(
        (buffer) => ({ ok: true, bytes: buffer.length, ms: Date.now() - started }),
        (error) => ({ ok: false, error: error.message })
      );

      report(index, url, diagnosis, capture);
      results.push({ url, diagnosis, capture });
    }
  } finally {
    await browser.close();
    // capturePost holds a module-level browser that outlives the call, and an
    // open Chrome keeps the event loop alive forever.
    await closeBrowser();
  }

  const passed = results.filter((result) => result.capture.ok);
  const walled = results.filter(
    (result) => result.diagnosis.redirected || result.diagnosis.wall.length
  );

  console.log(`\n${'-'.repeat(60)}`);
  console.log(`${passed.length}/${results.length} captured`);

  if (passed.length === results.length && !walled.length) {
    console.log(
      usingCookie
        ? 'Clean pass. Worth re-running with LINKEDIN_LI_AT unset — if it still\npasses, the cookie is a liability you do not need.'
        : 'Clean pass with no cookie. Leave LINKEDIN_LI_AT empty.'
    );
  } else if (walled.length) {
    console.log(
      `LinkedIn showed a sign-in wall on ${walled.length} of ${results.length}.` +
        (usingCookie
          ? '\nThe cookie is set, so it has likely expired — logging out or changing\nthe password invalidates it. Re-copy li_at from a logged-in browser.'
          : '\nThis is exactly what LINKEDIN_LI_AT exists for. Set it from a BURNER\naccount — it is a full session credential, not a scoped API key.')
    );
  } else {
    console.log('Captures failed without a sign-in wall — read the per-URL lines above.');
  }

  if (passed.length !== results.length) process.exitCode = 1;
}

if (urls.length) {
  await main().catch((error) => {
    console.error(`\nPreflight crashed: ${error.message}`);
    process.exitCode = 1;
  });
}
