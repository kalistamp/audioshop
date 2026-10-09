'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startServer, client, waitFor, TOKEN } = require('./helpers.cjs');

let server;
let api;

before(async () => {
    server = await startServer({ env: { MAX_WORDS: '200' } });
    api = client(server.base);
});
after(async () => { await server?.stop(); });

async function finish(id, statuses = ['done', 'failed', 'cancelled']) {
    return waitFor(async () => {
        const { data } = await api(`/api/jobs/${id}`);
        return statuses.includes(data.job.status) ? data.job : null;
    });
}

test('health is public; everything else needs the token', async () => {
    const health = await client(server.base, '')('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.data.app, 'audioshop');
    assert.equal((await client(server.base, '')('/api/status')).status, 401);
    assert.equal((await client(server.base, 'wrong-token-wrong-token-wrong')('/api/jobs')).status, 401);
    const status = await api('/api/status');
    assert.equal(status.status, 200);
    assert.deepEqual(status.data.voices, [{ id: 'default', label: 'My voice', default: true }]);
});

test('CORS: the GitHub Pages origin and localhost pass, other sites do not', async () => {
    const preflight = (origin) => fetch(`${server.base}/api/jobs`, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' }
    });
    const ok = await preflight('https://kalistamp.github.io');
    assert.equal(ok.status, 204);
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://kalistamp.github.io');
    assert.equal(ok.headers.get('access-control-allow-private-network'), 'true');
    assert.match(ok.headers.get('access-control-allow-headers'), /Authorization/);
    assert.equal((await preflight('http://localhost:5173')).status, 204);
    const evil = await preflight('https://evil.example');
    assert.equal(evil.status, 403);
    assert.equal(evil.headers.get('access-control-allow-origin'), null);
    const nullOrigin = await preflight('null');
    assert.equal(nullOrigin.status, 403);
});

test('a text job runs through every stage and its MP3 can be fetched three ways', async () => {
    const created = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'Hello there. This is a test of the reader. WARN' }, title: 'My Test' } });
    assert.equal(created.status, 201);
    const seen = new Set();
    const job = await waitFor(async () => {
        const { data } = await api(`/api/jobs/${created.data.job.id}`);
        seen.add(`${data.job.status}/${data.job.phase}`);
        return data.job.status === 'done' ? data.job : null;
    }, { interval: 30 });
    assert.ok([...seen].some(s => s.startsWith('reading/')), `saw ${[...seen]}`);
    assert.equal(job.title, 'My Test');
    assert.equal(job.words, 10);
    assert.equal(job.progress, 1);
    assert.equal(job.audioSeconds, 1.5);
    assert.deepEqual(job.warnings, ['A test warning.']);
    const report = JSON.parse(fs.readFileSync(path.join(server.dataDir, 'jobs', job.id, 'report.json'), 'utf8'));
    assert.equal(report.args.readTitle, true);
    assert.equal(report.args.title, 'My Test');

    const withToken = await api(`/api/jobs/${job.id}/audio`, { raw: true });
    assert.equal(withToken.status, 200);
    assert.equal(withToken.headers.get('content-type'), 'audio/mpeg');
    assert.match(withToken.headers.get('content-disposition'), /filename="My-Test\.mp3"/);
    const bytes = Buffer.from(await withToken.arrayBuffer());
    assert.equal(bytes.subarray(0, 3).toString(), 'ID3');

    const link = await api(`/api/jobs/${job.id}/link`, { method: 'POST' });
    const anonymous = client(server.base, '');
    const signed = await anonymous(`${link.data.path}&download=1`, { raw: true });
    assert.equal(signed.status, 200);
    assert.match(signed.headers.get('content-disposition'), /^attachment/);
    const ranged = await anonymous(link.data.path, { raw: true, headers: { Range: 'bytes=0-99' } });
    assert.equal(ranged.status, 206);
    assert.equal((await ranged.arrayBuffer()).byteLength, 100);
    const tampered = await anonymous(link.data.path.replace(/sig=[^&]+/, 'sig=AAAA'), { raw: true });
    assert.equal(tampered.status, 401);
    assert.equal((await anonymous(`/api/jobs/${job.id}/audio`, { raw: true })).status, 401);

    const text = await api(`/api/jobs/${job.id}/text`);
    assert.match(text.data.text, /This is a test/);
});

test('uploads: allowed files become a job; other types are refused', async () => {
    const bad = await api('/api/uploads', { method: 'POST', body: Buffer.from('MZ\x90'), headers: { 'X-File-Name': 'tool.exe' } });
    assert.equal(bad.status, 415);
    const up = await api('/api/uploads', { method: 'POST', body: Buffer.from('Chapter text from a file. It is short.'),
        headers: { 'X-File-Name': encodeURIComponent('My Notes.txt'), 'Content-Type': 'text/plain' } });
    assert.equal(up.status, 201);
    assert.equal(up.data.name, 'My Notes.txt');
    const created = await api('/api/jobs', { method: 'POST', json: { source: { type: 'files', uploads: [up.data.id] }, readTitle: false } });
    assert.equal(created.status, 201);
    assert.equal(created.data.job.source.label, 'My Notes.txt');
    const job = await finish(created.data.job.id);
    assert.equal(job.status, 'done');
    assert.equal(job.title, 'My Notes');
    const again = await api('/api/jobs', { method: 'POST', json: { source: { type: 'files', uploads: [up.data.id] } } });
    assert.equal(again.status, 410);  // an upload belongs to one job
});

test('bad input is rejected with a clear message', async () => {
    const ftp = await api('/api/jobs', { method: 'POST', json: { source: { type: 'url', url: 'ftp://example.com/a' } } });
    assert.equal(ftp.status, 400);
    assert.match(ftp.data.error, /http/);
    const empty = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: '   ' } } });
    assert.equal(empty.status, 400);
    const voice = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'hi' }, voice: 'nope' } });
    assert.equal(voice.status, 400);
    assert.equal((await api('/api/jobs/does-not-exist')).status, 404);
});

test('extractor failures and the word limit end as readable errors', async () => {
    const url = await api('/api/jobs', { method: 'POST', json: { source: { type: 'url', url: 'https://news.example.org/story' } } });
    assert.equal(url.data.job.source.label, 'news.example.org');
    assert.equal((await finish(url.data.job.id)).title, 'Story from news.example.org');
    const reportOf = id => JSON.parse(fs.readFileSync(path.join(server.dataDir, 'jobs', id, 'report.json'), 'utf8'));
    assert.equal(reportOf(url.data.job.id).args.readTitle, true);  // a real headline is announced

    const untitled = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'No headline here. Just text.' } } });
    assert.equal((await finish(untitled.data.job.id)).status, 'done');
    assert.equal(reportOf(untitled.data.job.id).args.readTitle, false);  // a stand-in label is not

    const failing = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'FAIL_EXTRACT please' } } });
    const failed = await finish(failing.data.job.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'No article text found on that page.');

    const long = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'word '.repeat(250) } } });
    const tooLong = await finish(long.data.job.id);
    assert.equal(tooLong.status, 'failed');
    assert.match(tooLong.error, /250 words; the limit is 200/);

    const hot = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'OVERHEAT now' } } });
    const stopped = await finish(hot.data.job.id);
    assert.match(stopped.error, /too hot/);
});

test('cancel stops the engine process; retry and delete work', async () => {
    const created = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'HANG forever' } } });
    const id = created.data.job.id;
    const pidFile = path.join(server.dataDir, 'jobs', id, 'reader.pid');
    await waitFor(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    const cancelled = await api(`/api/jobs/${id}/cancel`, { method: 'POST' });
    assert.equal(cancelled.status, 200);
    assert.equal((await finish(id)).status, 'cancelled');
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });

    const failing = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'FAIL_EXTRACT' } } });
    await finish(failing.data.job.id);
    const retried = await api(`/api/jobs/${failing.data.job.id}/retry`, { method: 'POST' });
    assert.equal(retried.status, 200);
    assert.equal((await finish(failing.data.job.id)).status, 'failed');

    const removed = await api(`/api/jobs/${id}`, { method: 'DELETE' });
    assert.equal(removed.status, 204);
    assert.equal((await api(`/api/jobs/${id}`)).status, 404);
    assert.equal(fs.existsSync(path.join(server.dataDir, 'jobs', id)), false);
});

test('jobs run one at a time, oldest first', async () => {
    const a = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'SLOW first' } } });
    const b = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'second one' } } });
    let both = false;
    await waitFor(async () => {
        const [ja, jb] = await Promise.all([api(`/api/jobs/${a.data.job.id}`), api(`/api/jobs/${b.data.job.id}`)]);
        const running = ['extracting', 'reading'];
        if (running.includes(ja.data.job.status) && running.includes(jb.data.job.status)) both = true;
        if (ja.data.job.status !== 'done') assert.ok(['queued', 'cancelled'].includes(jb.data.job.status) || jb.data.job.status !== 'done');
        return ja.data.job.status === 'done' && jb.data.job.status === 'done';
    }, { interval: 50 });
    assert.equal(both, false);
    const [ja, jb] = await Promise.all([api(`/api/jobs/${a.data.job.id}`), api(`/api/jobs/${b.data.job.id}`)]);
    assert.ok(ja.data.job.finishedAt <= jb.data.job.startedAt);
});

test('the app itself is served with its security policy', async () => {
    const res = await fetch(`${server.base}/`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.match(html, /Content-Security-Policy/);
    assert.match(html, /script-src 'self'/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(`${server.base}/sw.js`)).headers.get('cache-control'), 'no-cache');
});

test('a server restart puts the interrupted job back in the queue and stops its engine', async () => {
    const created = await api('/api/jobs', { method: 'POST', json: { source: { type: 'text', text: 'HANG until restart' } } });
    const id = created.data.job.id;
    const pidFile = path.join(server.dataDir, 'jobs', id, 'reader.pid');
    await waitFor(() => fs.existsSync(pidFile));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await server.stop();
    await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
    fs.rmSync(pidFile);
    // Edit the job's text so the restarted run completes instead of hanging again.
    fs.writeFileSync(path.join(server.dataDir, 'jobs', id, 'job.json'), JSON.stringify({ source: { type: 'text', text: 'resumed fine' }, title: '' }));
    server = await startServer({ dataDir: server.dataDir, env: { MAX_WORDS: '200' } });
    api = client(server.base);
    const job = await finish(id);
    assert.equal(job.status, 'done');
    assert.match(server.log(), /resuming 1 interrupted/);
});

test('the token is never written to the log', async () => {
    assert.equal(server.log().includes(TOKEN), false);
});
