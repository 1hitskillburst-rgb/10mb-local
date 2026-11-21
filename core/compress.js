const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Point fluent-ffmpeg to the installed binary
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

/**
 * Probe a video file to get duration and other metadata with multi-stream fallbacks.
 * @param {string} inputPath - Absolute path to the video file
 * @returns {Promise<{duration: number, size: number, videoCodec: string, audioCodec: string, hasAudio: boolean, width: number, height: number}>}
 */
function probeVideo(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
      if (err) return reject(err);

      const format = metadata.format || {};
      const videoStream = (metadata.streams || []).find(s => s.codec_type === 'video');
      const audioStream = (metadata.streams || []).find(s => s.codec_type === 'audio');

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

      resolve({
        duration: duration || 0,
        size: parseInt(format.size, 10) || 0,
        videoCodec: videoStream ? videoStream.codec_name : 'unknown',
        audioCodec: audioStream ? audioStream.codec_name : 'none',
        hasAudio: !!audioStream,
        width: videoStream ? (parseInt(videoStream.width, 10) || 0) : 0,
        height: videoStream ? (parseInt(videoStream.height, 10) || 0) : 0,
      });
    });
  });
}

/**
 * Compress a video to a target file size using constrained single-pass VBV encoding.
 *
 * @param {string} inputPath   - Path to the source video
 * @param {string} outputPath  - Path for the compressed output
 * @param {number} targetMB    - Target size in megabytes (minimum 10)
 * @param {function} onProgress - Callback receiving { percent: 0-100, stage: string }
 * @param {object} [options]   - Optional settings
 * @returns {Promise<{originalSize: number, compressedSize: number, duration: number}>}
 */
async function compress(inputPath, outputPath, targetMB = 10, onProgress = () => {}, options = {}) {
  // Enforce minimum target
  targetMB = Math.max(parseInt(targetMB, 10) || 10, 10);

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
  const randomSuffix = crypto.randomBytes(4).toString('hex');
  const trimmedPath = outputPath.replace(/\.[^.]+$/, '') + `_trimmed_${randomSuffix}.mkv`;
  let needsTrimCleanup = false;

  try {
    if (isTrimming) {
      console.log(`[Trim] Pre-trimming ${trimStart.toFixed(2)}s \u2192 ${trimEnd.toFixed(2)}s`);
      onProgress({ percent: 0, stage: 'trimming' });

      await new Promise((resolve, reject) => {
        ffmpeg(inputPath)
          .inputOptions(['-ss', String(trimStart)])
          .outputOptions(['-t', String(trimEnd - trimStart)])
          .videoCodec('copy')
          .audioCodec('copy')
          .output(trimmedPath)
          .on('start', () => console.log('[Trim] Stream-copy trim started...'))
          .on('error', (err) => reject(new Error(`Trim failed: ${err.message}`)))
          .on('end', resolve)
          .run();
      });

      // Re-probe trimmed file for actual keyframe-aligned duration
      const trimMeta = await probeVideo(trimmedPath);
      duration = trimMeta.duration || (trimEnd - trimStart);
      encodePath = trimmedPath;
      needsTrimCleanup = true;

      if (!duration || duration <= 0) {
        throw new Error('Trimmed video has no valid duration.');
      }

      console.log(`[Trim] Trimmed file duration: ${duration.toFixed(2)}s`);
    }

    // --- Speed factor (clamped between 0.5x and 2.0x for filter safety) ---
    let speed = 1.0;
    if (typeof options.speed === 'number' && Number.isFinite(options.speed) && options.speed > 0) {
      speed = Math.max(0.5, Math.min(2.0, options.speed));
    }
    duration = duration / speed; // Adjust duration for bitrate calculation

    // --- Format Check (MP3, GIF, MP4) ---
    const format = String(options.format || 'mp4').toLowerCase();

    // --- MP3 Audio Extraction ---
    if (format === 'mp3') {
      if (!meta.hasAudio) {
        throw new Error('Cannot extract MP3 audio: the source video contains no audio stream.');
      }
      console.log('[Format] Extracting MP3 audio...');
      onProgress({ percent: 10, stage: 'compressing' });
      const mp3Bitrate = parseInt(options.audioBitrate, 10) || 192;
      await new Promise((resolve, reject) => {
        const cmd = ffmpeg(encodePath).noVideo().audioCodec('libmp3lame').audioBitrate(mp3Bitrate);
        if (volume !== 1) {
          cmd.audioFilter(`volume=${volume.toFixed(2)}`);
        }
        if (speed !== 1.0) {
          cmd.audioFilter(`atempo=${speed.toFixed(2)}`);
        }
        cmd.output(outputPath)
          .on('progress', p => onProgress({ percent: Math.min(10 + Math.round((p.percent || 0) * 0.85), 95), stage: 'compressing' }))
          .on('error', err => reject(new Error(`MP3 extraction failed: ${err.message}`)))
          .on('end', () => { onProgress({ percent: 100, stage: 'done' }); resolve(); })
          .run();
      });

      const compressedStats = fs.statSync(outputPath);
      return { originalSize: parseInt(meta.size, 10), compressedSize: compressedStats.size, duration };
    }

    // --- GIF Export ---
    if (format === 'gif') {
      console.log('[Format] Generating animated GIF...');
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

      await new Promise((resolve, reject) => {
        ffmpeg(encodePath)
          .complexFilter(vfFilters.join(','))
          .output(outputPath)
          .on('progress', p => onProgress({ percent: Math.min(10 + Math.round((p.percent || 0) * 0.85), 95), stage: 'compressing' }))
          .on('error', err => reject(new Error(`GIF generation failed: ${err.message}`)))
          .on('end', () => { onProgress({ percent: 100, stage: 'done' }); resolve(); })
          .run();
      });

      const compressedStats = fs.statSync(outputPath);
      return { originalSize: parseInt(meta.size, 10), compressedSize: compressedStats.size, duration };
    }

    // --- MP4 Video Compression Flow ---

    // --- Audio Bitrate & Mute ---
    const muteAudio = options.muteAudio === true || options.audioBitrate === 0 || !meta.hasAudio;
    const audioBitrate = muteAudio ? 0 : (parseInt(options.audioBitrate, 10) || 128); // kbps

    // 5% safety margin to ensure final output size stays strictly below target limit
    const safetyFactor = 0.95;
    const targetBytes = Math.floor(targetMB * 1024 * 1024 * safetyFactor);
    const audioBitsTotal = audioBitrate * 1000 * duration;
    const videoBitsTotal = (targetBytes * 8) - audioBitsTotal;

    if (videoBitsTotal <= 0) {
      throw new Error(
        `Target size (${targetMB}MB) is too small for this video's duration (${Math.round(duration)}s). ` +
        `Audio alone would require ~${Math.round(audioBitsTotal / 8 / 1024 / 1024)}MB. Try muting audio or trimming the clip.`
      );
    }

    // Enforce reasonable minimum video bitrate (64 kbps)
    const videoBitrate = Math.max(64, Math.floor(videoBitsTotal / duration / 1000)); // kbps

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

    // --- Smart Downscaling & Resolution (Enforce Even Heights) ---
    let targetHeight = 0; // 0 = keep original
    const origHeight = meta.height || 0;
    const reqRes = String(options.resolution || 'auto').toLowerCase();

    if (reqRes === 'auto') {
      if (origHeight > 1080 && videoBitrate < 3500) {
        targetHeight = 1080;
      } else if (origHeight > 720 && videoBitrate < 1800) {
        targetHeight = 720;
      } else if (origHeight > 480 && videoBitrate < 750) {
        targetHeight = 480;
      } else if (origHeight > 360 && videoBitrate < 350) {
        targetHeight = 360;
      }
    } else if (['1080', '720', '480', '360'].includes(reqRes)) {
      const specifiedH = parseInt(reqRes, 10);
      if (origHeight > specifiedH || origHeight === 0) {
        targetHeight = specifiedH;
      }
    }

    if (targetHeight > 0) {
      targetHeight = targetHeight - (targetHeight % 2); // Ensure strictly divisible by 2
      videoFilters.push(`scale=-2:${targetHeight}`);
      console.log(`[Quality] Scaling resolution to ${targetHeight}p`);
    }

    // Always ensure final output dimensions are even for libx264
    videoFilters.push("pad='ceil(iw/2)*2':'ceil(ih/2)*2'");

    // --- FPS Capping ---
    let targetFps = 0; // 0 = keep original
    const reqFps = String(options.fps || 'auto').toLowerCase();
    if (reqFps === '30' || reqFps === '24') {
      targetFps = parseInt(reqFps, 10);
    } else if (reqFps === 'auto' && videoBitrate < 1000) {
      targetFps = 30; // Auto-cap at 30fps for low bitrates to boost quality per frame
    }

    // Build FFmpeg command options
    const encodeOpts = [
      '-preset', 'slow',
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',       // Universal web & mobile player compatibility
      '-maxrate', `${Math.floor(videoBitrate * 1.15)}k`,
      '-bufsize', `${Math.floor(videoBitrate * 2.0)}k`,
      '-movflags', '+faststart',   // Web-optimized MP4 streaming
    ];

    if (videoFilters.length > 0) {
      encodeOpts.push('-vf', videoFilters.join(','));
    }
    if (targetFps > 0) {
      encodeOpts.push('-r', String(targetFps));
      console.log(`[Quality] Capping framerate to ${targetFps} fps`);
    }

    // Single-Pass Constrained VBV Encoding
    await new Promise((resolve, reject) => {
      const cmd = ffmpeg(encodePath)
        .videoCodec('libx264')
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
          console.log(`[Encoding] Single-pass VBV encoding (target ${videoBitrate} kbps, maxrate ${Math.floor(videoBitrate * 1.15)} kbps)...`);
          onProgress({ percent: 10, stage: 'compressing' });
        })
        .on('progress', (p) => {
          const pct = Math.min(10 + Math.round((p.percent || 0) * 0.85), 95);
          onProgress({ percent: pct, stage: 'compressing' });
        })
        .on('error', (err) => reject(new Error(`Compression failed: ${err.message}`)))
        .on('end', () => {
          onProgress({ percent: 100, stage: 'done' });
          resolve();
        });
      cmd.run();
    });

    const compressedStats = fs.statSync(outputPath);

    return {
      originalSize: parseInt(meta.size, 10),
      compressedSize: compressedStats.size,
      duration: duration,
    };
  } finally {
    // Guaranteed cleanup of intermediate trimmed files, even on failure
    if (needsTrimCleanup && trimmedPath && fs.existsSync(trimmedPath)) {
      try {
        fs.unlinkSync(trimmedPath);
        console.log(`[Trim] Cleaned up temporary trimmed file: ${path.basename(trimmedPath)}`);
      } catch (_) { /* best effort */ }
    }
  }
}

module.exports = { compress, probeVideo };
