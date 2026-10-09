#!/usr/bin/env node
'use strict';
// Stands in for `voice-reader read` in tests: same arguments, same PHASE/PROGRESS lines on stderr,
// writes a small MP3 and a JSON report. Special words in the text change its behaviour:
//   HANG     -> keeps "reading" until killed (records its pid for the cancel test)
//   OVERHEAT -> exits with code 4, like voice-reader's laptop-care stop
//   SLOW     -> takes ~3 s
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const textFile = args[args.indexOf('read') + 1];
const out = at('-o');
const report = at('--report');
const text = fs.readFileSync(textFile, 'utf8');
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    console.error('PHASE loading');
    await sleep(150);
    console.error('PHASE reading');
    if (text.includes('HANG')) {
        fs.writeFileSync(path.join(path.dirname(textFile), 'reader.pid'), String(process.pid));
        console.error('PROGRESS 1 10');
        await sleep(600000);
    }
    if (text.includes('OVERHEAT')) process.exit(4);
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
        await sleep(text.includes('SLOW') ? 750 : 120);
        console.error(`PROGRESS ${i} ${steps}`);
    }
    console.error('PHASE encoding');
    fs.copyFileSync(path.join(__dirname, 'tone.mp3'), out);
    fs.writeFileSync(report, JSON.stringify({ audio_s: 1.5, wall_s: 0.8, words: text.split(/\s+/).length,
        args: { readTitle: args.includes('--read-title'), config: args.includes('--config') ? at('--config') : null,
            title: at('--title') } }));
})();
