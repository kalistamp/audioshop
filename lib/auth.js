'use strict';

// The site is public (GitHub Pages) but the server reads in your voice, so every API call carries
// the access token from `npm run setup`. Audio can also be fetched through a short-lived signed
// link, because an <audio> element or a download link cannot send an Authorization header.

const crypto = require('node:crypto');

const LINK_TTL_MS = 30 * 60 * 1000;

function digest(value) {
    return crypto.createHash('sha256').update(String(value)).digest();
}

function tokenMatches(given, expected) {
    if (!given || !expected) return false;
    return crypto.timingSafeEqual(digest(given), digest(expected));
}

function bearer(req) {
    const header = req.get('authorization') || '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : '';
}

function signLink(token, jobId, now = Date.now()) {
    const expires = now + LINK_TTL_MS;
    const sig = crypto.createHmac('sha256', token).update(`${jobId}.${expires}`).digest('base64url');
    return { expires, sig };
}

function linkValid(token, jobId, expires, sig) {
    if (!token || !sig || !/^\d+$/.test(String(expires)) || Number(expires) < Date.now()) return false;
    const expected = crypto.createHmac('sha256', token).update(`${jobId}.${expires}`).digest('base64url');
    return expected.length === String(sig).length
        && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(sig)));
}

function requireToken(token) {
    return (req, res, next) => {
        if (tokenMatches(bearer(req), token)) return next();
        res.status(401).json({ error: 'This server needs its access token. Open Settings and pair again.' });
    };
}

// CORS for the GitHub Pages copy of the app. Requests without an Origin (or from the server's own
// pages) are same-origin and need nothing. Chrome's Local Network Access also asks a public page
// for permission before it may call a private address (a Tailscale 100.x one, for instance); the
// preflight answer below is the server's half of that handshake.
function cors(allowedOrigins) {
    return (req, res, next) => {
        const origin = req.get('origin');
        let sameOrigin = false;
        try {
            sameOrigin = Boolean(origin) && new URL(origin).host === req.get('host');
        } catch { /* "null" or malformed origins are simply not trusted */ }
        if (origin && (allowedOrigins.includes(origin) || sameOrigin || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin))) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');
            if (req.method === 'OPTIONS') {
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-File-Name');
                res.setHeader('Access-Control-Max-Age', '600');
                if (req.get('access-control-request-private-network')) {
                    res.setHeader('Access-Control-Allow-Private-Network', 'true');
                }
                return res.status(204).end();
            }
        } else if (origin && req.method === 'OPTIONS') {
            return res.status(403).end();
        }
        next();
    };
}

module.exports = { tokenMatches, bearer, signLink, linkValid, requireToken, cors, LINK_TTL_MS };
