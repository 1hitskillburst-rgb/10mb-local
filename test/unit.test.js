const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const {
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
} = require('../core/utils');

test('isValidUUID accepts valid UUIDs and rejects traversal or garbage', () => {
  assert.equal(isValidUUID(crypto.randomUUID()), true);
  assert.equal(isValidUUID('not-a-uuid'), false);
  assert.equal(isValidUUID('../../etc/passwd'), false);
  assert.equal(isValidUUID(null), false);
});

test('isPathInside enforces strict trailing separator boundary', () => {
  const base = path.resolve('/tmp/safe_dir');
  assert.equal(isPathInside(path.join(base, 'video.mp4'), base), true);
  assert.equal(isPathInside(path.join(base, '../safe_dir_evil/video.mp4'), base), false);
  assert.equal(isPathInside('/tmp/safe_dir_evil/video.mp4', base), false);
  assert.equal(isPathInside(base, base), false);
});

test('sanitizeFilename strips directory traversal, quotes, and control characters', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('clip\r\n"evil".mp4'), 'clip___evil_.mp4');
  assert.equal(sanitizeFilename('..\\..\\windows\\system32\\cmd.exe'), 'cmd.exe');
  assert.equal(sanitizeFilename('   '), 'video.mp4');
});

test('sanitizeErrorMessage removes internal Unix and Windows file paths', () => {
  const msg = sanitizeErrorMessage('ffmpeg failed on /app/applet/tmp/abc123.mp4: Invalid data\nstack line 2');
  assert.equal(msg.includes('/app/applet'), false);
  assert.equal(msg.includes('stack line 2'), false);
  const winMsg = sanitizeErrorMessage('Error reading C:\\Users\\secret\\clip.mp4');
  assert.equal(winMsg.includes('C:\\Users'), false);
});

test('parseAndValidateCompressOptions clamps extreme values and allowlists options', () => {
  const { targetMB, options } = parseAndValidateCompressOptions({
    targetMB: 999999,
    volume: 50,
    speed: 100,
    audioBitrate: 9999,
    resolution: '9999p',
    fps: '60',
    format: 'exe',
    aspectRatio: '16:9',
    encoder: 'NVENC',
    trimStart: 10,
    trimEnd: 5, // invalid: end <= start
  });

  assert.equal(targetMB, 2000);
  assert.equal(options.volume, 2);
  assert.equal(options.speed, 2);
  assert.equal(options.audioBitrate, undefined);
  assert.equal(options.resolution, undefined);
  assert.equal(options.fps, '60');
  assert.equal(options.format, 'mp4');
  assert.equal(options.aspectRatio, '16:9');
  assert.equal(options.encoder, 'nvenc');
  assert.equal(options.trimStart, undefined);
  assert.equal(options.trimEnd, undefined);
});

test('calculateBitrateAndScaling downscales 4K low-bitrate videos to 360p (lowest threshold first)', () => {
  // 10MB target over 240s (~330 kbps total, ~200 kbps video after 128k audio)
  const result = calculateBitrateAndScaling({
    duration: 240,
    targetMB: 10,
    audioBitrate: 128,
    muteAudio: false,
    hasAudio: true,
    origHeight: 2160,
    reqRes: 'auto',
    reqFps: 'auto',
  });

  assert.equal(result.targetHeight, 360);
  assert.equal(result.targetFps, 30);
  assert.ok(result.videoBitrate >= 64 && result.videoBitrate < 350);
});

test('calculateBitrateAndScaling respects explicit 60 fps and throws when target is impossible', () => {
  const res60 = calculateBitrateAndScaling({
    duration: 10,
    targetMB: 10,
    origHeight: 1080,
    reqRes: 'original',
    reqFps: '60',
  });
  assert.equal(res60.targetFps, 60);
  assert.equal(res60.targetHeight, 0);

  assert.throws(() => {
    calculateBitrateAndScaling({
      duration: 10000,
      targetMB: 10,
      audioBitrate: 192,
      muteAudio: false,
      hasAudio: true,
    });
  }, /too small/i);
});

test('parseRangeHeader handles normal, open-ended, suffix, and invalid ranges', () => {
  assert.deepEqual(parseRangeHeader('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRangeHeader('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRangeHeader('bytes=-200', 1000), { start: 800, end: 999 });
  assert.equal(parseRangeHeader('bytes=1000-1200', 1000), null);
  assert.equal(parseRangeHeader('bytes=500-100', 1000), null);
  assert.equal(parseRangeHeader('bytes=-', 1000), null);
  assert.equal(parseRangeHeader('bytes=0-10, 20-30', 1000), null);
});

test('session signing, verification, and owner hashing resist tampering', () => {
  const secret = 'test-secret-key-for-unit-tests';
  const sid = crypto.randomUUID();
  const token = signSessionId(sid, secret);

  assert.equal(verifySessionToken(token, secret), sid);
  assert.equal(verifySessionToken(token + 'x', secret), null);
  assert.equal(verifySessionToken(token, 'wrong-secret'), null);

  const ownerA = hashSessionOwner(sid, secret);
  const ownerB = hashSessionOwner(crypto.randomUUID(), secret);
  assert.notEqual(ownerA, ownerB);
  assert.equal(ownerA.includes(sid), false);
});

test('parseCookies prevents prototype pollution and parses tokens cleanly', () => {
  const cookies = parseCookies('__proto__=polluted; mb10_sid=abc.def; theme=dark');
  assert.equal(cookies.mb10_sid, 'abc.def');
  assert.equal(cookies.theme, 'dark');
  assert.equal(({}).polluted, undefined);
});

test('isSameOriginRequest allows same-origin and blocks cross-origin CSRF attempts', () => {
  assert.equal(
    isSameOriginRequest({ headers: { host: 'localhost:3000', origin: 'http://localhost:3000' } }),
    true
  );
  assert.equal(
    isSameOriginRequest({ headers: { 'x-forwarded-host': 'app.example.com', origin: 'https://app.example.com' } }),
    true
  );
  assert.equal(
    isSameOriginRequest({ headers: { host: 'localhost:3000', origin: 'https://evil.example' } }),
    false
  );
  assert.equal(
    isSameOriginRequest({ headers: { host: 'localhost:3000', origin: 'null' } }),
    false
  );
  assert.equal(
    isSameOriginRequest({ headers: { host: 'localhost:3000', referer: 'https://evil.example/phish' } }),
    false
  );
});
