#!/usr/bin/env node

/**
 * 10mb.video — Command Line Interface
 * Compress any video to a target file size with FFmpeg.
 */

const path = require('path');
const fs = require('fs');
const { compress, probeVideo } = require('../core/compress');
const pkg = require('../package.json');

function printUsage() {
  console.log(`
  10mb.video — Video Compression CLI (v${pkg.version})
  Compress any video to a target file size (default: 10MB)

  Usage:
    node cli/index.js --input <file> [options]

  Options:
    -i, --input <file>         Source video file path (required)
    -o, --output <file>        Output file path (default: <name>_compressed.<ext>)
    -t, --target <mb>          Target file size in MB (default: 10, min: 10)
    -f, --format <format>      Output format: mp4 | gif | mp3 (default: mp4)
    -s, --trim-start <sec>     Trim start timestamp in seconds (default: 0)
    -e, --trim-end <sec>       Trim end timestamp in seconds
    -r, --resolution <res>     Target height: auto | original | 1080 | 720 | 480 | 360 (default: auto)
        --fps <fps>            Target frame rate: auto | original | 60 | 30 | 24 (default: auto)
        --speed <factor>       Playback speed multiplier (0.5 to 2.0, default: 1.0)
        --volume <factor>      Audio volume multiplier (0.0 to 2.0, default: 1.0)
        --mute                 Strip/mute audio stream
    -a, --audio-bitrate <kbps> Audio bitrate: 192 | 128 | 96 | 64 (default: 128)
        --aspect-ratio <ratio> Aspect ratio: original | 16:9 | 9:16 | 1:1 (default: original)
    -h, --help                 Show this help message
    -v, --version              Show version

  Examples:
    node cli/index.js -i gameplay.mp4 -t 10
    node cli/index.js -i clip.mov -t 16 -o discord_clip.mp4
    node cli/index.js -i video.mp4 -s 10 -e 25 --format gif
    node cli/index.js -i podcast.mp4 --format mp3 -a 192
`);
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const val = bytes / Math.pow(k, i);
  return `${val.toFixed(i >= 2 ? 2 : 0)} ${units[i]}`;
}

function formatTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function renderProgressBar(percent, stage) {
  const width = 30;
  const clamped = Math.min(100, Math.max(0, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  const bar = '='.repeat(Math.max(0, filled - 1)) + (filled > 0 ? '>' : '') + ' '.repeat(empty);
  const pctStr = `${Math.round(clamped)}%`.padStart(4, ' ');
  const stageMap = {
    trimming: 'Trimming...',
    analyzing: 'Analyzing...',
    compressing: 'Encoding...',
    done: 'Done!',
  };
  const label = stageMap[stage] || stage || 'Processing...';

  // Overwrite current line in terminal
  if (process.stdout.isTTY) {
    process.stdout.write(`\r  [${bar}] ${pctStr} | ${label}   `);
  }
}

function parseArgs(args) {
  const options = {
    input: null,
    output: null,
    target: 10,
    format: 'mp4',
    trimStart: undefined,
    trimEnd: undefined,
    resolution: 'auto',
    fps: 'auto',
    speed: 1.0,
    volume: 1.0,
    muteAudio: false,
    audioBitrate: 128,
    aspectRatio: 'original',
    help: false,
    version: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    if (arg === '-h' || arg === '--help') {
      options.help = true;
    } else if (arg === '-v' || arg === '--version') {
      options.version = true;
    } else if ((arg === '-i' || arg === '--input') && next) {
      options.input = next; i++;
    } else if ((arg === '-o' || arg === '--output') && next) {
      options.output = next; i++;
    } else if ((arg === '-t' || arg === '--target') && next) {
      options.target = Math.max(10, parseInt(next, 10) || 10); i++;
    } else if ((arg === '-f' || arg === '--format') && next) {
      options.format = next.toLowerCase(); i++;
    } else if ((arg === '-s' || arg === '--trim-start') && next) {
      options.trimStart = parseFloat(next); i++;
    } else if ((arg === '-e' || arg === '--trim-end') && next) {
      options.trimEnd = parseFloat(next); i++;
    } else if ((arg === '-r' || arg === '--resolution') && next) {
      options.resolution = next.toLowerCase(); i++;
    } else if (arg === '--fps' && next) {
      options.fps = next.toLowerCase(); i++;
    } else if (arg === '--speed' && next) {
      options.speed = parseFloat(next); i++;
    } else if (arg === '--volume' && next) {
      options.volume = parseFloat(next); i++;
    } else if (arg === '--mute') {
      options.muteAudio = true;
    } else if ((arg === '-a' || arg === '--audio-bitrate') && next) {
      options.audioBitrate = parseInt(next, 10) || 128; i++;
    } else if (arg === '--aspect-ratio' && next) {
      options.aspectRatio = next.toLowerCase(); i++;
    } else if (!arg.startsWith('-') && !options.input) {
      options.input = arg;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.version) {
    console.log(`10mb.video CLI v${pkg.version}`);
    process.exit(0);
  }

  if (options.help || !options.input) {
    printUsage();
    process.exit(options.help ? 0 : 1);
  }

  const inputPath = path.resolve(process.cwd(), options.input);

  if (!fs.existsSync(inputPath)) {
    console.error(`\n  Error: Input file not found: "${inputPath}"\n`);
    process.exit(1);
  }

  const outFormat = ['mp4', 'gif', 'mp3'].includes(options.format) ? options.format : 'mp4';

  let outputPath;
  if (options.output) {
    outputPath = path.resolve(process.cwd(), options.output);
  } else {
    const ext = path.extname(inputPath);
    const base = path.basename(inputPath, ext);
    outputPath = path.join(path.dirname(inputPath), `${base}_compressed.${outFormat}`);
  }

  console.log(`\n  10mb.video — Video Compression CLI`);
  console.log(`  -----------------------------------`);
  console.log(`  Source:     ${inputPath}`);
  console.log(`  Target:     ${options.target} MB`);
  console.log(`  Format:     ${outFormat.toUpperCase()}`);

  try {
    const meta = await probeVideo(inputPath);
    console.log(`  Duration:   ${formatTime(meta.duration)} (${meta.duration.toFixed(2)}s)`);
    console.log(`  Dimensions: ${meta.width}x${meta.height}`);
    console.log(`  Original:   ${formatBytes(meta.size)}`);
    console.log(`  Audio:      ${meta.hasAudio ? meta.audioCodec : 'none'}`);
    console.log(`  -----------------------------------\n`);

    const compressOpts = {
      format: outFormat,
      trimStart: options.trimStart,
      trimEnd: options.trimEnd,
      resolution: options.resolution,
      fps: options.fps,
      speed: options.speed,
      volume: options.volume,
      muteAudio: options.muteAudio,
      audioBitrate: options.audioBitrate,
      aspectRatio: options.aspectRatio,
    };

    const startTime = Date.now();

    renderProgressBar(0, 'Starting...');

    const result = await compress(inputPath, outputPath, options.target, (p) => {
      renderProgressBar(p.percent, p.stage);
    }, compressOpts);

    if (process.stdout.isTTY) {
      renderProgressBar(100, 'done');
      process.stdout.write('\n\n');
    } else {
      console.log('Compression complete.');
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const savedPct = result.originalSize > 0 && result.compressedSize > 0
      ? ((1 - (result.compressedSize / result.originalSize)) * 100).toFixed(1)
      : '0.0';

    console.log(`  Success! Compressed file saved to:`);
    console.log(`  → ${outputPath}\n`);
    console.log(`  Original Size:   ${formatBytes(result.originalSize)}`);
    console.log(`  Compressed Size: ${formatBytes(result.compressedSize)} (${savedPct}% reduction)`);
    console.log(`  Final Duration:  ${formatTime(result.duration)}`);
    console.log(`  Time Elapsed:    ${elapsed}s\n`);

  } catch (err) {
    if (process.stdout.isTTY) process.stdout.write('\n');
    console.error(`\n  Error: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
