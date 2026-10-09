'use strict';

// npm run pair [-- --public-url=https://machine.tailnet.ts.net] [--site=https://you.github.io/audioshop/]
// Prints a link (and a QR code) that sets up the app on your phone in one tap. The server address and
// token travel in the URL fragment (#pair=...), which browsers never send to GitHub or anyone else.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

function arg(name) {
    const hit = process.argv.find(a => a.startsWith(`--${name}=`));
    return hit ? hit.split('=').slice(1).join('=') : '';
}

const server = (arg('public-url') || process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const site = arg('site') || process.env.SITE_URL || 'https://kalistamp.github.io/audioshop/';
const token = process.env.AUDIOSHOP_TOKEN;

if (!token) {
    console.error('No AUDIOSHOP_TOKEN: run `npm run setup` first.');
    process.exit(1);
}
if (!/^https:\/\//.test(server)) {
    console.error('Give the HTTPS address your phone uses, e.g. npm run pair -- --public-url=https://machine.tailnet.ts.net');
    process.exit(1);
}

const pairing = Buffer.from(JSON.stringify({ server, token })).toString('base64url');
const viaPages = `${site.replace(/\/?$/, '/')}#pair=${pairing}`;
const direct = `${server}/#pair=${pairing}`;

console.log('\nOpen ONE of these on your phone (it contains your access token: do not share it):\n');
console.log(`  GitHub Pages copy:   ${viaPages}`);
console.log(`  Served by this computer: ${direct}\n`);
try {
    require('qrcode-terminal').generate(direct, { small: true }, qr => console.log(`Scan to open the copy served by this computer:\n${qr}`));
} catch {
    // optional dependency
}
