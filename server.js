/**
 * Faba•Me Audio Uploader — Server
 *
 * Key fix: Faba's API rejects large WAV files (413).
 * We convert to WAV with reduced samplerate (22050Hz mono) to stay small.
 * For multiupload: each file uses the same share_id independently (re-auth each time).
 */

const express = require('express');
const multer  = require('multer');
const axios   = require('axios');
const FormData = require('form-data');
const { JSDOM } = require('jsdom');
const { URL }   = require('url');
const ffmpeg    = require('fluent-ffmpeg');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Allow large uploads from client → our server
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/\.(mp3|wav|ogg|aac|m4a|flac|opus)$/i.test(file.originalname) ||
        /^audio\//.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Formato non supportato'));
    }
  }
});

const BASE = 'https://studio.myfaba.com/record/';

/* ── helpers ──────────────────────────────────────────────────────────────── */

function extractShareId(input = '') {
  const m = input.match(/([A-Za-z0-9]{10})(?:[/?#].*)?$/);
  return m ? m[1] : null;
}

/** Step 1 – hit share URL, grab 302 cookies + redirect location */
async function loadPage(shareId) {
  const resp = await axios.get(`${BASE}${shareId}`, {
    maxRedirects: 0,
    validateStatus: s => s < 400,
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' }
  });

  if (resp.status !== 302) throw new Error(`Link non valido o scaduto (HTTP ${resp.status})`);

  let xsrf = null, sess = null;
  for (const c of resp.headers['set-cookie'] || []) {
    const x = c.match(/XSRF-TOKEN=([^;]+)/);
    const s = c.match(/myfaba_cms_session=([^;]+)/);
    if (x) xsrf = decodeURIComponent(x[1]);
    if (s) sess = s[1];
  }
  const location = resp.headers['location'];
  if (!xsrf || !sess || !location) throw new Error('Sessione non ottenuta. Link scaduto?');
  return { xsrf, sess, location };
}

/** Step 2 – follow redirect, parse form */
async function fetchForm(xsrf, sess, location) {
  const cookie = `XSRF-TOKEN=${encodeURIComponent(xsrf)}; myfaba_cms_session=${sess}`;
  const resp = await axios.get(location, {
    headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' }
  });

  const dom  = new JSDOM(resp.data);
  const doc  = dom.window.document;
  const form = doc.getElementById('form');
  if (!form) throw new Error('Form non trovato. Il link è scaduto.');

  const actionUrl = form.getAttribute('action');
  const tokenEl   = doc.querySelector('input[name="_token"]');
  if (!actionUrl || !tokenEl) throw new Error('Token CSRF non trovato.');

  const parsed = new URL(actionUrl);
  const expires = parsed.searchParams.get('expires');
  const expiresMs = expires ? parseInt(expires) * 1000 : null;

  // Try to extract storage data — Faba doesn't currently expose this in the page HTML,
  // so usedSeconds/maxSeconds will be null for now.
  let usedSeconds = null, maxSeconds = null;
  try {
    const scripts = [...doc.querySelectorAll('script:not([src])')].map(s => s.textContent);
    for (const src of scripts) {
      const mUsed = src.match(/"(?:used_duration|usedDuration|current_duration)"\s*:\s*(\d+)/);
      const mMax  = src.match(/"(?:max_duration|maxDuration|total_duration|limit)"\s*:\s*(\d+)/);
      if (mUsed) usedSeconds = parseInt(mUsed[1]);
      if (mMax)  maxSeconds  = parseInt(mMax[1]);
    }
  } catch(e) { /* non-fatal */ }

  return { actionUrl, _token: tokenEl.value, cookie, expiresMs, usedSeconds, maxSeconds };
}

/** Convert any audio → WAV (22050 Hz mono, pcm_s16le) to keep file small */
function convertToWav(buf, origName) {
  return new Promise((resolve, reject) => {
    const ext  = path.extname(origName) || '.mp3';
    const tmpIn  = path.join(os.tmpdir(), `fab_in_${Date.now()}${ext}`);
    const tmpOut = path.join(os.tmpdir(), `fab_out_${Date.now()}.wav`);

    fs.writeFileSync(tmpIn, buf);

    ffmpeg(tmpIn)
      .audioCodec('pcm_s16le')
      .audioChannels(1)        // mono keeps size down
      .audioFrequency(22050)   // 22kHz good enough for voice/music, WAV stays small
      .format('wav')
      .on('end', () => {
        const out = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpIn);  } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
        resolve(out);
      })
      .on('error', err => {
        try { fs.unlinkSync(tmpIn);  } catch {}
        try { fs.unlinkSync(tmpOut); } catch {}
        reject(new Error('Conversione fallita: ' + err.message));
      })
      .save(tmpOut);
  });
}

/** Parse WAV header to get duration in seconds */
function wavDuration(buf) {
  try {
    const sampleRate  = buf.readUInt32LE(24);
    const numChannels = buf.readUInt16LE(22);
    const bitsPerSample = buf.readUInt16LE(34);
    const dataSize    = buf.readUInt32LE(40);
    const bytesPerSample = (bitsPerSample / 8) * numChannels;
    return Math.max(1, Math.floor(dataSize / (bytesPerSample * sampleRate)));
  } catch { return 1; }
}

/** Step 3 – POST to Faba cloud */
async function uploadWav(actionUrl, cookie, _token, wavBuf, author, title) {
  const duration = wavDuration(wavBuf);
  const fd = new FormData();
  fd.append('_token', _token);
  fd.append('duration', String(duration));
  fd.append('creator', author);
  fd.append('title', title);
  fd.append('userAudio', wavBuf, { filename: 'recorded.wav', contentType: 'audio/wav', knownLength: wavBuf.length });

  const resp = await axios.post(actionUrl, fd, {
    headers: { ...fd.getHeaders(), Cookie: cookie,
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
      Referer: 'https://studio.myfaba.com/' },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    timeout: 120_000,
    validateStatus: () => true
  });

  if (resp.status === 403) throw new Error('STORAGE_FULL');
  if (resp.status === 422) throw new Error('DURATION_EXCEEDED');
  if (resp.status === 413) throw new Error('FILE_TOO_LARGE');
  if (resp.status < 200 || resp.status >= 400) throw new Error(`FABA_ERROR_${resp.status}`);

  return { duration };
}

/* ── human-readable error mapper ─────────────────────────────────────────── */
function humanError(raw) {
  const map = {
    'STORAGE_FULL':      'Spazio esaurito 🔴 — hai raggiunto il limite massimo di minuti del tuo Faba•Me. Vai sull\'app MyFaba, seleziona il personaggio e rimuovi alcune tracce per liberare spazio, poi riprova.',
    'DURATION_EXCEEDED': 'Spazio insufficiente 🟡 — questo file è più lungo dello spazio rimanente. Prova con un file più corto oppure libera spazio nell\'app MyFaba.',
    'FILE_TOO_LARGE':    'File troppo grande anche dopo la conversione. Prova a spezzarlo in più parti (max ~60 min per traccia).',
  };
  if (map[raw]) return map[raw];
  if (raw.startsWith('FABA_ERROR_')) return `Errore dal server Faba (codice ${raw.replace('FABA_ERROR_','')}) — riprova tra qualche secondo.`;
  return raw;
}

/* ── YouTube via yt-dlp ───────────────────────────────────────────────────── */

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// Find yt-dlp binary (works on Docker + local)
function ytdlpBin() {
  return '/usr/local/bin/yt-dlp';
}

// Path where the user's YouTube cookies.txt is stored persistently
const COOKIES_PATH = path.join('/tmp', 'yt_cookies.txt');

// Build yt-dlp args, injecting cookies if available
function ytdlpArgs(extra = []) {
  const args = ['--no-playlist', '--no-warnings', ...extra];
  if (fs.existsSync(COOKIES_PATH)) {
    args.push('--cookies', COOKIES_PATH);
    console.log('yt-dlp: using cookies from', COOKIES_PATH);
  }
  return args;
}

/** Parse yt-dlp stderr/message into a human-readable Italian error */
function ytdlpHumanError(raw = '') {
  const msg = raw.toLowerCase();
  if (msg.includes('sign in') || msg.includes('bot') || msg.includes('confirm'))
    return 'YouTube ha bloccato la richiesta (protezione anti-bot). Carica il file cookies.txt nella sezione YouTube per sbloccare il download.';
  if (msg.includes('private'))
    return 'Il video è privato e non può essere scaricato.';
  if (msg.includes('not available') || msg.includes('unavailable'))
    return 'Il video non è disponibile in questa regione o è stato rimosso.';
  if (msg.includes('copyright'))
    return 'Il video è bloccato per copyright.';
  if (msg.includes('enoent') || msg.includes('not found'))
    return 'yt-dlp non è installato sul server. Controlla il Dockerfile.';
  if (msg.includes('members only'))
    return 'Il video è riservato agli iscritti al canale.';
  if (msg.includes('429') || msg.includes('too many'))
    return 'YouTube ha limitato le richieste dal server. Riprova tra qualche minuto.';
  return `Impossibile scaricare da YouTube: ${raw.slice(0, 150)}`;
}

/** Fetch video metadata without downloading */
async function youtubeInfo(url) {
  try {
    const { stdout } = await execFileAsync(ytdlpBin(), ytdlpArgs(['--dump-json', url]), { timeout: 30_000 });
    const info = JSON.parse(stdout);
    return {
      title: info.title || 'Audio da YouTube',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || null,
      uploader: info.uploader || ''
    };
  } catch(e) {
    const combined = (e.stderr || '') + (e.message || '');
    console.error('yt-dlp info error:', combined.slice(0, 300));
    throw new Error(ytdlpHumanError(combined));
  }
}

/** Download audio from YouTube → WAV buffer */
function youtubeDownload(url) {
  return new Promise((resolve, reject) => {
    const tmpOut = path.join(os.tmpdir(), `fab_yt_${Date.now()}.wav`);
    let ytStderr = '';

    const ytdlp = spawn(ytdlpBin(), ytdlpArgs(['-f', 'bestaudio', '-o', '-', url]));
    const ff = spawn('ffmpeg', ['-i', 'pipe:0', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '22050', '-f', 'wav', tmpOut]);

    ytdlp.stdout.pipe(ff.stdin);
    ytdlp.stderr.on('data', d => { ytStderr += d.toString(); });
    ff.stderr.on('data', () => {});

    ytdlp.on('error', err => reject(new Error(ytdlpHumanError(err.message))));
    ytdlp.on('close', code => { if (code !== 0) { ff.stdin.end(); reject(new Error(ytdlpHumanError(ytStderr))); } });

    ff.on('close', code => {
      if (code !== 0) { try { fs.unlinkSync(tmpOut); } catch {} reject(new Error('Conversione audio fallita.')); return; }
      try { const buf = fs.readFileSync(tmpOut); fs.unlinkSync(tmpOut); resolve(buf); }
      catch(e) { reject(e); }
    });
  });
}

/* ── API routes ───────────────────────────────────────────────────────────── */

// Upload YouTube cookies.txt (called once by the admin to bypass bot detection)
const cookiesUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.post('/api/youtube-cookies', cookiesUpload.single('cookies'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'Nessun file ricevuto.' });
  const text = req.file.buffer.toString('utf8');
  if (!text.includes('youtube.com') && !text.includes('# Netscape HTTP Cookie File')) {
    return res.status(400).json({ ok: false, error: 'Il file non sembra un cookies.txt valido. Esportalo con l\'estensione "Get cookies.txt LOCALLY" da Chrome.' });
  }
  fs.writeFileSync(COOKIES_PATH, text);
  console.log('YouTube cookies saved, size:', text.length);
  res.json({ ok: true, message: 'Cookie salvati! I download YouTube dovrebbero ora funzionare.' });
});

// Check if cookies are loaded
app.get('/api/youtube-cookies-status', (req, res) => {
  const hasCookies = fs.existsSync(COOKIES_PATH);
  res.json({ hasCookies });
});

// YouTube: get video info
app.post('/api/youtube-info', async (req, res) => {
  const { url } = req.body;
  if (!url || !/youtube\.com|youtu\.be/.test(url))
    return res.status(400).json({ ok: false, error: 'URL YouTube non valido.' });

  try {
    const info = await youtubeInfo(url);
    res.json({ ok: true, ...info });
  } catch(e) {
    console.error('YouTube info error:', e.message);
    const msg = e.message.includes('not found') || e.message.includes('ENOENT')
      ? 'yt-dlp non disponibile sul server.'
      : 'Video non trovato o non disponibile.';
    res.status(400).json({ ok: false, error: msg });
  }
});

// YouTube: download + convert + upload to Faba
app.post('/api/youtube-upload', async (req, res) => {
  const { url, shareId, author, title } = req.body;

  if (!url || !shareId || !author || !title)
    return res.status(400).json({ ok: false, error: 'Dati mancanti.' });

  try {
    console.log(`Downloading YouTube: ${url}`);
    const wavBuf = await youtubeDownload(url);
    const sizeMB = (wavBuf.length / 1024 / 1024).toFixed(1);
    console.log(`YouTube WAV size: ${sizeMB} MB`);

    const { xsrf, sess, location } = await loadPage(shareId);
    const { actionUrl, _token, cookie } = await fetchForm(xsrf, sess, location);
    await uploadWav(actionUrl, cookie, _token, wavBuf, author, title);

    res.json({ ok: true });
  } catch(e) {
    console.error('YouTube upload error:', e.message);
    res.status(500).json({ ok: false, error: humanError(e.message) });
  }
});

// Validate link
app.post('/api/validate', async (req, res) => {
  const shareId = extractShareId(req.body.url || '');
  if (!shareId) return res.status(400).json({ ok: false, error: 'URL non valido. Deve essere del tipo https://studio.myfaba.com/record/XXXXXXXXXX' });

  try {
    const { xsrf, sess, location } = await loadPage(shareId);
    const { expiresMs, usedSeconds, maxSeconds } = await fetchForm(xsrf, sess, location);

    let expiresLabel = null;
    if (expiresMs) {
      const d = new Date(expiresMs);
      expiresLabel = d.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    res.json({ ok: true, shareId, expiresLabel, usedSeconds, maxSeconds });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// Upload single file (called once per file for multiupload)
app.post('/api/upload', upload.single('audio'), async (req, res) => {
  const { shareId, author, title } = req.body;

  if (!shareId || !author || !title || !req.file)
    return res.status(400).json({ ok: false, error: 'Dati mancanti.' });

  try {
    const { xsrf, sess, location } = await loadPage(shareId);
    const { actionUrl, _token, cookie } = await fetchForm(xsrf, sess, location);

    const isWav = /\.wav$/i.test(req.file.originalname);
    const wavBuf = isWav ? req.file.buffer : await convertToWav(req.file.buffer, req.file.originalname);

    const sizeMB = (wavBuf.length / 1024 / 1024).toFixed(1);
    console.log(`Uploading "${title}" – WAV size: ${sizeMB} MB`);

    const { duration } = await uploadWav(actionUrl, cookie, _token, wavBuf, author, title);
    res.json({ ok: true, duration });

  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ ok: false, error: humanError(e.message) });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🎵 Faba Uploader → http://localhost:${PORT}`));
