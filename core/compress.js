const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const fs = require('fs');
const crypto = require('crypto');
const { calculateBitrateAndScaling } = require('./utils');

// Point fluent-ffmpeg to the installed binary
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per FFmpeg job
const activeFfmpegCommands = new Set();

/**
 * Terminates all currently running FFmpeg child processes (used on graceful shutdown).
 */
function killActiveJobs() {
  for (const cmd of activeFfmpegCommands) {
    try {
      cmd.kill('SIGKILL');
    } catch (_) {
      // Ignore already-exited processes
    }
  }
  activeFfmpegCommands.clear();
}

let cachedEncoders = null;
/**
 * Detect available hardware acceleration video encoders on this host.
 * @returns {Promise<{cpu: boolean, nvenc: boolean, qsv: boolean, amf: boolean}>}
 */
function getHardwareEncoders() {
  if (cachedEncoders) return Promise.resolve(cachedEncoders);
  return new Promise((resolve) => {
    ffmpeg.getAvailableEncoders((err, encoders) => {
      if (err || !encoders) {
        cachedEncoders = { cpu: true, nvenc: false, qsv: false, amf: false };
        return resolve(cachedEncoders);
      }
      cachedEncoders = {
        cpu: true,
        nvenc: !!(encoders.h264_nvenc || encoders.nvenc_h264),
        qsv: !!encoders.h264_qsv,
        amf: !!encoders.h264_amf,
      };
      resolve(cachedEncoders);
    });
  });
}

/**
 * Runs a fluent-ffmpeg command with leak-free tracking, hard timeout, and AbortSignal support.
 */
function runFfmpegCommand(cmd, { timeoutMs = DEFAULT_JOB_TIMEOUT_MS, signal } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      activeFfmpegCommands.delete(cmd);
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onAbort = () => {
      try { cmd.kill('SIGKILL'); } catch (_) {}
      fail(new Error('Compression cancelled.'));
    };

    if (signal && signal.aborted) {
      return fail(new Error('Compression cancelled.'));
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { cmd.kill('SIGKILL'); } catch (_) {}
        fail(new Error('Compression timed out. Please try a shorter clip or lower resolution.'));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    }

    activeFfmpegCommands.add(cmd);

    cmd
      .on('error', (err) => fail(err))
      .on('end', succeed);

    try {
      cmd.run();
    } catch (err) {
      fail(err);
    }
  });
}

/**
 * Probe a video file to get duration and other metadata with multi-stream fallbacks.
 * @param {string} inputPath - Absolute path to the video file
 * @returns {Promise<{duration: number, size: number, videoCodec: string, audioCodec: string, hasVideo: boolean, hasAudio: boolean, width: number, height: number}>}
 */
function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);
      if (!metadata || typeof metadata !== 'object') {
        return reject(new Error('Invalid media metadata.'));
      }

      const format = metadata.format || {};
      const streams = Array.isArray(metadata.streams) ? metadata.streams : [];
      const videoStream = streams.find(s => s.codec_type === 'video');
      const audioStream = streams.find(s => s.codec_type === 'audio');

      // Comprehensive duration resolution: format -> video stream -> audio stream -> tag duration
      let duration = parseFloat(format.duration) || 0;
      if ((!duration || duration <= 0) && videoStream && videoStream.duration) {
        duration = parseFloat(videoStream.duration) || 0;
      }
      if ((!duration || duration <= 0) && audioStream && audioStream.duration) {
        duration = parseFloat(audioStream.duration) || 0;
      }
      if ((!duration || duration <= 0) && format.tags && format.tags.DURATION) {
        const parts = String(format.tags.DURATION).split(':');
        if (parts.length === 3) {
          duration = (parseFloat(parts[0]) || 0) * 3600 + (parseFloat(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
        }
      }
      if ((!duration || duration <= 0) && videoStream && videoStream.tags && videoStream.tags.DURATION) {
        const parts = String(videoStream.tags.DURATION).split(':');
        if (parts.length === 3) {
          duration = (parseFloat(parts[0]) || 0) * 3600 + (parseFloat(parts[1]) || 0) * 60 + (parseFloat(parts[2]) || 0);
        }
      }

      const width = videoStream ? (parseInt(videoStream.width, 10) || 0) : 0;
      const height = videoStream ? (parseInt(videoStream.height, 10) || 0) : 0;

      resolve({
        duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
        size: parseInt(format.size, 10) || 0,
        videoCodec: videoStream ? (videoStream.codec_name || 'unknown') : 'unknown',
        audioCodec: audioStream ? (audioStream.codec_name || 'none') : 'none',
        hasVideo: Boolean(videoStream && width > 0 && height > 0),
        hasAudio: Boolean(audioStream),
        width,
        height,
      });
    });
  });
}

/**
 * Verifies that an uploaded file is genuinely a valid video file via ffprobe inspection.
 */
async function validateVideoFile(filePath) {
  const meta = await probeVideo(filePath);
  if (!meta.hasVideo || meta.videoCodec === 'unknown') {
    throw new Error('Uploaded file does not contain a valid video stream.');
  }
  return meta;
}

function removeFileQuietly(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_) {
    // Best-effort cleanup
  }
}

/**
 * Compress a video to a target file size using constrained single-pass VBV encoding.
 * Strips all container metadata (GPS, EXIF, device tags, chapters) for full user privacy.
 *
 * @param {string} inputPath   - Path to the source video
 * @param {string} outputPath  - Path for the compressed output
 * @param {number} targetMB    - Target size in megabytes (minimum 10)
 * @param {function} onProgress - Callback receiving { percent: 0-100, stage: string }
 * @param {object} [options]   - Optional settings
 * @returns {Promise<{originalSize: number, compressedSize: number, duration: number}>}
 */
async function compress(inputPath, outputPath, targetMB = 10, onProgress = () => {}, options = {}) {
  targetMB = Math.max(10, Math.min(2000, parseInt(targetMB, 10) || 10));
  const timeoutMs = (typeof options.timeoutMs === 'number' && options.timeoutMs > 0)
    ? options.timeoutMs
    : DEFAULT_JOB_TIMEOUT_MS;
  const signal = options.signal;

  const meta = await probeVideo(inputPath);
  const fullDuration = meta.duration;

  if (!fullDuration || fullDuration <= 0) {
    throw new Error('Could not determine video duration. The file may be corrupt or an unsupported stream format.');
  }

  // --- Trim bounds ---
  const trimStart = (typeof options.trimStart === 'number' && Number.isFinite(options.trimStart) && options.trimStart > 0)
    ? Math.min(options.trimStart, fullDuration)
    : 0;
  const trimEnd = (typeof options.trimEnd === 'number' && Number.isFinite(options.trimEnd) && options.trimEnd > 0)
    ? Math.min(options.trimEnd, fullDuration)
    : fullDuration;
  const isTrimming = trimStart > 0 || trimEnd < fullDuration;

  if ((trimEnd - trimStart) <= 0.05) {
    throw new Error('Invalid trim range. Trim duration must be at least 0.1 seconds.');
  }

  // --- Volume ---
  const volume = (typeof options.volume === 'number' && Number.isFinite(options.volume))
    ? Math.max(0, Math.min(2, options.volume))
    : 1;

  // --- Pre-trim step with guaranteed cleanup in try/finally ---
  let encodePath = inputPath;
  let duration = fullDuration;
  const randomSuffix = crypto.randomBytes(6).toString('hex');
  const trimmedPath = outputPath.replace(/\.[^.]+$/, '') + `_trimmed_${randomSuffix}.mkv`;
  let needsTrimCleanup = false;
  let completedSuccessfully = false;

  try {
    if (isTrimming) {
      onProgress({ percent: 0, stage: 'trimming' });

      const trimCmd = ffmpeg(inputPath)
        .inputOptions(['-ss', String(trimStart)])
        .outputOptions([
          '-t', String(trimEnd - trimStart),
          '-map_metadata', '-1',
          '-map_chapters', '-1',
        ])
        .videoCodec('copy')
        .audioCodec('copy')
        .output(trimmedPath);

      needsTrimCleanup = true;
      await runFfmpegCommand(trimCmd, { timeoutMs, signal }).catch((err) => {
        throw new Error(`Trim failed: ${err.message}`);
      });

      // Re-probe trimmed file for actual keyframe-aligned duration
      const trimMeta = await probeVideo(trimmedPath);
      duration = trimMeta.duration || (trimEnd - trimStart);
      encodePath = trimmedPath;

      if (!duration || duration <= 0) {
        throw new Error('Trimmed video has no valid duration.');
      }
    }

    // --- Speed factor (clamped between 0.5x and 2.0x for filter safety) ---
    let speed = 1.0;
    if (typeof options.speed === 'number' && Number.isFinite(options.speed) && options.speed > 0) {
      speed = Math.max(0.5, Math.min(2.0, options.speed));
    }
    duration = duration / speed;

    // --- Format Check (MP3, GIF, MP4) ---
    const format = String(options.format || 'mp4').toLowerCase();

    // --- MP3 Audio Extraction ---
    if (format === 'mp3') {
      if (!meta.hasAudio) {
        throw new Error('Cannot extract MP3 audio: the source video contains no audio stream.');
      }
      onProgress({ percent: 10, stage: 'compressing' });
      const requestedMp3Bitrate = parseInt(options.audioBitrate, 10);
      const mp3Bitrate = [64, 96, 128, 192, 256, 320].includes(requestedMp3Bitrate) ? requestedMp3Bitrate : 192;

      const cmd = ffmpeg(encodePath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate(mp3Bitrate)
        .outputOptions(['-map_metadata', '-1', '-map_chapters', '-1']);

      // Combine audio filters into a single -af chain so both volume & speed apply reliably
      const mp3AudioFilters = [];
      if (volume !== 1) mp3AudioFilters.push(`volume=${volume.toFixed(2)}`);
      if (speed !== 1.0) mp3AudioFilters.push(`atempo=${speed.toFixed(2)}`);
      if (mp3AudioFilters.length > 0) {
        cmd.audioFilter(mp3AudioFilters.join(','));
      }

      cmd
        .output(outputPath)
        .on('progress', (p) => {
          onProgress({ percent: Math.min(10 + Math.round((p.percent || 0) * 0.85), 95), stage: 'compressing' });
        });

      await runFfmpegCommand(cmd, { timeoutMs, signal }).catch((err) => {
        throw new Error(`MP3 extraction failed: ${err.message}`);
      });

      onProgress({ percent: 100, stage: 'done' });
      const compressedStats = fs.statSync(outputPath);
      completedSuccessfully = true;
      return { originalSize: parseInt(meta.size, 10), compressedSize: compressedStats.size, duration };
    }

    // --- GIF Export ---
    if (format === 'gif') {
      onProgress({ percent: 10, stage: 'compressing' });
      const vfFilters = [];
      if (speed !== 1.0) vfFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);

      const aspectRatio = String(options.aspectRatio || 'original').toLowerCase();
      if (aspectRatio === '1:1') {
        vfFilters.push("crop='trunc(min(iw\\,ih)/2)*2':'trunc(min(iw\\,ih)/2)*2'");
      } else if (aspectRatio === '16:9') {
        vfFilters.push("crop='trunc(if(gte(a\\,16/9)\\,ih*16/9\\,iw)/2)*2':'trunc(if(gte(a\\,16/9)\\,ih\\,iw*9/16)/2)*2'");
      } else if (aspectRatio === '9:16') {
        vfFilters.push("crop='trunc(if(gte(a\\,9/16)\\,ih*9/16\\,iw)/2)*2':'trunc(if(gte(a\\,9/16)\\,ih\\,iw*16/9)/2)*2'");
      }

      let scaleFilter = 'scale=min(480\\,iw):-2:flags=lanczos';
      const reqRes = String(options.resolution || 'auto').toLowerCase();
      if (['1080', '720', '480', '360'].includes(reqRes)) {
        scaleFilter = `scale=-2:${reqRes}:flags=lanczos`;
      }
      vfFilters.push(`fps=15,${scaleFilter},split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`);

      const cmd = ffmpeg(encodePath)
        .complexFilter(vfFilters.join(','))
        .outputOptions(['-map_metadata', '-1'])
        .output(outputPath)
        .on('progress', (p) => {
          onProgress({ percent: Math.min(10 + Math.round((p.percent || 0) * 0.85), 95), stage: 'compressing' });
        });

      await runFfmpegCommand(cmd, { timeoutMs, signal }).catch((err) => {
        throw new Error(`GIF generation failed: ${err.message}`);
      });

      onProgress({ percent: 100, stage: 'done' });
      const compressedStats = fs.statSync(outputPath);
      completedSuccessfully = true;
      return { originalSize: parseInt(meta.size, 10), compressedSize: compressedStats.size, duration };
    }

    // --- MP4 Video Compression Flow ---
    const {
      muteAudio,
      audioBitrate,
      videoBitrate,
      targetHeight,
      targetFps,
    } = calculateBitrateAndScaling({
      duration,
      targetMB,
      audioBitrate: options.audioBitrate === 0 ? 0 : (parseInt(options.audioBitrate, 10) || 128),
      muteAudio: options.muteAudio === true,
      hasAudio: meta.hasAudio,
      origHeight: meta.height || 0,
      reqRes: options.resolution || 'auto',
      reqFps: options.fps || 'auto',
    });

    // --- Aspect Ratio Cropping with Even Dimension Guarantee ---
    const videoFilters = [];
    const aspectRatio = String(options.aspectRatio || 'original').toLowerCase();
    if (aspectRatio === '1:1') {
      videoFilters.push("crop='trunc(min(iw\\,ih)/2)*2':'trunc(min(iw\\,ih)/2)*2'");
    } else if (aspectRatio === '16:9') {
      videoFilters.push("crop='trunc(if(gte(a\\,16/9)\\,ih*16/9\\,iw)/2)*2':'trunc(if(gte(a\\,16/9)\\,ih\\,iw*9/16)/2)*2'");
    } else if (aspectRatio === '9:16') {
      videoFilters.push("crop='trunc(if(gte(a\\,9/16)\\,ih*9/16\\,iw)/2)*2':'trunc(if(gte(a\\,9/16)\\,ih\\,iw*16/9)/2)*2'");
    }

    // --- Speed filter ---
    if (speed !== 1.0) {
      videoFilters.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
    }

    // --- Resolution Scaling ---
    if (targetHeight > 0) {
      videoFilters.push(`scale=-2:${targetHeight}`);
    }

    // Always ensure final output dimensions are even for H.264 yuv420p
    videoFilters.push("pad='ceil(iw/2)*2':'ceil(ih/2)*2'");

    // Encoding runner supporting CPU & Hardware Acceleration (NVENC, QSV, AMF)
    const runEncoding = (codec) => {
      const isNvenc = codec.includes('nvenc');
      const isQsv = codec.includes('qsv');
      const isAmf = codec.includes('amf');

      // Strip all container metadata, EXIF, GPS tags, chapters, and encoder software tags for privacy
      const encodeOpts = [
        '-map_metadata', '-1',
        '-map_chapters', '-1',
        '-profile:v', 'high',
        '-pix_fmt', 'yuv420p',
        '-maxrate', `${Math.floor(videoBitrate * 1.15)}k`,
        '-bufsize', `${Math.floor(videoBitrate * 2.0)}k`,
        '-movflags', '+faststart',
      ];

      if (isNvenc) {
        encodeOpts.push('-preset', 'p4');
      } else if (isQsv) {
        encodeOpts.push('-preset', 'medium');
      } else if (isAmf) {
        encodeOpts.push('-quality', 'balanced');
      } else {
        encodeOpts.push('-preset', 'medium', '-level', '4.1');
      }

      if (videoFilters.length > 0) {
        encodeOpts.push('-vf', videoFilters.join(','));
      }
      if (targetFps > 0) {
        encodeOpts.push('-r', String(targetFps));
      }

      const cmd = ffmpeg(encodePath)
        .videoCodec(codec)
        .videoBitrate(videoBitrate);

      if (muteAudio) {
        cmd.addOption('-an');
      } else {
        cmd.audioCodec('aac').audioBitrate(audioBitrate);
        const audioFilters = [];
        if (volume !== 1 && meta.hasAudio) {
          audioFilters.push(`volume=${volume.toFixed(2)}`);
        }
        if (speed !== 1.0 && meta.hasAudio) {
          audioFilters.push(`atempo=${speed.toFixed(2)}`);
        }
        if (audioFilters.length > 0) {
          cmd.audioFilter(audioFilters.join(','));
        }
      }

      cmd
        .addOptions(encodeOpts)
        .output(outputPath)
        .on('start', () => {
          onProgress({ percent: 10, stage: 'compressing' });
        })
        .on('progress', (p) => {
          const pct = Math.min(10 + Math.round((p.percent || 0) * 0.85), 95);
          onProgress({ percent: pct, stage: 'compressing' });
        });

      return runFfmpegCommand(cmd, { timeoutMs, signal });
    };

    // Determine target codec from requested options with graceful fallback
    const reqEncoder = String(options.encoder || 'auto').toLowerCase();
    let targetCodec = 'libx264';
    if (reqEncoder === 'nvenc') targetCodec = 'h264_nvenc';
    else if (reqEncoder === 'qsv') targetCodec = 'h264_qsv';
    else if (reqEncoder === 'amf') targetCodec = 'h264_amf';

    try {
      await runEncoding(targetCodec);
    } catch (err) {
      if (targetCodec !== 'libx264' && !(signal && signal.aborted)) {
        removeFileQuietly(outputPath);
        await runEncoding('libx264');
      } else {
        throw new Error(`Compression failed: ${err.message}`);
      }
    }

    onProgress({ percent: 100, stage: 'done' });
    const compressedStats = fs.statSync(outputPath);
    completedSuccessfully = true;

    return {
      originalSize: parseInt(meta.size, 10),
      compressedSize: compressedStats.size,
      duration,
    };
  } finally {
    // Guaranteed cleanup of intermediate trimmed files, even on failure
    if (needsTrimCleanup) {
      removeFileQuietly(trimmedPath);
    }
    // Remove partial/corrupt output file if compression failed or was aborted
    if (!completedSuccessfully) {
      removeFileQuietly(outputPath);
    }
  }
}

module.exports = {
  compress,
  probeVideo,
  validateVideoFile,
  getHardwareEncoders,
  killActiveJobs,
};
