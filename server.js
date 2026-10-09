'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./lib/config');  // loads .env first
const auth = require('./lib/auth');
const db = require('./lib/db');
const engine = require('./lib/engine');
const jobs = require('./lib/jobs');
const uploads = require('./lib/uploads');
const voices = require('./lib/voices');
const { version } = require('./package.json');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');  // tailscale serve / a local reverse proxy

/* ------------------------------- plumbing --------------------------------- */

/** Wraps an async route so a rejected promise becomes a JSON error, not a hang. */
function route(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fail(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function slug(title) {
    const base = String(title || 'audioshop').normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
    return base || 'audioshop';
}

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
});
app.use('/api', auth.cors(config.allowedOrigins));

/* --------------------------------- health --------------------------------- */

// Public on purpose: the app uses it to tell "server unreachable" from "wrong token".
app.get('/api/health', (req, res) => {
    res.json({ ok: true, app: 'audioshop', version });
});

/* ------------------------------ everything else needs the token ------------ */

// Audio has its own check (token or signed link), so it is registered before the gate.
app.get('/api/jobs/:id/audio', route(async (req, res) => {
    const signed = auth.linkValid(config.token, req.params.id, req.query.expires, req.query.sig);
    if (!signed && !auth.tokenMatches(auth.bearer(req), config.token)) {
        throw fail('This link has expired. Open the recording again in Audioshop.', 401);
    }
    const audio = jobs.audioPath(req.params.id);
    if (!audio) throw fail('That recording has no audio yet.', 404);
    const name = `${slug(audio.row.title)}.mp3`;
    res.setHeader('Content-Disposition',
        `${req.query.download ? 'attachment' : 'inline'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('audio/mpeg');
    res.sendFile(audio.file);  // honours Range, so the phone's player can seek while streaming
}));

app.use('/api', auth.requireToken(config.token));

app.get('/api/status', (req, res) => {
    res.json({
        engine: engine.status(),
        queue: jobs.queueState(),
        voices: voices.forClient(),
        limits: { maxWords: config.limits.maxWords, maxUploadMb: config.limits.maxUploadBytes / 1048576,
            maxFiles: config.limits.maxFiles, types: [...uploads.ALLOWED] },
        secondsPerWord: jobs.secondsPerWord()
    });
});

// One file per request; the body is the raw file, which keeps uploads dependency-free.
app.post('/api/uploads', express.raw({ type: () => true, limit: config.limits.maxUploadBytes }), route(async (req, res) => {
    if (!req.body?.length) throw fail('No file arrived with that upload.');
    let name = req.get('x-file-name') || 'upload';
    try { name = decodeURIComponent(name); } catch { /* keep as sent */ }
    res.status(201).json(uploads.save(req.body, name));
}));

app.post('/api/jobs', express.json({ limit: '2mb' }), route(async (req, res) => {
    res.status(201).json({ job: jobs.create(req.body) });
}));

app.get('/api/jobs', (req, res) => {
    res.json({ jobs: jobs.list() });
});

app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) throw fail('No such recording.', 404);
    res.json({ job });
});

app.get('/api/jobs/:id/text', (req, res) => {
    res.json(jobs.text(req.params.id));
});

// A short-lived link the phone can hand to its audio player or to a download.
app.post('/api/jobs/:id/link', (req, res) => {
    if (!jobs.audioPath(req.params.id)) throw fail('That recording has no audio yet.', 404);
    const { expires, sig } = auth.signLink(config.token, req.params.id);
    const query = `expires=${expires}&sig=${encodeURIComponent(sig)}`;
    res.json({ path: `/api/jobs/${req.params.id}/audio?${query}`, expires });
});

app.post('/api/jobs/:id/cancel', (req, res) => {
    res.json({ job: jobs.cancel(req.params.id) });
});

app.post('/api/jobs/:id/retry', (req, res) => {
    res.json({ job: jobs.retry(req.params.id) });
});

app.delete('/api/jobs/:id', (req, res) => {
    jobs.remove(req.params.id);
    res.status(204).end();
});

app.use('/api', (req, res) => res.status(404).json({ error: 'No such endpoint.' }));

/* ------------------------- the app itself (same files as GitHub Pages) ----- */

app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders(res, file) {
        if (file.endsWith('sw.js') || file.endsWith('.webmanifest')) res.setHeader('Cache-Control', 'no-cache');
    }
}));

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || error.statusCode || 500;
    if (error.type === 'entity.too.large') {
        return res.status(413).json({ error: `Files can be up to ${config.limits.maxUploadBytes / 1048576} MB.` });
    }
    if (status >= 500) console.error(error);
    res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : error.message });
});

/* --------------------------------- start ---------------------------------- */

function start() {
    if (!config.token || config.token.length < 24) {
        console.error('AUDIOSHOP_TOKEN is missing or too short. Run `npm run setup` first.');
        process.exit(1);
    }
    fs.mkdirSync(config.dataDir, { recursive: true });
    db.open(config.dbPath);
    uploads.init(config.uploadsDir);
    voices.load(config.voicesPath);
    jobs.start();
    const server = app.listen(config.port, config.host, () => {
        const status = engine.status();
        console.log(`Audioshop on http://${config.host}:${config.port}` +
            (config.publicUrl ? ` (phone: ${config.publicUrl})` : ''));
        for (const problem of status.problems) console.warn(`warning: ${problem}`);
    });
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            jobs.shutdown();
            server.close(() => { db.close(); process.exit(0); });
            setTimeout(() => process.exit(0), 3000).unref();
        });
    }
    return server;
}

if (require.main === module) start();

module.exports = { app, start };
