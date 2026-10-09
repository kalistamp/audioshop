'use strict';

/**
 * Audioshop, the phone side. This page is a remote control: the voice runs on your own computer
 * (server.js + voice-reader). The page sends it a link, a file or text, follows the job, then keeps
 * the finished MP3 in IndexedDB so it plays offline.
 *
 * Everything this page knows about you lives in this browser: the server address and access token
 * (localStorage) and saved MP3s (IndexedDB). Text from web pages is always inserted with
 * textContent, never as HTML.
 */

const APP_VERSION = '1.0.0';
const WORDS_PER_MINUTE = 215;  // measured speaking rate of the voice
const ACTIVE = ['queued', 'extracting', 'reading'];
const SPEEDS = [1, 1.25, 1.5, 1.75, 2, 0.8];

const $ = (selector) => document.querySelector(selector);

/* =============================== small helpers ============================== */

const local = {
    get(key, fallback) {
        try {
            const value = localStorage.getItem(`audioshop.${key}`);
            return value === null ? fallback : JSON.parse(value);
        } catch { return fallback; }
    },
    set(key, value) {
        try { localStorage.setItem(`audioshop.${key}`, JSON.stringify(value)); } catch { /* private mode */ }
    },
    remove(key) {
        try { localStorage.removeItem(`audioshop.${key}`); } catch { /* ignore */ }
    }
};

/** Builds an element. Strings become text nodes, so page titles can never inject markup. */
function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'className') node.className = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else if (key === 'dataset') Object.assign(node.dataset, value);
        else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
}

function icon(path) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', path);
    svg.append(p);
    return svg;
}

const ICONS = {
    url: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    files: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h6',
    text: 'M5 6h14M5 10h14M5 14h10M5 18h7',
    saved: 'M12 3v12m0 0-4-4m4 4 4-4M5 19h14'
};

function words(text) {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

function minutes(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`;
    const m = Math.round(seconds / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

function clock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
    const s = Math.floor(seconds % 60).toString().padStart(2, '0');
    const m = Math.floor(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)}:${(m % 60).toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
}

function megabytes(bytes) {
    return bytes ? `${(bytes / 1048576).toFixed(1)} MB` : '';
}

function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
}

function fileName(item) {
    const base = String(item.title || 'audioshop').normalize('NFKD').replace(/[̀-ͯ]/g, '')
        .replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
    return `${base || 'audioshop'}.mp3`;
}

let toastTimer;
function toast(message, ms = 4000) {
    const node = $('#toast');
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, ms);
}

/* ================================== state =================================== */

const state = {
    server: local.get('server', ''),
    token: local.get('token', ''),
    status: null,
    jobs: local.get('jobs', []),
    saved: new Map(),          // id -> metadata of MP3s stored on this phone
    mode: 'link',
    files: [],
    pollTimer: null,
    current: null,             // what the player has loaded
    highlight: null,
    lastStatus: new Map(),
    saving: new Set(),
    installPrompt: null
};

/* =================================== API ==================================== */

class ApiError extends Error {
    constructor(message, kind, status = 0) {
        super(message);
        this.kind = kind;      // unpaired | network | auth | http
        this.status = status;
    }
}

function networkHint() {
    if (!navigator.onLine) return 'This phone is offline.';
    const host = hostOf(state.server);
    const tailnet = /\.ts\.net$/i.test(host) || /^100\./.test(host);
    const crossSite = location.origin !== new URL(state.server).origin;
    if (tailnet && crossSite) {
        return 'Could not reach your computer. Make sure Tailscale is switched on on this phone. ' +
            `In Chrome, tap Allow when asked about devices on your local network, or open ${state.server} instead.`;
    }
    return 'Could not reach your computer. Is it switched on, with Audioshop running?';
}

async function api(path, { method = 'GET', json } = {}) {
    if (!state.server || !state.token) throw new ApiError('Connect your computer in Settings first.', 'unpaired');
    let res;
    try {
        res = await fetch(state.server + path, {
            method,
            cache: 'no-store',
            headers: { Authorization: `Bearer ${state.token}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
            body: json === undefined ? undefined : JSON.stringify(json)
        });
    } catch {
        throw new ApiError(networkHint(), 'network');
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) throw new ApiError(data.error || 'The access token was not accepted.', 'auth', 401);
    if (!res.ok) throw new ApiError(data.error || `Your computer answered ${res.status}.`, 'http', res.status);
    return data;
}

// XHR rather than fetch: it reports upload progress, which matters for photos on mobile data.
function uploadFile(file, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${state.server}/api/uploads`);
        xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
        xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
        xhr.upload.onprogress = (event) => event.lengthComputable && onProgress(event.loaded / event.total);
        xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
            if (xhr.status >= 200 && xhr.status < 300) resolve(data);
            else reject(new ApiError(data.error || `Upload failed (${xhr.status}).`, xhr.status === 401 ? 'auth' : 'http', xhr.status));
        };
        xhr.onerror = () => reject(new ApiError(networkHint(), 'network'));
        xhr.send(file);
    });
}

// Phone photos are 3-12 MB and carry GPS data. Re-encoding at 2600 px is enough for OCR, uploads
// much faster, and drops the EXIF block. HEIC that this browser cannot decode goes up untouched.
async function shrinkImage(file) {
    if (!file.type.startsWith('image/') || file.size < 1.5e6 || typeof createImageBitmap !== 'function') return file;
    try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        const scale = Math.min(1, 2600 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(bitmap.width * scale);
        canvas.height = Math.round(bitmap.height * scale);
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close?.();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
        if (!blob || blob.size >= file.size) return file;
        return new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' });
    } catch {
        return file;
    }
}

/* ============================ offline audio store =========================== */

const idb = {
    db: null,
    open() {
        if (!this.db) {
            this.db = new Promise((resolve, reject) => {
                const request = indexedDB.open('audioshop', 1);
                request.onupgradeneeded = () => request.result.createObjectStore('audio', { keyPath: 'id' });
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        }
        return this.db;
    },
    async run(mode, fn) {
        const db = await this.open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('audio', mode);
            const request = fn(tx.objectStore('audio'));
            tx.oncomplete = () => resolve(request?.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error);
        });
    },
    put(record) { return this.run('readwrite', store => store.put(record)); },
    get(id) { return this.run('readonly', store => store.get(id)); },
    remove(id) { return this.run('readwrite', store => store.delete(id)); },
    all() { return this.run('readonly', store => store.getAll()); },
    clear() { return this.run('readwrite', store => store.clear()); }
};

async function loadSaved() {
    try {
        for (const record of await idb.all()) {
            const { blob, ...meta } = record;
            state.saved.set(record.id, { ...meta, bytes: blob?.size || meta.bytes });
        }
    } catch { /* IndexedDB unavailable (private mode): streaming still works */ }
}

async function saveOffline(job, { quiet = false } = {}) {
    if (state.saved.has(job.id) || state.saving.has(job.id)) return;
    state.saving.add(job.id);
    renderLibrary();
    try {
        const res = await fetch(`${state.server}/api/jobs/${job.id}/audio`, { headers: { Authorization: `Bearer ${state.token}` } });
        if (!res.ok) throw new ApiError(`Could not download the audio (${res.status}).`, 'http', res.status);
        const blob = await res.blob();
        const meta = { id: job.id, title: job.title, sourceLabel: job.source?.label, sourceType: job.source?.type,
            audioSeconds: job.audioSeconds, words: job.words, createdAt: job.createdAt, savedAt: Date.now(), bytes: blob.size };
        await idb.put({ ...meta, blob });
        state.saved.set(job.id, meta);
        navigator.storage?.persist?.().catch(() => {});
        if (!quiet) toast('Saved on this phone. It will play offline.');
    } catch (error) {
        if (!quiet) toast(error.message || 'Could not save the audio on this phone.');
    } finally {
        state.saving.delete(job.id);
        renderLibrary();
        updateStorage();
    }
}

/* ================================= views ==================================== */

function showView(name) {
    for (const view of document.querySelectorAll('.view')) view.hidden = view.id !== `view-${name}`;
    for (const tab of document.querySelectorAll('.tab')) {
        const active = tab.dataset.goto === name;
        tab.classList.toggle('active', active);
        if (active) tab.setAttribute('aria-current', 'page'); else tab.removeAttribute('aria-current');
    }
    window.scrollTo({ top: 0 });
    if (name === 'library') refreshJobs();
    if (name === 'settings') updateStorage();
}

function setConnection(kind, text) {
    const node = $('#connection');
    node.dataset.state = kind;
    $('#connectionText').textContent = text;
}

/* ================================ new audio ================================= */

function setMode(mode) {
    state.mode = mode;
    for (const button of document.querySelectorAll('.segment')) {
        const active = button.dataset.mode === mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-selected', String(active));
    }
    for (const panel of document.querySelectorAll('.mode')) panel.hidden = panel.dataset.modePanel !== mode;
    updateEstimate();
}

function addFiles(list) {
    for (const file of list) state.files.push(file);
    renderFiles();
}

function renderFiles() {
    const listNode = $('#fileList');
    listNode.replaceChildren(...state.files.map((file, index) => el('li', {},
        el('span', { className: 'name' }, `${index + 1}. ${file.name}`),
        el('span', { className: 'size' }, megabytes(file.size) || '<0.1 MB'),
        el('button', { type: 'button', 'aria-label': `Remove ${file.name}`, onclick: () => {
            state.files.splice(index, 1);
            renderFiles();
        } }, '×'))));
    updateEstimate();
}

function updateEstimate() {
    const node = $('#estimate');
    if (state.mode === 'text') {
        const count = words($('#textInput').value);
        $('#textCount').textContent = `${count.toLocaleString()} words`;
        if (!count) return void (node.textContent = '');
        const perWord = state.status?.secondsPerWord || 0.16;
        node.textContent = `About ${minutes(20 + count * perWord)} to make · ${minutes(count / WORDS_PER_MINUTE * 60)} to listen`;
    } else if (state.mode === 'file' && state.files.length) {
        const images = state.files.filter(f => f.type.startsWith('image/')).length;
        node.textContent = images ? `${images} photo${images > 1 ? 's' : ''}: the text is read with OCR first.` : '';
    } else {
        node.textContent = state.mode === 'link' ? 'A 2,000-word article takes about 5 minutes to make.' : '';
    }
}

function formError(message) {
    const node = $('#formError');
    node.textContent = message || '';
    node.hidden = !message;
}

async function submitNew(event) {
    event?.preventDefault();
    formError('');
    if (!state.server || !state.token) {
        formError('Connect your computer first.');
        return showView('settings');
    }
    const button = $('#makeBtn');
    const title = $('#titleInput').value.trim();
    const voice = $('#voiceSelect').value || undefined;
    const readTitle = $('#readTitle').checked;
    button.disabled = true;
    try {
        let source;
        if (state.mode === 'link') {
            const url = $('#urlInput').value.trim();
            let parsed;
            try { parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`); } catch { /* checked below */ }
            if (!url || !parsed || !/^https?:$/.test(parsed.protocol)) throw new Error('Paste a link to an article first.');
            source = { type: 'url', url: parsed.href };
        } else if (state.mode === 'text') {
            const text = $('#textInput').value;
            if (!words(text)) throw new Error('Type or paste some text first.');
            source = { type: 'text', text };
        } else {
            if (!state.files.length) throw new Error('Choose a file or take a photo first.');
            const ids = [];
            for (const [index, original] of state.files.entries()) {
                button.textContent = `Preparing ${index + 1} of ${state.files.length}…`;
                const file = await shrinkImage(original);
                const uploaded = await uploadFile(file, (fraction) => {
                    button.textContent = `Uploading ${index + 1} of ${state.files.length} · ${Math.round(fraction * 100)}%`;
                });
                ids.push(uploaded.id);
            }
            source = { type: 'files', uploads: ids };
        }
        button.textContent = 'Sending…';
        const { job } = await api('/api/jobs', { method: 'POST', json: { source, title, voice, readTitle } });
        $('#urlInput').value = '';
        $('#textInput').value = '';
        $('#titleInput').value = '';
        state.files = [];
        renderFiles();
        state.highlight = job.id;
        state.jobs = [job, ...state.jobs.filter(j => j.id !== job.id)];
        state.lastStatus.set(job.id, job.status);
        showView('library');
        renderLibrary();
    } catch (error) {
        formError(error.message);
        if (error.kind === 'auth') setConnection('error', 'Token rejected');
    } finally {
        button.disabled = false;
        button.textContent = 'Make audio';
    }
}

/* ================================= library ================================== */

function libraryItems() {
    const byId = new Map(state.jobs.map(job => [job.id, job]));
    for (const [id, meta] of state.saved) {
        if (!byId.has(id)) {
            byId.set(id, { id, status: 'done', title: meta.title, source: { label: meta.sourceLabel, type: meta.sourceType },
                audioSeconds: meta.audioSeconds, words: meta.words, createdAt: meta.createdAt, localOnly: true });
        }
    }
    return [...byId.values()].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function queuePosition(job) {
    const running = state.jobs.some(j => j.status === 'extracting' || j.status === 'reading');
    const ahead = state.jobs.filter(j => j.status === 'queued' && j.createdAt < job.createdAt).length;
    return ahead + (running ? 1 : 0);
}

function statusLine(job) {
    if (job.status === 'queued') {
        const ahead = queuePosition(job);
        return { text: ahead ? `Waiting: ${ahead} ahead of it` : 'Starting…', bar: 'indeterminate' };
    }
    if (job.status === 'extracting') return { text: 'Getting the text…', bar: 'indeterminate' };
    if (job.status === 'reading') {
        if (job.phase === 'loading') return { text: 'Warming up your voice…', bar: 'indeterminate' };
        if (job.phase === 'encoding') return { text: 'Finishing the MP3…', bar: 0.99 };
        const elapsed = (Date.now() - (job.startedAt || Date.now())) / 1000;
        const p = job.progress || 0;
        const left = p > 0.08 ? elapsed * (1 - p) / p : (job.estimateSeconds || 0) - elapsed;
        return { text: `Reading ${Math.round(p * 100)}%${left > 0 ? ` · about ${minutes(left)} left` : ''}`, bar: p };
    }
    if (job.status === 'failed') return { text: job.error || 'Something went wrong.', error: true };
    if (job.status === 'cancelled') return { text: 'Cancelled.' };
    return null;
}

function jobCard(job) {
    const saved = state.saved.get(job.id);
    const duration = job.audioSeconds || saved?.audioSeconds;
    const meta = [job.source?.label, job.words ? `${job.words.toLocaleString()} words` : '', duration ? minutes(duration) : '']
        .filter(Boolean).map(part => part.replace(/ /g, '\u00a0')).join(' · ');  // wrap between items only
    const status = statusLine(job);
    const actions = [];
    if (job.status === 'done') {
        actions.push(el('button', { type: 'button', className: 'button primary small', onclick: () => play(job) },
            state.current?.id === job.id && !$('#audio').paused ? 'Playing' : 'Play'));
        actions.push(el('button', { type: 'button', className: 'button small', onclick: () => download(job) }, 'Download'));
        if (navigator.share) actions.push(el('button', { type: 'button', className: 'button small', onclick: () => share(job) }, 'Share'));
        if (!saved && !job.localOnly) {
            actions.push(el('button', { type: 'button', className: 'button small', disabled: state.saving.has(job.id),
                onclick: () => saveOffline(job) }, state.saving.has(job.id) ? 'Saving…' : 'Save offline'));
        }
    }
    if (ACTIVE.includes(job.status)) {
        actions.push(el('button', { type: 'button', className: 'button small', onclick: () => act(job, 'cancel') }, 'Cancel'));
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
        actions.push(el('button', { type: 'button', className: 'button primary small', onclick: () => act(job, 'retry') }, 'Try again'));
        if (job.source?.type === 'url') {
            actions.push(el('button', { type: 'button', className: 'button small', onclick: () => {
                setMode('text');
                showView('new');
                $('#textInput').focus();
                toast('Copy the article text from the page and paste it here.');
            } }, 'Paste text instead'));
        }
    }
    if (job.status === 'done' && !job.localOnly) {
        actions.push(el('button', { type: 'button', className: 'button small', onclick: () => showText(job) }, 'Text'));
    }
    if (!ACTIVE.includes(job.status)) {
        actions.push(el('button', { type: 'button', className: 'button small danger', onclick: () => removeJob(job) }, 'Delete'));
    }
    const progress = status && status.bar !== undefined
        ? el('div', { className: `progress${status.bar === 'indeterminate' ? ' indeterminate' : ''}`, role: 'progressbar',
            'aria-valuemin': '0', 'aria-valuemax': '100',
            'aria-valuenow': typeof status.bar === 'number' ? String(Math.round(status.bar * 100)) : undefined }, el('span'))
        : null;
    if (progress && typeof status.bar === 'number') progress.firstChild.style.width = `${Math.round(status.bar * 100)}%`;
    const iconPath = ICONS[job.source?.type] || ICONS.text;
    return el('li', { className: `job${state.highlight === job.id ? ' highlight' : ''}`, dataset: { id: job.id } },
        el('div', { className: 'job-head' },
            el('div', { className: 'job-icon' }, icon(iconPath)),
            el('div', { className: 'job-main' },
                el('p', { className: 'job-title' }, job.title || job.source?.label || 'Untitled'),
                el('div', { className: 'job-meta' }, meta,
                    saved ? el('span', { className: 'chip' }, 'on this phone') : null))),
        status ? el('p', { className: `job-status${status.error ? ' error' : ''}` }, status.text) : null,
        progress,
        job.warnings?.length && job.status !== 'failed'
            ? el('ul', { className: 'job-warnings' }, job.warnings.map(w => el('li', {}, w))) : null,
        actions.length ? el('div', { className: 'job-actions' }, actions) : null);
}

function renderLibrary() {
    const items = libraryItems();
    $('#jobList').replaceChildren(...items.map(jobCard));
    $('#libraryEmpty').hidden = items.length > 0;
    const active = state.jobs.filter(j => ACTIVE.includes(j.status)).length;
    const badge = $('#activeBadge');
    badge.hidden = !active;
    badge.textContent = String(active);
}

async function act(job, action) {
    try {
        const { job: updated } = await api(`/api/jobs/${job.id}/${action}`, { method: 'POST' });
        state.jobs = state.jobs.map(j => j.id === updated.id ? updated : j);
        renderLibrary();
        schedulePoll(800);
    } catch (error) {
        toast(error.message);
    }
}

async function removeJob(job) {
    const saved = state.saved.has(job.id);
    if (!confirm(saved ? 'Delete this recording from your computer and this phone?' : 'Delete this recording?')) return;
    try {
        if (!job.localOnly) await api(`/api/jobs/${job.id}`, { method: 'DELETE' });
    } catch (error) {
        if (error.status !== 404) return toast(error.message);
    }
    if (saved) {
        await idb.remove(job.id).catch(() => {});
        state.saved.delete(job.id);
    }
    if (state.current?.id === job.id) closePlayer();
    local.remove(`pos.${job.id}`);
    state.jobs = state.jobs.filter(j => j.id !== job.id);
    renderLibrary();
    updateStorage();
}

async function showText(job) {
    try {
        const { title, text } = await api(`/api/jobs/${job.id}/text`);
        const dialog = el('dialog', { className: 'panel text-dialog' },
            el('h3', {}, title || 'Text'),
            el('div', { className: 'text-body' }, text.split(/\n{2,}/).map(p => el('p', {}, p))),
            el('button', { type: 'button', className: 'button primary', onclick: () => dialog.close() }, 'Close'));
        dialog.addEventListener('close', () => dialog.remove());
        document.body.append(dialog);
        dialog.showModal();
    } catch (error) {
        toast(error.message);
    }
}

function finished(job) {
    toast(`“${job.title || 'Your audio'}” is ready.`, 6000);
    navigator.vibrate?.([60, 40, 60]);
    if (local.get('notify', false) && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
        navigator.serviceWorker?.ready.then(reg => reg.showNotification('Audio ready', {
            body: job.title || 'Your recording is ready.', icon: 'icons/icon-192.png', tag: job.id
        })).catch(() => {});
    }
    if (local.get('autoSave', true)) saveOffline(job, { quiet: true });
}

async function refreshJobs() {
    if (!state.server || !state.token) {
        renderLibrary();
        return;
    }
    try {
        const { jobs } = await api('/api/jobs');
        for (const job of jobs) {
            const before = state.lastStatus.get(job.id);
            if (before && before !== 'done' && job.status === 'done') finished(job);
            state.lastStatus.set(job.id, job.status);
        }
        state.jobs = jobs;
        local.set('jobs', jobs.slice(0, 100));
        $('#offlineNotice').hidden = true;
        const busy = jobs.some(j => ACTIVE.includes(j.status));
        setConnection(busy ? 'busy' : 'ok', busy ? 'Reading…' : 'Connected');
    } catch (error) {
        if (error.kind === 'network') {
            $('#offlineNotice').hidden = false;
            setConnection('offline', navigator.onLine ? 'Unreachable' : 'Offline');
        } else if (error.kind === 'auth') {
            setConnection('error', 'Token rejected');
        }
    } finally {
        renderLibrary();
        schedulePoll();
    }
}

function schedulePoll(delay) {
    clearTimeout(state.pollTimer);
    if (!state.server) return;
    const busy = state.jobs.some(j => ACTIVE.includes(j.status));
    state.pollTimer = setTimeout(refreshJobs, delay ?? (document.hidden ? 20000 : busy ? 2500 : 30000));
}

/* ================================= player =================================== */

const audio = $('#audio');

async function sourceFor(job) {
    const record = await idb.get(job.id).catch(() => null);
    if (record?.blob) return { url: URL.createObjectURL(record.blob), revoke: true };
    const { path } = await api(`/api/jobs/${job.id}/link`, { method: 'POST' });
    return { url: state.server + path, revoke: false };
}

async function play(job) {
    if (state.current?.id === job.id) return togglePlay();
    try {
        const source = await sourceFor(job);
        if (state.current?.revoke) URL.revokeObjectURL(state.current.url);
        state.current = { id: job.id, title: job.title, ...source };
        audio.src = source.url;
        audio.playbackRate = local.get('speed', 1);
        $('#playerTitle').textContent = job.title || 'Audioshop';
        $('#player').hidden = false;
        document.querySelector('.app').classList.add('has-player');
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: job.title || 'Audioshop', artist: 'Read by you (AI voice)', album: job.source?.label || 'Audioshop',
                artwork: [{ src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' }]
            });
        }
        await audio.play();
    } catch (error) {
        toast(error.name === 'NotAllowedError' ? 'Tap play to start.' : (error.message || 'Could not play that recording.'));
    }
    renderLibrary();
}

function togglePlay() {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
}

function closePlayer() {
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (state.current?.revoke) URL.revokeObjectURL(state.current.url);
    state.current = null;
    $('#player').hidden = true;
    document.querySelector('.app').classList.remove('has-player');
}

function seekBy(seconds) {
    if (!Number.isFinite(audio.duration)) return;
    audio.currentTime = Math.min(Math.max(0, audio.currentTime + seconds), audio.duration - 0.5);
}

let lastSaved = 0;
audio.addEventListener('loadedmetadata', () => {
    const resume = local.get(`pos.${state.current?.id}`, 0);
    if (resume > 5 && resume < audio.duration - 10) audio.currentTime = resume;
});
audio.addEventListener('timeupdate', () => {
    const { currentTime, duration } = audio;
    if (Number.isFinite(duration)) {
        $('#seek').value = String(Math.round(currentTime / duration * 1000));
        $('#timeNow').textContent = clock(currentTime);
        $('#timeLeft').textContent = `-${clock(duration - currentTime)}`;
        navigator.mediaSession?.setPositionState?.({ duration, position: Math.min(currentTime, duration), playbackRate: audio.playbackRate });
    }
    if (state.current && Date.now() - lastSaved > 5000) {
        lastSaved = Date.now();
        local.set(`pos.${state.current.id}`, currentTime);
    }
});
audio.addEventListener('play', () => { $('#playBtn').classList.add('playing'); $('#playBtn').setAttribute('aria-label', 'Pause'); });
audio.addEventListener('pause', () => {
    $('#playBtn').classList.remove('playing');
    $('#playBtn').setAttribute('aria-label', 'Play');
    if (state.current) local.set(`pos.${state.current.id}`, audio.currentTime);
});
audio.addEventListener('ended', () => state.current && local.remove(`pos.${state.current.id}`));
audio.addEventListener('error', () => state.current && toast('That audio could not be played. Try Download instead.'));

if ('mediaSession' in navigator) {
    const handlers = {
        play: () => audio.play(), pause: () => audio.pause(),
        seekbackward: () => seekBy(-15), seekforward: () => seekBy(30),
        seekto: (details) => { audio.currentTime = details.seekTime; }
    };
    for (const [action, handler] of Object.entries(handlers)) {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported */ }
    }
}

async function download(job) {
    try {
        const record = await idb.get(job.id).catch(() => null);
        if (record?.blob) {
            const url = URL.createObjectURL(record.blob);
            const link = el('a', { href: url, download: fileName(job) });
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            return;
        }
        const { path } = await api(`/api/jobs/${job.id}/link`, { method: 'POST' });
        location.href = `${state.server}${path}&download=1`;
    } catch (error) {
        toast(error.message);
    }
}

async function share(job) {
    try {
        const record = await idb.get(job.id).catch(() => null);
        if (!record?.blob) {
            await saveOffline(job, { quiet: true });
            return toast('Saved on this phone. Tap Share again to send it to another app.');
        }
        const file = new File([record.blob], fileName(job), { type: 'audio/mpeg' });
        if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: job.title });
        else download(job);
    } catch (error) {
        if (error.name !== 'AbortError') toast(error.message || 'Sharing failed.');
    }
}

/* ================================ settings ================================== */

function normalizeServer(value) {
    let url;
    try { url = new URL(value.trim()); } catch { throw new Error('Enter the full address, starting with https://'); }
    const loopback = /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
    if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:')) {
        throw new Error('The address must start with https:// (Tailscale Serve gives you one).');
    }
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

function renderStatus(status) {
    const node = $('#serverStatus');
    const engine = status.engine;
    node.replaceChildren(...[
        el('p', { className: engine.ready ? 'ok' : 'bad' }, engine.ready ? 'Connected. Your voice is ready.' : 'Connected, but the voice engine needs attention:'),
        engine.problems.length ? el('ul', {}, engine.problems.map(p => el('li', {}, p))) : null,
        el('p', { className: 'hint' }, `Voices: ${status.voices.map(v => v.label).join(', ')} · ` +
            `up to ${status.limits.maxWords.toLocaleString()} words · ${status.queue.waiting} waiting`)
    ].filter(Boolean));
    const select = $('#voiceSelect');
    const chosen = local.get('voice', '');
    select.replaceChildren(...status.voices.map(v => el('option', { value: v.id, selected: chosen ? v.id === chosen : v.default }, v.label)));
}

async function connect(serverValue, token, { quiet = false } = {}) {
    const server = normalizeServer(serverValue);
    if (!token) throw new Error('Enter the access token from npm run setup.');
    const previous = { server: state.server, token: state.token };
    Object.assign(state, { server, token });
    try {
        const status = await api('/api/status');
        local.set('server', server);
        local.set('token', token);
        if (!local.get('pairedAt', 0)) local.set('pairedAt', Date.now());
        state.status = status;
        renderStatus(status);
        $('#onboarding').hidden = true;
        setConnection('ok', 'Connected');
        if (!quiet) toast('Connected to your computer.');
        refreshJobs();
        return status;
    } catch (error) {
        if (quiet) {  // startup reconnect: keep the saved pairing, show why, try again later
            setConnection(error.kind === 'auth' ? 'error' : 'offline', error.kind === 'auth' ? 'Token rejected' : 'Unreachable');
            if (error.kind === 'network') $('#offlineNotice').hidden = false;
            schedulePoll(15000);
            return null;
        }
        Object.assign(state, previous);
        throw error;
    }
}

async function updateStorage() {
    let used = 0;
    for (const meta of state.saved.values()) used += meta.bytes || 0;
    let text = `${state.saved.size} recording${state.saved.size === 1 ? '' : 's'} saved (${megabytes(used) || '0 MB'}).`;
    try {
        const estimate = await navigator.storage?.estimate?.();
        if (estimate?.quota) text += ` About ${Math.round(estimate.quota / 1073741824 * 10) / 10} GB available to this site.`;
        if (await navigator.storage?.persisted?.()) text += ' Protected from automatic clean-up.';
    } catch { /* not supported */ }
    $('#storageInfo').textContent = text;
}

/* ============================ links and pairing ============================= */

// #pair=<base64url {"server","token"}> from `npm run pair`. The fragment never leaves the phone.
function pairFromLink(pairing) {
    $('#serverInput').value = pairing.server;
    $('#tokenInput').value = pairing.token;
    connect(pairing.server, pairing.token).catch((error) => {
        showView('settings');
        $('#serverStatus').replaceChildren(el('p', { className: 'bad' }, error.message));
    });
}

function readPairing() {
    const match = location.hash.match(/^#pair=([\w-]+)/);
    if (!match) return null;
    history.replaceState(null, '', location.pathname + location.search);
    try {
        const json = atob(match[1].replace(/-/g, '+').replace(/_/g, '/'));
        const { server, token } = JSON.parse(json);
        return { server, token };
    } catch {
        toast('That pairing link is damaged. Run npm run pair again.');
        return null;
    }
}

// ?url= / ?text= / ?title= come from the Android share sheet (manifest share_target) or from an
// iOS Shortcut. ?go=1 starts the recording straight away.
function readSharedContent() {
    const params = new URLSearchParams(location.search);
    let url = params.get('url') || '';
    const text = params.get('text') || '';
    const title = params.get('title') || '';
    if (!url && /https?:\/\/\S+/.test(text)) url = text.match(/https?:\/\/\S+/)[0];
    if (!url && !text) return false;
    history.replaceState(null, '', location.pathname);
    if (url) {
        setMode('link');
        $('#urlInput').value = url;
    } else {
        setMode('text');
        $('#textInput').value = text;
    }
    if (title && !url) $('#titleInput').value = title;
    updateEstimate();
    if (params.get('go') === '1' && state.server) submitNew();
    return true;
}

/* ================================== wiring ================================== */

function wire() {
    for (const button of document.querySelectorAll('[data-goto]')) {
        button.addEventListener('click', () => showView(button.dataset.goto));
    }
    for (const button of document.querySelectorAll('.segment')) {
        button.addEventListener('click', () => setMode(button.dataset.mode));
    }
    $('#newForm').addEventListener('submit', submitNew);
    $('#textInput').addEventListener('input', updateEstimate);
    $('#fileInput').addEventListener('change', (event) => {
        addFiles(event.target.files);
        event.target.value = '';
    });
    const drop = $('#dropzone');
    drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragging'));
    drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('dragging');
        addFiles(event.dataTransfer.files);
    });
    $('#pasteBtn').addEventListener('click', async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim();
            const url = text.match(/https?:\/\/\S+/)?.[0];
            if (url) $('#urlInput').value = url;
            else if (text) toast('The clipboard has no link in it.');
        } catch {
            $('#urlInput').focus();
            toast('Press and hold in the box, then choose Paste.');
        }
    });
    $('#voiceSelect').addEventListener('change', (event) => local.set('voice', event.target.value));
    $('#readTitle').checked = local.get('readTitle', true);
    $('#readTitle').addEventListener('change', (event) => local.set('readTitle', event.target.checked));

    $('#serverForm').addEventListener('submit', async (event) => {
        event.preventDefault();
        const button = $('#connectBtn');
        button.disabled = true;
        button.textContent = 'Connecting…';
        try {
            await connect($('#serverInput').value, $('#tokenInput').value.trim());
        } catch (error) {
            $('#serverStatus').replaceChildren(el('p', { className: 'bad' }, error.message));
            setConnection(error.kind === 'auth' ? 'error' : 'offline', error.kind === 'auth' ? 'Token rejected' : 'Not connected');
        } finally {
            button.disabled = false;
            button.textContent = 'Connect';
        }
    });
    $('#showToken').addEventListener('click', (event) => {
        const input = $('#tokenInput');
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        event.target.textContent = show ? 'Hide' : 'Show';
        event.target.setAttribute('aria-pressed', String(show));
    });
    $('#autoSave').checked = local.get('autoSave', true);
    $('#autoSave').addEventListener('change', (event) => local.set('autoSave', event.target.checked));
    $('#notifyDone').checked = local.get('notify', false) && 'Notification' in window && Notification.permission === 'granted';
    $('#notifyDone').addEventListener('change', async (event) => {
        if (event.target.checked && 'Notification' in window) {
            const permission = await Notification.requestPermission();
            event.target.checked = permission === 'granted';
            if (permission !== 'granted') toast('Notifications are blocked for this site in your browser settings.');
        }
        local.set('notify', event.target.checked);
    });
    $('#clearAudio').addEventListener('click', async () => {
        if (!state.saved.size || !confirm('Remove all audio saved on this phone? It stays on your computer.')) return;
        closePlayer();
        await idb.clear().catch(() => {});
        state.saved.clear();
        renderLibrary();
        updateStorage();
    });
    $('#forgetServer').addEventListener('click', () => {
        if (!confirm('Disconnect this phone from your computer? Saved audio stays on the phone.')) return;
        for (const key of ['server', 'token', 'jobs', 'pairedAt']) local.remove(key);
        Object.assign(state, { server: '', token: '', jobs: [], status: null });
        $('#serverInput').value = '';
        $('#tokenInput').value = '';
        $('#serverStatus').replaceChildren();
        $('#onboarding').hidden = false;
        setConnection('unknown', 'Not connected');
        renderLibrary();
    });
    $('#connection').addEventListener('click', () => showView(state.server ? 'library' : 'settings'));
    $('#refreshBtn').addEventListener('click', refreshJobs);

    $('#playBtn').addEventListener('click', togglePlay);
    $('#back15').addEventListener('click', () => seekBy(-15));
    $('#fwd30').addEventListener('click', () => seekBy(30));
    $('#seek').addEventListener('input', (event) => {
        if (Number.isFinite(audio.duration)) audio.currentTime = event.target.value / 1000 * audio.duration;
    });
    $('#speedBtn').addEventListener('click', () => {
        const next = SPEEDS[(SPEEDS.indexOf(audio.playbackRate) + 1) % SPEEDS.length] || 1;
        audio.playbackRate = next;
        local.set('speed', next);
        $('#speedBtn').textContent = `${next}×`;
    });
    $('#speedBtn').textContent = `${local.get('speed', 1)}×`;

    window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        state.installPrompt = event;
        $('#installBtn').hidden = false;
    });
    $('#installBtn').addEventListener('click', async () => {
        await state.installPrompt?.prompt();
        state.installPrompt = null;
        $('#installBtn').hidden = true;
    });
    if (matchMedia('(display-mode: standalone)').matches || navigator.standalone) $('#installPanel').hidden = true;

    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshJobs(); else schedulePoll(); });
    window.addEventListener('online', refreshJobs);
    window.addEventListener('hashchange', () => {  // a pairing link opened while the app is already open
        const paired = readPairing();
        if (paired) pairFromLink(paired);
    });
    window.addEventListener('offline', () => setConnection('offline', 'Offline'));
}

async function boot() {
    $('#appVersion').textContent = APP_VERSION;
    wire();
    await loadSaved();

    const paired = readPairing();
    // When this page is served by your own computer, its address is the server address.
    if (!state.server && !paired && !/github\.io$/.test(location.hostname) && location.protocol !== 'file:') {
        $('#serverInput').value = new URL('.', location.href).href.replace(/\/+$/, '');
    }
    $('#serverInput').value = paired?.server || state.server || $('#serverInput').value;
    $('#tokenInput').value = paired?.token || state.token || '';
    $('#onboarding').hidden = Boolean(state.server || paired);
    for (const job of state.jobs) state.lastStatus.set(job.id, job.status);
    renderLibrary();

    const shared = readSharedContent();
    if (paired) {
        pairFromLink(paired);
    } else if (state.server) {
        connect(state.server, state.token, { quiet: true });
    } else {
        setConnection('unknown', 'Not connected');
    }
    if (!shared && state.server && state.jobs.some(j => ACTIVE.includes(j.status))) showView('library');
    updateEstimate();

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

boot();
