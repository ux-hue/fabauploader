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




/* ── YouTube via yt-dlp ───────────────────────────────────────────────────── */
//
// yt-dlp is already installed in the Docker image.
// It handles all client negotiation, PO tokens, and signature deciphering
// internally — no manual client config needed.
// Default client in 2026: android_vr (no PO token required from server IPs).
//

const YTDLP = '/usr/local/bin/yt-dlp';
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

function ytdlpUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

// Get video metadata (title, duration, thumbnail) — fast, no download
async function ytdlpInfo(videoId) {
  const args = [
    '--no-playlist', '--no-warnings', '--skip-download',
    '--print', '%(title)s\n%(duration)s\n%(thumbnail)s',
    ytdlpUrl(videoId)
  ];
  const { stdout } = await execFileAsync(YTDLP, args, { timeout: 30_000 });
  const [title, durationStr, thumbnail] = stdout.trim().split('\n');
  return {
    title: title || 'Audio da YouTube',
    duration: parseInt(durationStr) || 0,
    thumbnail: (thumbnail && thumbnail !== 'NA') ? thumbnail : null,
  };
}

// Download best audio → pipe through ffmpeg → WAV buffer
function ytdlpDownloadWav(videoId) {
  return new Promise((resolve, reject) => {
    const tmpOut = path.join(os.tmpdir(), `fab_yt_${Date.now()}.wav`);

    const ytdlp = spawn(YTDLP, [
      '--no-playlist', '--no-warnings',
      '-f', 'bestaudio',
      '-o', '-',            // output to stdout
      ytdlpUrl(videoId)
    ]);

    const ff = spawn('ffmpeg', [
      '-y', '-i', 'pipe:0',
      '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '22050',
      '-f', 'wav', tmpOut
    ]);

    ytdlp.stdout.pipe(ff.stdin);

    let ytErr = '';
    ytdlp.stderr.on('data', d => { ytErr += d.toString(); });

    let ffErr = '';
    ff.stderr.on('data', d => { ffErr += d.toString(); });

    ytdlp.on('error', err => reject(new Error(`yt-dlp non trovato: ${err.message}`)));
    ytdlp.on('close', code => {
      if (code !== 0) {
        ff.stdin.end();
        reject(new Error(parseYtdlpError(ytErr)));
      }
    });

    ff.on('error', err => reject(new Error(`ffmpeg error: ${err.message}`)));
    ff.on('close', code => {
      if (code !== 0) {
        console.error('ffmpeg stderr:', ffErr.slice(-300));
        reject(new Error('Conversione audio fallita.'));
        return;
      }
      try {
        const buf = fs.readFileSync(tmpOut);
        try { fs.unlinkSync(tmpOut); } catch {}
        resolve(buf);
      } catch(e) { reject(e); }
    });
  });
}

function parseYtdlpError(stderr = '') {
  const s = stderr.toLowerCase();
  if (s.includes('sign in') || s.includes('login') || s.includes('private'))
    return 'Il video è privato o richiede accesso.';
  if (s.includes('copyright') || s.includes('blocked'))
    return 'Il video è bloccato per copyright.';
  if (s.includes('not available') || s.includes('unavailable'))
    return 'Il video non è disponibile in questa regione.';
  if (s.includes('members only'))
    return 'Il video è riservato agli iscritti al canale.';
  if (s.includes('age'))
    return 'Il video ha restrizioni di età.';
  if (s.includes('429') || s.includes('too many'))
    return 'Troppe richieste a YouTube. Riprova tra qualche minuto.';
  return 'Impossibile scaricare il video. Prova con un altro link o carica l\'MP3 manualmente.';
}

app.post('/api/youtube-info', async (req, res) => {
  const { url } = req.body;
  if (!url || !/youtube\.com|youtu\.be/.test(url))
    return res.status(400).json({ ok: false, error: 'URL YouTube non valido.' });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ ok: false, error: 'ID video non trovato nell\'URL.' });

  try {
    const info = await ytdlpInfo(videoId);
    res.json({ ok: true, ...info });
  } catch(e) {
    console.error('yt-info error:', e.message);
    res.status(400).json({ ok: false, error: parseYtdlpError(e.message) });
  }
});

app.post('/api/youtube-upload', async (req, res) => {
  const { url, shareId, author, title } = req.body;
  if (!url || !shareId || !author || !title)
    return res.status(400).json({ ok: false, error: 'Dati mancanti.' });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ ok: false, error: 'ID video non trovato nell\'URL.' });

  try {
    console.log(`[yt-dlp] downloading ${videoId}`);
    const wavBuf = await ytdlpDownloadWav(videoId);
    console.log(`[yt-dlp] WAV: ${(wavBuf.length / 1024 / 1024).toFixed(1)} MB`);

    const { xsrf, sess, location } = await loadPage(shareId);
    const { actionUrl, _token, cookie } = await fetchForm(xsrf, sess, location);
    const { duration } = await uploadWav(actionUrl, cookie, _token, wavBuf, author, title);
    res.json({ ok: true, duration });

  } catch(e) {
    console.error('yt-upload error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
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
