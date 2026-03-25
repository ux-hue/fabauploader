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

  // Parse expiry from action URL query string
  const parsed = new URL(actionUrl);
  const expires = parsed.searchParams.get('expires');
  const expiresMs = expires ? parseInt(expires) * 1000 : null;

  // Try to extract storage limit/usage from the page (Faba exposes this as JSON in a script tag or data attrs)
  let usedSeconds = null, maxSeconds = null;
  try {
    // Look for data embedded in script tags (e.g. window.__PROPS__ or similar)
    const scripts = [...doc.querySelectorAll('script:not([src])')].map(s => s.textContent);
    for (const src of scripts) {
      // Try common patterns: "duration":1234, "max_duration":5400, "used":..., "limit":...
      const mUsed = src.match(/"(?:used_duration|used|usedDuration|current_duration)"\s*:\s*(\d+)/);
      const mMax  = src.match(/"(?:max_duration|limit|maxDuration|total_duration)"\s*:\s*(\d+)/);
      if (mUsed) usedSeconds = parseInt(mUsed[1]);
      if (mMax)  maxSeconds  = parseInt(mMax[1]);
    }
    // Also look in data attributes on body/root elements
    const body = doc.body;
    if (body) {
      const d = body.dataset;
      if (d.usedDuration) usedSeconds = parseInt(d.usedDuration);
      if (d.maxDuration)  maxSeconds  = parseInt(d.maxDuration);
    }
    // Log what we find for debugging
    if (usedSeconds !== null || maxSeconds !== null) {
      console.log(`Faba storage: used=${usedSeconds}s max=${maxSeconds}s`);
    } else {
      // Dump a snippet to help identify where the data lives
      const bodyText = resp.data.slice(0, 3000);
      const durMatch = bodyText.match(/duration[^}]{0,200}/gi);
      if (durMatch) console.log('Faba page duration hints:', durMatch.slice(0,3));
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
  // Try common locations
  const candidates = [
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
    'yt-dlp'
  ];
  return candidates[0]; // execFile will fail gracefully if not found
}

/** Fetch video metadata without downloading */
async function youtubeInfo(url) {
  const { stdout } = await execFileAsync(ytdlpBin(), [
    '--dump-json',
    '--no-playlist',
    '--no-warnings',
    url
  ], { timeout: 30_000 });

  const info = JSON.parse(stdout);
  return {
    title: info.title || 'Audio da YouTube',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || null,
    uploader: info.uploader || ''
  };
}

/** Download audio from YouTube as a Buffer, converted to WAV via ffmpeg pipe */
function youtubeDownload(url) {
  return new Promise((resolve, reject) => {
    const tmpOut = path.join(os.tmpdir(), `fab_yt_${Date.now()}.wav`);

    // yt-dlp → stdout (best audio) → ffmpeg → WAV file
    const ytdlp = spawn(ytdlpBin(), [
      '--no-playlist',
      '--no-warnings',
      '-f', 'bestaudio',
      '-o', '-',   // output to stdout
      url
    ]);

    const ff = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', '22050',
      '-f', 'wav',
      tmpOut
    ]);

    ytdlp.stdout.pipe(ff.stdin);

    ytdlp.stderr.on('data', d => {
      const msg = d.toString();
      if (msg.includes('ERROR')) console.error('yt-dlp:', msg.trim());
    });

    ff.stderr.on('data', () => {}); // suppress ffmpeg verbose

    ytdlp.on('error', err => reject(new Error('yt-dlp non trovato. Assicurati sia installato nel server.')));

    ff.on('close', code => {
      if (code !== 0) {
        reject(new Error('Conversione audio YouTube fallita.'));
        return;
      }
      try {
        const buf = fs.readFileSync(tmpOut);
        fs.unlinkSync(tmpOut);
        resolve(buf);
      } catch(e) {
        reject(e);
      }
    });
  });
}

/* ── API routes ───────────────────────────────────────────────────────────── */

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
