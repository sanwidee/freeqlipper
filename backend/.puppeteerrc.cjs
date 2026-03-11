/** @type {import("puppeteer").Configuration} */
module.exports = {
  // Skip Chromium download during npm install.
  // Qlipper uses system Edge/Chrome instead (see overlayRenderer.js findSystemBrowser).
  // This prevents npm install failures on Windows where the download can fail silently.
  skipDownload: true,
};
