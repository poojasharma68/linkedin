// Why did this post come out with a grey box in it?
//
//   npm run capture:debug -- "https://www.linkedin.com/posts/..."
//
// Runs the real capturePost with its diagnosis turned on, then writes the PNG
// so the log and the picture can be read side by side. The log names every
// empty slot in the card — its size, its classes, and every data-* attribute
// on it, which is where LinkedIn parks a URL that nothing has promoted yet.
import { writeFile } from 'node:fs/promises';
import { capturePost, closeBrowser } from '../lib/capture.js';

const [url, out = 'capture-debug.png'] = process.argv.slice(2);

if (!url) {
  console.error(`Pass the post URL that came out wrong:

  npm run capture:debug -- "https://www.linkedin.com/posts/..." [out.png]`);
  process.exitCode = 1;
} else {
  // Read inside capturePost, so setting it here is enough.
  process.env.CAPTURE_DEBUG = '1';

  console.log(`li_at : ${process.env.LINKEDIN_LI_AT ? 'set' : 'NOT set (anonymous visitor)'}`);
  console.log(`url   : ${url}\n`);

  const started = Date.now();
  try {
    const shot = await capturePost(url);
    await writeFile(out, shot);
    console.log(`\nCaptured ${(shot.length / 1024).toFixed(0)} KB in ${Date.now() - started}ms → ${out}`);
    console.log('No "empty media slot" line above means every image painted.');
  } catch (error) {
    console.error(`\nFailed after ${Date.now() - started}ms: ${error.message}`);
    process.exitCode = 1;
  }

  await closeBrowser();
}
