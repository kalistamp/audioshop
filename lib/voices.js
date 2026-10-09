'use strict';

// Voice profiles live in data/voices.json on this machine only. Each one points at a voice-reader
// config file (which names the voice state and, for a fine-tuned model, the model file). The phone
// only ever sees the id and the label.
//
// [{ "id": "default", "label": "My voice" },
//  { "id": "finetuned", "label": "My voice, fine-tuned", "config": "/path/to/voice-reader/configs/x.yaml" }]

const fs = require('node:fs');

let profiles = [{ id: 'default', label: 'My voice', config: null }];

function load(voicesPath) {
    if (!fs.existsSync(voicesPath)) return profiles;
    const raw = JSON.parse(fs.readFileSync(voicesPath, 'utf8'));
    const valid = raw.filter(p => p && typeof p.id === 'string' && /^[\w-]{1,40}$/.test(p.id) && p.label);
    for (const profile of valid) {
        if (profile.config && !fs.existsSync(profile.config)) {
            console.warn(`voice profile ${profile.id}: config ${profile.config} not found; skipped`);
        }
    }
    const usable = valid.filter(p => !p.config || fs.existsSync(p.config))
        .map(p => ({ id: p.id, label: String(p.label).slice(0, 60), config: p.config || null }));
    if (usable.length) profiles = usable;
    return profiles;
}

function get(id) {
    return profiles.find(p => p.id === id) || null;
}

function defaultId() {
    return profiles[0].id;
}

function forClient() {
    return profiles.map((p, index) => ({ id: p.id, label: p.label, default: index === 0 }));
}

module.exports = { load, get, defaultId, forClient };
