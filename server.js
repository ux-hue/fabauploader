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



/* ── YouTube via InnerTube API diretto (axios) ────────────────────────────── */
//
// Chiama /youtubei/v1/player direttamente — nessun parsing HTML,
// nessun wrapper che può crashare. Prova più client in sequenza.
//

function extractVideoId(url) {
  const m = url.match(/(?:v=|youtu\.be\/|\/v\/|\/embed\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

// Configurazioni client InnerTube aggiornate a marzo 2026
// Fonte: yt-dlp _base.py — android_vr e tv sono i client default senza PO token
const INNERTUBE_CLIENTS = [
  {
    // android_vr — default yt-dlp, non richiede PO token
    name: 'ANDROID_VR',
    body: {
      context: {
        client: {
          clientName: 'ANDROID_VR',
          clientVersion: '1.56.21',
          deviceMake: 'Oculus',
          deviceModel: 'Quest 3',
          androidSdkVersion: 32,
          osName: 'Android',
          osVersion: '12L',
          hl: 'en', gl: 'US'
        }
      }
    },
    headers: {
      'User-Agent': 'com.google.android.apps.youtube.vr.oculus/1.56.21 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip',
      'X-YouTube-Client-Name': '28',
      'X-YouTube-Client-Version': '1.56.21',
    }
  },
  {
    // tv_downgraded — TVHTML5 version 4, no PO token needed, works from servers
    name: 'TV_DOWNGRADED',
    body: {
      context: {
        client: {
          clientName: 'TVHTML5',
          clientVersion: '4',
          hl: 'en', gl: 'US'
        }
      }
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/Version',
      'X-YouTube-Client-Name': '7',
      'X-YouTube-Client-Version': '4',
    }
  },
  {
    // tv — TVHTML5 latest, works without cookies
    name: 'TV',
    body: {
      context: {
        client: {
          clientName: 'TVHTML5',
          clientVersion: '7.20260114.12.00',
          userAgent: 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
          hl: 'en', gl: 'US'
        }
      }
    },
    headers: {
      'User-Agent': 'Mozilla/5.0 (ChromiumStylePlatform) Cobalt/25.lts.30.1034943-gold (unlike Gecko), Unknown_TV_Unknown_0/Unknown (Unknown, Unknown)',
      'X-YouTube-Client-Name': '7',
      'X-YouTube-Client-Version': '7.20260114.12.00',
    }
  }
];

const INNERTUBE_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';

async function fetchPlayerData(videoId) {
  for (const client of INNERTUBE_CLIENTS) {
    try {
      const body = {
        ...client.body,
        videoId,
        racyCheckOk: true,
        contentCheckOk: true
      };
      const resp = await axios.post(INNERTUBE_URL, body, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          ...client.headers
        },
        timeout: 15_000
      });
      const d = resp.data;
      const status = d?.playabilityStatus?.status;
      console.log(`[yt] client=${client.name} status=${status}`);

      if (status === 'OK') {
        return { data: d, clientName: client.name };
      }
    } catch(e) {
      console.log(`[yt] client=${client.name} error: ${e.message.slice(0, 80)}`);
    }
  }
  return null;
}

function parsePlayerData(data) {
  const details = data.videoDetails || {};
  const title = details.title || 'Audio da YouTube';
  const duration = parseInt(details.lengthSeconds) || 0;
  const thumbnails = details.thumbnail?.thumbnails || [];
  const thumbnail = thumbnails[thumbnails.length - 1]?.url || null;

  // Trova il miglior formato audio
  const allFormats = [
    ...(data.streamingData?.adaptiveFormats || []),
    ...(data.streamingData?.formats || [])
  ];
  const audioFormats = allFormats
    .filter(f => f.mimeType?.startsWith('audio/') && f.url)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));

  const audioUrl = audioFormats[0]?.url || null;
  return { title, duration, thumbnail, audioUrl };
}

app.post('/api/youtube-info', async (req, res) => {
  const { url } = req.body;
  if (!url || !/youtube\.com|youtu\.be/.test(url))
    return res.status(400).json({ ok: false, error: 'URL YouTube non valido.' });

  const videoId = extractVideoId(url);
  if (!videoId)
    return res.status(400).json({ ok: false, error: 'ID video non trovato nell\'URL.' });

  try {
    const result = await fetchPlayerData(videoId);
    if (!result) return res.status(400).json({ ok: false, error: 'Video non accessibile dal server. Prova a caricare l\'MP3 manualmente.' });

    const { title, duration, thumbnail } = parsePlayerData(result.data);
    res.json({ ok: true, title, duration, thumbnail });
  } catch(e) {
    console.error('yt-info error:', e.message);
    res.status(400).json({ ok: false, error: ytHumanError(e.message) });
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
    console.log(`[yt] downloading ${videoId}`);
    const result = await fetchPlayerData(videoId);
    if (!result) throw new Error('NO_CLIENTS');

    const { audioUrl } = parsePlayerData(result.data);
    if (!audioUrl) throw new Error('NO_FORMAT');
    console.log(`[yt] audio URL via ${result.clientName}`);

    const wavBuf = await new Promise((resolve, reject) => {
      const tmpOut = path.join(os.tmpdir(), `fab_yt_${Date.now()}.wav`);
      const { spawn } = require('child_process');
      const ff = spawn('ffmpeg', [
        '-y',
        '-user_agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        '-i', audioUrl,
        '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '22050',
        '-f', 'wav', tmpOut
      ]);
      let ffErr = '';
      ff.stderr.on('data', d => { ffErr += d.toString(); });
      ff.on('close', code => {
        if (code !== 0) {
          console.error('ffmpeg stderr:', ffErr.slice(-400));
          reject(new Error('FFMPEG_FAILED'));
          return;
        }
        try { const buf = fs.readFileSync(tmpOut); fs.unlinkSync(tmpOut); resolve(buf); }
        catch(e) { reject(e); }
      });
      ff.on('error', reject);
    });

    console.log(`[yt] WAV: ${(wavBuf.length / 1024 / 1024).toFixed(1)} MB`);
    const { xsrf, sess, location } = await loadPage(shareId);
    const { actionUrl, _token, cookie } = await fetchForm(xsrf, sess, location);
    const { duration } = await uploadWav(actionUrl, cookie, _token, wavBuf, author, title);
    res.json({ ok: true, duration });

  } catch(e) {
    console.error('yt-upload error:', e.message);
    res.status(500).json({ ok: false, error: ytHumanError(e.message) });
  }
});

function ytHumanError(msg = '') {
  const m = msg.toLowerCase();
  if (m === 'login_required' || m.includes('sign in') || m.includes('private'))
    return 'Il video è privato o richiede accesso.';
  if (m === 'unplayable' || m.includes('unavailable') || m.includes('not available'))
    return 'Il video non è disponibile in questa regione o è stato rimosso.';
  if (m === 'no_clients' || m.includes('tutti i client') || m.includes('non accessibile'))
    return 'Il video non è scaricabile dal server. Prova a caricare l\'MP3 manualmente o usa un link YouTube diverso.';
  if (m === 'no_format' || m.includes('decipher') || m.includes('audio url'))
    return 'Formato audio non ottenibile. Prova con un altro video o carica l\'MP3 manualmente.';
  if (m === 'ffmpeg_failed' || m.includes('conversione'))
    return 'Errore nella conversione audio. Prova con un altro video.';
  if (m.includes('copyright')) return 'Il video è bloccato per copyright.';
  if (m.includes('age'))       return 'Il video ha restrizioni di età.';
  if (m.includes('members'))   return 'Il video è riservato agli iscritti al canale.';
  return 'Impossibile scaricare il video. Prova con un altro link o carica l\'MP3 manualmente.';
}

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
