const path = require('path');
const crypto = require('crypto');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPRESSED_FILE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}_compressed\.(mp4|gif|mp3)$/i;
const CLIP_FILE_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp4|mov|avi|mkv|webm|flv|ts|wmv|m4v|mpg|mpeg|gif|mp3)$/i;

const ACCEPTED_MIMES = [
  'video/mp4',
  'video/quicktime',
  'video/x-msvideo',
  'video/x-matroska',
  'video/webm',
  'video/x-flv',
  'video/mp2t',
  'video/mpeg',
  'video/x-m4v',
  'video/x-ms-wmv',
];

const ACCEPTED_EXTS = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.flv', '.ts', '.wmv', '.m4v', '.mpg', '.mpeg'];
const ALLOWED_AUDIO_BITRATES = [0, 64, 96, 128, 192, 256, 320];
const ALLOWED_RESOLUTIONS = ['auto', 'original', '1080', '720', '480', '360'];
const ALLOWED_FPS = ['auto', 'original', '60', '30', '24'];
const ALLOWED_FORMATS = ['mp4', 'gif', 'mp3'];
const ALLOWED_ASPECT_RATIOS = ['original', '16:9', '9:16', '1:1'];
const ALLOWED_ENCODERS = ['auto', 'cpu', 'libx264', 'nvenc', 'qsv', 'amf'];

const MIN_TARGET_MB = 10;
const MAX_TARGET_MB = 2000;

function isValidUUID(str) {
  return typeof str === 'string' && UUID_REGEX.test(str);
}

/**
 * Strictly verifies that candidatePath resolves inside baseDir (with trailing path.sep).
 */
function isPathInside(candidatePath, baseDir) {
  if (typeof candidatePath !== 'string' || typeof baseDir !== 'string') return false;
  const resolvedBase = path.resolve(baseDir);
  const resolvedCandidate = path.resolve(candidatePath);
  const baseWithSep = resolvedBase.endsWith(path.sep) ? resolvedBase : resolvedBase + path.sep;
  return resolvedCandidate.startsWith(baseWithSep);
}

/**
 * Strips path separators, control characters, quotes, and overly long strings from filenames.
 */
function sanitizeFilename(name, fallback = 'video.mp4') {
  if (typeof name !== 'string' || !name.trim()) return fallback;
  const base = path.basename(name.replace(/\\/g, '/'));
  const cleaned = base
    .replace(/[\x00-\x1f\x7f"<>|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

/**
 * Removes internal server filesystem paths and stack traces from error messages before returning to clients.
 */
function sanitizeErrorMessage(message, fallback = 'An error occurred while processing the video.') {
  if (!message || typeof message !== 'string') return fallback;
  const firstLine = message.split(/\r?\n/)[0].trim();
  const scrubbed = firstLine
    .replace(/[A-Za-z]:\\[^\s:'"]+/g, '[file]')
    .replace(/(?:^|[\s:'"])(\/(?:app|tmp|var|home|root|usr|etc|opt|srv|storage|Users)[^\s:'"]*)/g, ' [file]')
    .replace(/\s+/g, ' ')
    .trim();
  return scrubbed ? scrubbed.slice(0, 240) : fallback;
}

/**
 * Validates and clamps user-supplied compression options.
 */
function parseAndValidateCompressOptions(body = {}) {
  const input = (body && typeof body === 'object') ? body : {};
  const parsedTarget = Number.parseInt(input.targetMB, 10);
  const targetMB = Number.isFinite(parsedTarget)
    ? Math.max(MIN_TARGET_MB, Math.min(MAX_TARGET_MB, parsedTarget))
    : MIN_TARGET_MB;

  const options = {};

  if (typeof input.trimStart === 'number' && Number.isFinite(input.trimStart) && input.trimStart >= 0) {
    options.trimStart = input.trimStart;
  }
  if (typeof input.trimEnd === 'number' && Number.isFinite(input.trimEnd) && input.trimEnd > 0) {
    options.trimEnd = input.trimEnd;
  }
  if (
    options.trimStart !== undefined &&
    options.trimEnd !== undefined &&
    options.trimEnd <= options.trimStart
  ) {
    delete options.trimStart;
    delete options.trimEnd;
  }

  if (typeof input.volume === 'number' && Number.isFinite(input.volume)) {
    options.volume = Math.max(0, Math.min(2, input.volume));
  }

  const resStr = String(input.resolution || '').toLowerCase();
  if (ALLOWED_RESOLUTIONS.includes(resStr)) {
    options.resolution = resStr;
  }

  const fpsStr = String(input.fps || '').toLowerCase();
  if (ALLOWED_FPS.includes(fpsStr)) {
    options.fps = fpsStr;
  }

  if (input.audioBitrate === 'mute') {
    options.audioBitrate = 0;
    options.muteAudio = true;
  } else if (typeof input.audioBitrate === 'number' && Number.isFinite(input.audioBitrate)) {
    const rounded = Math.round(input.audioBitrate);
    if (ALLOWED_AUDIO_BITRATES.includes(rounded)) {
      options.audioBitrate = rounded;
    }
  }

  if (typeof input.muteAudio === 'boolean') {
    options.muteAudio = input.muteAudio;
  }

  const fmtStr = String(input.format || 'mp4').toLowerCase();
  options.format = ALLOWED_FORMATS.includes(fmtStr) ? fmtStr : 'mp4';

  if (typeof input.speed === 'number' && Number.isFinite(input.speed) && input.speed > 0) {
    options.speed = Math.max(0.5, Math.min(2.0, input.speed));
  }

  const arStr = String(input.aspectRatio || '').toLowerCase();
  if (ALLOWED_ASPECT_RATIOS.includes(arStr)) {
    options.aspectRatio = arStr;
  }

  const encStr = String(input.encoder || '').toLowerCase();
  if (ALLOWED_ENCODERS.includes(encStr)) {
    options.encoder = encStr;
  }

  return { targetMB, options };
}

/**
 * Pure bitrate, smart resolution downscaling (lowest-threshold-first), and FPS calculation.
 */
function calculateBitrateAndScaling({
  duration,
  targetMB = 10,
  audioBitrate = 128,
  muteAudio = false,
  hasAudio = true,
  origHeight = 0,
  reqRes = 'auto',
  reqFps = 'auto',
}) {
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('Could not determine video duration.');
  }

  const clampedTargetMB = Math.max(MIN_TARGET_MB, Math.min(MAX_TARGET_MB, Math.floor(targetMB) || MIN_TARGET_MB));
  const effectiveMute = muteAudio === true || audioBitrate === 0 || !hasAudio;
  const effectiveAudioKbps = effectiveMute
    ? 0
    : (ALLOWED_AUDIO_BITRATES.includes(audioBitrate) && audioBitrate > 0 ? audioBitrate : 128);

  const safetyFactor = 0.95;
  const targetBytes = Math.floor(clampedTargetMB * 1024 * 1024 * safetyFactor);
  const audioBitsTotal = effectiveAudioKbps * 1000 * duration;
  const videoBitsTotal = (targetBytes * 8) - audioBitsTotal;

  if (videoBitsTotal <= 0) {
    throw new Error(
      `Target size (${clampedTargetMB}MB) is too small for this video's duration (${Math.round(duration)}s). ` +
      `Audio alone would require ~${Math.round(audioBitsTotal / 8 / 1024 / 1024)}MB. Try muting audio or trimming the clip.`
    );
  }

  const videoBitrate = Math.max(64, Math.floor(videoBitsTotal / duration / 1000));

  // Smart downscaling: check LOWEST bitrate thresholds FIRST so low-bitrate 4K/1080p scales down properly
  let targetHeight = 0;
  const normalizedRes = String(reqRes || 'auto').toLowerCase();
  if (normalizedRes === 'auto') {
    if (origHeight > 360 && videoBitrate < 350) {
      targetHeight = 360;
    } else if (origHeight > 480 && videoBitrate < 750) {
      targetHeight = 480;
    } else if (origHeight > 720 && videoBitrate < 1800) {
      targetHeight = 720;
    } else if (origHeight > 1080 && videoBitrate < 3500) {
      targetHeight = 1080;
    }
  } else if (['1080', '720', '480', '360'].includes(normalizedRes)) {
    const specifiedH = parseInt(normalizedRes, 10);
    if (origHeight > specifiedH || origHeight === 0) {
      targetHeight = specifiedH;
    }
  }

  if (targetHeight > 0) {
    targetHeight = targetHeight - (targetHeight % 2);
  }

  let targetFps = 0;
  const normalizedFps = String(reqFps || 'auto').toLowerCase();
  if (normalizedFps === '60' || normalizedFps === '30' || normalizedFps === '24') {
    targetFps = parseInt(normalizedFps, 10);
  } else if (normalizedFps === 'auto' && videoBitrate < 1000) {
    targetFps = 30;
  }

  return {
    muteAudio: effectiveMute,
    audioBitrate: effectiveAudioKbps,
    videoBitrate,
    targetHeight,
    targetFps,
  };
}

/**
 * Strict RFC 7233 single-range header parser. Returns { start, end } or null if unsatisfiable.
 */
function parseRangeHeader(rangeHeader, fileSize) {
  if (typeof rangeHeader !== 'string' || !Number.isInteger(fileSize) || fileSize <= 0) {
    return null;
  }
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;

  let start = match[1] ? Number.parseInt(match[1], 10) : NaN;
  let end = match[2] ? Number.parseInt(match[2], 10) : NaN;

  if (Number.isNaN(start) && Number.isNaN(end)) return null;

  if (Number.isNaN(start)) {
    if (end <= 0) return null;
    start = Math.max(0, fileSize - end);
    end = fileSize - 1;
  } else if (Number.isNaN(end) || end >= fileSize) {
    end = fileSize - 1;
  }

  if (start < 0 || start >= fileSize || start > end) return null;
  return { start, end };
}

/**
 * Signs a session ID using HMAC-SHA256.
 */
function signSessionId(sessionId, secret) {
  const sig = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  return `${sessionId}.${sig}`;
}

/**
 * Verifies a signed session token using constant-time comparison. Returns sessionId or null.
 */
function verifySessionToken(token, secret) {
  if (typeof token !== 'string' || !secret) return null;
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  const sessionId = token.slice(0, dotIdx);
  const providedSig = token.slice(dotIdx + 1);
  if (!isValidUUID(sessionId) || !providedSig) return null;

  const expectedSig = crypto.createHmac('sha256', secret).update(sessionId).digest('base64url');
  const a = Buffer.from(providedSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? sessionId : null;
}

/**
 * Derives a non-reversible owner hash from the session ID so raw session IDs are never stored on disk.
 */
function hashSessionOwner(sessionId, secret) {
  return crypto.createHmac('sha256', secret).update(`owner:${sessionId}`).digest('hex');
}

/**
 * Safely parses an HTTP Cookie header without prototype pollution.
 */
function parseCookies(cookieHeader) {
  const result = Object.create(null);
  if (typeof cookieHeader !== 'string' || !cookieHeader) return result;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    if (!key || key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const rawVal = part.slice(eqIdx + 1).trim();
    try {
      result[key] = decodeURIComponent(rawVal);
    } catch {
      result[key] = rawVal;
    }
  }
  return result;
}

/**
 * Checks whether a state-changing request originates from the same host (CSRF protection).
 */
function isSameOriginRequest(req) {
  const headers = req && req.headers ? req.headers : {};
  const origin = headers.origin;
  const referer = headers.referer;
  const rawHost = headers['x-forwarded-host'] || headers.host;
  const expectedHost = rawHost ? String(rawHost).split(',')[0].trim().toLowerCase() : '';

  if (origin) {
    if (origin === 'null') return false;
    try {
      const originHost = new URL(origin).host.toLowerCase();
      return Boolean(expectedHost) && originHost === expectedHost;
    } catch {
      return false;
    }
  }

  if (referer) {
    try {
      const refererHost = new URL(referer).host.toLowerCase();
      return Boolean(expectedHost) && refererHost === expectedHost;
    } catch {
      return false;
    }
  }

  // Non-browser API clients (curl, CLI, automated tests) without Origin/Referer
  return true;
}

module.exports = {
  UUID_REGEX,
  COMPRESSED_FILE_REGEX,
  CLIP_FILE_REGEX,
  ACCEPTED_MIMES,
  ACCEPTED_EXTS,
  ALLOWED_AUDIO_BITRATES,
  ALLOWED_RESOLUTIONS,
  ALLOWED_FPS,
  ALLOWED_FORMATS,
  ALLOWED_ASPECT_RATIOS,
  ALLOWED_ENCODERS,
  MIN_TARGET_MB,
  MAX_TARGET_MB,
  isValidUUID,
  isPathInside,
  sanitizeFilename,
  sanitizeErrorMessage,
  parseAndValidateCompressOptions,
  calculateBitrateAndScaling,
  parseRangeHeader,
  signSessionId,
  verifySessionToken,
  hashSessionOwner,
  parseCookies,
  isSameOriginRequest,
};
