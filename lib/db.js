'use strict';

// The job list lives in SQLite through node:sqlite, so there is no native module to build.

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const COLUMNS = [
    'status', 'phase', 'progress', 'title', 'title_locked', 'source_type', 'source_label', 'voice',
    'read_title', 'words', 'kind', 'warnings', 'preview', 'estimate_seconds', 'started_at',
    'finished_at', 'audio_seconds', 'audio_bytes', 'wall_seconds', 'error'
];

let db;

function open(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            status TEXT NOT NULL,
            phase TEXT,
            progress REAL NOT NULL DEFAULT 0,
            title TEXT,
            title_locked INTEGER NOT NULL DEFAULT 0,
            source_type TEXT NOT NULL,
            source_label TEXT,
            voice TEXT,
            read_title INTEGER NOT NULL DEFAULT 1,
            words INTEGER,
            kind TEXT,
            warnings TEXT,
            preview TEXT,
            estimate_seconds REAL,
            started_at INTEGER,
            finished_at INTEGER,
            audio_seconds REAL,
            audio_bytes INTEGER,
            wall_seconds REAL,
            error TEXT
        );
        CREATE INDEX IF NOT EXISTS jobs_created ON jobs (created_at);
    `);
    return db;
}

function insert(job) {
    const now = Date.now();
    db.prepare(`INSERT INTO jobs (id, created_at, updated_at, status, title, title_locked, source_type,
                source_label, voice, read_title) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(job.id, now, now, 'queued', job.title || null, job.title ? 1 : 0, job.sourceType,
            job.sourceLabel, job.voice, job.readTitle ? 1 : 0);
    return get(job.id);
}

function get(id) {
    return db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) || null;
}

function list(limit = 100) {
    return db.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit);
}

function update(id, fields) {
    const keys = Object.keys(fields).filter(key => COLUMNS.includes(key));
    if (!keys.length) return get(id);
    const values = keys.map(key => fields[key] === undefined ? null : fields[key]);
    db.prepare(`UPDATE jobs SET ${keys.map(key => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .run(...values, Date.now(), id);
    return get(id);
}

function nextQueued() {
    return db.prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() || null;
}

function countQueued() {
    return db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'").get().n;
}

function remove(id) {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(id);
}

// A server restart interrupts the job in progress; it simply goes back to the front of the queue.
function requeueInterrupted() {
    return db.prepare(`UPDATE jobs SET status = 'queued', phase = NULL, progress = 0, error = NULL
                       WHERE status IN ('extracting', 'reading')`).run().changes;
}

function expired(cutoff, keep) {
    const old = db.prepare(`SELECT id FROM jobs WHERE created_at < ? AND status NOT IN
                            ('queued', 'extracting', 'reading')`).all(cutoff);
    const surplus = db.prepare(`SELECT id FROM jobs WHERE status NOT IN ('queued', 'extracting', 'reading')
                                ORDER BY created_at DESC LIMIT -1 OFFSET ?`).all(keep);
    return [...new Set([...old, ...surplus].map(row => row.id))];
}

function recentRates(limit = 10) {
    return db.prepare(`SELECT words, wall_seconds FROM jobs WHERE status = 'done' AND words > 0
                       AND wall_seconds > 0 ORDER BY finished_at DESC LIMIT ?`).all(limit);
}

function close() {
    db?.close();
    db = undefined;
}

module.exports = { open, insert, get, list, update, nextQueued, countQueued, remove, requeueInterrupted,
    expired, recentRates, close };
