'use strict';

// Runs the two programs that do the real work, both on this machine:
//   1. the extractor (extractor/, Python): link, document or photos -> text.txt + extract.json
//   2. voice-reader (the TTS project): text.txt -> audio.mp3 in your voice
// Each runs in its own process group so a cancel stops the whole tree, including voice-reader's
// synthesis workers. voice-reader reports progress as "PHASE x" / "PROGRESS n total" lines when
// VOICE_READER_PROGRESS=1.

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

class EngineError extends Error {
    constructor(message, { cancelled = false, detail = [] } = {}) {
        super(message);
        this.name = 'EngineError';
        this.cancelled = cancelled;
        this.detail = detail;  // the program's last stderr lines, for the server log only
    }
}

function stop(child) {
    if (!child.pid || child.exitCode !== null) return;
    if (config.isWindows) {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
        return;
    }
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ }
    }, 5000).unref();
}

function run(command, args, { cwd, env, signal, timeoutMs, onLine }) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd, env: { ...process.env, ...env }, detached: !config.isWindows,
            stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        });
        const tail = [];
        let buffer = '';
        let timer;
        const onAbort = () => stop(child);
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            buffer += chunk;
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop();
            for (const line of lines) {
                if (!line.trim()) continue;
                tail.push(line);
                if (tail.length > 40) tail.shift();
                onLine?.(line);
            }
        });
        child.stdout.resume();
        child.on('error', (error) => {
            signal?.removeEventListener('abort', onAbort);
            clearTimeout(timer);
            reject(new EngineError(`Could not start ${path.basename(command)}: ${error.message}`));
        });
        child.on('close', (code) => {
            signal?.removeEventListener('abort', onAbort);
            clearTimeout(timer);
            if (buffer.trim()) tail.push(buffer.trim());
            resolve({ code, tail, aborted: Boolean(signal?.aborted) });
        });
        if (signal) {
            if (signal.aborted) stop(child);
            signal.addEventListener('abort', onAbort, { once: true });
        }
        if (timeoutMs) timer = setTimeout(() => stop(child), timeoutMs);
    });
}

function userMessage(tail, fallback) {
    const marked = [...tail].reverse().find(line => line.startsWith('AUDIOSHOP_ERROR: '));
    if (marked) return marked.slice('AUDIOSHOP_ERROR: '.length);
    // voice-reader: a logged ERROR line, or the last line of a Python traceback ("RuntimeError: ...").
    const logged = [...tail].reverse().find(line => / ERROR /.test(line));
    if (logged) return logged.replace(/^.*? ERROR /, '');
    const raised = [...tail].reverse().find(line => /^[A-Za-z_.]+(Error|Exception): /.test(line));
    if (raised) return raised.replace(/^[A-Za-z_.]+(Error|Exception): /, '');
    return fallback;
}

async function extract(jobDir, signal) {
    const [command, ...args] = config.extractorCmd;
    // cwd is the extractor folder: `python -m audioshop_extract` finds the package from there.
    const result = await run(command, [...args, jobDir], {
        cwd: path.join(config.ROOT, 'extractor'), env: { HF_HUB_DISABLE_TELEMETRY: '1' }, signal,
        timeoutMs: config.extractTimeoutMs
    });
    if (result.aborted) throw new EngineError('Cancelled.', { cancelled: true });
    if (result.code !== 0) {
        throw new EngineError(userMessage(result.tail, 'Could not get the text out of that source.'),
            { detail: result.tail.slice(-6) });
    }
    return JSON.parse(fs.readFileSync(path.join(jobDir, 'extract.json'), 'utf8'));
}

async function read(jobDir, { title, readTitle, voiceConfig }, { onProgress, onPhase, signal }) {
    const args = [];
    if (voiceConfig) args.push('--config', voiceConfig);
    args.push('read', path.join(jobDir, 'text.txt'), '-o', path.join(jobDir, 'audio.mp3'),
        '--title', title, '--report', path.join(jobDir, 'report.json'));
    if (readTitle) args.push('--read-title');
    const result = await run(config.voiceReaderBin, args, {
        cwd: config.voiceReaderHome || config.ROOT,
        env: { VOICE_READER_PROGRESS: '1', VOICE_READER_HOME: config.voiceReaderHome || '', HF_HUB_DISABLE_TELEMETRY: '1' },
        signal,
        onLine(line) {
            const progress = line.match(/^PROGRESS (\d+) (\d+)$/);
            if (progress) return onProgress?.(Number(progress[1]), Number(progress[2]));
            const phase = line.match(/^PHASE (\w+)$/);
            if (phase) onPhase?.(phase[1]);
        }
    });
    if (result.aborted) throw new EngineError('Cancelled.', { cancelled: true });
    if (result.code === 4) {
        throw new EngineError('Stopped to protect the computer: the CPU ran too hot. It will cool down; try again later.');
    }
    if (result.code !== 0 || !fs.existsSync(path.join(jobDir, 'audio.mp3'))) {
        throw new EngineError(userMessage(result.tail, 'The voice engine failed while reading.'),
            { detail: result.tail.slice(-6) });
    }
    const reportPath = path.join(jobDir, 'report.json');
    return fs.existsSync(reportPath) ? JSON.parse(fs.readFileSync(reportPath, 'utf8')) : {};
}

function onPath(binary) {
    if (path.isAbsolute(binary)) return fs.existsSync(binary);
    const probe = spawnSync(config.isWindows ? 'where' : 'which', [binary], { encoding: 'utf8' });
    return probe.status === 0;
}

let cached = { at: 0, value: null };

// What would stop a job from running, in words the settings screen can show.
function status() {
    if (cached.value && Date.now() - cached.at < 30000) return cached.value;
    const problems = [];
    if (!onPath(config.voiceReaderBin)) {
        problems.push('voice-reader was not found. Set VOICE_READER_HOME in .env to the voice-reader project folder.');
    }
    if (!process.env.AUDIOSHOP_EXTRACTOR_CMD && !onPath(config.extractorCmd[0])) {
        problems.push('uv was not found, so the text extractor cannot run. Install uv and run npm run setup.');
    }
    if (!onPath('ffmpeg')) problems.push('ffmpeg was not found on PATH; voice-reader needs it to write MP3s.');
    cached = { at: Date.now(), value: { ready: problems.length === 0, problems } };
    return cached.value;
}

module.exports = { extract, read, status, run, EngineError, userMessage };
