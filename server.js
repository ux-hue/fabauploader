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
    validateStatus: s => s < 500,
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1' }
  });

  // 404 / 410 / 200 (non-redirect) = link expired or invalid
  if (resp.status === 404 || resp.status === 410)
    throw new Error('LINK_SCADUTO');
  if (resp.status !== 302)
    throw new Error('LINK_SCADUTO');

  let xsrf = null, sess = null;
  for (const c of resp.headers['set-cookie'] || []) {
    const x = c.match(/XSRF-TOKEN=([^;]+)/);
    const s = c.match(/myfaba_cms_session=([^;]+)/);
    if (x) xsrf = decodeURIComponent(x[1]);
    if (s) sess = s[1];
  }
  const location = resp.headers['location'];
  if (!xsrf || !sess || !location) throw new Error('LINK_SCADUTO');
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
  if (!form) throw new Error('LINK_SCADUTO');

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
    'LINK_SCADUTO':      '🔗 Link scaduto — questo link di invito non è più valido (dura 24 ore). Apri MyFaba → Faba+Me → Aggiungi traccia → Invita a registrare per generarne uno nuovo.',
  };
  if (map[raw]) return map[raw];
  if (raw.startsWith('FABA_ERROR_')) return `Errore dal server Faba (codice ${raw.replace('FABA_ERROR_','')}) — riprova tra qualche secondo.`;
  return raw;
}





/* ── YouTube via yt-dlp con cookie account dedicato ──────────────────────── */
//
// Usa un account Google dedicato all'app (non dell'utente).
// Setup una-tantum: esporta cookies.txt dall'account → incolla in YOUTUBE_COOKIES su Render.
//

const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const YTDLP = '/usr/local/bin/yt-dlp';
const COOKIES_FILE = path.join(os.tmpdir(), 'yt_cookies.txt');

// Scrivi cookie dal env var su disco all'avvio
// Supporta sia testo normale che base64 (utile se Render tronca le newline)
(function initCookies() {
  const c = process.env.YOUTUBE_COOKIES;
  if (!c) {
    console.warn('⚠️  YOUTUBE_COOKIES non impostato');
    return;
  }
  try {
    // Prova a decodificare come base64, altrimenti usa testo normale
    let content = c;
    if (!c.includes('\t') && !c.includes('youtube.com')) {
      // Sembra base64
      content = Buffer.from(c, 'base64').toString('utf8');
      console.log('📦 Cookie decodificati da base64');
    }
    fs.writeFileSync(COOKIES_FILE, content, 'utf8');
    const lines = content.split('\n').filter(l => l.includes('youtube.com')).length;
    console.log(`✅ YouTube cookies caricati (${lines} cookie per youtube.com)`);
  } catch(e) {
    console.error('❌ Errore caricamento cookie:', e.message);
  }
})();

// DEBUG: verifica stato cookie
app.get('/api/yt-cookie-status', (req, res) => {
  const envSet = !!process.env.YOUTUBE_COOKIES;
  const fileExists = fs.existsSync(COOKIES_FILE);
  let lines = 0;
  if (fileExists) {
    const content = fs.readFileSync(COOKIES_FILE, 'utf8');
    lines = content.split('\n').filter(l => l.includes('youtube.com')).length;
  }
  res.json({ envSet, fileExists, ytCookieLines: lines });
});


function ytArgs(extra = []) {
  const args = ['--no-playlist', '--no-warnings'];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  return [...args, ...extra];
}

function ytUrl(id) { return `https://www.youtube.com/watch?v=${id}`; }

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Info: titolo, durata, thumbnail
async function ytInfo(videoId) {
  const { stdout } = await execFileAsync(YTDLP,
    ytArgs(['--skip-download', '--print', '%(title)s\n%(duration)s\n%(thumbnail)s', ytUrl(videoId)]),
    { timeout: 30_000 }
  );
  const [title, dur, thumb] = stdout.trim().split('\n');
  return { title: title || 'Audio da YouTube', duration: parseInt(dur)||0, thumbnail: thumb&&thumb!=='NA'?thumb:null };
}

// Download audio → WAV → upload a Faba (tutto server-side)
function ytDownloadWav(videoId) {
  return new Promise((resolve, reject) => {
    const tmpOut = path.join(os.tmpdir(), `fab_yt_${Date.now()}.wav`);
    const ytdlp = spawn(YTDLP, ytArgs(['-f', 'bestaudio', '-o', '-', ytUrl(videoId)]));
    const ff = spawn('ffmpeg', ['-y', '-i', 'pipe:0', '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '22050', '-f', 'wav', tmpOut]);
    ytdlp.stdout.pipe(ff.stdin);
    let ytErr = '';
    ytdlp.stderr.on('data', d => { ytErr += d; });
    ff.stderr.on('data', () => {});
    ytdlp.on('error', e => reject(e));
    ytdlp.on('close', code => { if (code !== 0) { ff.stdin.end(); reject(new Error(ytErrMsg(ytErr))); }});
    ff.on('close', code => {
      if (code !== 0) { reject(new Error('Conversione audio fallita.')); return; }
      try { const buf = fs.readFileSync(tmpOut); try{fs.unlinkSync(tmpOut);}catch{} resolve(buf); }
      catch(e) { reject(e); }
    });
  });
}

function ytErrMsg(s = '') {
  s = s.toLowerCase();
  if (s.includes('sign in') || s.includes('bot')) return 'Autenticazione YouTube mancante — configura YOUTUBE_COOKIES su Render.';
  if (s.includes('private')) return 'Il video è privato.';
  if (s.includes('copyright') || s.includes('blocked')) return 'Il video è bloccato per copyright.';
  if (s.includes('unavailable') || s.includes('not available')) return 'Il video non è disponibile.';
  if (s.includes('age')) return 'Il video ha restrizioni di età.';
  return 'Impossibile scaricare il video. Prova con un altro link.';
}

// Route: info video
app.post('/api/yt-info', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId))
    return res.status(400).json({ ok: false, error: 'ID video non valido.' });
  try {
    const info = await ytInfo(videoId);
    res.json({ ok: true, ...info });
  } catch(e) {
    console.error('yt-info error:', e.message);
    const msg = ytErrMsg(e.message);
    const needsNotube = e.message.includes('bot') || e.message.includes('sign in') || e.message.includes('copyright');
    res.status(400).json({ ok: false, error: msg, notubeUrl: needsNotube ? 'https://notube.net' : null });
  }
});

// Route: download + converti + carica su Faba
app.post('/api/youtube-upload', async (req, res) => {
  const { url, shareId, author, title } = req.body;
  if (!url || !shareId || !author || !title)
    return res.status(400).json({ ok: false, error: 'Dati mancanti.' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ ok: false, error: 'URL non valido.' });
  try {
    console.log(`[yt] downloading ${videoId}`);
    const wavBuf = await ytDownloadWav(videoId);
    console.log(`[yt] WAV: ${(wavBuf.length/1024/1024).toFixed(1)} MB`);
    const { xsrf, sess, location } = await loadPage(shareId);
    const { actionUrl, _token, cookie } = await fetchForm(xsrf, sess, location);
    const { duration } = await uploadWav(actionUrl, cookie, _token, wavBuf, author, title);
    res.json({ ok: true, duration });
  } catch(e) {
    console.error('[yt] upload error:', e.message);
    res.status(500).json({ ok: false, error: ytErrMsg(e.message), notubeUrl: 'https://notube.net' });
  }
});

/* ── API routes ───────────────────────────────────────────────────────────── */
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
    res.status(400).json({ ok: false, error: humanError(e.message) });
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
