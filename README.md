# 10mb Video

A video compression tool that targets a configurable file size — defaulting to 10MB, but adjustable by the user.

---

## What It Does

Upload (or drop) a video. Set a target file size. Get back a compressed version that hits as close to that target as possible without going over.

- Default target: **10MB**
- Minimum target: **10MB** (can be raised, but not lowered below this)
- Supports common formats: MP4, MOV, AVI, MKV, WebM
- Output format: MP4 (H.264 + AAC)

---

## How It Works

Compression is done in two passes using FFmpeg:

1. **Pass 1** — FFmpeg analyzes the video to build a stats file
2. **Pass 2** — FFmpeg encodes at the calculated bitrate to hit the target size

The target bitrate is calculated as:

```
target_bitrate = (target_size_bytes * 8) / duration_seconds - audio_bitrate
```

This gives a close-to-accurate result without guessing. No re-uploads, no server-side magic needed for the core logic.

---

## Project Structure

```
10mb-video/
├── README.md
├── .gitignore
├── package.json            # (if web app) or requirements.txt (if Python CLI)
│
├── core/
│   └── compress.js         # FFmpeg wrapper — bitrate calc + two-pass logic
│
├── cli/
│   └── index.js            # CLI entry point (optional)
│
├── web/
│   ├── index.html          # Upload UI
│   ├── app.js              # Frontend logic
│   └── style.css
│
├── server/
│   └── index.js            # Express server — handles uploads + runs FFmpeg
│
└── tmp/                    # Temp files during compression (gitignored)
```

---

## Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Compression | FFmpeg | Industry standard, free, handles everything |
| Backend | Node.js + Express | Easy file handling, streams well |
| Frontend | Vanilla JS or React | TBD based on complexity |
| File I/O | `multer` | Handles multipart uploads cleanly |
| FFmpeg bindings | `fluent-ffmpeg` | Nicer API than raw `child_process` |

---

## Getting Started

### Prerequisites

- Node.js 18+
- FFmpeg installed and on your PATH

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows
# Download from https://ffmpeg.org/download.html and add to PATH
```

### Install

```bash
git clone https://github.com/yourname/10mb-video.git
cd 10mb-video
npm install
```

### Run (web app)

```bash
npm start
# Open http://localhost:3000
```

### Run (Docker / Self-Hosting)

```bash
docker compose up -d
# Open http://localhost:3000
```

### Run (CLI)

```bash
node cli/index.js --input myvideo.mp4 --target 10
# Output: myvideo_compressed.mp4
```

### Run (tests & security audit)

```bash
npm test
```

---

## Core Logic (Pseudocode)

```js
function compress(inputPath, outputPath, targetMB = 10) {
  const targetBytes = targetMB * 1024 * 1024;
  const duration = getVideoDuration(inputPath);        // in seconds
  const audioBitrate = 128;                            // kbps
  const targetBitrate = Math.floor(
    (targetBytes * 8) / duration / 1000 - audioBitrate // kbps
  );

  // Single-pass constrained VBV encode
  ffmpeg(inputPath)
    .videoBitrate(targetBitrate)
    .audioBitrate(audioBitrate)
    .output(outputPath)
    .run();
}
```

---

## Features & Implementation Status

- [x] Drag-and-drop upload with format validation
- [x] Live compression progress bar (SSE real-time streaming)
- [x] Adjustable target size (slider and preset chips: 10MB, 16MB, 20MB, 50MB)
- [x] Before/after file size display with savings percentage
- [x] Quality preview player & side-by-side synchronized comparison
- [x] Interactive video trimming scrubber with keyframe-aligned cuts
- [x] Audio volume (0-200%), muting, and bitrate controls
- [x] Multi-format conversion (MP4 video, Animated GIF, MP3 audio)
- [x] Stored clips library with HTTP 206 partial content range streaming
- [x] Security-hardened (CSP, zero server path leaks, strict regex validation, traversal protection)
- [ ] Batch compression (multiple files)
- [ ] Optional: client-side compression via WebAssembly (FFmpeg.wasm) — no server needed

---

## FFmpeg.wasm (Optional Path)

If you want a fully client-side tool (no server, no uploads), FFmpeg can run in the browser via WebAssembly:

```bash
npm install @ffmpeg/ffmpeg @ffmpeg/util
```

The tradeoff: it's slower than native FFmpeg and has some format limitations. Good for a zero-backend MVP though.

---

## Contributing

Pull requests welcome. If you're adding a new feature, open an issue first so we can align on scope.

---

## License

MIT
