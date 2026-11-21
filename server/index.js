const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { compress, probeVideo } = require('../core/compress');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Security Helper: UUID Validation ---
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPRESSED_FILE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_compressed\.(mp4|gif|mp3)$/i;
function isValidUUID(str) {
  return typeof str === 'string' && UUID_REGEX.test(str);
}

// --- Directories ---
const TMP_DIR = path.resolve(__dirname, '..', 'tmp');
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const CLIPS_DIR = path.resolve(__dirname, '..', 'storage', 'clips');

if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}
if (!fs.existsSync(CLIPS_DIR)) {
  fs.mkdirSync(CLIPS_DIR, { recursive: true });
}

// Auto-cleanup for tmp files to prevent disk bloating
const MAX_TMP_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours
function cleanupTmp(maxAgeMs = MAX_TMP_AGE_MS) {
  if (!fs.existsSync(TMP_DIR)) return;
  const now = Date.now();
  try {
    const files = fs.readdirSync(TMP_DIR);
    for (const file of files) {
      const filePath = path.join(TMP_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;
        const isLogOrTrimmed = file.endsWith('.log') || file.endsWith('.mbtree') || file.includes('_trimmed');
        const age = now - stats.mtimeMs;
        // Purge intermediate log/trim files older than 10 mins, or any tmp files older than maxAgeMs
        if (isLogOrTrimmed ? age > 10 * 60 * 1000 : age > maxAgeMs) {
          fs.unlinkSync(filePath);
          console.log(`[Auto-cleanup] Removed stale tmp file: ${file}`);
        }
      } catch (_) {}
    }
  } catch (err) {
    console.error('[Auto-cleanup] Error cleaning tmp directory:', err.message);
  }
}

// Run cleanup immediately on server startup and every 30 minutes
cleanupTmp();
setInterval(() => cleanupTmp(), 30 * 60 * 1000);

const CLIPS_MANIFEST = path.join(CLIPS_DIR, 'clips.json');

function readClipsJson() {
  if (!fs.existsSync(CLIPS_MANIFEST)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(CLIPS_MANIFEST, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeClipsJson(clips) {
  // Atomic file write using unique temporary file to prevent corruption or race condition on crash
  const tmpFile = `${CLIPS_MANIFEST}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(clips, null, 2), 'utf8');
  fs.renameSync(tmpFile, CLIPS_MANIFEST);
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.avi': return 'video/x-msvideo';
    case '.mkv': return 'video/x-matroska';
    case '.mp3': return 'audio/mpeg';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

// --- Baseline Security Headers Middleware ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; media-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self';"
  );
  next();
});

// --- Middleware ---
app.use(express.json());
app.use(express.static(WEB_DIR));

// --- Multer config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const rawExt = path.extname(file.originalname).toLowerCase();
    const ext = ACCEPTED_EXTS.includes(rawExt) ? rawExt : '.mp4';
    cb(null, `${id}${ext}`);
  },
});

const ACCEPTED_MIMES = [
  'video/mp4',
  'video/quicktime',   // .mov
  'video/x-msvideo',   // .avi
  'video/x-matroska',  // .mkv
  'video/webm',
  'video/x-flv',
  'video/mp2t',
];

const ACCEPTED_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.ts', '.wmv', '.m4v', '.mpg', '.mpeg'];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024, files: 1 }, // 5 GB max upload, 1 file per request
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // Strictly verify both extension and video MIME type
    const hasValidExt = ACCEPTED_EXTS.includes(ext);
    const hasValidMime = file.mimetype.startsWith('video/') || ACCEPTED_MIMES.includes(file.mimetype);

    if (hasValidExt && hasValidMime) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a valid video file (MP4, MOV, WebM, MKV, etc.).'));
    }
  },
});

// --- SSE clients for progress ---
const progressClients = new Map(); // id -> [response, ...]

/**
 * Send an SSE event to all listeners for a given job ID.
 */
function sendProgress(id, event, data) {
  const clients = progressClients.get(id) || [];
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => {
    try { res.write(payload); } catch (_) {}
  });
}

function closeProgress(id) {
  const clients = progressClients.get(id) || [];
  clients.forEach(res => {
    try { res.end(); } catch (_) {}
  });
  progressClients.delete(id);
}

// --- Routes ---

/**
 * POST /api/upload
 * Accepts a video file and returns an ID for subsequent operations.
 * Path leak remediated (no internal server path returned).
 */
app.post('/api/upload', (req, res) => {
  upload.single('video')(req, res, (err) => {
    if (err) {
      const message = err instanceof multer.MulterError
        ? `Upload error: ${err.message}`
        : err.message || 'Upload failed';
      return res.status(400).json({ error: message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const id = path.basename(req.file.filename, path.extname(req.file.filename));

    // Internal server path intentionally removed to prevent information disclosure
    res.json({
      id,
      originalName: req.file.originalname,
      size: req.file.size,
    });
  });
});

/**
 * POST /api/compress
 * Triggers compression for an uploaded file.
 * Validates inputs, bounds, and prevents path traversal.
 */
app.post('/api/compress', async (req, res) => {
  const { id, targetMB, trimStart, trimEnd, volume, resolution, fps, audioBitrate, muteAudio, format, speed, aspectRatio } = req.body;

  if (!id || !isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid or missing file ID' });
  }

  const target = Math.max(parseInt(targetMB, 10) || 10, 10);

  // Find the original uploaded video file strictly in TMP_DIR
  const files = fs.readdirSync(TMP_DIR).filter(f => {
    const ext = path.extname(f);
    const baseWithoutExt = path.basename(f, ext);
    return baseWithoutExt === id && !f.includes('_compressed') && !f.includes('_trimmed') && !f.includes('_passlog');
  });

  if (files.length === 0) {
    return res.status(404).json({ error: 'File not found. It may have expired or been cleaned up.' });
  }

  const outExt = (format === 'gif' || format === 'mp3') ? format : 'mp4';
  const inputFile = path.join(TMP_DIR, files[0]);
  const outputFile = path.join(TMP_DIR, `${id}_compressed.${outExt}`);

  // Build sanitized options
  const options = {};
  if (typeof trimStart === 'number' && trimStart >= 0) options.trimStart = trimStart;
  if (typeof trimEnd === 'number' && trimEnd > 0) options.trimEnd = trimEnd;
  if (typeof volume === 'number') options.volume = volume;
  if (['auto', 'original', '1080', '720', '480', '360'].includes(String(resolution))) options.resolution = resolution;
  if (['auto', 'original', '60', '30', '24'].includes(String(fps))) options.fps = fps;
  if (typeof audioBitrate === 'number' || audioBitrate === 'mute') options.audioBitrate = audioBitrate === 'mute' ? 0 : audioBitrate;
  if (typeof muteAudio === 'boolean') options.muteAudio = muteAudio;
  if (['mp4', 'gif', 'mp3'].includes(String(format))) options.format = format;
  if (typeof speed === 'number' && speed > 0) options.speed = speed;
  if (['original', '16:9', '9:16', '1:1'].includes(String(aspectRatio))) options.aspectRatio = aspectRatio;

  // Respond immediately — compression runs asynchronously
  res.json({ status: 'started', id });

  // Run compression with progress reporting
  try {
    const result = await compress(inputFile, outputFile, target, (progress) => {
      sendProgress(id, 'progress', progress);
    }, options);

    sendProgress(id, 'done', {
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      duration: result.duration,
      format: outExt,
      outputUrl: `/tmp/${id}_compressed.${outExt}`,
      downloadUrl: `/api/download/${id}_compressed.${outExt}`,
    });
  } catch (err) {
    console.error(`Compression failed for ${id}:`, err.message);
    sendProgress(id, 'error', { message: err.message });
  } finally {
    // Delay closing slightly so client receives the done/error event before socket closes
    setTimeout(() => {
      closeProgress(id);
    }, 600);
  }
});

/**
 * Controlled static serving of /tmp
 * Only serves valid compressed media files (.mp4, .gif, .mp3).
 * Forbids scripts, HTML, SVG, and raw uploads to prevent XSS and leaks.
 */
app.use('/tmp', (req, res, next) => {
  const safeName = path.basename(req.path);

  if (!COMPRESSED_FILE_REGEX.test(safeName)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(TMP_DIR, safeName);
  if (!filePath.startsWith(TMP_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.setHeader('Content-Type', getMimeType(filePath));
  res.sendFile(filePath);
});

/**
 * GET /api/download/:filename
 * Securely serves compressed files with path traversal protection.
 */
app.get('/api/download/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);

  if (!COMPRESSED_FILE_REGEX.test(safeFilename)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const outputFile = path.join(TMP_DIR, safeFilename);

  if (!outputFile.startsWith(TMP_DIR) || !fs.existsSync(outputFile)) {
    return res.status(404).json({ error: 'File not found' });
  }

  // Sanitize download filename for Content-Disposition
  const downloadName = `10mb_${safeFilename.replace(/["\r\n]/g, '_')}`;

  res.download(outputFile, downloadName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

/**
 * GET /api/progress/:id
 * SSE endpoint for real-time compression progress with heartbeat keep-alive.
 */
app.get('/api/progress/:id', (req, res) => {
  const { id } = req.params;

  if (!id || !isValidUUID(id)) {
    return res.status(400).end('Invalid ID');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  // Initial connect confirmation
  res.write(`event: connected\ndata: ${JSON.stringify({ id })}\n\n`);

  // Register client
  if (!progressClients.has(id)) {
    progressClients.set(id, []);
  }
  progressClients.get(id).push(res);

  // Keep-alive heartbeat every 15s to prevent socket drops and connection leaks
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {}
  }, 15000);

  // Safety timeout: automatically close orphaned SSE connection after 30 minutes
  const maxConnectionTimeout = setTimeout(() => {
    try { res.end(); } catch (_) {}
  }, 30 * 60 * 1000);

  // Clean up on disconnect
  req.on('close', () => {
    clearTimeout(maxConnectionTimeout);
    clearInterval(pingInterval);
    const clients = progressClients.get(id) || [];
    const idx = clients.indexOf(res);
    if (idx > -1) clients.splice(idx, 1);
    if (clients.length === 0) progressClients.delete(id);
  });
});

// ==========================================
// --- Stored Clips Routes ---
// ==========================================

/**
 * GET /api/clips
 * Returns list of stored clips metadata.
 */
app.get('/api/clips', (req, res) => {
  const clips = readClipsJson();
  res.json(clips);
});

/**
 * POST /api/clips/save
 * Save a video file (from tmp or upload) as a stored clip.
 * Body: { id, title, format, originalName, size, duration }
 */
app.post('/api/clips/save', async (req, res) => {
  const { id, title, format, originalName, size, duration } = req.body;

  if (!id || !isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid or missing file ID to save' });
  }

  const ext = (['mp4', 'gif', 'mp3'].includes(String(format)) ? format : 'mp4').toLowerCase();
  
  // Look for compressed file first, then raw uploaded file in TMP_DIR
  const compFile = path.join(TMP_DIR, `${id}_compressed.${ext}`);
  let sourceFile = compFile;

  if (!fs.existsSync(sourceFile)) {
    // Try matching raw file in TMP_DIR
    const files = fs.readdirSync(TMP_DIR).filter(f => {
      const fExt = path.extname(f);
      return path.basename(f, fExt) === id;
    });
    if (files.length > 0) {
      sourceFile = path.join(TMP_DIR, files[0]);
    } else {
      return res.status(404).json({ error: 'Source file not found' });
    }
  }

  const clipId = crypto.randomUUID();
  const actualExt = path.extname(sourceFile) || `.${ext}`;
  const clipFileName = `${clipId}${actualExt}`;
  const destFile = path.join(CLIPS_DIR, clipFileName);

  try {
    fs.copyFileSync(sourceFile, destFile);
    const stat = fs.statSync(destFile);

    let clipDuration = duration || 0;
    if (!clipDuration || clipDuration <= 0) {
      try {
        const meta = await probeVideo(destFile);
        clipDuration = meta.duration || 0;
      } catch (_) {}
    }

    const safeTitle = String(title || originalName || `Clip ${clipId.slice(0, 6)}`).replace(/[\r\n]/g, ' ').trim().slice(0, 200);
    const safeOrigName = String(originalName || title || `video${actualExt}`).replace(/[\r\n]/g, ' ').trim().slice(0, 200);

    const clipObj = {
      id: clipId,
      title: safeTitle,
      originalName: safeOrigName,
      filename: clipFileName,
      format: actualExt.replace('.', ''),
      size: stat.size || size || 0,
      duration: clipDuration,
      createdAt: new Date().toISOString(),
      streamUrl: `/api/clips/stream/${clipFileName}`,
      downloadUrl: `/api/clips/download/${clipFileName}`,
    };

    const clips = readClipsJson();
    clips.unshift(clipObj); // newest first
    writeClipsJson(clips);

    // Auto-cleanup: remove raw uncompressed upload from tmp now that it is saved
    try {
      const rawFiles = fs.readdirSync(TMP_DIR).filter(f => {
        const fExt = path.extname(f);
        return path.basename(f, fExt) === id && !f.includes('_compressed') && !f.includes('_trimmed');
      });
      for (const rf of rawFiles) {
        fs.unlinkSync(path.join(TMP_DIR, rf));
        console.log(`[Auto-cleanup] Removed raw source upload: ${rf}`);
      }
    } catch (_) {}

    res.json({ success: true, clip: clipObj });
  } catch (err) {
    console.error('Failed to save clip:', err.message);
    res.status(500).json({ error: 'Failed to save clip to storage' });
  }
});

/**
 * POST /api/clips/upload
 * Directly upload a video to stored clips.
 */
app.post('/api/clips/upload', (req, res) => {
  upload.single('video')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const clipId = crypto.randomUUID();
    const rawExt = path.extname(req.file.originalname).toLowerCase();
    const ext = ACCEPTED_EXTS.includes(rawExt) ? rawExt : '.mp4';
    const clipFileName = `${clipId}${ext}`;
    const destFile = path.join(CLIPS_DIR, clipFileName);

    try {
      fs.copyFileSync(req.file.path, destFile);
      try { fs.unlinkSync(req.file.path); } catch (_) {}
      const stat = fs.statSync(destFile);

      let clipDuration = 0;
      try {
        const meta = await probeVideo(destFile);
        clipDuration = meta.duration || 0;
      } catch (_) {}

      const safeTitle = path.basename(req.file.originalname).replace(/[\r\n]/g, ' ').trim().slice(0, 200);

      const clipObj = {
        id: clipId,
        title: safeTitle,
        originalName: safeTitle,
        filename: clipFileName,
        format: ext.replace('.', ''),
        size: stat.size,
        duration: clipDuration,
        createdAt: new Date().toISOString(),
        streamUrl: `/api/clips/stream/${clipFileName}`,
        downloadUrl: `/api/clips/download/${clipFileName}`,
      };

      const clips = readClipsJson();
      clips.unshift(clipObj);
      writeClipsJson(clips);

      res.json({ success: true, clip: clipObj });
    } catch (e) {
      if (fs.existsSync(destFile)) {
        try { fs.unlinkSync(destFile); } catch (_) {}
      }
      res.status(500).json({ error: 'Failed to save clip' });
    }
  });
});

/**
 * GET /api/clips/stream/:filename
 * HTTP 206 Partial Content range-streaming with Path Traversal Protection.
 */
app.get('/api/clips/stream/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);

  // Forbid non-clip files such as clips.json and .gitkeep
  if (safeFilename === 'clips.json' || safeFilename === '.gitkeep') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(CLIPS_DIR, safeFilename);

  if (!filePath.startsWith(CLIPS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Clip file not found' });
  }

  const clips = readClipsJson();
  const clip = clips.find(c => c.filename === safeFilename);
  if (!clip) {
    return res.status(404).json({ error: 'Clip not found in library' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  if (fileSize === 0) {
    res.writeHead(200, {
      'Content-Length': 0,
      'Content-Type': getMimeType(filePath),
    });
    return res.end();
  }

  const range = req.headers.range;

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    let start = match[1] ? parseInt(match[1], 10) : NaN;
    let end = match[2] ? parseInt(match[2], 10) : NaN;

    if (isNaN(start) && isNaN(end)) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    if (isNaN(start)) {
      start = Math.max(0, fileSize - end);
      end = fileSize - 1;
    } else if (isNaN(end) || end >= fileSize) {
      end = fileSize - 1;
    }

    if (start >= fileSize || start > end || start < 0) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const chunksize = (end - start) + 1;
    const head = {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': getMimeType(filePath),
    };
    res.writeHead(206, head);
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  } else {
    const head = {
      'Accept-Ranges': 'bytes',
      'Content-Length': fileSize,
      'Content-Type': getMimeType(filePath),
    };
    res.writeHead(200, head);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    req.on('close', () => stream.destroy());
    stream.pipe(res);
  }
});

/**
 * GET /api/clips/download/:filename
 * Secure download of clip file.
 */
app.get('/api/clips/download/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);

  if (safeFilename === 'clips.json' || safeFilename === '.gitkeep') {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(CLIPS_DIR, safeFilename);

  if (!filePath.startsWith(CLIPS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Clip file not found' });
  }

  const clips = readClipsJson();
  const clip = clips.find(c => c.filename === safeFilename);
  if (!clip) {
    return res.status(404).json({ error: 'Clip not found in library' });
  }

  const rawDownloadName = clip ? clip.originalName : safeFilename;
  const safeDownloadName = path.basename(rawDownloadName).replace(/["\r\n]/g, '_');

  res.download(filePath, safeDownloadName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

/**
 * DELETE /api/clips/:id
 * Delete stored clip with UUID validation and path verification.
 */
app.delete('/api/clips/:id', (req, res) => {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid clip ID' });
  }

  const clips = readClipsJson();
  const idx = clips.findIndex(c => c.id === id);

  if (idx === -1) {
    return res.status(404).json({ error: 'Clip not found' });
  }

  const clip = clips[idx];
  const safeFilename = path.basename(clip.filename);
  const filePath = path.join(CLIPS_DIR, safeFilename);

  if (safeFilename !== 'clips.json' && safeFilename !== '.gitkeep' && filePath.startsWith(CLIPS_DIR) && fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      console.error('Failed to remove clip file:', e.message);
    }
  }

  clips.splice(idx, 1);
  writeClipsJson(clips);

  res.json({ success: true });
});

/**
 * POST /api/cleanup
 * Safely cleans up stale tmp files older than 30 minutes (prevents DoS of active jobs).
 */
app.post('/api/cleanup', (req, res) => {
  cleanupTmp(30 * 60 * 1000);
  res.json({ success: true, message: 'Stale tmp files cleaned successfully' });
});

// --- Central Error Handler ---
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  if (!res.headersSent) {
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

// --- Start ---
const server = app.listen(PORT, () => {
  console.log(`\n  10mb \u2014 Video Compression Tool`);
  console.log(`  \u2192 http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please terminate the process using it or set PORT=<port>.`);
  } else {
    console.error('Server startup error:', err.message);
  }
});
