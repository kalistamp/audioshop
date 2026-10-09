'use strict';

// Files arrive one request each as a raw body (no multipart parser needed) and wait in uploads/
// until a job claims them. Unclaimed uploads are swept after a day.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DOCUMENT_TYPES = ['.txt', '.text', '.md', '.markdown', '.html', '.htm', '.pdf', '.docx', '.epub'];
const IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.webp', '.heic', '.heif', '.gif', '.bmp', '.tif', '.tiff'];
const ALLOWED = new Set([...DOCUMENT_TYPES, ...IMAGE_TYPES]);
const STALE_MS = 24 * 60 * 60 * 1000;

let dir;

function init(uploadsDir) {
    dir = uploadsDir;
    fs.mkdirSync(dir, { recursive: true });
}

function cleanName(name) {
    const base = path.basename(String(name || 'upload')).replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').trim();
    return (base || 'upload').slice(0, 120);
}

function kindOf(ext) {
    return IMAGE_TYPES.includes(ext) ? 'image' : 'document';
}

function save(buffer, originalName) {
    const name = cleanName(originalName);
    const ext = path.extname(name).toLowerCase();
    if (!ALLOWED.has(ext)) {
        const error = new Error(`Audioshop reads text, Markdown, HTML, PDF, Word (.docx), EPUB and photos; ` +
            `not ${ext || 'that file type'}.`);
        error.status = 415;
        throw error;
    }
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(dir, id + ext), buffer);
    const meta = { id, name, ext, size: buffer.length, kind: kindOf(ext), created: Date.now() };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta));
    return meta;
}

function get(id) {
    if (!/^[0-9a-f-]{36}$/.test(String(id))) return null;
    const metaPath = path.join(dir, `${id}.json`);
    if (!fs.existsSync(metaPath)) return null;
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
}

// Moves uploads into a job's input/ folder and returns them in the order given.
function claim(ids, jobDir) {
    const inputDir = path.join(jobDir, 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    return ids.map((id, index) => {
        const meta = get(id);
        const fileName = `${String(index + 1).padStart(2, '0')}${meta.ext}`;
        fs.renameSync(path.join(dir, id + meta.ext), path.join(inputDir, fileName));
        fs.rmSync(path.join(dir, `${id}.json`), { force: true });
        return { path: `input/${fileName}`, name: meta.name, kind: meta.kind };
    });
}

function sweep(now = Date.now()) {
    for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.json')) continue;
        const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        if (now - meta.created > STALE_MS) {
            fs.rmSync(path.join(dir, meta.id + meta.ext), { force: true });
            fs.rmSync(path.join(dir, file), { force: true });
        }
    }
}

module.exports = { init, save, get, claim, sweep, cleanName, ALLOWED, IMAGE_TYPES, DOCUMENT_TYPES };
