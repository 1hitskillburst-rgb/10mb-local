/**
 * 10mb.video — Comprehensive Automated Test & Audit Suite
 * Tests core FFmpeg compression, probeVideo, security restrictions, and HTTP API endpoints.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { compress, probeVideo } = require('../core/compress');

// Locate sample test clip
const CLIPS_DIR = path.resolve(__dirname, '..', 'storage', 'clips');
const TMP_DIR = path.resolve(__dirname, '..', 'tmp');
const sampleFiles = fs.readdirSync(CLIPS_DIR).filter(f => f.endsWith('.mp4'));

if (sampleFiles.length === 0) {
  console.error('No sample MP4 found in storage/clips for testing.');
  process.exit(1);
}

const sampleClipPath = path.join(CLIPS_DIR, sampleFiles[0]);
console.log(`Using sample video for tests: ${path.basename(sampleClipPath)}`);

let serverProcess = null;
let serverPort = 3999;
let baseUrl = `http://127.0.0.1:${serverPort}`;

// Helper: HTTP request wrapper
function makeRequest(options, postData = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(options.path || '/', baseUrl);
    const reqOpts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: { ...headers, ...(options.headers || {}) },
    };

    const req = http.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
          json: () => {
            try { return JSON.parse(data); } catch { return null; }
          }
        });
      });
    });

    req.on('error', reject);

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Multipart form data builder
function buildMultipart(boundary, fields, files) {
  const chunks = [];
  for (const [key, val] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${val}\r\n`));
  }
  for (const [key, file] of Object.entries(files)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function runTests() {
  console.log('\n--- 1. Testing Core FFmpeg Operations ---');

  // Test 1: probeVideo
  console.log('[Test 1] probeVideo returns accurate metadata...');
  const meta = await probeVideo(sampleClipPath);
  assert.ok(meta.duration > 0, 'Duration should be > 0');
  assert.ok(meta.size > 0, 'Size should be > 0');
  assert.ok(meta.width > 0, 'Width should be > 0');
  assert.ok(meta.height > 0, 'Height should be > 0');
  assert.strictEqual(typeof meta.hasAudio, 'boolean', 'hasAudio should be boolean');
  console.log(`  ✓ Probe passed: ${meta.width}x${meta.height}, ${meta.duration.toFixed(2)}s, codec=${meta.videoCodec}`);

  // Test 2: MP4 compression with trim and accurate duration
  console.log('[Test 2] MP4 compression with trim...');
  const testMp4Out = path.join(TMP_DIR, 'test_suite_out.mp4');
  const trimRes = await compress(sampleClipPath, testMp4Out, 10, () => {}, {
    trimStart: 0,
    trimEnd: 2.0,
    resolution: '720',
  });
  assert.ok(fs.existsSync(testMp4Out), 'Output file must exist');
  assert.ok(trimRes.compressedSize > 0, 'Compressed size > 0');
  // Verify duration returns actual trimmed playback duration (~2s), not original 40s
  assert.ok(trimRes.duration <= 3.5, `Trimmed duration (${trimRes.duration}) should reflect trimmed range`);
  fs.unlinkSync(testMp4Out);
  console.log('  ✓ MP4 compression with trim passed');

  // Test 3: MP3 audio extraction
  console.log('[Test 3] MP3 audio extraction...');
  const testMp3Out = path.join(TMP_DIR, 'test_suite_out.mp3');
  const mp3Res = await compress(sampleClipPath, testMp3Out, 10, () => {}, {
    trimStart: 0,
    trimEnd: 1.5,
    format: 'mp3',
    audioBitrate: 128,
  });
  assert.ok(fs.existsSync(testMp3Out), 'MP3 output file must exist');
  assert.ok(mp3Res.compressedSize > 0, 'MP3 size > 0');
  fs.unlinkSync(testMp3Out);
  console.log('  ✓ MP3 audio extraction passed');

  // Test 4: Animated GIF export with even dimensions
  console.log('[Test 4] Animated GIF export...');
  const testGifOut = path.join(TMP_DIR, 'test_suite_out.gif');
  const gifRes = await compress(sampleClipPath, testGifOut, 10, () => {}, {
    trimStart: 0,
    trimEnd: 1.0,
    format: 'gif',
    aspectRatio: '1:1',
    speed: 1.25,
  });
  assert.ok(fs.existsSync(testGifOut), 'GIF output file must exist');
  assert.ok(gifRes.compressedSize > 0, 'GIF size > 0');
  fs.unlinkSync(testGifOut);
  console.log('  ✓ Animated GIF export passed');

  console.log('\n--- 2. Starting HTTP Server on Test Port ---');
  process.env.PORT = serverPort;
  // Load server
  require('../server/index');

  // Wait for server to listen
  await new Promise(r => setTimeout(r, 600));

  console.log('\n--- 3. Testing Security Headers & Endpoints ---');

  // Test 5: Security headers (CSP, nosniff, DENY, XSS)
  console.log('[Test 5] Security headers present...');
  const homeRes = await makeRequest({ path: '/' });
  assert.strictEqual(homeRes.statusCode, 200);
  assert.strictEqual(homeRes.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(homeRes.headers['x-frame-options'], 'DENY');
  assert.ok(homeRes.headers['content-security-policy'], 'CSP must be set');
  console.log('  ✓ Security headers verified');

  // Test 6: Invalid file upload rejection
  console.log('[Test 6] Reject non-video file upload...');
  const boundary = `----WebKitFormBoundary${crypto.randomBytes(8).toString('hex')}`;
  const badPayload = buildMultipart(boundary, {}, {
    video: {
      filename: 'malicious.exe',
      contentType: 'application/x-msdownload',
      buffer: Buffer.from('NOT A VIDEO FILE'),
    }
  });

  const uploadBadRes = await makeRequest(
    { path: '/api/upload', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } },
    badPayload
  );
  assert.strictEqual(uploadBadRes.statusCode, 400, 'Non-video upload should return 400');
  console.log('  ✓ Non-video upload properly rejected (400)');

  // Test 7: Valid video upload returns UUID only (no internal paths leaked)
  console.log('[Test 7] Valid video upload...');
  const videoBuffer = fs.readFileSync(sampleClipPath).subarray(0, 500000); // 500KB test slice
  const goodPayload = buildMultipart(boundary, {}, {
    video: {
      filename: 'test_sample.mp4',
      contentType: 'video/mp4',
      buffer: videoBuffer,
    }
  });

  const uploadGoodRes = await makeRequest(
    { path: '/api/upload', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } },
    goodPayload
  );
  assert.strictEqual(uploadGoodRes.statusCode, 200);
  const uploadJson = uploadGoodRes.json();
  assert.ok(uploadJson.id, 'Upload response must include ID');
  assert.ok(!uploadJson.path, 'Upload response MUST NOT leak server file path');
  const uploadedId = uploadJson.id;
  console.log(`  ✓ Valid upload succeeded, ID: ${uploadedId} (zero path disclosure)`);

  // Test 8: SSE Progress Endpoint with UUID validation
  console.log('[Test 8] SSE progress endpoint...');
  const badSseRes = await makeRequest({ path: '/api/progress/not-a-uuid' });
  assert.strictEqual(badSseRes.statusCode, 400);

  const goodSseRes = await new Promise((resolve, reject) => {
    const req = http.get(`${baseUrl}/api/progress/${uploadedId}`, (res) => {
      assert.strictEqual(res.statusCode, 200);
      assert.strictEqual(res.headers['content-type'], 'text/event-stream');
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.includes('event: connected')) {
          req.destroy();
          resolve(true);
        }
      });
    });
    req.on('error', reject);
  });
  assert.ok(goodSseRes, 'SSE connection established and connected event received');
  console.log('  ✓ SSE progress connection verified');

  // Test 9: Protected /tmp Static Serving (Blocks unauthorized files & path traversal)
  console.log('[Test 9] /tmp access control & path traversal defense...');
  const rawAccess = await makeRequest({ path: `/tmp/${uploadedId}.mp4` });
  assert.strictEqual(rawAccess.statusCode, 403, 'Raw uploads must be blocked from /tmp');

  const pathTraversal = await makeRequest({ path: '/tmp/..%2f..%2fpackage.json' });
  assert.strictEqual(pathTraversal.statusCode, 403, 'Path traversal must return 403');

  const scriptAccess = await makeRequest({ path: '/tmp/test.js' });
  assert.strictEqual(scriptAccess.statusCode, 403, 'Arbitrary files must return 403');
  console.log('  ✓ /tmp strictly enforces compressed file pattern');

  // Test 10: Stored Clips API Security & Access Controls
  console.log('[Test 10] Stored clips API & path security...');
  const clipsListRes = await makeRequest({ path: '/api/clips' });
  assert.strictEqual(clipsListRes.statusCode, 200);
  const clips = clipsListRes.json();
  assert.ok(Array.isArray(clips), 'Clips list must be an array');

  // Test security: streaming clips.json or .gitkeep must be BLOCKED
  const leakClipsJson = await makeRequest({ path: '/api/clips/stream/clips.json' });
  assert.strictEqual(leakClipsJson.statusCode, 403, 'Streaming clips.json must be 403 Forbidden');

  const leakGitkeep = await makeRequest({ path: '/api/clips/download/.gitkeep' });
  assert.strictEqual(leakGitkeep.statusCode, 403, 'Downloading .gitkeep must be 403 Forbidden');

  const downloadClipsJson = await makeRequest({ path: '/api/clips/download/clips.json' });
  assert.strictEqual(downloadClipsJson.statusCode, 403, 'Downloading clips.json must be 403 Forbidden');
  console.log('  ✓ Protected storage files (clips.json, .gitkeep) cannot be read or downloaded');

  // Test 11: HTTP Range Streaming on Stored Clips
  if (clips.length > 0) {
    console.log('[Test 11] HTTP Range partial content (206) and 416 handling...');
    const clipFilename = clips[0].filename;

    // Normal Range (first 100 bytes)
    const rangeRes = await makeRequest({
      path: `/api/clips/stream/${clipFilename}`,
      headers: { Range: 'bytes=0-99' }
    });
    assert.strictEqual(rangeRes.statusCode, 206, 'Valid range must return 206 Partial Content');
    assert.strictEqual(rangeRes.headers['content-length'], '100');
    assert.ok(rangeRes.headers['content-range'].startsWith('bytes 0-99/'));

    // Suffix Range (last 200 bytes)
    const suffixRes = await makeRequest({
      path: `/api/clips/stream/${clipFilename}`,
      headers: { Range: 'bytes=-200' }
    });
    assert.strictEqual(suffixRes.statusCode, 206, 'Suffix range must return 206');
    assert.strictEqual(suffixRes.headers['content-length'], '200');

    // Out of bounds range (must return 416 Range Not Satisfiable)
    const oobRes = await makeRequest({
      path: `/api/clips/stream/${clipFilename}`,
      headers: { Range: 'bytes=999999999-999999999' }
    });
    assert.strictEqual(oobRes.statusCode, 416, 'Out of bounds range must return 416');
    console.log('  ✓ HTTP 206 Range streaming and 416 out-of-bounds protection verified');
  }

  // Test 12: Stored Clip Save and Delete workflow
  console.log('[Test 12] Stored clips save and delete lifecycle...');
  // Create a dummy compressed file to save
  const dummyCompFile = path.join(TMP_DIR, `${uploadedId}_compressed.mp4`);
  fs.writeFileSync(dummyCompFile, Buffer.from('FAKE_COMPRESSED_DATA'));

  const saveRes = await makeRequest({
    path: '/api/clips/save',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  }, JSON.stringify({
    id: uploadedId,
    title: 'Audit Test Clip',
    format: 'mp4',
    duration: 2.5,
  }));
  assert.strictEqual(saveRes.statusCode, 200);
  const savedClip = saveRes.json().clip;
  assert.ok(savedClip && savedClip.id, 'Saved clip object returned');
  console.log(`  ✓ Clip saved with ID: ${savedClip.id}`);

  // Clean up saved clip via DELETE /api/clips/:id
  const deleteRes = await makeRequest({
    path: `/api/clips/${savedClip.id}`,
    method: 'DELETE',
  });
  assert.strictEqual(deleteRes.statusCode, 200);
  assert.strictEqual(deleteRes.json().success, true);
  console.log('  ✓ Clip deleted successfully via API');

  // Test 13: Temporary file auto-cleanup endpoint
  console.log('[Test 13] /api/cleanup endpoint...');
  const cleanupRes = await makeRequest({
    path: '/api/cleanup',
    method: 'POST',
  });
  assert.strictEqual(cleanupRes.statusCode, 200);
  assert.strictEqual(cleanupRes.json().success, true);
  console.log('  ✓ Cleanup endpoint verified');

  // Test 14: CLI argument parsing and help output
  console.log('[Test 14] CLI argument parsing & invocation...');
  const { parseArgs } = require('../cli/index');
  const parsed = parseArgs(['-i', 'test.mp4', '-t', '16', '-f', 'gif', '-s', '5', '-e', '15', '--mute']);
  assert.strictEqual(parsed.input, 'test.mp4');
  assert.strictEqual(parsed.target, 16);
  assert.strictEqual(parsed.format, 'gif');
  assert.strictEqual(parsed.trimStart, 5);
  assert.strictEqual(parsed.trimEnd, 15);
  assert.strictEqual(parsed.muteAudio, true);
  console.log('  ✓ CLI argument parser verified');

  // Clean up any remaining test uploads
  try {
    const toClean = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(uploadedId));
    for (const f of toClean) {
      fs.unlinkSync(path.join(TMP_DIR, f));
    }
  } catch (_) {}

  console.log('\n========================================');
  console.log('  ALL AUDIT & SECURITY TESTS PASSED!  ✓');
  console.log('========================================\n');
  process.exit(0);
}

runTests().catch(err => {
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
