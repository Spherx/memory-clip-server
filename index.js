const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { Pool } = require('pg');
const ffmpeg  = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
ffmpeg.setFfmpegPath(ffmpegPath);   // use bundled binary, don't rely on system PATH

const app  = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// DATABASE
// ============================================================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clips (
      id          SERIAL PRIMARY KEY,
      filename    TEXT NOT NULL,
      video_url   TEXT,
      lat         DOUBLE PRECISION,
      lng         DOUBLE PRECISION,
      locked      BOOLEAN DEFAULT false,
      satellites  INTEGER DEFAULT 0,
      timestamp   TEXT,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  console.log('Database ready');
}

// ============================================================
// FILE STORAGE
// ============================================================
const DATA_DIR   = process.env.DATA_DIR || __dirname;  // mount a Railway volume at /data and set DATA_DIR=/data
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const OUTPUT_DIR = path.join(DATA_DIR, 'outputs');
[UPLOAD_DIR, OUTPUT_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    // Preserve original filename from ESP32
    cb(null, Date.now() + '_' + file.originalname);
  }
});
const upload = multer({ storage, limits: { fileSize: 500 * 1024 * 1024 } }); // 500MB max

// ============================================================
// MIDDLEWARE
// ============================================================
app.use(cors());
app.use(express.json());
app.use('/videos', express.static(OUTPUT_DIR));

// ============================================================
// ROUTES
// ============================================================

// Health check
app.get('/', (req, res) => res.json({ status: 'Memory Clip server running' }));

// Upload endpoint — receives video, audio, gps from ESP32
app.post('/upload', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
  { name: 'gps',   maxCount: 1 }
]), async (req, res) => {
  try {
    const videoFile = req.files?.video?.[0];
    const audioFile = req.files?.audio?.[0];
    const gpsFile   = req.files?.gps?.[0];

    if (!videoFile || !audioFile) {
      return res.status(400).json({ error: 'Missing video or audio file' });
    }

    // Parse GPS JSON
    let gpsData = { lat: null, lng: null, locked: false, satellites: 0, timestamp: null };
    if (gpsFile) {
      try {
        const raw = fs.readFileSync(gpsFile.path, 'utf8');
        gpsData = { ...gpsData, ...JSON.parse(raw) };
      } catch (e) {
        console.warn('GPS parse error:', e.message);
      }
    }

    // Output MP4 filename
    const outName = Date.now() + '_clip.mp4';
    const outPath = path.join(OUTPUT_DIR, outName);

    console.log(`Processing: ${videoFile.originalname} + ${audioFile.originalname}`);

    // Merge video + audio with FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoFile.path)
        .input(audioFile.path)
        .outputOptions([
          '-c:v libx264',
          '-c:a aac',
          '-shortest',
          '-movflags +faststart'
        ])
        .output(outPath)
        .on('end', resolve)
        .on('error', reject)
        .run();
    });

    // Clean up temp upload files
    [videoFile.path, audioFile.path, gpsFile?.path].forEach(f => {
      if (f) try { fs.unlinkSync(f); } catch {}
    });

    // Save to database
    const videoUrl = `/videos/${outName}`;
    const result = await pool.query(
      `INSERT INTO clips (filename, video_url, lat, lng, locked, satellites, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [outName, videoUrl, gpsData.lat, gpsData.lng, gpsData.locked, gpsData.satellites, gpsData.timestamp]
    );

    console.log(`Clip saved: id=${result.rows[0].id} url=${videoUrl}`);
    res.json({ success: true, id: result.rows[0].id, url: videoUrl });

  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get all clips (for the website)
app.get('/memories', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM clips ORDER BY created_at DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single clip
app.get('/memories/:id', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM clips WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// START
// ============================================================
initDb().then(() => {
  app.listen(PORT, () => console.log(`Memory Clip server on port ${PORT}`));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
