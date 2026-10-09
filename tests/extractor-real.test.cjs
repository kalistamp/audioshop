'use strict';
// The API tests use a stand-in extractor. This one runs the real Python extractor exactly as the
// server starts it (default command and working folder), so a path or packaging mistake shows up
// here. Skipped until `npm run setup` has created the extractor environment.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { root } = require('./helpers.cjs');

process.env.AUDIOSHOP_ENV_FILE = path.join(os.tmpdir(), 'audioshop-no-such.env');
delete process.env.AUDIOSHOP_EXTRACTOR_CMD;
const engine = require('../lib/engine');

const ready = fs.existsSync(path.join(root, 'extractor', '.venv'));

test('the real extractor turns a text job into text.txt and extract.json', { skip: !ready && 'run npm run setup first' }, async () => {
    const jobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audioshop-extract-'));
    try {
        fs.writeFileSync(path.join(jobDir, 'job.json'), JSON.stringify({
            source: { type: 'text', text: 'Bike lanes approved\n\nThe council met on Tuesday. It voted for twelve new bike lanes.' },
            title: ''
        }));
        const info = await engine.extract(jobDir);
        assert.equal(info.title, 'Bike lanes approved');
        assert.equal(info.kind, 'pasted text');
        assert.match(fs.readFileSync(path.join(jobDir, 'text.txt'), 'utf8'), /twelve new bike lanes/);
    } finally {
        fs.rmSync(jobDir, { recursive: true, force: true });
    }
});
