# Audioshop

Turn an article into an MP3 read in your own voice, and keep it on your phone for
offline listening. Paste a link, pick a document, or take photos of a page; your
own computer reads it aloud with your cloned voice and the phone saves the result.

The app is a static site on GitHub Pages. GitHub Pages cannot run a voice model,
so the site is only a remote control: the work happens on your computer, which
the phone reaches privately over [Tailscale](https://tailscale.com). Nothing in
this repository is personal. Your voice files, model weights, access token and
recordings stay on your computer (see [What is kept where](#what-is-kept-where)).

```
 phone (GitHub Pages app) ── HTTPS + token ──▶ Tailscale Serve (https://machine.tailnet.ts.net)
                                                   │  private to your tailnet
                                                   ▼
                                    Audioshop server (127.0.0.1:8787, this repo)
                                       1. extractor: link / PDF / Word / EPUB / photos → text
                                       2. voice-reader (Pocket TTS, your voice) → MP3
 phone ◀── MP3, saved in the app for offline play ──┘
```

## Running it

On the computer that has voice-reader (the text-to-speech project with your voice) set up:

```bash
npm install
npm run setup     # .env with a fresh token, the extractor (uv), the English OCR model
npm start         # http://127.0.0.1:8787
```

You need Node 22.5 or newer, [uv](https://docs.astral.sh/uv/), ffmpeg, and a working
voice-reader (`voice-reader read` must already work there). `npm run setup` finds
voice-reader when this folder sits inside it; otherwise set `VOICE_READER_HOME` in
`.env`. Run setup again any time: it keeps your token and settings.

Open http://127.0.0.1:8787 on the computer itself to try it before involving the
phone. The computer serves the same app as GitHub Pages.

## Reaching it from your phone

1. Install Tailscale on the computer and the phone and sign in to the same account.
2. In the [Tailscale admin console](https://login.tailscale.com/admin/dns), under
   DNS, turn on **MagicDNS** and **HTTPS Certificates**.
3. On the computer:

   ```bash
   tailscale serve --bg 8787
   npm run pair -- --public-url=https://<machine>.<tailnet>.ts.net
   ```

   `tailscale serve` prints the exact address. Save it once with
   `npm run setup -- --public-url=https://...`, and plain `npm run pair` works from then on.
   `pair` prints two links and a QR code.
4. Open one of the links on the phone. It connects the app; there is nothing to type.

The pairing link carries your token after the `#`, and browsers never send that part to
any server, GitHub included. The app removes it from the address bar straight away. Treat the
link like a password: anyone with it and access to your tailnet could make audio
with your voice. To revoke it, run `npm run setup -- --new-token`, restart the server,
and pair again.

**Which link to use.** Both open the same app.
- **GitHub Pages:** https://kalistamp.github.io/audioshop/.
- **Served by your computer:** at your `ts.net` address.

Recent versions of Chrome may ask for permission to access devices on your local
network the first time the GitHub Pages copy calls your computer, because Tailscale
addresses count as local. Answer **Allow**. The copy served by your computer never
asks, and Safari does not either.

Then **Add to Home Screen** (Safari: Share menu; Chrome: menu ▸ Install app). Installed,
it opens full screen, and on Android it appears in the share sheet.

### Keep it running

Linux (systemd user service; `setup` writes the unit with your paths):

```bash
mkdir -p ~/.config/systemd/user && cp data/audioshop.service ~/.config/systemd/user/
systemctl --user enable --now audioshop
loginctl enable-linger $USER      # keep it running when you are logged out
journalctl --user -u audioshop -f # logs
```

Windows (PowerShell), start at log-on:

```powershell
$node = (Get-Command node).Source
schtasks /Create /SC ONLOGON /TN Audioshop /TR "`"$node`" `"$PWD\server.js`"" /RL LIMITED
```

## How you use it

**New.** Choose **Link**, **File or photo**, or **Text**.

| You give it | What happens |
| --- | --- |
| A news or blog link | The page is fetched and cleaned up: menus, ads and "related" links are left out |
| A PDF (link or file) | Text pages are read directly; scanned pages go through OCR |
| Word (.docx), EPUB, .txt, .md, .html | The text is read in document order |
| Photos of a page | OCR, in the order you picked them; several photos become one article |
| Pasted text | Read as is |

**Options** let you set the title, choose a voice, and decide whether the title is
read aloud first. Only a real headline is announced. When there is none, the
recording is named after its opening words, and those are not read twice.

**Library.** Shows each recording with live progress, an estimate and a Cancel button.
When it finishes, the MP3 is saved on the phone (turn this off in Settings). Android
phones also buzz, and a notification appears if you allowed one. Each recording has these
buttons:
- **Play**;
- **Download** saves the MP3 to Files;
- **Share** sends it to another app;
- **Text** shows exactly what was read;
- **Delete**.

**Player.** Skips back 15 s and forward 30 s, plays at 0.8× to 2×, works from the lock
screen and headphones, and remembers where you stopped in each recording.

**Sharing into the app.**
- **Android:** install the app, then share any link to **Audioshop**.
- **iPhone:** make a Shortcut. Set it to receive URLs from the Share Sheet, then
  add *URL Encode* on the input, then *Open URLs*
  `https://kalistamp.github.io/audioshop/?url=[URL Encoded Text]&go=1`.
  `go=1` starts the recording straight away.

The shared link stays on the phone: the app's service worker answers that page from
its cache, so the article address never reaches GitHub.

## Voices

`data/voices.json` lists the voices the app offers. The first one is the default:

```json
[
  { "id": "v004", "label": "My voice" },
  { "id": "ft-a", "label": "Fine-tuned E002a", "config": "/path/to/voice-configs/E002a-step40.yaml" }
]
```

A profile without `config` uses voice-reader's `configs/base.yaml`. With `config`, it uses
that voice-reader config file, which can point at a different voice state or a fine-tuned
model (`voice:` and `pocket.config:`). Keep those files in `data/`, which is gitignored.
Restart the server after editing.

## What is kept where

| Thing | Where | In this repo? |
| --- | --- | --- |
| Voice recordings, voice states, model weights | voice-reader's `data/` on your computer | Never |
| Access token | `.env` (mode 600) and the phone's app storage | Never (`.env` is gitignored) |
| Articles, their text and MP3s | `data/jobs/` on your computer | Never (`data/` is gitignored) |
| Saved MP3s for offline play | The phone's browser storage | — |
| The app itself | `public/` → GitHub Pages | Yes, and nothing else is published |

- The server listens on 127.0.0.1 only. Tailscale Serve makes it reachable from your own
  devices and nothing else; no port is opened on your router.
- Every request needs the token. MP3 links handed to the player are signed and expire
  after 30 minutes.
- Every MP3 has an ID3 comment saying it is AI-generated speech.
- Old jobs are deleted after `KEEP_DAYS` (30) or beyond the newest `KEEP_JOBS` (100).
  Audio saved on the phone stays until you delete it there.
- The site loads nothing from other domains: no analytics, no CDNs, and the fonts ship
  with the app.

## How it fits together

```
server.js                 Express: the API, CORS for the Pages origin, and the app (public/)
lib/config.js             .env and defaults; where voice-reader and the extractor live
lib/auth.js               Token check, signed audio links, CORS / local-network preflight
lib/jobs.js               The queue: one job at a time, progress, estimates, retries, clean-up
lib/engine.js             Runs the extractor and voice-reader as killable process groups
lib/db.js                 Job list (node:sqlite, no native build)
lib/uploads.js            Upload types, sizes and the uploads folder
lib/voices.js             data/voices.json
extractor/                Python: links, PDF, Word, EPUB and photos (OCR) → plain text
scripts/setup.js          npm run setup
scripts/pair.js           npm run pair: the one-tap pairing link and QR code
public/                   The phone app (what GitHub Pages serves)
.github/workflows/        Pages deploy of public/, and the tests
```

### Notes on the design

- **Why a computer at home and not a cloud GPU.** The voice model runs well on a CPU
  (a 2,000-word article takes about 5 minutes on a 2014 Mac mini), costs nothing per
  article, and your voice never leaves your machines. GitHub Pages hosts the part that
  can be static; Tailscale gives the phone a private HTTPS route without opening a port.
- **Jobs survive everything.** A job is a folder plus a database row. If the server
  restarts mid-job, the job goes back in the queue. Cancel stops voice-reader *and* its
  worker processes. Closing the app does nothing to a job: come back later and it is in
  the Library.
- **Links are fetched by your computer, so every fetch is screened.** Only http and https
  are allowed. The address is resolved once, and the connection is pinned to that IP.
  Private, loopback, tailnet and cloud-metadata addresses are refused. Each redirect is
  checked again, and pages are capped at 8 MB. Set `AUDIOSHOP_ALLOW_PRIVATE_HOSTS=1` only
  if you need articles from your own network.
- **OCR is local.** It uses RapidOCR (ONNX) with the English PP-OCRv3 model, checked by
  SHA-256 when downloaded. It handles tilted and upside-down photos and two-column pages,
  re-joins hyphenated words, and splits paragraphs by line spacing.
- **The phone app is plain HTML, CSS and JavaScript.** It has no build step and no
  dependencies. A strict Content-Security-Policy is set. Text from articles is only ever
  inserted as text, never as HTML. Large photos are shrunk on the phone before upload,
  to save mobile data.

## Tests

```bash
npm test                # API, real extractor, and phone-sized browser tests (Node's test runner)
npm run test:extractor  # Python extractor: PDF, DOCX, EPUB, HTML, OCR on generated pages
```

The API and browser tests run the real server with stand-in engines (`tests/fixtures/`),
so they need neither the voice model nor your recordings. The browser tests use
Playwright's Chromium: run `npx playwright install chromium` once. They serve the app
and the API from different origins, exactly as GitHub Pages does. They cover pairing,
making audio from text and files, offline playback through the service worker, the
share target, and HTML in titles. Screenshots land in `tests/artifacts/`.

## Limits

- Your computer has to be on and on Tailscale while audio is being made. Listening to
  saved audio needs neither.
- Sites behind a paywall or a login cannot be fetched, because the computer has no cookies
  for them. Paste the text instead, or share a PDF or screenshots.
- Pages that only render with JavaScript may come out empty, for the same reason.
- English only (voice and OCR).
- Up to `MAX_WORDS` (20,000) words, 20 files and `MAX_UPLOAD_MB` (30 MB) per file.
  Jobs run one at a time.
- Time: roughly 0.16 s per word plus 20 s to load the model on the Mac mini. The estimate
  learns from your own finished jobs.
