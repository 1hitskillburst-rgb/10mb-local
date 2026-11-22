const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const {
  compress,
  probeVideo,
  validateVideoFile,
  getHardwareEncoders,
  killActiveJobs,
} = require('../core/compress');
const {
  COMPRESSED_FILE_REGEX,
  CLIP_FILE_REGEX,
  ACCEPTED_EXTS,
  ACCEPTED_MIMES,
  isValidUUID,
  isPathInside,
  sanitizeFilename,
  sanitizeErrorMessage,
  parseAndValidateCompressOptions,
  parseRangeHeader,
  signSessionId,
  verifySessionToken,
  hashSessionOwner,
  parseCookies,
  isSameOriginRequest,
} = require('../core/utils');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const SESSION_COOKIE_NAME = 'mb10_sid';
const SESSION_MAX_AGE_SEC = 30 * 24 * 60 * 60; // 30 days
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_CONCURRENT_JOBS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_JOBS, 10) || 3);
const MAX_TMP_AGE_MS = Math.max(60 * 1000, (parseInt(process.env.TMP_TTL_MINUTES, 10) || 15) * 60 * 1000); // 15 min default

// --- Directories ---
const TMP_DIR = path.resolve(__dirname, '..', 'tmp');
const WEB_DIR = path.resolve(__dirname, '..', 'web');
const CLIPS_DIR = path.resolve(__dirname, '..', 'storage', 'clips');
const CLIPS_MANIFEST = path.join(CLIPS_DIR, 'clips.json');

fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(CLIPS_DIR, { recursive: true });

// --- State Registries (all bounded & pruned to prevent memory leaks) ---
const progressClients = new Map(); // uploadId -> Set<{ res, cleanup }>
const uploadRegistry = new Map();  // uploadId -> { ownerId, rawFilename, compressedFilename, format, createdAt, active }
const activeJobs = new Map();      // uploadId -> { ownerId, controller, startedAt }
const rateBuckets = new Map();     // key -> { count, resetAt }

// --- Async Manifest Write Queue (prevents concurrent write corruption & orphaned files) ---
let manifestQueue = Promise.resolve();
function withClipsLock(fn) {
  const next = manifestQueue.then(fn, fn);
  manifestQueue = next.catch(() => {});
  return next;
}

async function unlinkQuietly(filePath) {
  if (!filePath) return;
  try {
    await fsp.unlink(filePath);
  } catch (_) {
    // Already removed or absent
  }
}

function unlinkSyncQuietly(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {}
}

function readClipsJsonSync() {
  if (!fs.existsSync(CLIPS_MANIFEST)) return [];
  try {
    const raw = fs.readFileSync(CLIPS_MANIFEST, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeClipsJsonAtomic(clips) {
  const tmpFile = `${CLIPS_MANIFEST}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmpFile, JSON.stringify(clips, null, 2), 'utf8');
  await fsp.rename(tmpFile, CLIPS_MANIFEST);
}

function toPublicClip(clip) {
  return {
    id: clip.id,
    title: clip.title,
    originalName: clip.originalName,
    filename: clip.filename,
    format: clip.format,
    size: clip.size,
    duration: clip.duration,
    createdAt: clip.createdAt,
    streamUrl: clip.streamUrl,
    downloadUrl: clip.downloadUrl,
  };
}

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.mp4':
    case '.m4v': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mov': return 'video/quicktime';
    case '.avi': return 'video/x-msvideo';
    case '.mkv': return 'video/x-matroska';
    case '.flv': return 'video/x-flv';
    case '.ts': return 'video/mp2t';
    case '.wmv': return 'video/x-ms-wmv';
    case '.mpg':
    case '.mpeg': return 'video/mpeg';
    case '.mp3': return 'audio/mpeg';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

// --- Auto-cleanup for tmp files, stale manifest temp files, and bounded in-memory maps ---
function cleanupTmp(maxAgeMs = MAX_TMP_AGE_MS) {
  const now = Date.now();

  // 1. Prune expired tmp files (never delete files belonging to currently active jobs)
  if (fs.existsSync(TMP_DIR)) {
    try {
      const files = fs.readdirSync(TMP_DIR);
      for (const file of files) {
        const filePath = path.join(TMP_DIR, file);
        if (!isPathInside(filePath, TMP_DIR)) continue;
        try {
          const stats = fs.statSync(filePath);
          if (!stats.isFile()) continue;

          // Check if file belongs to an active encoding job
          const prefixId = file.split(/[._]/)[0];
          if (isValidUUID(prefixId) && activeJobs.has(prefixId)) continue;

          const isIntermediate = file.endsWith('.log') || file.endsWith('.mbtree') || file.includes('_trimmed');
          const age = now - stats.mtimeMs;
          if (isIntermediate ? age > 5 * 60 * 1000 : age > maxAgeMs) {
            unlinkSyncQuietly(filePath);
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // 2. Prune stale uploadRegistry entries whose files no longer exist or expired
  for (const [id, entry] of uploadRegistry.entries()) {
    if (entry.active || activeJobs.has(id)) continue;
    const rawExists = entry.rawFilename && fs.existsSync(path.join(TMP_DIR, entry.rawFilename));
    const compExists = entry.compressedFilename && fs.existsSync(path.join(TMP_DIR, entry.compressedFilename));
    if ((!rawExists && !compExists) || (now - entry.createdAt > maxAgeMs)) {
      if (entry.rawFilename) unlinkSyncQuietly(path.join(TMP_DIR, entry.rawFilename));
      if (entry.compressedFilename) unlinkSyncQuietly(path.join(TMP_DIR, entry.compressedFilename));
      uploadRegistry.delete(id);
    }
  }

  // 3. Prune expired rate limiter buckets
  for (const [key, bucket] of rateBuckets.entries()) {
    if (now >= bucket.resetAt) {
      rateBuckets.delete(key);
    }
  }

  // 4. Clean up any orphaned atomic manifest .tmp files in CLIPS_DIR
  if (fs.existsSync(CLIPS_DIR)) {
    try {
      for (const file of fs.readdirSync(CLIPS_DIR)) {
        if (file.startsWith('clips.json.') && file.endsWith('.tmp')) {
          const full = path.join(CLIPS_DIR, file);
          const stat = fs.statSync(full);
          if (now - stat.mtimeMs > 5 * 60 * 1000) {
            unlinkSyncQuietly(full);
          }
        }
      }
    } catch (_) {}
  }
}

cleanupTmp();
const cleanupTimer = setInterval(() => cleanupTmp(), 5 * 60 * 1000);
if (typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

// --- Security & Privacy Headers Middleware ---
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'
  );
  // Strict CSP: zero external CDNs, zero unsafe-eval, zero third-party tracking
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self' blob:; img-src 'self' data: blob:; connect-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'"
  );
  next();
});

// Prevent caching of any private API or temporary media responses
app.use(['/api', '/tmp'], (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// --- Cryptographic Private Session Middleware (Full Per-User Isolation) ---
function isHttpsRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  return req.secure || proto === 'https';
}

function setSessionCookie(req, res, signedToken) {
  const secure = isHttpsRequest(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(signedToken)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${SESSION_MAX_AGE_SEC}`,
  ];
  if (secure) {
    parts.push('Secure', 'SameSite=None', 'Partitioned');
  } else {
    parts.push('SameSite=Lax');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function ensureSession(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const rawToken = cookies[SESSION_COOKIE_NAME] || req.headers['x-session-token'];
  let sessionId = verifySessionToken(rawToken, SESSION_SECRET);

  if (!sessionId) {
    sessionId = crypto.randomUUID();
    const signed = signSessionId(sessionId, SESSION_SECRET);
    setSessionCookie(req, res, signed);
  }

  req.sessionId = sessionId;
  req.ownerId = hashSessionOwner(sessionId, SESSION_SECRET);
  next();
}

// --- CSRF Same-Origin Protection for State-Changing Routes ---
function requireSameOrigin(req, res, next) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
    if (!isSameOriginRequest(req)) {
      return res.status(403).json({ error: 'Cross-origin request blocked.' });
    }
  }
  next();
}

// --- Bounded In-Memory Rate Limiter ---
function createRateLimiter({ windowMs, maxRequests, keyPrefix }) {
  return (req, res, next) => {
    const now = Date.now();
    const actor = req.ownerId || req.ip || 'anon';
    const key = `${keyPrefix}:${actor}`;
    let bucket = rateBuckets.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 1, resetAt: now + windowMs };
      rateBuckets.set(key, bucket);
      return next();
    }
    bucket.count += 1;
    if (bucket.count > maxRequests) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    }
    next();
  };
}

const uploadLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'upload' });
const compressLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 20, keyPrefix: 'compress' });
const mutateLimiter = createRateLimiter({ windowMs: 60 * 1000, maxRequests: 60, keyPrefix: 'mutate' });

// --- Core Middleware ---
app.use(express.json({ limit: '100kb' }));
app.use(express.static(WEB_DIR, { dotfiles: 'ignore', etag: true, maxAge: 0 }));
app.use(['/api', '/tmp'], ensureSession, requireSameOrigin);

// --- Multer Config ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => {
    const id = crypto.randomUUID();
    const rawExt = path.extname(file.originalname || '').toLowerCase();
    const ext = ACCEPTED_EXTS.includes(rawExt) ? rawExt : '.mp4';
    cb(null, `${id}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1, fields: 10 }, // 2 GB max upload, 1 file per request
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const hasValidExt = ACCEPTED_EXTS.includes(ext);
    const hasValidMime =
      typeof file.mimetype === 'string' &&
      (file.mimetype.startsWith('video/') || ACCEPTED_MIMES.includes(file.mimetype));

    if (hasValidExt && hasValidMime) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a valid video file (MP4, MOV, WebM, MKV, etc.).'));
    }
  },
});

// --- SSE Progress Management (Leak-Free) ---
function sendProgress(id, event, data) {
  const clients = progressClients.get(id);
  if (!clients || clients.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of Array.from(clients)) {
    try {
      client.res.write(payload);
    } catch (_) {
      client.cleanup();
    }
  }
}

function closeProgress(id) {
  const clients = progressClients.get(id);
  if (!clients) return;
  for (const client of Array.from(clients)) {
    try {
      client.res.end();
    } catch (_) {}
    client.cleanup();
  }
  progressClients.delete(id);
}

// --- Routes ---

/**
 * POST /api/upload
 * Accepts a video file, verifies real media structure via ffprobe, binds to private user session.
 */
app.post('/api/upload', uploadLimiter, (req, res) => {
  upload.single('video')(req, res, async (err) => {
    if (err) {
      const message = err instanceof multer.MulterError
        ? `Upload error: ${err.message}`
        : sanitizeErrorMessage(err.message, 'Upload failed');
      return res.status(400).json({ error: message });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const id = path.basename(req.file.filename, path.extname(req.file.filename));

    try {
      // Strictly validate actual video stream via ffprobe (blocks spoofed extensions/MIME types)
      const meta = await validateVideoFile(filePath);

      uploadRegistry.set(id, {
        ownerId: req.ownerId,
        rawFilename: req.file.filename,
        compressedFilename: null,
        format: null,
        createdAt: Date.now(),
        active: false,
      });

      res.json({
        id,
        originalName: sanitizeFilename(req.file.originalname, 'video.mp4'),
        size: req.file.size,
        duration: meta.duration,
        width: meta.width,
        height: meta.height,
        hasAudio: meta.hasAudio,
      });
    } catch (probeErr) {
      await unlinkQuietly(filePath);
      return res.status(400).json({
        error: 'Uploaded file is not a valid or supported video stream.',
      });
    }
  });
});

/**
 * POST /api/compress
 * Triggers compression for a session-owned uploaded file.
 * Immediately purges the raw uploaded file once compression completes or fails.
 */
app.post('/api/compress', compressLimiter, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { id } = body;

  if (!id || !isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid or missing file ID' });
  }

  const entry = uploadRegistry.get(id);
  if (!entry || entry.ownerId !== req.ownerId) {
    return res.status(404).json({ error: 'File not found. It may have expired or been cleaned up.' });
  }

  if (activeJobs.has(id)) {
    return res.status(409).json({ error: 'Compression is already in progress for this file.' });
  }

  if (activeJobs.size >= MAX_CONCURRENT_JOBS) {
    return res.status(429).json({ error: 'Server is busy processing other videos. Please try again shortly.' });
  }

  if (!entry.rawFilename) {
    return res.status(404).json({ error: 'Source file has already been purged. Please re-upload.' });
  }

  const inputFile = path.join(TMP_DIR, path.basename(entry.rawFilename));
  if (!isPathInside(inputFile, TMP_DIR) || !fs.existsSync(inputFile)) {
    return res.status(404).json({ error: 'File not found. It may have expired or been cleaned up.' });
  }

  const { targetMB, options } = parseAndValidateCompressOptions(body);
  const outExt = (options.format === 'gif' || options.format === 'mp3') ? options.format : 'mp4';
  const compressedFilename = `${id}_compressed.${outExt}`;
  const outputFile = path.join(TMP_DIR, compressedFilename);

  if (!isPathInside(outputFile, TMP_DIR)) {
    return res.status(400).json({ error: 'Invalid output path' });
  }

  // Remove any previous compressed output for this ID if format changed
  if (entry.compressedFilename && entry.compressedFilename !== compressedFilename) {
    await unlinkQuietly(path.join(TMP_DIR, path.basename(entry.compressedFilename)));
  }

  const controller = new AbortController();
  entry.active = true;
  activeJobs.set(id, { ownerId: req.ownerId, controller, startedAt: Date.now() });

  // Respond immediately — compression runs asynchronously
  res.json({ status: 'started', id });

  try {
    const result = await compress(
      inputFile,
      outputFile,
      targetMB,
      (progress) => {
        sendProgress(id, 'progress', progress);
      },
      { ...options, signal: controller.signal }
    );

    entry.compressedFilename = compressedFilename;
    entry.format = outExt;
    entry.createdAt = Date.now(); // Refresh TTL from compression completion

    sendProgress(id, 'done', {
      originalSize: result.originalSize,
      compressedSize: result.compressedSize,
      duration: result.duration,
      format: outExt,
      outputUrl: `/tmp/${compressedFilename}`,
      downloadUrl: `/api/download/${compressedFilename}`,
    });
  } catch (err) {
    const safeMsg = sanitizeErrorMessage(err.message, 'Compression failed.');
    sendProgress(id, 'error', { message: safeMsg });
  } finally {
    entry.active = false;
    activeJobs.delete(id);

    // Privacy: Immediately purge raw uploaded source file once encoding finishes or fails
    if (entry.rawFilename) {
      const rawPath = path.join(TMP_DIR, path.basename(entry.rawFilename));
      entry.rawFilename = null;
      if (isPathInside(rawPath, TMP_DIR)) {
        await unlinkQuietly(rawPath);
      }
    }

    const closeTimer = setTimeout(() => {
      closeProgress(id);
    }, 500);
    if (typeof closeTimer.unref === 'function') closeTimer.unref();
  }
});

/**
 * DELETE /api/tmp/:id
 * Immediately deletes the current user's temporary upload/compressed files and cancels any active job.
 */
app.delete('/api/tmp/:id', mutateLimiter, async (req, res) => {
  const { id } = req.params;
  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid file ID' });
  }

  const entry = uploadRegistry.get(id);
  if (!entry || entry.ownerId !== req.ownerId) {
    return res.status(404).json({ error: 'File not found' });
  }

  const job = activeJobs.get(id);
  if (job && job.ownerId === req.ownerId) {
    job.controller.abort();
    activeJobs.delete(id);
  }

  if (entry.rawFilename) {
    await unlinkQuietly(path.join(TMP_DIR, path.basename(entry.rawFilename)));
  }
  if (entry.compressedFilename) {
    await unlinkQuietly(path.join(TMP_DIR, path.basename(entry.compressedFilename)));
  }

  uploadRegistry.delete(id);
  closeProgress(id);
  res.json({ success: true });
});

/**
 * Controlled serving of /tmp
 * Only serves session-owned compressed media files (.mp4, .gif, .mp3).
 */
app.use('/tmp', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const safeName = path.basename(req.path);
  if (!COMPRESSED_FILE_REGEX.test(safeName)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const uploadId = safeName.slice(0, 36);
  const entry = uploadRegistry.get(uploadId);
  if (!entry || entry.ownerId !== req.ownerId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(TMP_DIR, safeName);
  if (!isPathInside(filePath, TMP_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found' });
  }

  res.setHeader('Content-Type', getMimeType(filePath));
  res.sendFile(filePath);
});

/**
 * GET /api/download/:filename
 * Securely downloads session-owned compressed files with path confinement.
 */
app.get('/api/download/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);

  if (!COMPRESSED_FILE_REGEX.test(safeFilename)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const uploadId = safeFilename.slice(0, 36);
  const entry = uploadRegistry.get(uploadId);
  if (!entry || entry.ownerId !== req.ownerId) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const outputFile = path.join(TMP_DIR, safeFilename);
  if (!isPathInside(outputFile, TMP_DIR) || !fs.existsSync(outputFile)) {
    return res.status(404).json({ error: 'File not found' });
  }

  const downloadName = `10mb_${sanitizeFilename(safeFilename, 'compressed.mp4')}`;
  res.download(outputFile, downloadName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

/**
 * GET /api/encoders
 * Returns detected hardware acceleration video encoders on this host.
 */
app.get('/api/encoders', async (req, res) => {
  try {
    const encoders = await getHardwareEncoders();
    res.json(encoders);
  } catch {
    res.json({ cpu: true, nvenc: false, qsv: false, amf: false });
  }
});

/**
 * GET /api/progress/:id
 * SSE endpoint for real-time compression progress, strictly bound to the uploading user's session.
 */
app.get('/api/progress/:id', (req, res) => {
  const { id } = req.params;

  if (!id || !isValidUUID(id)) {
    return res.status(400).end('Invalid ID');
  }

  const entry = uploadRegistry.get(id);
  if (!entry || entry.ownerId !== req.ownerId) {
    return res.status(403).end('Access denied');
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store, no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ id })}\n\n`);

  let cleaned = false;
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (_) {
      cleanup();
    }
  }, 15000);
  if (typeof pingInterval.unref === 'function') pingInterval.unref();

  const maxConnectionTimeout = setTimeout(() => {
    try { res.end(); } catch (_) {}
    cleanup();
  }, 15 * 60 * 1000);
  if (typeof maxConnectionTimeout.unref === 'function') maxConnectionTimeout.unref();

  const clientEntry = { res, cleanup };

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(maxConnectionTimeout);
    clearInterval(pingInterval);
    const set = progressClients.get(id);
    if (set) {
      set.delete(clientEntry);
      if (set.size === 0) progressClients.delete(id);
    }
  }

  if (!progressClients.has(id)) {
    progressClients.set(id, new Set());
  }
  progressClients.get(id).add(clientEntry);

  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('finish', cleanup);
});

// ==========================================
// --- Private Stored Clips Routes ---
// ==========================================

/**
 * GET /api/clips
 * Returns ONLY the stored clips belonging to the requesting user's private session.
 */
app.get('/api/clips', (req, res) => {
  const allClips = readClipsJsonSync();
  const userClips = allClips
    .filter(c => c && c.ownerId === req.ownerId)
    .map(toPublicClip);
  res.json(userClips);
});

/**
 * POST /api/clips/save
 * Saves a session-owned compressed video as a private stored clip.
 */
app.post('/api/clips/save', mutateLimiter, async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { id, title, format, originalName, duration } = body;

  if (!id || !isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid or missing file ID to save' });
  }

  const entry = uploadRegistry.get(id);
  if (!entry || entry.ownerId !== req.ownerId) {
    return res.status(404).json({ error: 'Source file not found' });
  }

  const ext = (['mp4', 'gif', 'mp3'].includes(String(format)) ? String(format) : 'mp4').toLowerCase();
  let sourceFile = null;

  if (entry.compressedFilename) {
    const candidate = path.join(TMP_DIR, path.basename(entry.compressedFilename));
    if (isPathInside(candidate, TMP_DIR) && fs.existsSync(candidate)) {
      sourceFile = candidate;
    }
  }

  if (!sourceFile) {
    const compCandidate = path.join(TMP_DIR, `${id}_compressed.${ext}`);
    if (isPathInside(compCandidate, TMP_DIR) && fs.existsSync(compCandidate)) {
      sourceFile = compCandidate;
    } else if (entry.rawFilename) {
      const rawCandidate = path.join(TMP_DIR, path.basename(entry.rawFilename));
      if (isPathInside(rawCandidate, TMP_DIR) && fs.existsSync(rawCandidate)) {
        sourceFile = rawCandidate;
      }
    }
  }

  if (!sourceFile) {
    return res.status(404).json({ error: 'Source file not found' });
  }

  const clipId = crypto.randomUUID();
  const actualExt = path.extname(sourceFile).toLowerCase() || `.${ext}`;
  const clipFileName = `${clipId}${actualExt}`;
  const destFile = path.join(CLIPS_DIR, clipFileName);

  if (!isPathInside(destFile, CLIPS_DIR)) {
    return res.status(400).json({ error: 'Invalid destination path' });
  }

  try {
    await fsp.copyFile(sourceFile, destFile);
    const stat = await fsp.stat(destFile);

    let clipDuration = (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) ? duration : 0;
    if (clipDuration <= 0) {
      try {
        const meta = await probeVideo(destFile);
        clipDuration = meta.duration || 0;
      } catch (_) {}
    }

    const safeTitle = sanitizeFilename(title || originalName || `Clip ${clipId.slice(0, 6)}`, `Clip ${clipId.slice(0, 6)}`);
    const safeOrigName = sanitizeFilename(originalName || title || `video${actualExt}`, `video${actualExt}`);

    const clipObj = {
      id: clipId,
      ownerId: req.ownerId,
      title: safeTitle,
      originalName: safeOrigName,
      filename: clipFileName,
      format: actualExt.replace('.', ''),
      size: stat.size,
      duration: clipDuration,
      createdAt: new Date().toISOString(),
      streamUrl: `/api/clips/stream/${clipFileName}`,
      downloadUrl: `/api/clips/download/${clipFileName}`,
    };

    await withClipsLock(async () => {
      const clips = readClipsJsonSync();
      clips.unshift(clipObj);
      await writeClipsJsonAtomic(clips);
    });

    // Remove raw upload immediately if it was still present
    if (entry.rawFilename) {
      const rawPath = path.join(TMP_DIR, path.basename(entry.rawFilename));
      entry.rawFilename = null;
      if (isPathInside(rawPath, TMP_DIR)) {
        await unlinkQuietly(rawPath);
      }
    }

    res.json({ success: true, clip: toPublicClip(clipObj) });
  } catch (err) {
    await unlinkQuietly(destFile);
    res.status(500).json({ error: 'Failed to save clip to storage' });
  }
});

/**
 * POST /api/clips/upload
 * Directly uploads a verified video into the user's private stored clips library.
 */
app.post('/api/clips/upload', uploadLimiter, (req, res) => {
  upload.single('video')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: sanitizeErrorMessage(err.message, 'Upload failed') });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No video file provided' });
    }

    const tempPath = req.file.path;
    const clipId = crypto.randomUUID();
    const rawExt = path.extname(req.file.originalname || '').toLowerCase();
    const ext = ACCEPTED_EXTS.includes(rawExt) ? rawExt : '.mp4';
    const clipFileName = `${clipId}${ext}`;
    const destFile = path.join(CLIPS_DIR, clipFileName);

    if (!isPathInside(destFile, CLIPS_DIR)) {
      await unlinkQuietly(tempPath);
      return res.status(400).json({ error: 'Invalid file destination' });
    }

    try {
      // Verify the file is actually a valid video before accepting into storage
      const meta = await validateVideoFile(tempPath);

      await fsp.copyFile(tempPath, destFile);
      await unlinkQuietly(tempPath);
      const stat = await fsp.stat(destFile);

      const safeTitle = sanitizeFilename(req.file.originalname, `Clip ${clipId.slice(0, 6)}`);

      const clipObj = {
        id: clipId,
        ownerId: req.ownerId,
        title: safeTitle,
        originalName: safeTitle,
        filename: clipFileName,
        format: ext.replace('.', ''),
        size: stat.size,
        duration: meta.duration || 0,
        createdAt: new Date().toISOString(),
        streamUrl: `/api/clips/stream/${clipFileName}`,
        downloadUrl: `/api/clips/download/${clipFileName}`,
      };

      await withClipsLock(async () => {
        const clips = readClipsJsonSync();
        clips.unshift(clipObj);
        await writeClipsJsonAtomic(clips);
      });

      res.json({ success: true, clip: toPublicClip(clipObj) });
    } catch (e) {
      await unlinkQuietly(tempPath);
      await unlinkQuietly(destFile);
      return res.status(400).json({ error: 'Uploaded file is not a valid or supported video.' });
    }
  });
});

/**
 * GET /api/clips/stream/:filename
 * Private HTTP 206 Partial Content range-streaming with strict ownership & path confinement.
 */
app.get('/api/clips/stream/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);

  if (safeFilename === 'clips.json' || safeFilename === '.gitkeep' || !CLIP_FILE_REGEX.test(safeFilename)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(CLIPS_DIR, safeFilename);
  if (!isPathInside(filePath, CLIPS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Clip file not found' });
  }

  const clips = readClipsJsonSync();
  const clip = clips.find(c => c && c.filename === safeFilename && c.ownerId === req.ownerId);
  if (!clip) {
    return res.status(404).json({ error: 'Clip not found in library' });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const mime = getMimeType(filePath);

  if (fileSize === 0) {
    res.writeHead(200, { 'Content-Length': 0, 'Content-Type': mime });
    return res.end();
  }

  const range = req.headers.range;
  let stream;

  if (range) {
    const parsed = parseRangeHeader(range, fileSize);
    if (!parsed) {
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
    }

    const { start, end } = parsed;
    const chunksize = (end - start) + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': mime,
    });
    stream = fs.createReadStream(filePath, { start, end });
  } else {
    res.writeHead(200, {
      'Accept-Ranges': 'bytes',
      'Content-Length': fileSize,
      'Content-Type': mime,
    });
    stream = fs.createReadStream(filePath);
  }

  const destroyStream = () => {
    if (!stream.destroyed) stream.destroy();
  };

  stream.on('error', () => {
    destroyStream();
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  req.on('close', destroyStream);
  res.on('close', destroyStream);
  stream.pipe(res);
});

/**
 * GET /api/clips/download/:filename
 * Secure private download of a session-owned clip file.
 */
app.get('/api/clips/download/:filename', (req, res) => {
  const safeFilename = path.basename(req.params.filename);

  if (safeFilename === 'clips.json' || safeFilename === '.gitkeep' || !CLIP_FILE_REGEX.test(safeFilename)) {
    return res.status(403).json({ error: 'Access denied' });
  }

  const filePath = path.join(CLIPS_DIR, safeFilename);
  if (!isPathInside(filePath, CLIPS_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Clip file not found' });
  }

  const clips = readClipsJsonSync();
  const clip = clips.find(c => c && c.filename === safeFilename && c.ownerId === req.ownerId);
  if (!clip) {
    return res.status(404).json({ error: 'Clip not found in library' });
  }

  const safeDownloadName = sanitizeFilename(clip.originalName || safeFilename, safeFilename);
  res.download(filePath, safeDownloadName, (err) => {
    if (err && !res.headersSent) {
      res.status(500).json({ error: 'Download failed' });
    }
  });
});

/**
 * DELETE /api/clips/:id
 * Deletes a session-owned stored clip with strict ownership & path confinement.
 */
app.delete('/api/clips/:id', mutateLimiter, async (req, res) => {
  const { id } = req.params;

  if (!isValidUUID(id)) {
    return res.status(400).json({ error: 'Invalid clip ID' });
  }

  let removedClip = null;
  await withClipsLock(async () => {
    const clips = readClipsJsonSync();
    const idx = clips.findIndex(c => c && c.id === id && c.ownerId === req.ownerId);
    if (idx === -1) return;
    removedClip = clips[idx];
    clips.splice(idx, 1);
    await writeClipsJsonAtomic(clips);
  });

  if (!removedClip) {
    return res.status(404).json({ error: 'Clip not found' });
  }

  const safeFilename = path.basename(removedClip.filename || '');
  if (CLIP_FILE_REGEX.test(safeFilename)) {
    const filePath = path.join(CLIPS_DIR, safeFilename);
    if (isPathInside(filePath, CLIPS_DIR)) {
      await unlinkQuietly(filePath);
    }
  }

  res.json({ success: true });
});

/**
 * POST /api/privacy/purge
 * Full user privacy wipe: immediately deletes all of the user's temp files, active jobs,
 * and stored clips, and rotates the user's session token.
 */
app.post('/api/privacy/purge', mutateLimiter, async (req, res) => {
  const ownerId = req.ownerId;
  let removedTemp = 0;
  let removedClips = 0;

  // 1. Cancel active jobs & delete user's tmp files
  for (const [id, entry] of Array.from(uploadRegistry.entries())) {
    if (entry.ownerId !== ownerId) continue;
    const job = activeJobs.get(id);
    if (job) {
      job.controller.abort();
      activeJobs.delete(id);
    }
    if (entry.rawFilename) {
      await unlinkQuietly(path.join(TMP_DIR, path.basename(entry.rawFilename)));
      removedTemp += 1;
    }
    if (entry.compressedFilename) {
      await unlinkQuietly(path.join(TMP_DIR, path.basename(entry.compressedFilename)));
      removedTemp += 1;
    }
    uploadRegistry.delete(id);
    closeProgress(id);
  }

  // 2. Delete all stored clips owned by this user
  const filesToDelete = [];
  await withClipsLock(async () => {
    const clips = readClipsJsonSync();
    const kept = [];
    for (const clip of clips) {
      if (clip && clip.ownerId === ownerId) {
        removedClips += 1;
        const safeFilename = path.basename(clip.filename || '');
        if (CLIP_FILE_REGEX.test(safeFilename)) {
          const filePath = path.join(CLIPS_DIR, safeFilename);
          if (isPathInside(filePath, CLIPS_DIR)) filesToDelete.push(filePath);
        }
      } else {
        kept.push(clip);
      }
    }
    if (removedClips > 0) {
      await writeClipsJsonAtomic(kept);
    }
  });

  for (const filePath of filesToDelete) {
    await unlinkQuietly(filePath);
  }

  // 3. Rotate session cookie to a fresh private ID
  const newSessionId = crypto.randomUUID();
  setSessionCookie(req, res, signSessionId(newSessionId, SESSION_SECRET));

  res.json({
    success: true,
    removedTemp,
    removedClips,
    message: 'All your temporary files and stored clips have been permanently deleted.',
  });
});

/**
 * POST /api/cleanup
 * Cleans up the requesting user's inactive temp files and any globally expired (>TTL) temp files.
 */
app.post('/api/cleanup', mutateLimiter, async (req, res) => {
  for (const [id, entry] of Array.from(uploadRegistry.entries())) {
    if (entry.ownerId !== req.ownerId || entry.active || activeJobs.has(id)) continue;
    if (entry.rawFilename) {
      await unlinkQuietly(path.join(TMP_DIR, path.basename(entry.rawFilename)));
      entry.rawFilename = null;
    }
  }
  cleanupTmp(MAX_TMP_AGE_MS);
  res.json({ success: true, message: 'Stale temporary files cleaned successfully' });
});

// --- Central Error Handler (Zero Internal Detail Disclosure) ---
app.use((err, req, res, next) => {
  console.error('[Server Error]', sanitizeErrorMessage(err && err.message, 'Unhandled error'));
  if (!res.headersSent) {
    const status = (err && err.status >= 400 && err.status < 500) ? err.status : 500;
    const message = status < 500
      ? sanitizeErrorMessage(err.message, 'Invalid request')
      : 'Internal server error';
    res.status(status).json({ error: message });
  }
});

// --- Graceful Shutdown (Prevents Orphaned FFmpeg Processes & Lingering Temp Files) ---
let shuttingDown = false;
function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(cleanupTimer);
  killActiveJobs();
  for (const id of Array.from(progressClients.keys())) {
    closeProgress(id);
  }
  cleanupTmp(0);
  server.close(() => {
    process.exit(0);
  });
  const forceTimer = setTimeout(() => process.exit(0), 3000);
  if (typeof forceTimer.unref === 'function') forceTimer.unref();
}

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// --- Start ---
const server = app.listen(PORT, () => {
  console.log(`\n  10mb.video — Private Video Compression`);
  console.log(`  \u2192 http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Please terminate the process using it or set PORT=<port>.`);
  } else {
    console.error('Server startup error:', err.message);
  }
});

module.exports = {
  app,
  server,
  _internals: {
    progressClients,
    uploadRegistry,
    activeJobs,
    rateBuckets,
    TMP_DIR,
    CLIPS_DIR,
    cleanupTmp,
  },
};
