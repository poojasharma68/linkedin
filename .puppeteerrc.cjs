const { join } = require('path');

// Puppeteer defaults to $HOME/.cache/puppeteer, but Render builds and runs in
// separate containers and only carries over the project directory. Chrome
// downloaded to the home cache during `npm install` is gone by the time the
// server starts, which surfaces as "Could not find Chrome (ver. ...)" pointing
// at /opt/render/.cache/puppeteer. Keeping the cache next to the source means
// one path is valid in both containers, and locally too.
//
// The key is `cacheDirectory` — `cacheDir` is not read, and an unknown key is
// ignored in silence, so a typo here looks exactly like no config at all.
module.exports = {
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
