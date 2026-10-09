'use strict';
// Starts a real server.js in a child process with a temporary data folder and the fake engine, so the
// tests exercise the HTTP API, the queue and process handling exactly as deployed, without the voice
// model. Nothing is read from the developer's .env.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(__dirname, 'fixtures');
const TOKEN = 'test-token-0123456789-abcdefghijklmnop';

function freePort() {
    return new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

async function startServer({ dataDir, env = {} } = {}) {
    const port = await freePort();
    dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'audioshop-test-'));
    const child = spawn(process.execPath, ['server.js'], {
        cwd: root,
        env: {
            ...process.env,
            AUDIOSHOP_ENV_FILE: path.join(dataDir, 'no-such.env'),
            AUDIOSHOP_DATA_DIR: dataDir,
            AUDIOSHOP_TOKEN: TOKEN,
            PORT: String(port),
            HOST: '127.0.0.1',
            ALLOWED_ORIGINS: 'https://kalistamp.github.io',
            AUDIOSHOP_EXTRACTOR_CMD: JSON.stringify([process.execPath, path.join(fixtures, 'fake-extractor.js')]),
            VOICE_READER_BIN: path.join(fixtures, 'fake-voice-reader.js'),
            VOICE_READER_HOME: '',
            NODE_NO_WARNINGS: '1',
            ...env
        },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    child.stdout.on('data', chunk => { log += chunk; });
    child.stderr.on('data', chunk => { log += chunk; });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`${base}/api/health`)).ok) break;
        } catch { /* not up yet */ }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {
        base, port, dataDir, child,
        log: () => log,
        stop: () => new Promise((resolve) => {
            if (child.exitCode !== null) return resolve();
            child.once('exit', resolve);
            child.kill('SIGTERM');
        })
    };
}

function client(base, token = TOKEN) {
    return async (pathname, { method = 'GET', json, headers = {}, body, raw = false } = {}) => {
        const res = await fetch(base + pathname, {
            method,
            headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(json ? { 'Content-Type': 'application/json' } : {}), ...headers },
            body: json ? JSON.stringify(json) : body
        });
        if (raw) return res;
        const text = await res.text();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch { data = text; }
        return { status: res.status, data, headers: res.headers };
    };
}

async function waitFor(fn, { timeout = 15000, interval = 100 } = {}) {
    const end = Date.now() + timeout;
    let last;
    while (Date.now() < end) {
        last = await fn();
        if (last) return last;
        await new Promise(resolve => setTimeout(resolve, interval));
    }
    throw new Error(`timed out; last value ${JSON.stringify(last)}`);
}

module.exports = { startServer, client, waitFor, TOKEN, root, fixtures };
