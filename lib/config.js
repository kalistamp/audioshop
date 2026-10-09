'use strict';

// Every setting comes from the environment (or .env, which is never committed). Nothing here is a
// secret by default: the access token, the voice-reader location and the public URL are local.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const envPath = process.env.AUDIOSHOP_ENV_FILE || path.join(ROOT, '.env');
// Existing environment values take precedence over .env values.
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

function positive(name, fallback) {
    const value = Number(process.env[name]);
    return Number.isFinite(value) && value > 0 ? value : fallback;
}

function list(name, fallback) {
    const raw = process.env[name];
    if (!raw) return fallback;
    return raw.split(',').map(item => item.trim().replace(/\/+$/, '')).filter(Boolean);
}

const isWindows = process.platform === 'win32';
const dataDir = path.resolve(process.env.AUDIOSHOP_DATA_DIR || path.join(ROOT, 'data'));
const voiceReaderHome = process.env.VOICE_READER_HOME ? path.resolve(process.env.VOICE_READER_HOME) : '';

function defaultVoiceReaderBin() {
    if (!voiceReaderHome) return 'voice-reader';
    return isWindows
        ? path.join(voiceReaderHome, '.venv', 'Scripts', 'voice-reader.exe')
        : path.join(voiceReaderHome, '.venv', 'bin', 'voice-reader');
}

function extractorCommand() {
    if (process.env.AUDIOSHOP_EXTRACTOR_CMD) return JSON.parse(process.env.AUDIOSHOP_EXTRACTOR_CMD);
    return [process.env.UV_BIN || 'uv', 'run', '--quiet', '--project', path.join(ROOT, 'extractor'),
        'python', '-m', 'audioshop_extract'];
}

module.exports = {
    ROOT,
    isWindows,
    dataDir,
    jobsDir: path.join(dataDir, 'jobs'),
    uploadsDir: path.join(dataDir, 'uploads'),
    dbPath: path.join(dataDir, 'audioshop.db'),
    voicesPath: path.join(dataDir, 'voices.json'),
    port: positive('PORT', 8787),
    host: process.env.HOST || '127.0.0.1',
    token: process.env.AUDIOSHOP_TOKEN || '',
    publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
    allowedOrigins: list('ALLOWED_ORIGINS', ['https://kalistamp.github.io']),
    voiceReaderHome,
    voiceReaderBin: process.env.VOICE_READER_BIN || defaultVoiceReaderBin(),
    extractorCmd: extractorCommand(),
    limits: {
        maxWords: positive('MAX_WORDS', 20000),
        maxUploadBytes: positive('MAX_UPLOAD_MB', 30) * 1024 * 1024,
        maxFiles: positive('MAX_FILES', 20),
        maxTextChars: 400000
    },
    retention: { keepDays: positive('KEEP_DAYS', 30), keepJobs: positive('KEEP_JOBS', 100) },
    extractTimeoutMs: positive('EXTRACT_TIMEOUT_S', 600) * 1000
};
