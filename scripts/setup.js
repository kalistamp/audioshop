'use strict';

// npm run setup [-- --public-url=https://machine.tailnet.ts.net] [--new-token]
//   1. creates .env with a fresh access token (kept if one exists, replaced with --new-token) and
//      the voice-reader location;
//   2. installs the extractor's Python environment with uv;
//   3. downloads the English OCR recognizer (checksum-pinned) to ~/.cache/audioshop/models;
//   4. writes data/voices.json and a systemd user unit you can install.
// Re-running it is safe. It never prints the token.

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENV = path.join(ROOT, '.env');
const OCR_MODEL = {
    url: 'https://huggingface.co/SWHL/RapidOCR/resolve/1cfba2e90f/PP-OCRv3/en_PP-OCRv3_rec_infer.onnx',
    sha256: 'ef7abd8bd3629ae57ea2c28b425c1bd258a871b93fd2fe7c433946ade9b5d9ea',
    file: path.join(os.homedir(), '.cache', 'audioshop', 'models', 'en_PP-OCRv3_rec_infer.onnx')
};

function readEnv() {
    const values = new Map();
    const source = fs.existsSync(ENV) ? ENV : path.join(ROOT, '.env.example');
    for (const line of fs.readFileSync(source, 'utf8').split(/\r?\n/)) {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (match) values.set(match[1], match[2].trim());
    }
    return values;
}

function writeEnv(values) {
    const template = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8').split(/\r?\n/);
    const seen = new Set();
    const lines = template.map((line) => {
        const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
        if (!match) return line;
        seen.add(match[1]);
        return `${match[1]}=${values.get(match[1]) ?? ''}`;
    });
    for (const [key, value] of values) if (!seen.has(key)) lines.push(`${key}=${value}`);
    fs.writeFileSync(ENV, lines.join('\n'), { mode: 0o600 });
    fs.chmodSync(ENV, 0o600);
}

function findVoiceReader() {
    for (const candidate of [process.env.VOICE_READER_HOME, path.resolve(ROOT, '..')]) {
        if (!candidate) continue;
        if (fs.existsSync(path.join(candidate, 'configs', 'base.yaml'))) return candidate;
    }
    return '';
}

function download(url, file) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode)) return resolve(download(res.headers.location, file));
            if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        }).on('error', reject);
    });
}

async function ensureOcrModel() {
    if (fs.existsSync(OCR_MODEL.file)) {
        const hash = crypto.createHash('sha256').update(fs.readFileSync(OCR_MODEL.file)).digest('hex');
        if (hash === OCR_MODEL.sha256) return 'already present';
    }
    const data = await download(OCR_MODEL.url, OCR_MODEL.file);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== OCR_MODEL.sha256) throw new Error('OCR model checksum mismatch; not saved');
    fs.mkdirSync(path.dirname(OCR_MODEL.file), { recursive: true });
    fs.writeFileSync(OCR_MODEL.file, data);
    return 'downloaded';
}

async function main() {
    const values = readEnv();
    const newToken = process.argv.includes('--new-token');  // revokes every paired phone
    if (newToken || !values.get('AUDIOSHOP_TOKEN')) values.set('AUDIOSHOP_TOKEN', crypto.randomBytes(32).toString('base64url'));
    if (!values.get('VOICE_READER_HOME')) values.set('VOICE_READER_HOME', findVoiceReader());
    const publicArg = process.argv.find(arg => arg.startsWith('--public-url='));
    if (publicArg) values.set('PUBLIC_URL', publicArg.split('=').slice(1).join('=').replace(/\/+$/, ''));
    writeEnv(values);
    console.log(`.env ready (token ${newToken ? 'replaced: restart the server and pair again' : 'set'}, ` +
        `voice-reader: ${values.get('VOICE_READER_HOME') || 'NOT FOUND - set VOICE_READER_HOME'})`);

    const uv = spawnSync(process.env.UV_BIN || 'uv', ['sync', '--quiet', '--project', path.join(ROOT, 'extractor')],
        { stdio: 'inherit' });
    console.log(uv.status === 0 ? 'extractor environment ready' : 'uv sync failed: is uv installed? (https://docs.astral.sh/uv/)');

    try {
        console.log(`English OCR model: ${await ensureOcrModel()}`);
    } catch (error) {
        console.warn(`OCR model not installed (${error.message}); photos will use the bundled model.`);
    }

    const dataDir = path.join(ROOT, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    const voicesPath = path.join(dataDir, 'voices.json');
    if (!fs.existsSync(voicesPath)) {
        fs.writeFileSync(voicesPath, JSON.stringify([{ id: 'default', label: 'My voice' }], null, 2));
        console.log('data/voices.json created (one profile: the voice-reader default voice)');
    }

    const node = process.execPath;
    const unit = `[Unit]
Description=Audioshop job server (articles read in your voice)
After=network-online.target

[Service]
WorkingDirectory=${ROOT}
ExecStart=${node} server.js
Environment=PATH=${path.dirname(node)}:${path.join(os.homedir(), '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
    fs.writeFileSync(path.join(dataDir, 'audioshop.service'), unit);
    console.log(`
Next:
  npm start                         # or run it as a service:
  mkdir -p ~/.config/systemd/user && cp data/audioshop.service ~/.config/systemd/user/
  systemctl --user enable --now audioshop && loginctl enable-linger $USER
  tailscale serve --bg ${values.get('PORT') || 8787}             # HTTPS for your phone (see README)
  npm run pair -- --public-url=https://<machine>.<tailnet>.ts.net`);
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});
