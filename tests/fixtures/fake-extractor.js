#!/usr/bin/env node
'use strict';
// Stands in for the Python extractor in tests: same contract (job.json in, text.txt + extract.json out,
// "AUDIOSHOP_ERROR: ..." on failure).
const fs = require('node:fs');
const path = require('node:path');

const dir = process.argv[2];
const job = JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8'));
let text = '';
let title = '';
if (job.source.type === 'text') text = job.source.text;
if (job.source.type === 'url') {
    const host = new URL(job.source.url).hostname;
    title = `Story from ${host}`;
    text = `This is the article found at ${host}. It has a few sentences. They are short.`;
}
if (job.source.type === 'files') {
    text = job.source.files.map(f => fs.readFileSync(path.join(dir, f.path), 'utf8')).join('\n\n');
    title = path.parse(job.source.files[0].name).name;
}
if (text.includes('FAIL_EXTRACT')) {
    console.error('some log line\nAUDIOSHOP_ERROR: No article text found on that page.');
    process.exit(2);
}
const titleFound = Boolean(job.title || (title && job.source.type === 'url'));  // file names are only labels
title = job.title || title || text.split('\n')[0].slice(0, 60);
fs.writeFileSync(path.join(dir, 'text.txt'), text);
fs.writeFileSync(path.join(dir, 'extract.json'), JSON.stringify({
    title, titleFound, words: text.split(/\s+/).filter(Boolean).length, chars: text.length, kind: job.source.type,
    pages: 1, warnings: text.includes('WARN') ? ['A test warning.'] : [], preview: text.slice(0, 100)
}));
