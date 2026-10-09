'use strict';

// One job at a time, oldest first. The voice engine already uses both CPU cores (and enforces its
// own laptop-care limits), so running two articles at once would only make both slower and hotter.
//
//   queued -> extracting -> reading -> done
//                 \             \--> failed | cancelled
//                  \--> failed | cancelled

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const db = require('./db');
const engine = require('./engine');
const uploads = require('./uploads');
const voices = require('./voices');

const ACTIVE = ['queued', 'extracting', 'reading'];
const DEFAULT_SECONDS_PER_WORD = 0.16;  // measured: ~2,000 words in ~5 minutes on a 2-core i5
const STARTUP_SECONDS = 20;

let running = null;   // { id, controller }
let sweeping = null;

function userError(message, status = 400) {
    const error = new Error(message);
    error.status = status;
    return error;
}

function jobDir(id) {
    return path.join(config.jobsDir, id);
}

function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

/** Shapes a database row into the object the phone works with. */
function toClient(row) {
    if (!row) return null;
    return {
        id: row.id,
        status: row.status,
        phase: row.phase,
        progress: row.progress,
        title: row.title,
        source: { type: row.source_type, label: row.source_label },
        voice: row.voice,
        words: row.words,
        kind: row.kind,
        warnings: row.warnings ? JSON.parse(row.warnings) : [],
        preview: row.preview,
        createdAt: row.created_at,
        startedAt: row.started_at,
        finishedAt: row.finished_at,
        estimateSeconds: row.estimate_seconds,
        audioSeconds: row.audio_seconds,
        audioBytes: row.audio_bytes,
        error: row.error
    };
}

// Learned from recent finished jobs, minus the model load. Short jobs are left out: their time is
// almost all start-up and would make every estimate several times too long.
function secondsPerWord() {
    const recent = db.recentRates().filter(r => r.words >= 150);
    if (!recent.length) return DEFAULT_SECONDS_PER_WORD;
    const words = recent.reduce((sum, r) => sum + r.words, 0);
    const seconds = recent.reduce((sum, r) => sum + Math.max(r.wall_seconds - STARTUP_SECONDS, 0), 0);
    return Math.min(Math.max(seconds / words, 0.05), 2);
}

function validate(input) {
    const source = input?.source || {};
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 200) : '';
    const voice = input.voice || voices.defaultId();
    if (!voices.get(voice)) throw userError('That voice is not set up on this server.');
    const readTitle = input.readTitle !== false;
    if (source.type === 'url') {
        const url = String(source.url || '').trim();
        let parsed;
        try { parsed = new URL(url); } catch { throw userError('That does not look like a link.'); }
        if (!['http:', 'https:'].includes(parsed.protocol) || url.length > 2000) {
            throw userError('Only http and https links can be read.');
        }
        return { title, voice, readTitle, source: { type: 'url', url }, label: hostOf(url) };
    }
    if (source.type === 'text') {
        const text = String(source.text || '');
        if (!text.trim()) throw userError('There is no text to read.');
        if (text.length > config.limits.maxTextChars) throw userError('That text is too long for one recording.');
        return { title, voice, readTitle, source: { type: 'text', text }, label: 'Pasted text' };
    }
    if (source.type === 'files') {
        const ids = Array.isArray(source.uploads) ? source.uploads : [];
        if (!ids.length) throw userError('No files were attached.');
        if (ids.length > config.limits.maxFiles) throw userError(`At most ${config.limits.maxFiles} files per recording.`);
        const metas = ids.map(id => uploads.get(id));
        if (metas.some(m => !m)) throw userError('An uploaded file has expired; please add it again.', 410);
        const label = metas.length === 1 ? metas[0].name : `${metas.length} files`;
        return { title, voice, readTitle, source: { type: 'files', uploads: ids }, label };
    }
    throw userError('Choose a link, a file or some text.');
}

function create(input) {
    const job = validate(input || {});
    const id = crypto.randomBytes(9).toString('base64url');
    const dir = jobDir(id);
    fs.mkdirSync(dir, { recursive: true });
    let source = job.source;
    if (source.type === 'files') source = { type: 'files', files: uploads.claim(source.uploads, dir) };
    fs.writeFileSync(path.join(dir, 'job.json'), JSON.stringify({ source, title: job.title }));
    const row = db.insert({ id, title: job.title, sourceType: job.source.type, sourceLabel: job.label,
        voice: job.voice, readTitle: job.readTitle });
    kick();
    return toClient(row);
}

async function work(row) {
    const controller = new AbortController();
    running = { id: row.id, controller };
    const dir = jobDir(row.id);
    const started = Date.now();
    db.update(row.id, { status: 'extracting', phase: 'extracting', progress: 0, started_at: started, error: null });
    try {
        const meta = await engine.extract(dir, controller.signal);
        if (meta.words > config.limits.maxWords) {
            throw userError(`That is ${meta.words.toLocaleString('en-US')} words; the limit is ` +
                `${config.limits.maxWords.toLocaleString('en-US')}. Split it into parts.`);
        }
        const title = row.title_locked ? row.title : meta.title;
        db.update(row.id, {
            status: 'reading', phase: 'loading', title, words: meta.words, kind: meta.kind,
            warnings: JSON.stringify(meta.warnings || []), preview: meta.preview,
            estimate_seconds: Math.round(STARTUP_SECONDS + meta.words * secondsPerWord())
        });
        const profile = voices.get(row.voice) || voices.get(voices.defaultId());
        // Announce only a real title (typed in, or found in the source), never a stand-in label.
        const readTitle = Boolean(row.read_title) && (Boolean(row.title_locked) || meta.titleFound !== false);
        const report = await engine.read(dir, { title, readTitle, voiceConfig: profile.config }, {
            signal: controller.signal,
            onPhase: phase => db.update(row.id, { phase }),
            onProgress: (done, total) => db.update(row.id, { phase: 'reading', progress: done / total })
        });
        const bytes = fs.statSync(path.join(dir, 'audio.mp3')).size;
        db.update(row.id, {
            status: 'done', phase: null, progress: 1, finished_at: Date.now(),
            audio_seconds: report.audio_s ?? null, audio_bytes: bytes,
            wall_seconds: (Date.now() - started) / 1000
        });
    } catch (error) {
        const cancelled = error.cancelled || controller.signal.aborted;
        db.update(row.id, {
            status: cancelled ? 'cancelled' : 'failed', phase: null, finished_at: Date.now(),
            error: cancelled ? null : String(error.message || error).slice(0, 500)
        });
        if (!cancelled) {
            console.error(`job ${row.id} failed: ${error.message}`);
            for (const line of error.detail || []) console.error(`  | ${line}`);
        }
    } finally {
        running = null;
    }
}

function kick() {
    if (running) return;
    const next = db.nextQueued();
    if (!next) return void sweep();
    work(next).finally(() => setImmediate(kick));
}

function cancel(id) {
    const row = db.get(id);
    if (!row) throw userError('No such recording.', 404);
    if (running?.id === id) running.controller.abort();
    else if (row.status === 'queued') db.update(id, { status: 'cancelled', finished_at: Date.now() });
    return toClient(db.get(id));
}

function retry(id) {
    const row = db.get(id);
    if (!row) throw userError('No such recording.', 404);
    if (!['failed', 'cancelled'].includes(row.status)) throw userError('Only a failed or cancelled recording can be retried.');
    for (const stale of ['text.txt', 'extract.json', 'audio.mp3', 'report.json']) {
        fs.rmSync(path.join(jobDir(id), stale), { force: true });
    }
    db.update(id, { status: 'queued', phase: null, progress: 0, error: null, finished_at: null });
    kick();
    return toClient(db.get(id));
}

function remove(id) {
    const row = db.get(id);
    if (!row) throw userError('No such recording.', 404);
    if (running?.id === id) running.controller.abort();
    db.remove(id);
    fs.rmSync(jobDir(id), { recursive: true, force: true });
}

function text(id) {
    const row = db.get(id);
    const file = path.join(jobDir(id), 'text.txt');
    if (!row || !fs.existsSync(file)) throw userError('No text for that recording yet.', 404);
    return { title: row.title, text: fs.readFileSync(file, 'utf8') };
}

function audioPath(id) {
    const row = db.get(id);
    const file = path.join(jobDir(id), 'audio.mp3');
    if (!row || row.status !== 'done' || !fs.existsSync(file)) return null;
    return { file, row };
}

// Old recordings are removed after KEEP_DAYS, and only the newest KEEP_JOBS are kept.
function sweep() {
    if (sweeping) return;
    sweeping = true;
    try {
        const cutoff = Date.now() - config.retention.keepDays * 86400000;
        for (const id of db.expired(cutoff, config.retention.keepJobs)) {
            db.remove(id);
            fs.rmSync(jobDir(id), { recursive: true, force: true });
        }
        uploads.sweep();
    } finally {
        sweeping = false;
    }
}

function start() {
    fs.mkdirSync(config.jobsDir, { recursive: true });
    const requeued = db.requeueInterrupted();
    if (requeued) console.log(`resuming ${requeued} interrupted recording(s)`);
    kick();
    setInterval(sweep, 60 * 60 * 1000).unref();
}

// On shutdown the running recording's process group is stopped; it is re-queued at the next start.
function shutdown() {
    running?.controller.abort();
}

function queueState() {
    return { running: running ? toClient(db.get(running.id)) : null, waiting: db.countQueued() };
}

module.exports = { start, shutdown, create, cancel, retry, remove, text, audioPath, list: () => db.list().map(toClient),
    get: id => toClient(db.get(id)), queueState, secondsPerWord, ACTIVE, toClient };
