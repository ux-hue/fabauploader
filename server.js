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


/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Accetta link nuovo (share.myfaba.com/r/ID) e vecchio (studio.myfaba.com/record/ID).
 *  Ritorna l'URL completo normalizzato (usato come "shareId" opaco dal frontend). */
function extractShareId(input = '') {
  const t = String(input);
  let m = t.match(/https?:\/\/share\.myfaba\.com\/r\/([A-Za-z0-9_-]+)/);
  if (m) return `https://share.myfaba.com/r/${m[1]}`;
  m = t.match(/https?:\/\/studio\.myfaba\.com\/record\/([A-Za-z0-9_-]+)/);
  if (m) return `https://studio.myfaba.com/record/${m[1]}`;
  return null;
}

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1';

/** Step 1+2 – segue i redirect a mano (max 8) tenendo i cookie, fino alla pagina col form */
async function loadPage(shareUrl) {
  const jar = {};
  const addCookies = resp => {
    for (const c of resp.headers['set-cookie'] || []) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    }
  };
  const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

  let url = shareUrl;
  for (let hop = 0; hop < 8; hop++) {
    const resp = await axios.get(url, {
      maxRedirects: 0,
      validateStatus: s => s < 500,
      headers: { 'User-Agent': UA, ...(Object.keys(jar).length ? { Cookie: cookieHeader() } : {}) }
    });
    addCookies(resp);
    console.log(`[faba] hop ${hop} ${resp.status} ${url}`);

    if (resp.status === 403) throw new Error('STORAGE_FULL');
    if (resp.status === 404 || resp.status === 410) throw new Error('LINK_SCADUTO');

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers['location'];
      if (!loc) throw new Error('LINK_SCADUTO');
      url = new URL(loc, url).toString();
      continue;
    }
    if (resp.status === 200) {
      const html = typeof resp.data === 'string' ? resp.data : String(resp.data);
      const dom = new JSDOM(html);
      if (dom.window.document.getElementById('form')) return { jar, cookie: cookieHeader(), html, pageUrl: url };
      // pagina senza form: mostra indizi nei log per debug
      console.log('[faba] pagina senza #form:', html.slice(0, 300).replace(/\s+/g, ' '));
      throw new Error('LINK_SCADUTO');
    }
    throw new Error('LINK_SCADUTO');
  }
  throw new Error('LINK_SCADUTO');
}

/** Estrae dal form: action, token, scadenza */
async function fetchForm(page) {
  const doc  = new JSDOM(page.html).window.document;
  const form = doc.getElementById('form');
  if (!form) throw new Error('LINK_SCADUTO');

  const actionRaw = form.getAttribute('action');
  const tokenEl   = doc.querySelector('input[name="_token"]');
  if (!actionRaw || !tokenEl) throw new Error('Token CSRF non trovato.');
  const actionUrl = new URL(actionRaw, page.pageUrl).toString();

  const parsed = new URL(actionUrl);
  const expires = parsed.searchParams.get('expires');
  const expiresMs = expires ? parseInt(expires) * 1000 : null;

  return { actionUrl, _token: tokenEl.value, cookie: page.cookie, expiresMs, usedSeconds: null, maxSeconds: null };
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
      Referer: 'https://share.myfaba.com/' },
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
    'STORAGE_FULL':      '🔴 Spazio esaurito — il tuo Faba•Me ha raggiunto il limite di tracce. Apri l\'app MyFaba, vai sul personaggio, rimuovi alcune tracce per liberare spazio, poi genera un nuovo link d\'invito.',
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
  if (s.includes('private')) return 'Il video è privato.';
  if (s.includes('copyright') || s.includes('blocked')) return 'Il video è bloccato per copyright.';
  if (s.includes('unavailable') || s.includes('not available')) return 'Il video non è disponibile.';
  if (s.includes('age')) return 'Il video ha restrizioni di età.';
  return 'Impossibile scaricare il video. Prova con un altro link.';
}

const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
const RAPIDAPI_HOST = 'youtube-mp3-audio-video-downloader.p.rapidapi.com';

// Spicy-Laika YouTube MP3 Audio Video Downloader
async function rapidApiGetMp3(videoId) {
  if (!RAPIDAPI_KEY) throw new Error('RAPIDAPI_KEY non configurata');
  const headers = { 'x-rapidapi-key': RAPIDAPI_KEY, 'x-rapidapi-host': RAPIDAPI_HOST };

  const r = await axios.get(
    `https://${RAPIDAPI_HOST}/get_mp3_download_link/${videoId}`,
    { params: { quality: 'low', wait_until_the_file_is_ready: 'true' }, headers, timeout: 60_000 }
  );
  const d = r.data;
  console.log(`[rapidapi] response:`, JSON.stringify(d).slice(0, 200));

  // Campo URL può essere 'file', 'downloadUrl', 'url', 'link'
  const mp3Url = d.file || d.downloadUrl || d.download_url || d.url || d.link;
  if (!mp3Url) throw new Error(`RapidAPI: nessun URL — ${JSON.stringify(d).slice(0, 100)}`);

  // Il file potrebbe non essere ancora pronto — poll HEAD fino a 300s
  console.log(`[rapidapi] polling URL: ${mp3Url.slice(0, 60)}`);
  for (let i = 0; i < 30; i++) {
    await new Promise(res => setTimeout(res, 10_000));
    try {
      const head = await axios.head(mp3Url, { timeout: 8_000 });
      if (head.status === 200) {
        console.log(`[rapidapi] file ready after ${(i+1)*10}s`);
        return { title: d.title || d.videoTitle || 'Audio da YouTube', mp3Url };
      }
    } catch(e) {
      console.log(`[rapidapi] poll ${i+1}: not ready yet (${e.response?.status || e.message})`);
    }
  }
  throw new Error('RapidAPI: timeout — file non disponibile dopo 300s');
}

// Route: info video (usa oEmbed per titolo + thumbnail, veloce)
app.post('/api/yt-info', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId))
    return res.status(400).json({ ok: false, error: 'ID video non valido.' });
  try {
    // oEmbed è pubblico, non richiede auth — solo metadati base
    const oe = await axios.get(`https://www.youtube.com/oembed?url=https://youtu.be/${videoId}&format=json`, { timeout: 10_000 });
    res.json({ ok: true, title: oe.data.title || 'Audio da YouTube', duration: 0, thumbnail: oe.data.thumbnail_url || null });
  } catch(e) {
    // Se anche oEmbed fallisce il video è privato/inesistente
    res.status(400).json({ ok: false, error: 'Video non trovato o privato.', notubeUrl: 'https://notube.link/it/youtube-app-322' });
  }
});

// Route: download MP3 via RapidAPI + converti WAV + carica su Faba
app.post('/api/youtube-upload', async (req, res) => {
  const { url, shareId, author, title } = req.body;
  if (!url || !shareId || !author || !title)
    return res.status(400).json({ ok: false, error: 'Dati mancanti.' });
  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ ok: false, error: 'URL non valido.' });

  try {
    console.log(`[yt] RapidAPI download ${videoId}`);
    const { mp3Url, title: ytTitle } = await rapidApiGetMp3(videoId);
    console.log(`[yt] MP3 URL ottenuto`);

    // Scarica MP3 e converti in WAV via ffmpeg
    const wavBuf = await new Promise((resolve, reject) => {
      const tmpOut = path.join(os.tmpdir(), `fab_yt_${Date.now()}.wav`);
      const ff = require('child_process').spawn('ffmpeg', [
        '-y', '-i', mp3Url,
        '-acodec', 'pcm_s16le', '-ac', '1', '-ar', '22050',
        '-f', 'wav', tmpOut
      ]);
      let ffErr = '';
      ff.stderr.on('data', d => { ffErr += d; });
      ff.on('close', code => {
        if (code !== 0) { console.error('ffmpeg:', ffErr.slice(-200)); reject(new Error('Conversione audio fallita.')); return; }
        try { const buf = fs.readFileSync(tmpOut); try{fs.unlinkSync(tmpOut);}catch{} resolve(buf); }
        catch(e) { reject(e); }
      });
      ff.on('error', reject);
    });

    console.log(`[yt] WAV: ${(wavBuf.length/1024/1024).toFixed(1)} MB`);
    const page = await loadPage(shareId);
    const { actionUrl, _token, cookie } = await fetchForm(page);
    const { duration } = await uploadWav(actionUrl, cookie, _token, wavBuf, author, title);
    res.json({ ok: true, duration });

  } catch(e) {
    console.error('[yt] upload error:', e.message);
    const notubeUrl = 'https://notube.link/it/youtube-app-322';
    if (e.message.includes('RAPIDAPI_KEY')) {
      return res.status(500).json({ ok: false, error: 'Servizio YouTube non configurato. Scarica l\'MP3 manualmente da notube.link.', notubeUrl });
    }
    res.status(500).json({ ok: false, error: ytErrMsg(e.message), notubeUrl });
  }
});

/* ── API routes ───────────────────────────────────────────────────────────── */
// Validate link
app.post('/api/validate', async (req, res) => {
  const shareId = extractShareId(req.body.url || '');
  if (!shareId) return res.status(400).json({ ok: false, error: 'URL non valido. Deve essere del tipo https://share.myfaba.com/r/XXXXXXXXXX' });

  try {
    const page = await loadPage(shareId);
    const { expiresMs, usedSeconds, maxSeconds } = await fetchForm(page);

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
    const page = await loadPage(shareId);
    const { actionUrl, _token, cookie } = await fetchForm(page);

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

/* ── DEBUG temporaneo: analizza il nuovo flusso Faba (da rimuovere dopo) ───── */
app.get('/api/faba-debug', async (req, res) => {
  try {
    const shareUrl = extractShareId(req.query.url || '');
    if (!shareUrl) return res.status(400).type('text').send('url mancante');
    const jar = {}; let url = shareUrl, html = '', out = [];
    const ck = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    for (let i = 0; i < 8; i++) {
      const r = await axios.get(url, { maxRedirects: 0, validateStatus: s => s < 600,
        headers: { 'User-Agent': UA, ...(Object.keys(jar).length ? { Cookie: ck() } : {}) } });
      for (const c of r.headers['set-cookie'] || []) { const [p] = c.split(';'); const j = p.indexOf('='); if (j > 0) jar[p.slice(0, j)] = p.slice(j + 1); }
      out.push(`HOP ${i} ${r.status} ${url.replace(/token=[^&]+/, 'token=…')}`);
      if (r.status >= 300 && r.status < 400) { url = new URL(r.headers.location, url).toString(); continue; }
      html = String(r.data); break;
    }
    out.push('COOKIES: ' + Object.keys(jar).join(', '));
    out.push('HTML length: ' + html.length);
    // testo visibile + indizi nel payload Next
    const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 600);
    out.push('TESTO PAGINA: ' + text);
    const inline = (html.match(/<script>[\s\S]*?<\/script>/g) || []).join('\n').replace(/token":"[^"]+/g, 'token":"…');
    const hints = inline.match(/[^"\\]{0,60}(upload|record|audio|api\/|expires|signed|presign|storage|bucket)[^"\\]{0,80}/gi) || [];
    out.push('INDIZI NEL PAYLOAD (' + hints.length + '):\n' + [...new Set(hints)].slice(0, 60).join('\n'));
    const chunks = [...new Set((html.match(/\/_next\/static\/chunks\/[A-Za-z0-9_.\-~]+\.js/g) || []))];
    out.push('CHUNKS: ' + chunks.length);
    const base = new URL(url).origin;
    for (const c of chunks) {
      try {
        const js = (await axios.get(base + c, { headers: { 'User-Agent': UA }, timeout: 15000 })).data;
        const src = typeof js === 'string' ? js : JSON.stringify(js);
        const m = src.match(/[^"'`\n]{0,70}(\/api\/[A-Za-z0-9_\-\/\.\$\{\}]+|upload[A-Za-z]*|\/invites\/[^"'`]{0,60}|FormData|multipart)[^"'`\n]{0,70}/gi) || [];
        const u = [...new Set(m)].slice(0, 25);
        if (u.length) out.push(`\n# ${c}\n` + u.join('\n'));
      } catch (e) { out.push(`# ${c} errore ${e.message}`); }
    }
    res.type('text').send(out.join('\n'));
  } catch (e) { res.status(500).type('text').send('ERR ' + e.message); }
});

app.listen(PORT, () => console.log(`🎵 Faba Uploader → http://localhost:${PORT}`));
