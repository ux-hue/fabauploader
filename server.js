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




/* ── API routes ───────────────────────────────────────────────────────────── */

// Proxy audio stream da URL googlevideo.com (CORS bloccato dal browser direttamente)
app.get('/api/yt-audio', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  // Verifica che sia un URL googlevideo legittimo
  if (!url.startsWith('https://') || !url.includes('googlevideo.com'))
    return res.status(400).send('URL non valido');
  try {
    const r = await axios.get(url, {
      responseType: 'stream',
      timeout: 120_000,
      headers: {
        'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
        'Referer': 'https://www.youtube.com/'
      }
    });
    res.set('Content-Type', r.headers['content-type'] || 'audio/webm');
    if (r.headers['content-length']) res.set('Content-Length', r.headers['content-length']);
    res.set('Access-Control-Allow-Origin', '*');
    r.data.pipe(res);
  } catch(e) {
    console.error('yt-audio proxy error:', e.message);
    res.status(500).send('Errore nel download audio');
  }
});
app.post('/api/yt-test', async (req, res) => {
  const { videoId, client } = req.body;
  if (!videoId || !client) return res.status(400).json({ error: 'Missing params' });
  try {
    const clientCtx = { clientName: client.clientName, clientVersion: client.clientVersion, hl: 'en', gl: 'US', ...(client.extra || {}) };
    const r = await axios.post(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      { videoId, context: { client: clientCtx }, racyCheckOk: true, contentCheckOk: true },
      { headers: { 'Content-Type': 'application/json', ...(client.headers || {}) }, timeout: 15_000 }
    );
    const d = r.data;
    const status = d.playabilityStatus?.status;
    const reason = d.playabilityStatus?.reason || '';
    const fmts = [...(d.streamingData?.adaptiveFormats||[]), ...(d.streamingData?.formats||[])]
      .filter(f => f.mimeType?.startsWith('audio/'));
    const audioWithUrl = fmts.filter(f => f.url);
    const audioWithCipher = fmts.filter(f => f.signatureCipher);
    res.json({ status, reason, audioWithUrl: audioWithUrl.length, audioWithCipher: audioWithCipher.length, firstUrl: audioWithUrl[0]?.url?.slice(0,100) || null });
  } catch(e) {
    res.json({ status: 'ERROR', error: e.message, audioWithUrl: 0, audioWithCipher: 0 });
  }
});

// InnerTube proxy — usa ANDROID_VR (confermato funzionante da server Render)
app.post('/api/yt-info', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId))
    return res.status(400).json({ ok: false, error: 'ID video non valido.' });

  try {
    const r = await axios.post(
      'https://www.youtube.com/youtubei/v1/player?prettyPrint=false',
      {
        videoId,
        context: { client: {
          clientName: 'ANDROID_VR', clientVersion: '1.56.21',
          deviceMake: 'Oculus', deviceModel: 'Quest 3',
          androidSdkVersion: 32, osName: 'Android', osVersion: '12L',
          hl: 'en', gl: 'US'
        }},
        racyCheckOk: true, contentCheckOk: true
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
          'X-YouTube-Client-Name': '28',
          'X-YouTube-Client-Version': '1.56.21'
        },
        timeout: 15_000
      }
    );

    const d = r.data;
    const status = d.playabilityStatus?.status;

    if (status && status !== 'OK') {
      const NOTUBE = `<a href="https://notube.net" target="_blank" style="color:#FF5A35">notube.net</a>`;
      if (status === 'LOGIN_REQUIRED')
        return res.json({ ok: false, error: `Questo video non è scaricabile dal server. Scaricalo come MP3 da ${NOTUBE} e poi caricalo qui.`, notubeUrl: `https://notube.net/en/youtube-app-270` });
      if (status === 'UNPLAYABLE') {
        const reason = d.playabilityStatus?.reason || '';
        return res.json({ ok: false, error: `Video non disponibile${reason ? ': ' + reason : ''}. Prova a scaricarlo da ${NOTUBE} e caricarlo come MP3.`, notubeUrl: `https://notube.net/en/youtube-app-270` });
      }
      return res.json({ ok: false, error: d.playabilityStatus?.reason || status });
    }

    const fmts = [...(d.streamingData?.adaptiveFormats||[]), ...(d.streamingData?.formats||[])]
      .filter(f => f.mimeType?.startsWith('audio/') && f.url)
      .sort((a, b) => (b.bitrate||0) - (a.bitrate||0));

    if (!fmts.length)
      return res.json({ ok: false, error: 'Nessun formato audio disponibile.' });

    const det = d.videoDetails || {};
    const thumbs = det.thumbnail?.thumbnails || [];
    res.json({
      ok: true,
      title:    det.title || 'Audio da YouTube',
      duration: parseInt(det.lengthSeconds) || 0,
      thumbnail: thumbs[thumbs.length-1]?.url || null,
      audioUrl:  fmts[0].url,
      mimeType:  fmts[0].mimeType.split(';')[0]
    });
  } catch(e) {
    console.error('yt-info error:', e.message);
    res.status(500).json({ ok: false, error: 'Errore nel recupero del video.' });
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
