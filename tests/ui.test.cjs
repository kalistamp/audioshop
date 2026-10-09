'use strict';
// Phone-sized browser tests. The app is served from one origin and the API from another, which is
// exactly the GitHub Pages arrangement (CORS, pairing link, uploads, offline). Screenshots land in
// tests/artifacts/ for a human look. Needs Playwright's Chromium: `npx playwright install chromium`.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');

const { startServer, TOKEN, root } = require('./helpers.cjs');

const artifacts = path.join(__dirname, 'artifacts');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
let api, site, siteUrl, browser, context, page;
const problems = [];
const siteRequests = [];  // every URL the static host was asked for

before(async () => {
    fs.mkdirSync(artifacts, { recursive: true });
    api = await startServer();
    site = http.createServer((req, res) => {
        siteRequests.push(req.url);
        const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        const file = path.join(root, 'public', pathname === '/' ? 'index.html' : pathname);
        if (!file.startsWith(path.join(root, 'public')) || !fs.existsSync(file)) { res.statusCode = 404; return res.end(); }
        res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
        res.end(fs.readFileSync(file));
    });
    await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
    siteUrl = `http://127.0.0.1:${site.address().port}/`;
    browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
    context = await browser.newContext({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
        userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36'
    });
    page = await context.newPage();
    page.on('pageerror', error => problems.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (/Content Security Policy|Refused to/.test(message.text())) problems.push(`csp: ${message.text()}`);
    });
});

after(async () => {
    await browser?.close();
    await new Promise(resolve => site?.close(resolve));
    await api?.stop();
});

function pairingLink() {
    const pairing = Buffer.from(JSON.stringify({ server: api.base, token: TOKEN })).toString('base64url');
    return `${siteUrl}#pair=${pairing}`;
}

const shot = (name) => page.screenshot({ path: path.join(artifacts, `${name}.png`), fullPage: false });

test('first visit shows the onboarding card and no connection', async () => {
    await page.goto(siteUrl);
    await page.waitForSelector('#onboarding:not([hidden])');
    assert.equal(await page.textContent('#connectionText'), 'Not connected');
    await shot('01-first-visit');
});

test('a pairing link connects, and the fragment is removed from the address bar', async () => {
    await page.goto(pairingLink());
    await page.waitForFunction(() => document.querySelector('#connectionText').textContent === 'Connected');
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.isHidden('#onboarding'), true);
    assert.deepEqual(await page.$$eval('#voiceSelect option', o => o.map(x => x.textContent)), ['My voice']);
    await shot('02-paired-new');
});

test('pasted text becomes audio that is saved on the phone and plays', async () => {
    await page.click('#tab-text');
    await page.fill('#textInput', 'The city council voted on Tuesday to add twelve miles of bike lanes. Construction starts in spring.');
    assert.match(await page.textContent('#estimate'), /to make/);
    await page.click('.options summary');
    await page.fill('#titleInput', '<img src=x onerror="window.pwned=1"> Bike lanes');
    await page.click('#makeBtn');
    await page.waitForSelector('#view-library:not([hidden])');
    await page.waitForSelector('.job .chip', { timeout: 20000 });  // done and auto-saved offline
    assert.equal(await page.$('.job-title img'), null, 'a title must never become markup');
    assert.equal(await page.evaluate(() => window.pwned), undefined);
    assert.match(await page.textContent('.job-title'), /<img src=x/);
    await shot('03-library-done');
    await page.click('.job .button.primary');
    await page.waitForFunction(() => !document.querySelector('#audio').paused && document.querySelector('#audio').currentTime > 0.1);
    assert.equal(await page.isVisible('#player'), true);
    await shot('04-playing');
    await page.click('#playBtn');
});

test('a file upload becomes audio too', async () => {
    await page.click('.tab[data-goto="new"]');
    await page.click('#tab-file');
    const file = path.join(os.tmpdir(), 'audioshop-ui-notes.txt');
    fs.writeFileSync(file, 'Notes from a file. They are read aloud as well.');
    await page.setInputFiles('#fileInput', file);
    assert.match(await page.textContent('#fileList'), /audioshop-ui-notes\.txt/);
    await shot('05-file-selected');
    await page.click('#makeBtn');
    await page.waitForFunction(() => [...document.querySelectorAll('.job-title')].some(t => t.textContent === 'audioshop-ui-notes'));
    await page.waitForFunction(() => document.querySelectorAll('.job .chip').length >= 2, null, { timeout: 20000 });
});

test('settings screen', async () => {
    await page.click('.tab[data-goto="settings"]');
    await page.waitForFunction(() => /recordings? saved/.test(document.querySelector('#storageInfo').textContent));
    assert.match(await page.textContent('#storageInfo'), /2 recordings saved/);
    await shot('06-settings');
});

test('offline: the app opens from the service worker and saved audio still plays', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await context.setOffline(true);
    await page.reload();
    await page.click('.tab[data-goto="library"]');
    await page.waitForSelector('#offlineNotice:not([hidden])');
    assert.equal(await page.locator('.job .chip').count(), 2);
    await page.locator('.job .button.primary').first().click();
    await page.waitForFunction(() => !document.querySelector('#audio').paused && document.querySelector('#audio').currentTime > 0.1);
    assert.match(await page.evaluate(() => document.querySelector('#audio').src), /^blob:/);
    const fonts = await page.evaluate(async () => {
        await document.fonts.ready;
        return [...document.fonts].map(f => `${f.family.replace(/"/g, '')} ${f.status}`).sort();
    });
    assert.ok(fonts.includes('Manrope loaded'), `fonts offline: ${fonts}`);
    await shot('07-offline-library');
    await context.setOffline(false);
});

test('a shared link (Android share sheet) lands in the form', async () => {
    await page.goto(`${siteUrl}?text=${encodeURIComponent('Look at this https://news.example.org/story-1 wow')}`);
    await page.waitForSelector('#view-new:not([hidden])');
    assert.equal(await page.inputValue('#urlInput'), 'https://news.example.org/story-1');
    assert.equal(new URL(page.url()).search, '');
    // The service worker answered the navigation, so the shared link never reached the web host.
    assert.equal(siteRequests.some(u => u.includes('news.example.org')), false);
});

test('no page errors or security-policy violations', () => {
    assert.deepEqual(problems, []);
});
