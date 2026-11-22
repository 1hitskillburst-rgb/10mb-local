/**
 * 10mb.video — End-to-End Integration, Security, Privacy & Leak Audit Suite
 * Self-contained: generates its own temporary video fixture with embedded PII metadata,
 * tests FFmpeg compression & metadata stripping, per-user session isolation, CSRF protection,
 * spoofed upload rejection, immediate raw file purging, SSE cleanup, and one-click privacy wipe.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const { compress, probeVideo } = require('../core/compress');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const TMP_DIR = path.resolve(__dirname, '..', 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const serverPort = 3998;
const baseUrl = `http://127.0.0.1:${serverPort}`;
const sampleVideoPath = path.join(TMP_DIR, `fixture_${crypto.randomBytes(4).toString('hex')}.mp4`);

/**
 * Generates a real 3-second MP4 fixture with audio AND sensitive metadata tags (GPS, artist, comment)
 * to verify compression AND full privacy metadata stripping.
 */
function generateSampleVideo(outPath) {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input('testsrc=duration=3:size=640x360:rate=30')
      .inputFormat('lavfi')
      .input('sine=frequency=440:duration=3')
      .inputFormat('lavfi')
      .videoCodec('libx264')
      .audioCodec('aac')
      .outputOptions([
        '-pix_fmt', 'yuv420p',
        '-metadata', 'title=PrivateHomeVideo',
        '-metadata', 'artist=JaneDoe',
        '-metadata', 'comment=GPS_37.7749_-122.4194',
        '-movflags', '+faststart',
      ])
      .output(outPath)
      .on('error', reject)
      .on('end', resolve)
      .run();
  });
}

function inspectRawTags(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, meta) => {
      if (err) return reject(err);
      resolve((meta && meta.format && meta.format.tags) || {});
    });
  });
}

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
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        const body = bodyBuf.toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body,
          bodyBuf,
          json: () => {
            try { return JSON.parse(body); } catch { return null; }
          },
        });
      });
    });

    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function extractSessionCookie(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return null;
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  for (const c of arr) {
    if (c.startsWith('mb10_sid=')) {
      return c.split(';')[0];
    }
  }
  return null;
}

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
  console.log('\n--- 0. Generating Self-Contained Video Fixture ---');
  await generateSampleVideo(sampleVideoPath);
  const origTags = await inspectRawTags(sampleVideoPath);
  assert.strictEqual(origTags.artist, 'JaneDoe', 'Fixture should contain metadata prior to compression');

  console.log('\n--- 1. Testing Core FFmpeg Operations & Metadata Stripping ---');

  // Test 1: probeVideo
  const meta = await probeVideo(sampleVideoPath);
  assert.ok(meta.duration >= 2.5, 'Duration should be ~3s');
  assert.strictEqual(meta.width, 640);
  assert.strictEqual(meta.height, 360);
  assert.strictEqual(meta.hasVideo, true);
  assert.strictEqual(meta.hasAudio, true);
  console.log('  ✓ Test 1: probeVideo passed');

  // Test 2: MP4 compression with trim AND full metadata/PII stripping
  const testMp4Out = path.join(TMP_DIR, `out_${crypto.randomBytes(4).toString('hex')}.mp4`);
  const trimRes = await compress(sampleVideoPath, testMp4Out, 10, () => {}, {
    trimStart: 0,
    trimEnd: 2.0,
    resolution: '360',
  });
  assert.ok(fs.existsSync(testMp4Out));
  assert.ok(trimRes.compressedSize > 0);
  const outTags = await inspectRawTags(testMp4Out);
  assert.strictEqual(outTags.artist, undefined, 'Artist metadata MUST be stripped');
  assert.strictEqual(outTags.comment, undefined, 'GPS/comment metadata MUST be stripped');
  assert.strictEqual(outTags.title, undefined, 'Title metadata MUST be stripped');
  fs.unlinkSync(testMp4Out);
  console.log('  ✓ Test 2: MP4 compression + full metadata/GPS stripping passed');

  // Test 3: MP3 extraction with combined volume + speed filters & metadata stripping
  const testMp3Out = path.join(TMP_DIR, `out_${crypto.randomBytes(4).toString('hex')}.mp3`);
  const mp3Res = await compress(sampleVideoPath, testMp3Out, 10, () => {}, {
    trimStart: 0,
    trimEnd: 1.5,
    format: 'mp3',
    audioBitrate: 128,
    volume: 1.2,
    speed: 1.25,
  });
  assert.ok(fs.existsSync(testMp3Out));
  assert.ok(mp3Res.compressedSize > 0);
  const mp3Tags = await inspectRawTags(testMp3Out);
  assert.strictEqual(mp3Tags.artist, undefined, 'MP3 artist tag MUST be stripped');
  fs.unlinkSync(testMp3Out);
  console.log('  ✓ Test 3: MP3 extraction with chained audio filters passed');

  // Test 4: Animated GIF export
  const testGifOut = path.join(TMP_DIR, `out_${crypto.randomBytes(4).toString('hex')}.gif`);
  const gifRes = await compress(sampleVideoPath, testGifOut, 10, () => {}, {
    trimStart: 0,
    trimEnd: 1.0,
    format: 'gif',
    aspectRatio: '1:1',
    speed: 1.25,
  });
  assert.ok(fs.existsSync(testGifOut));
  assert.ok(gifRes.compressedSize > 0);
  fs.unlinkSync(testGifOut);
  console.log('  ✓ Test 4: Animated GIF export passed');

  console.log('\n--- 2. Starting Hardened HTTP Server on Test Port ---');
  process.env.PORT = String(serverPort);
  const { server, _internals } = require('../server/index');
  await new Promise(r => setTimeout(r, 400));

  console.log('\n--- 3. Testing Security Headers, Validation, Privacy & Leaks ---');

  // Test 5: Security & Privacy headers (strict CSP, no-referrer, Permissions-Policy, iframe-compatible)
  const homeRes = await makeRequest({ path: '/' });
  assert.strictEqual(homeRes.statusCode, 200);
  assert.strictEqual(homeRes.headers['x-content-type-options'], 'nosniff');
  assert.strictEqual(homeRes.headers['referrer-policy'], 'no-referrer');
  assert.strictEqual(homeRes.headers['x-frame-options'], undefined, 'Must not block iframe embedding');
  assert.strictEqual(homeRes.headers['x-powered-by'], undefined, 'Must not expose Express fingerprint');
  assert.ok(homeRes.headers['permissions-policy'], 'Permissions-Policy must be set');
  assert.ok(homeRes.headers['content-security-policy'], 'CSP must be set');
  assert.ok(!homeRes.headers['content-security-policy'].includes('unsafe-eval'), 'CSP must not allow unsafe-eval');
  assert.ok(!homeRes.headers['content-security-policy'].includes('unpkg.com'), 'CSP must not allow external CDNs');
  console.log('  ✓ Test 5: Security & privacy headers verified');

  // Test 6: Reject non-video upload AND spoofed .mp4 upload (ffprobe validation)
  const boundary = `----TestBoundary${crypto.randomBytes(8).toString('hex')}`;
  const exePayload = buildMultipart(boundary, {}, {
    video: { filename: 'malicious.exe', contentType: 'application/x-msdownload', buffer: Buffer.from('MZ_NOT_A_VIDEO') },
  });
  const exeRes = await makeRequest(
    { path: '/api/upload', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } },
    exePayload
  );
  assert.strictEqual(exeRes.statusCode, 400);

  const spoofPayload = buildMultipart(boundary, {}, {
    video: { filename: 'evil.mp4', contentType: 'video/mp4', buffer: Buffer.from('<script>alert(1)</script>') },
  });
  const spoofRes = await makeRequest(
    { path: '/api/upload', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } },
    spoofPayload
  );
  assert.strictEqual(spoofRes.statusCode, 400, 'Spoofed .mp4 must be rejected by FFprobe validation');
  console.log('  ✓ Test 6: Invalid & spoofed video uploads blocked (400)');

  // Test 7: Session A valid upload (zero path leak + HttpOnly session cookie + Cache-Control: no-store)
  const sampleBuf = fs.readFileSync(sampleVideoPath);
  const goodPayload = buildMultipart(boundary, {}, {
    video: { filename: '../../my_private_clip.mp4', contentType: 'video/mp4', buffer: sampleBuf },
  });
  const uploadRes = await makeRequest(
    { path: '/api/upload', method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } },
    goodPayload
  );
  assert.strictEqual(uploadRes.statusCode, 200);
  assert.ok(String(uploadRes.headers['cache-control']).includes('no-store'));
  const sessionACookie = extractSessionCookie(uploadRes.headers);
  assert.ok(sessionACookie, 'Server must issue a signed private session cookie');

  const uploadJson = uploadRes.json();
  assert.ok(uploadJson.id);
  assert.strictEqual(uploadJson.path, undefined, 'Must never leak internal server path');
  assert.strictEqual(uploadJson.originalName, 'my_private_clip.mp4', 'Must strip path traversal from filename');
  const uploadedId = uploadJson.id;
  console.log('  ✓ Test 7: Valid upload bound to Session A with zero path disclosure');

  // Test 8: Session B (another user) CANNOT access Session A's SSE progress, compress, or files
  const sessionBInit = await makeRequest({ path: '/api/clips' });
  const sessionBCookie = extractSessionCookie(sessionBInit.headers);
  assert.ok(sessionBCookie && sessionBCookie !== sessionACookie);

  const crossSse = await makeRequest({ path: `/api/progress/${uploadedId}`, headers: { Cookie: sessionBCookie } });
  assert.strictEqual(crossSse.statusCode, 403, 'Session B must be blocked from Session A SSE progress');

  const crossCompress = await makeRequest(
    { path: '/api/compress', method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionBCookie } },
    JSON.stringify({ id: uploadedId, targetMB: 10 })
  );
  assert.strictEqual(crossCompress.statusCode, 404, 'Session B must not be able to compress Session A upload');
  console.log('  ✓ Test 8: Cross-session upload/SSE isolation enforced');

  // Test 9: CSRF Origin protection blocks cross-site mutations
  const csrfRes = await makeRequest(
    {
      path: '/api/compress',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: sessionACookie,
        Origin: 'https://evil-attacker.example',
      },
    },
    JSON.stringify({ id: uploadedId, targetMB: 10 })
  );
  assert.strictEqual(csrfRes.statusCode, 403, 'Cross-origin POST must be blocked');
  console.log('  ✓ Test 9: CSRF cross-origin protection verified');

  // Test 10: Real end-to-end compression via SSE + immediate raw upload purging + zero lingering SSE clients
  const donePayload = await new Promise((resolve, reject) => {
    let settled = false;
    const sseReq = http.get(
      `${baseUrl}/api/progress/${uploadedId}`,
      { headers: { Cookie: sessionACookie } },
      (res) => {
        assert.strictEqual(res.statusCode, 200);
        let buf = '';
        res.on('data', (chunk) => {
          buf += chunk.toString('utf8');
          if (buf.includes('event: connected') && !settled) {
            settled = true;
            // Trigger compression once connected
            makeRequest(
              {
                path: '/api/compress',
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Cookie: sessionACookie },
              },
              JSON.stringify({ id: uploadedId, targetMB: 10, format: 'mp4' })
            ).catch(reject);
          }
          const doneMatch = buf.match(/event: done\ndata: ([^\n]+)\n/);
          if (doneMatch) {
            sseReq.destroy();
            resolve(JSON.parse(doneMatch[1]));
          }
          const errMatch = buf.match(/event: error\ndata: ([^\n]+)\n/);
          if (errMatch) {
            sseReq.destroy();
            reject(new Error(errMatch[1]));
          }
        });
      }
    );
    sseReq.on('error', (e) => {
      if (e.code !== 'ECONNRESET') reject(e);
    });
  });

  assert.ok(donePayload.compressedSize > 0);
  assert.strictEqual(donePayload.outputUrl, `/tmp/${uploadedId}_compressed.mp4`);

  // Wait briefly for server finally block & closeProgress cleanup
  await new Promise(r => setTimeout(r, 700));
  assert.strictEqual(
    fs.existsSync(path.join(TMP_DIR, `${uploadedId}.mp4`)),
    false,
    'Raw source upload MUST be purged immediately after compression'
  );
  assert.strictEqual(
    _internals.progressClients.size,
    0,
    'Zero SSE progress clients should linger after completion (no memory leak)'
  );
  console.log('  ✓ Test 10: End-to-end compression, immediate raw purge, and SSE cleanup verified');

  // Test 11: /tmp and /api/download ownership isolation + path traversal protection
  const sessionATmp = await makeRequest({ path: donePayload.outputUrl, headers: { Cookie: sessionACookie } });
  assert.strictEqual(sessionATmp.statusCode, 200);

  const sessionBTmp = await makeRequest({ path: donePayload.outputUrl, headers: { Cookie: sessionBCookie } });
  assert.strictEqual(sessionBTmp.statusCode, 403, 'Session B must NOT access Session A compressed file');

  const sessionBDownload = await makeRequest({ path: donePayload.downloadUrl, headers: { Cookie: sessionBCookie } });
  assert.strictEqual(sessionBDownload.statusCode, 403, 'Session B must NOT download Session A compressed file');

  const traversalRes = await makeRequest({ path: '/tmp/..%2f..%2fpackage.json', headers: { Cookie: sessionACookie } });
  assert.strictEqual(traversalRes.statusCode, 403);
  console.log('  ✓ Test 11: /tmp and /api/download session isolation & traversal defense verified');

  // Test 12: Private Stored Clips — Session A saves & streams (206/416), Session B sees NOTHING
  const saveRes = await makeRequest(
    { path: '/api/clips/save', method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: sessionACookie } },
    JSON.stringify({ id: uploadedId, title: 'My Private Clip', format: 'mp4', duration: 3 })
  );
  assert.strictEqual(saveRes.statusCode, 200);
  const savedClip = saveRes.json().clip;
  assert.ok(savedClip && savedClip.id);
  assert.strictEqual(savedClip.ownerId, undefined, 'ownerId hash must never be exposed in API response');

  const clipsA = (await makeRequest({ path: '/api/clips', headers: { Cookie: sessionACookie } })).json();
  assert.strictEqual(clipsA.length, 1);
  assert.strictEqual(clipsA[0].id, savedClip.id);

  const clipsB = (await makeRequest({ path: '/api/clips', headers: { Cookie: sessionBCookie } })).json();
  assert.strictEqual(clipsB.length, 0, 'Session B MUST NOT see Session A stored clips');

  // Session B cannot stream, download, or delete Session A's clip
  const streamB = await makeRequest({ path: savedClip.streamUrl, headers: { Cookie: sessionBCookie } });
  assert.strictEqual(streamB.statusCode, 404);
  const dlB = await makeRequest({ path: savedClip.downloadUrl, headers: { Cookie: sessionBCookie } });
  assert.strictEqual(dlB.statusCode, 404);
  const delB = await makeRequest({ path: `/api/clips/${savedClip.id}`, method: 'DELETE', headers: { Cookie: sessionBCookie } });
  assert.strictEqual(delB.statusCode, 404);

  // Protected storage files blocked
  assert.strictEqual((await makeRequest({ path: '/api/clips/stream/clips.json', headers: { Cookie: sessionACookie } })).statusCode, 403);
  assert.strictEqual((await makeRequest({ path: '/api/clips/download/.gitkeep', headers: { Cookie: sessionACookie } })).statusCode, 403);

  // Session A HTTP 206 Partial Content + 416 Out-of-Bounds
  const rangeRes = await makeRequest({
    path: savedClip.streamUrl,
    headers: { Cookie: sessionACookie, Range: 'bytes=0-99' },
  });
  assert.strictEqual(rangeRes.statusCode, 206);
  assert.strictEqual(rangeRes.headers['content-length'], '100');

  const oobRes = await makeRequest({
    path: savedClip.streamUrl,
    headers: { Cookie: sessionACookie, Range: 'bytes=999999999-999999999' },
  });
  assert.strictEqual(oobRes.statusCode, 416);
  console.log('  ✓ Test 12: Private Stored Clips isolation & HTTP 206/416 streaming verified');

  // Test 13: One-Click Privacy Purge wipes ALL of Session A's clips & temp files from disk
  const purgeRes = await makeRequest({
    path: '/api/privacy/purge',
    method: 'POST',
    headers: { Cookie: sessionACookie },
  });
  assert.strictEqual(purgeRes.statusCode, 200);
  const purgeJson = purgeRes.json();
  assert.strictEqual(purgeJson.success, true);
  assert.strictEqual(purgeJson.removedClips, 1);
  assert.strictEqual(
    fs.existsSync(path.join(_internals.CLIPS_DIR, savedClip.filename)),
    false,
    'Clip file must be deleted from disk on privacy purge'
  );
  assert.strictEqual(
    fs.existsSync(path.join(TMP_DIR, `${uploadedId}_compressed.mp4`)),
    false,
    'Compressed tmp file must be deleted from disk on privacy purge'
  );
  console.log('  ✓ Test 13: One-click privacy purge verified');

  // Test 14: CLI parser & Hardware encoder endpoint
  const { parseArgs } = require('../cli/index');
  const parsed = parseArgs(['-i', 'test.mp4', '-t', '16', '-f', 'gif', '-s', '5', '-e', '15', '--mute', '--encoder', 'nvenc']);
  assert.strictEqual(parsed.input, 'test.mp4');
  assert.strictEqual(parsed.target, 16);
  assert.strictEqual(parsed.format, 'gif');
  assert.strictEqual(parsed.muteAudio, true);

  const encRes = await makeRequest({ path: '/api/encoders' });
  assert.strictEqual(encRes.statusCode, 200);
  assert.strictEqual(encRes.json().cpu, true);
  console.log('  ✓ Test 14: CLI parser & hardware encoder API verified');

  // Cleanup fixture & close server
  if (fs.existsSync(sampleVideoPath)) fs.unlinkSync(sampleVideoPath);
  server.close();

  console.log('\n=================================================');
  console.log('  ALL SECURITY, PRIVACY & E2E TESTS PASSED!  ✓');
  console.log('=================================================\n');
  process.exit(0);
}

runTests().catch((err) => {
  if (fs.existsSync(sampleVideoPath)) {
    try { fs.unlinkSync(sampleVideoPath); } catch (_) {}
  }
  console.error('\n❌ Test failure:', err);
  process.exit(1);
});
