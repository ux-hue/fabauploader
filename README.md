# 🎵 Faba•Me Audio Uploader v2

Webapp mobile-first per caricare file audio su Faba•Me (personaggio sonoro di FABA+) tramite il link d'invito dell'app MyFaba.

## Fix v2 rispetto alla v1

- **413 risolto**: l'audio viene convertito in WAV 22050Hz mono (≈ 2.5MB/min) invece di 44100Hz stereo, molto sotto il limite dell'API Faba
- **Multiupload**: si possono aggiungere più file contemporaneamente, ognuno con il suo titolo, caricati uno alla volta in coda
- **UX semplificata**: design pensato per genitori, flusso in 4 step chiari
- **Titolo per-file**: ogni file nella coda ha il suo campo titolo modificabile

## Setup locale

**Requisiti:** Node.js ≥ 18 + ffmpeg installato

```bash
# Installa ffmpeg (macOS)
brew install ffmpeg

# Installa ffmpeg (Ubuntu/Debian)
sudo apt install ffmpeg

# Installa dipendenze Node
npm install

# Avvia
npm start
# → http://localhost:3000
```

## Deploy su Render

1. Crea un nuovo **Web Service** su render.com
2. Collegalo al repo GitHub
3. **Build command:** `npm install`
4. **Start command:** `node server.js`
5. Aggiungi i buildpack per ffmpeg:

   Nella tab **Environment**, aggiungi:
   ```
   FFMPEG_PATH=/usr/bin/ffmpeg
   ```

   Oppure usa il Dockerfile incluso (seleziona "Docker" come ambiente su Render).

### Render con Docker (consigliato)

Su Render, seleziona **"Docker"** come Runtime — il Dockerfile incluso installa automaticamente ffmpeg.

### Nota Render free tier

Il servizio free di Render va in sleep dopo 15 minuti di inattività. Il primo caricamento dopo il sleep può richiedere 30-60 secondi. Per uso continuo considera il piano $7/mese.

## Come funziona il multiupload

Il link d'invito MyFaba rimane valido per 24 ore e accetta **upload multipli sullo stesso link** (come confermato anche dal plugin FabaMore). Per ogni file:

1. Il server si ri-autentica con il link (nuova sessione)
2. Converte l'audio in WAV compresso
3. Fa il POST verso il cloud MyFaba
4. L'utente riceve una notifica nell'app per ogni traccia

Basato su [60ne/faba-tools](https://github.com/60ne/faba-tools) (Apache 2.0).
