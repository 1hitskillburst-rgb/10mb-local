// ==========================================================================
// 10mb.video — Application Controller (Unified SPA)
// ==========================================================================

(() => {
  'use strict';

  // ---- Application State ----
  let currentView = 'home';
  let selectedFile = null;
  let uploadedFileId = null;
  let eventSource = null;
  let videoObjectUrl = null;
  let videoDuration = 0;
  let trimStartRatio = 0;    // 0 to 1
  let trimEndRatio = 1;      // 0 to 1
  let isDraggingTrim = null; // 'start' | 'end' | null
  let isPlayingPreview = false;
  let previewRafId = null;
  let outputVolume = 100;    // 0 to 200%
  let isMuted = false;
  let volumeBeforeMute = 100;
  let selectedFormat = 'mp4';
  let clips = [];
  let activeClip = null;

  // ---- DOM Elements ----
  // Navigation & Views
  const views = ['home', 'studio', 'clips'];
  const navLinks = document.querySelectorAll('.links button');
  const navClipBadge = document.getElementById('navClipBadge');
  const homeClipCount = document.getElementById('homeClipCount');
  const themeToggle = document.getElementById('themeToggle');

  // Home Page
  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  const chooseFileBtn = document.getElementById('chooseFileBtn');
  const ringSvg = document.getElementById('ring');

  // Studio Trimmer & Player
  const studioDuration = document.getElementById('studioDuration');
  const videoPreview = document.getElementById('videoPreview');
  const playBtn = document.getElementById('playBtn');
  const playIcon = document.getElementById('playIcon');
  const trimBar = document.getElementById('trimBar');
  const trimSelected = document.getElementById('trimSelected');
  const trimHandleStart = document.getElementById('trimHandleStart');
  const trimHandleEnd = document.getElementById('trimHandleEnd');
  const trimPlayhead = document.getElementById('trimPlayhead');
  const trimStartTime = document.getElementById('trimStartTime');
  const trimCurrentTime = document.getElementById('trimCurrentTime');
  const trimEndTime = document.getElementById('trimEndTime');
  const audioMuteBtn = document.getElementById('audioMuteBtn');
  const audioIcon = document.getElementById('audioIcon');
  const volumeSlider = document.getElementById('volumeSlider');
  const volumeLabel = document.getElementById('volumeLabel');

  // Studio Settings & Actions
  const fileName = document.getElementById('fileName');
  const fileSize = document.getElementById('fileSize');
  const fmtBtns = document.querySelectorAll('#fmt button');
  const qualityEst = document.getElementById('qualityEst');
  const szEl = document.getElementById('sz');
  const sz2El = document.getElementById('sz2');
  const slider = document.getElementById('slider');
  const presetChips = document.querySelectorAll('#chips .chip');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const fpsSelect = document.getElementById('fpsSelect');
  const speedSelect = document.getElementById('speedSelect');
  const aspectSelect = document.getElementById('aspectSelect');
  const audioSelect = document.getElementById('audioSelect');
  const compressBtn = document.getElementById('compressBtn');

  // Studio Progress & Results
  const progressCard = document.getElementById('progressCard');
  const progressStatus = document.getElementById('progressStatus');
  const progressPercent = document.getElementById('progressPercent');
  const progressBar = document.getElementById('progressBar');
  const resultCard = document.getElementById('resultCard');
  const originalSize = document.getElementById('originalSize');
  const compressedSize = document.getElementById('compressedSize');
  const compressionRatio = document.getElementById('compressionRatio');
  const downloadBtn = document.getElementById('downloadBtn');
  const saveClipBtn = document.getElementById('saveClipBtn');
  const openCompareBtn = document.getElementById('openCompareBtn');

  // Comparison Modal
  const compareModal = document.getElementById('compareModal');
  const closeCompareModal = document.getElementById('closeCompareModal');
  const compareOriginal = document.getElementById('compareOriginal');
  const compareOutput = document.getElementById('compareOutput');
  const comparePlayBtn = document.getElementById('comparePlayBtn');
  const comparePlayText = document.getElementById('comparePlayText');

  // Clips Page
  const ytVideo = document.getElementById('ytVideo');
  const activeClipTitle = document.getElementById('activeClipTitle');
  const activeClipMeta = document.getElementById('activeClipMeta');
  const activeClipDownloadBtn = document.getElementById('activeClipDownloadBtn');
  const activeClipDeleteBtn = document.getElementById('activeClipDeleteBtn');
  const sidebarCount = document.getElementById('sidebarCount');
  const searchInput = document.getElementById('searchInput');
  const clipsList = document.getElementById('clipsList');
  const directUploadInput = document.getElementById('directUploadInput');

  // Toast
  const toastEl = document.getElementById('toast');

  // ==========================================
  //  ROUTING & VIEW MANAGEMENT
  // ==========================================

  function go(viewName) {
    if (!views.includes(viewName)) viewName = 'home';
    currentView = viewName;

    // Toggle view sections
    views.forEach(v => {
      const el = document.getElementById(v);
      if (el) el.classList.toggle('on', v === viewName);
    });

    // Update nav links aria-current
    navLinks.forEach(b => {
      if (b.dataset.go === viewName) {
        b.setAttribute('aria-current', 'page');
      } else {
        b.removeAttribute('aria-current');
      }
    });

    // Pause studio video when navigating away
    if (viewName !== 'studio' && videoPreview && !videoPreview.paused) {
      videoPreview.pause();
      isPlayingPreview = false;
      updatePlayPauseIcon();
    }

    // Refresh clips if entering clips page
    if (viewName === 'clips') {
      loadClips();
    }

    window.location.hash = viewName;
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Handle all [data-go] click triggers
  document.querySelectorAll('[data-go]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      go(b.dataset.go);
    });
  });

  // Handle URL hash on initial load & popstate
  window.addEventListener('popstate', () => {
    const hash = window.location.hash.replace('#', '');
    if (views.includes(hash)) {
      go(hash);
    }
  });

  // ==========================================
  //  THEME TOGGLE & PERSISTENCE
  // ==========================================

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('10mb_theme', theme);
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  const savedTheme = localStorage.getItem('10mb_theme');
  if (savedTheme) {
    applyTheme(savedTheme);
  }

  // ==========================================
  //  FORMAT UTILITIES & TOAST
  // ==========================================

  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 MB';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB'];
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

  function escapeHTML(str) {
    if (!str) return '';
    return String(str).replace(/[&<>'"]/g, tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag));
  }

  function showToast(message, type = 'normal') {
    if (!toastEl) return;
    toastEl.textContent = message;
    toastEl.className = `toast ${type} visible`;
    clearTimeout(toastEl._timer);
    toastEl._timer = setTimeout(() => {
      toastEl.classList.remove('visible');
    }, 4000);
  }

  // ==========================================
  //  ROTATING SVG RING GENERATION
  // ==========================================

  if (ringSvg) {
    const N = 64;
    let svgContent = '';
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const r = Math.round(242 - (242 - 140) * t);
      const g = Math.round(85 + (110 - 85) * t);
      const b = Math.round(44 + (120 - 44) * t);
      const angle = (i * 180 / N).toFixed(1);
      const tx = (Math.sin(t * Math.PI * 2) * 6).toFixed(1);
      svgContent += `<ellipse rx="78" ry="28" fill="none" stroke="rgb(${r},${g},${b})" stroke-width="0.75" transform="rotate(${angle}) translate(${tx} 0)"/>`;
    }
    ringSvg.innerHTML = svgContent;
  }

  // ==========================================
  //  FILE SELECTION & DRAG-AND-DROP
  // ==========================================

  function isVideoFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith('video/')) return true;
    const ext = file.name.split('.').pop().toLowerCase();
    return ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'ts'].includes(ext);
  }

  function handleVideoFile(file) {
    if (!file) return;
    if (!isVideoFile(file)) {
      showToast('Please upload a valid video file (MP4, MOV, AVI, MKV, WebM, etc.).', 'error');
      return;
    }

    selectedFile = file;
    uploadedFileId = null;

    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);

    if (videoObjectUrl) {
      URL.revokeObjectURL(videoObjectUrl);
    }
    videoObjectUrl = URL.createObjectURL(file);
    videoPreview.src = videoObjectUrl;
    compareOriginal.src = videoObjectUrl;

    videoPreview.addEventListener('loadedmetadata', onVideoMetadataLoaded, { once: true });

    // Reset trim and volume state
    trimStartRatio = 0;
    trimEndRatio = 1;
    isPlayingPreview = false;
    updatePlayPauseIcon();

    outputVolume = 100;
    isMuted = false;
    updateVolumeUI();

    // Reset progress and results
    progressCard.classList.remove('visible');
    resultCard.classList.remove('visible');
    compressBtn.disabled = false;

    // Navigate to studio
    go('studio');
  }

  function onVideoMetadataLoaded() {
    videoDuration = videoPreview.duration || 0;
    studioDuration.textContent = `Length ${formatTime(videoDuration)}`;

    trimStartRatio = 0;
    trimEndRatio = 1;

    updateTrimUI();
    updatePlayheadUI();

    videoPreview.currentTime = 0;

    // Allow user to set target up to 100MB or higher (defaulting to 10MB)
    const fileMB = Math.ceil(selectedFile.size / (1024 * 1024));
    const sliderMax = Math.min(500, Math.max(100, fileMB));
    slider.max = sliderMax;

    setTargetSize(10);
  }

  if (chooseFileBtn && fileInput) {
    chooseFileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
  }

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files && e.dataTransfer.files[0]) {
        handleVideoFile(e.dataTransfer.files[0]);
      }
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files[0]) {
        handleVideoFile(fileInput.files[0]);
      }
      fileInput.value = '';
    });
  }

  // Global window drop prevention
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());

  // ==========================================
  //  STUDIO VIDEO PLAYER & TRIM SCRUBBER
  // ==========================================

  function getTrimStartSeconds() {
    return trimStartRatio * videoDuration;
  }

  function getTrimEndSeconds() {
    return trimEndRatio * videoDuration;
  }

  function getTrimDuration() {
    return Math.max(0, getTrimEndSeconds() - getTrimStartSeconds());
  }

  function updateTrimUI() {
    const startPct = trimStartRatio * 100;
    const endPct = trimEndRatio * 100;

    trimHandleStart.style.left = `${startPct}%`;
    trimHandleEnd.style.left = `${endPct}%`;

    trimSelected.style.left = `${startPct}%`;
    trimSelected.style.width = `${endPct - startPct}%`;

    trimStartTime.textContent = formatTime(getTrimStartSeconds());
    trimEndTime.textContent = formatTime(getTrimEndSeconds());
    studioDuration.textContent = `Length ${formatTime(getTrimDuration())}`;

    updateQualityEstimate();
  }

  function updatePlayheadUI() {
    if (!videoDuration) return;
    const currentRatio = videoPreview.currentTime / videoDuration;
    trimPlayhead.style.left = `${currentRatio * 100}%`;
    trimCurrentTime.textContent = formatTime(videoPreview.currentTime);
  }

  function startPreviewLoop() {
    cancelAnimationFrame(previewRafId);
    function tick() {
      updatePlayheadUI();
      const endSec = getTrimEndSeconds();
      const startSec = getTrimStartSeconds();
      if (videoPreview.currentTime >= endSec - 0.05) {
        videoPreview.currentTime = startSec;
      }
      if (!videoPreview.paused) {
        previewRafId = requestAnimationFrame(tick);
      }
    }
    previewRafId = requestAnimationFrame(tick);
  }

  function stopPreviewLoop() {
    cancelAnimationFrame(previewRafId);
  }

  function updatePlayPauseIcon() {
    if (!playIcon || !playBtn) return;
    if (videoPreview.paused) {
      playIcon.innerHTML = '<path d="M7 4l13 8-13 8z"/>';
      playBtn.classList.remove('hidden');
    } else {
      playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1" fill="#f2552c"/><rect x="14" y="5" width="4" height="14" rx="1" fill="#f2552c"/>';
      playBtn.classList.add('hidden');
    }
  }

  function togglePlayPreview() {
    if (!videoPreview.src) return;
    if (videoPreview.paused) {
      const startSec = getTrimStartSeconds();
      const endSec = getTrimEndSeconds();
      if (videoPreview.currentTime < startSec || videoPreview.currentTime >= endSec - 0.1) {
        videoPreview.currentTime = startSec;
      }
      videoPreview.play().then(() => {
        isPlayingPreview = true;
        updatePlayPauseIcon();
        startPreviewLoop();
      }).catch(() => {});
    } else {
      videoPreview.pause();
      isPlayingPreview = false;
      updatePlayPauseIcon();
      stopPreviewLoop();
    }
  }

  if (playBtn) playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlayPreview(); });
  if (videoPreview) {
    videoPreview.addEventListener('click', togglePlayPreview);
    videoPreview.addEventListener('play', () => { updatePlayPauseIcon(); startPreviewLoop(); });
    videoPreview.addEventListener('pause', () => { updatePlayPauseIcon(); stopPreviewLoop(); updatePlayheadUI(); });
    videoPreview.addEventListener('ended', () => {
      videoPreview.currentTime = getTrimStartSeconds();
      updatePlayPauseIcon();
      stopPreviewLoop();
    });
  }

  // Trim handle dragging logic
  function getTrimBarRatio(clientX) {
    const rect = trimBar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }

  function onTrimDragStart(type, e) {
    e.preventDefault();
    isDraggingTrim = type;
    document.body.style.cursor = 'ew-resize';

    if (videoPreview && !videoPreview.paused) {
      videoPreview.pause();
      isPlayingPreview = false;
      updatePlayPauseIcon();
    }
  }

  function onTrimDragMove(clientX) {
    if (!isDraggingTrim || !videoDuration) return;
    const ratio = getTrimBarRatio(clientX);
    const MIN_GAP = 0.01;

    if (isDraggingTrim === 'start') {
      trimStartRatio = Math.min(ratio, trimEndRatio - MIN_GAP);
      trimStartRatio = Math.max(0, trimStartRatio);
      videoPreview.currentTime = getTrimStartSeconds();
    } else {
      trimEndRatio = Math.max(ratio, trimStartRatio + MIN_GAP);
      trimEndRatio = Math.min(1, trimEndRatio);
      videoPreview.currentTime = getTrimEndSeconds();
    }

    updateTrimUI();
    updatePlayheadUI();
  }

  function onTrimDragEnd() {
    if (!isDraggingTrim) return;
    isDraggingTrim = null;
    document.body.style.cursor = '';
  }

  if (trimHandleStart && trimHandleEnd && trimBar) {
    trimHandleStart.addEventListener('mousedown', (e) => onTrimDragStart('start', e));
    trimHandleEnd.addEventListener('mousedown', (e) => onTrimDragStart('end', e));
    trimHandleStart.addEventListener('touchstart', (e) => onTrimDragStart('start', e), { passive: false });
    trimHandleEnd.addEventListener('touchstart', (e) => onTrimDragStart('end', e), { passive: false });

    document.addEventListener('mousemove', (e) => {
      if (isDraggingTrim) onTrimDragMove(e.clientX);
    });
    document.addEventListener('touchmove', (e) => {
      if (isDraggingTrim && e.touches[0]) onTrimDragMove(e.touches[0].clientX);
    }, { passive: false });

    document.addEventListener('mouseup', onTrimDragEnd);
    document.addEventListener('touchend', onTrimDragEnd);

    // Click to seek scrubber
    trimBar.addEventListener('click', (e) => {
      if (isDraggingTrim || e.target.closest('.trim-handle')) return;
      const ratio = getTrimBarRatio(e.clientX);
      const clamped = Math.max(trimStartRatio, Math.min(trimEndRatio, ratio));
      videoPreview.currentTime = clamped * videoDuration;
      updatePlayheadUI();
    });
  }

  // ==========================================
  //  AUDIO VOLUME CONTROLS
  // ==========================================

  const VOL_ICON_HIGH = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>';
  const VOL_ICON_MUTE = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';

  function updateVolumeUI() {
    if (!volumeLabel || !volumeSlider || !audioIcon) return;
    volumeLabel.textContent = `${outputVolume}%`;
    volumeSlider.value = outputVolume;

    if (videoPreview) {
      videoPreview.volume = Math.min(outputVolume / 100, 1);
      videoPreview.muted = isMuted || outputVolume === 0;
    }

    if (isMuted || outputVolume === 0) {
      audioIcon.innerHTML = VOL_ICON_MUTE;
    } else {
      audioIcon.innerHTML = VOL_ICON_HIGH;
    }
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      outputVolume = parseInt(volumeSlider.value, 10);
      isMuted = false;
      updateVolumeUI();
    });
  }

  if (audioMuteBtn) {
    audioMuteBtn.addEventListener('click', () => {
      if (isMuted) {
        isMuted = false;
        outputVolume = volumeBeforeMute || 100;
      } else {
        volumeBeforeMute = outputVolume;
        isMuted = true;
      }
      updateVolumeUI();
    });
  }

  // ==========================================
  //  TARGET FILE SIZE & QUALITY ESTIMATOR
  // ==========================================

  function updateQualityEstimate() {
    if (!qualityEst) return;
    const duration = getTrimDuration() || videoDuration || 5;
    const targetMB = parseInt(slider.value, 10) || 10;
    const speed = parseFloat(speedSelect.value) || 1.0;
    const effectiveSec = duration / speed;

    const totalBits = targetMB * 1024 * 1024 * 8 * 0.95;
    const kbps = Math.floor(totalBits / effectiveSec / 1000);

    if (kbps >= 2500) {
      qualityEst.textContent = `Excellent quality (~${(kbps / 1000).toFixed(1)} Mbps)`;
    } else if (kbps >= 1200) {
      qualityEst.textContent = `Great quality (~${(kbps / 1000).toFixed(1)} Mbps)`;
    } else if (kbps >= 600) {
      qualityEst.textContent = `Good quality (${kbps} kbps)`;
    } else {
      qualityEst.textContent = `Compact quality (${kbps} kbps)`;
    }
  }

  function setTargetSize(mb) {
    const clamped = Math.max(10, parseInt(mb, 10) || 10);
    slider.value = clamped;
    szEl.textContent = clamped;
    sz2El.textContent = clamped;

    presetChips.forEach(chip => {
      chip.classList.toggle('on', parseInt(chip.dataset.v, 10) === clamped);
    });

    updateQualityEstimate();
  }

  if (slider) {
    slider.addEventListener('input', () => setTargetSize(slider.value));
  }

  presetChips.forEach(chip => {
    chip.addEventListener('click', () => setTargetSize(chip.dataset.v));
  });

  // Format Selection
  fmtBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      fmtBtns.forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      selectedFormat = btn.dataset.format || 'mp4';

      if (selectedFormat === 'mp3') {
        resolutionSelect.disabled = true;
        fpsSelect.disabled = true;
        aspectSelect.disabled = true;
      } else if (selectedFormat === 'gif') {
        resolutionSelect.disabled = false;
        fpsSelect.disabled = true;
        aspectSelect.disabled = false;
      } else {
        resolutionSelect.disabled = false;
        fpsSelect.disabled = false;
        aspectSelect.disabled = false;
      }

      updateQualityEstimate();
    });
  });

  if (speedSelect) speedSelect.addEventListener('change', updateQualityEstimate);

  // ==========================================
  //  COMPRESSION WORKFLOW
  // ==========================================

  function setProgress(percent, statusText) {
    const clamped = Math.min(100, Math.max(0, percent));
    progressBar.style.width = `${clamped}%`;
    progressPercent.textContent = `${Math.round(clamped)}%`;
    if (statusText) progressStatus.textContent = statusText;
  }

  if (compressBtn) {
    compressBtn.addEventListener('click', () => {
      if (!selectedFile) {
        showToast('Please select a video file first.', 'error');
        return;
      }
      startCompression();
    });
  }

  async function startCompression() {
    if (videoPreview && !videoPreview.paused) {
      videoPreview.pause();
      isPlayingPreview = false;
      updatePlayPauseIcon();
    }

    compressBtn.disabled = true;
    resultCard.classList.remove('visible');
    progressCard.classList.add('visible');
    setProgress(0, 'Uploading video…');

    try {
      const uploadData = await uploadFile(selectedFile);
      uploadedFileId = uploadData.id;

      setProgress(0, 'Compressing with FFmpeg…');
      const trimStart = getTrimStartSeconds();
      const trimEnd = getTrimEndSeconds();
      const vol = isMuted ? 0 : outputVolume;

      const opts = {
        format: selectedFormat,
        speed: parseFloat(speedSelect.value) || 1.0,
        aspectRatio: aspectSelect.value,
        resolution: resolutionSelect.value,
        fps: fpsSelect.value,
      };

      if (audioSelect.value === 'mute') {
        opts.muteAudio = true;
      } else {
        opts.audioBitrate = parseInt(audioSelect.value, 10) || 128;
      }

      // Connect progress listener before triggering async compression to prevent race conditions
      subscribeProgress(uploadedFileId);
      await requestCompression(uploadedFileId, parseInt(slider.value, 10), trimStart, trimEnd, vol, opts);

    } catch (err) {
      showToast(err.message || 'Compression failed. Please try again.', 'error');
      progressCard.classList.remove('visible');
      compressBtn.disabled = false;
    }
  }

  function uploadFile(file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const fd = new FormData();
      fd.append('video', file);

      xhr.open('POST', '/api/upload', true);

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) {
          const pct = (e.loaded / e.total) * 100;
          setProgress(pct, 'Uploading video…');
        }
      });

      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            const data = JSON.parse(xhr.responseText);
            if (data.id) resolve(data);
            else reject(new Error('Upload completed but missing file ID.'));
          } catch {
            reject(new Error('Invalid response from upload server.'));
          }
        } else {
          let msg = 'Upload failed.';
          try {
            const err = JSON.parse(xhr.responseText);
            if (err.error) msg = err.error;
          } catch (_) {}
          reject(new Error(msg));
        }
      });

      xhr.addEventListener('error', () => reject(new Error('Network error during file upload.')));
      xhr.send(fd);
    });
  }

  async function requestCompression(id, targetMB, trimStart, trimEnd, vol, extraOpts = {}) {
    const body = { id, targetMB, ...extraOpts };

    if (trimStart > 0.1 || (videoDuration - trimEnd) > 0.1) {
      body.trimStart = trimStart;
      body.trimEnd = trimEnd;
    }

    const volumeMultiplier = vol / 100;
    if (Math.abs(volumeMultiplier - 1) > 0.01) {
      body.volume = volumeMultiplier;
    }

    const res = await fetch('/api/compress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let msg = 'Failed to start compression.';
      try {
        const err = await res.json();
        if (err.error) msg = err.error;
      } catch (_) {}
      throw new Error(msg);
    }

    return res.json();
  }

  function subscribeProgress(id) {
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }

    eventSource = new EventSource(`/api/progress/${id}`);

    eventSource.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        const percent = data.percent || 0;
        const stage = data.stage || 'compressing';
        const stageMap = {
          trimming: 'Trimming clip…',
          analyzing: 'Analyzing streams…',
          compressing: 'Encoding pass…',
          done: 'Finalizing…',
        };
        setProgress(percent, stageMap[stage] || 'Compressing…');
      } catch (_) {}
    });

    eventSource.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data);
        onCompressionDone(data);
      } catch {
        showToast('Compression finished but result payload was invalid.', 'error');
        progressCard.classList.remove('visible');
        compressBtn.disabled = false;
      }
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    });

    eventSource.addEventListener('error', (e) => {
      // If result card is already visible or connection closed normally, ignore
      if (resultCard && resultCard.classList.contains('visible')) {
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        return;
      }

      if (e.data) {
        try {
          const err = JSON.parse(e.data);
          showToast(err.message || 'Compression error.', 'error');
        } catch (_) {
          showToast('Compression error occurred.', 'error');
        }
      } else {
        showToast('Connection interrupted during compression.', 'error');
      }
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      progressCard.classList.remove('visible');
      compressBtn.disabled = false;
    });
  }

  function onCompressionDone(data) {
    const origBytes = data.originalSize || (selectedFile ? selectedFile.size : 0);
    const compBytes = data.compressedSize || 0;
    const downloadUrl = data.downloadUrl || '#';
    const outputUrl = data.outputUrl || '';
    const format = data.format || 'mp4';

    originalSize.textContent = formatBytes(origBytes);
    compressedSize.textContent = formatBytes(compBytes);

    if (origBytes > 0 && compBytes > 0) {
      const saved = ((1 - compBytes / origBytes) * 100).toFixed(1);
      compressionRatio.textContent = `${saved}% smaller`;
    } else {
      compressionRatio.textContent = 'Optimized';
    }

    downloadBtn.href = downloadUrl;

    // Side-by-side comparison popout setup
    if (format === 'mp4' && outputUrl) {
      openCompareBtn.style.display = 'inline-flex';
      compareOutput.src = outputUrl;
      compareOriginal.src = videoObjectUrl;
      const startSec = getTrimStartSeconds();
      compareOriginal.currentTime = startSec;
      compareOutput.currentTime = 0;
    } else {
      openCompareBtn.style.display = 'none';
    }

    progressCard.classList.remove('visible');
    resultCard.classList.add('visible');
    compressBtn.disabled = false;
    setProgress(100, 'Complete!');
    showToast('Video compression complete!', 'success');
  }

  // ==========================================
  //  SAVE TO STORED CLIPS
  // ==========================================

  if (saveClipBtn) {
    saveClipBtn.addEventListener('click', async () => {
      if (!uploadedFileId) {
        showToast('No compressed clip available to save.', 'error');
        return;
      }

      saveClipBtn.disabled = true;
      const originalHTML = saveClipBtn.innerHTML;
      saveClipBtn.innerHTML = '<span>Saving to Library…</span>';

      try {
        const payload = {
          id: uploadedFileId,
          title: selectedFile ? selectedFile.name : 'Untitled Clip',
          originalName: selectedFile ? selectedFile.name : 'video.mp4',
          format: selectedFormat || 'mp4',
          duration: getTrimDuration() || videoDuration || 0,
        };

        const res = await fetch('/api/clips/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (res.ok && data.success) {
          saveClipBtn.innerHTML = '<span>✓ Saved to Stored Clips</span>';
          showToast('Saved to your Stored Clips library!', 'success');
          loadClips();
        } else {
          showToast(data.error || 'Failed to save clip.', 'error');
          saveClipBtn.innerHTML = originalHTML;
          saveClipBtn.disabled = false;
        }
      } catch (err) {
        showToast(err.message || 'Error saving clip.', 'error');
        saveClipBtn.innerHTML = originalHTML;
        saveClipBtn.disabled = false;
      }
    });
  }

  // ==========================================
  //  SIDE-BY-SIDE COMPARISON MODAL
  // ==========================================

  function openComparisonModal() {
    if (!compareModal) return;
    compareModal.classList.add('visible');
    document.body.style.overflow = 'hidden';
  }

  function closeComparisonModal() {
    if (!compareModal) return;
    compareModal.classList.remove('visible');
    document.body.style.overflow = '';
    if (compareOriginal) compareOriginal.pause();
    if (compareOutput) compareOutput.pause();
    comparePlayText.textContent = 'Play Both';
  }

  if (openCompareBtn) openCompareBtn.addEventListener('click', openComparisonModal);
  if (closeCompareModal) closeCompareModal.addEventListener('click', closeComparisonModal);
  if (compareModal) {
    compareModal.addEventListener('click', (e) => {
      if (e.target === compareModal) closeComparisonModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && compareModal && compareModal.classList.contains('visible')) {
      closeComparisonModal();
    }
  });

  if (comparePlayBtn && compareOriginal && compareOutput) {
    comparePlayBtn.addEventListener('click', () => {
      if (compareOriginal.paused) {
        const startSec = getTrimStartSeconds();
        const endSec = getTrimEndSeconds();
        if (compareOriginal.currentTime < startSec || compareOriginal.currentTime >= endSec - 0.1) {
          compareOriginal.currentTime = startSec;
          compareOutput.currentTime = 0;
        }
        compareOriginal.play().catch(() => {});
        compareOutput.play().catch(() => {});
        comparePlayText.textContent = 'Pause Both';
      } else {
        compareOriginal.pause();
        compareOutput.pause();
        comparePlayText.textContent = 'Play Both';
      }
    });

    compareOriginal.addEventListener('timeupdate', () => {
      const startSec = getTrimStartSeconds();
      const endSec = getTrimEndSeconds();
      if (compareOriginal.currentTime >= endSec - 0.05) {
        compareOriginal.currentTime = startSec;
        compareOutput.currentTime = 0;
      }
    });

    compareOutput.addEventListener('ended', () => {
      const startSec = getTrimStartSeconds();
      compareOriginal.currentTime = startSec;
      compareOutput.currentTime = 0;
      if (!compareOriginal.paused) {
        compareOriginal.play().catch(() => {});
      }
    });
  }

  // ==========================================
  //  STORED CLIPS LIBRARY
  // ==========================================

  async function loadClips() {
    try {
      const res = await fetch('/api/clips');
      if (!res.ok) throw new Error('Failed to load stored clips');
      clips = await res.json();
      updateClipsBadges(clips.length);
      renderClipsList(searchInput ? searchInput.value : '');

      if (clips.length > 0) {
        selectClip(clips[0]);
      } else {
        renderEmptyClipsState();
      }
    } catch (err) {
      console.error('Failed to load clips:', err);
      updateClipsBadges(0);
      renderEmptyClipsState();
    }
  }

  function updateClipsBadges(count) {
    if (navClipBadge) navClipBadge.textContent = count;
    if (homeClipCount) homeClipCount.textContent = `${count} clip${count === 1 ? '' : 's'} saved`;
    if (sidebarCount) sidebarCount.textContent = `${count} clip${count === 1 ? '' : 's'}`;
  }

  function renderClipsList(filterText = '') {
    if (!clipsList) return;
    clipsList.innerHTML = '';

    const q = filterText.trim().toLowerCase();
    const filtered = clips.filter(c =>
      (c.title || '').toLowerCase().includes(q) ||
      (c.format || '').toLowerCase().includes(q)
    );

    if (sidebarCount) {
      sidebarCount.textContent = `${filtered.length} clip${filtered.length === 1 ? '' : 's'}`;
    }

    if (filtered.length === 0) {
      if (clips.length === 0) {
        renderEmptyClipsState();
      } else {
        clipsList.innerHTML = `<div style="padding: 24px; text-align: center; color: var(--mute)">No clips matching "${escapeHTML(filterText)}"</div>`;
      }
      return;
    }

    filtered.forEach(clip => {
      const row = document.createElement('div');
      row.className = `row ${activeClip && activeClip.id === clip.id ? 'active' : ''}`;
      row.dataset.id = clip.id;

      const dateStr = clip.createdAt ? new Date(clip.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recently';
      const safeTitle = escapeHTML(clip.title || clip.originalName || 'Untitled Clip');
      const safeFormat = escapeHTML(clip.format || 'MP4').toUpperCase();
      const safeStreamUrl = encodeURI(clip.streamUrl || `/api/clips/stream/${encodeURIComponent(clip.filename)}`);

      row.innerHTML = `
        <div class="thumb">
          <video src="${safeStreamUrl}#t=0.5" preload="metadata" muted></video>
          <span>${formatTime(clip.duration)}</span>
        </div>
        <div style="flex:1;overflow:hidden">
          <b>${safeTitle}</b>
          <span class="small">${safeFormat} &nbsp;•&nbsp; ${formatBytes(clip.size)} &nbsp;•&nbsp; ${dateStr}</span>
        </div>
      `;

      row.addEventListener('click', () => selectClip(clip));
      clipsList.appendChild(row);
    });
  }

  function selectClip(clip) {
    if (!clip) return;
    activeClip = clip;

    // Highlight row in list
    document.querySelectorAll('.clips-list .row').forEach(r => {
      r.classList.toggle('active', r.dataset.id === clip.id);
    });

    // Populate metadata & download button safely
    activeClipTitle.textContent = clip.title || clip.originalName || 'Untitled Clip';
    const dateStr = clip.createdAt ? new Date(clip.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recently';
    activeClipMeta.textContent = `${(clip.format || 'MP4').toUpperCase()}  •  ${formatBytes(clip.size)}  •  ${dateStr}`;
    activeClipDownloadBtn.href = clip.downloadUrl || `/api/clips/download/${encodeURIComponent(clip.filename)}`;

    if (activeClipDownloadBtn) {
      activeClipDownloadBtn.style.pointerEvents = '';
      activeClipDownloadBtn.style.opacity = '1';
    }
    if (activeClipDeleteBtn) {
      activeClipDeleteBtn.disabled = false;
      activeClipDeleteBtn.style.opacity = '1';
    }

    // Load stream into player
    ytVideo.src = clip.streamUrl || `/api/clips/stream/${encodeURIComponent(clip.filename)}`;
    ytVideo.load();
  }

  function renderEmptyClipsState() {
    if (clipsList) {
      clipsList.innerHTML = `
        <div style="padding: 32px 16px; text-align: center; color: var(--mute)">
          <p style="margin-bottom: 12px">No stored clips yet.</p>
          <span class="small">Upload or compress a video to save clips here.</span>
        </div>
      `;
    }
    if (activeClipTitle) activeClipTitle.textContent = 'No clips stored';
    if (activeClipMeta) activeClipMeta.textContent = '—';
    if (ytVideo) {
      ytVideo.pause();
      ytVideo.removeAttribute('src');
      ytVideo.load();
    }
    if (activeClipDownloadBtn) {
      activeClipDownloadBtn.style.pointerEvents = 'none';
      activeClipDownloadBtn.style.opacity = '0.5';
      activeClipDownloadBtn.removeAttribute('href');
    }
    if (activeClipDeleteBtn) {
      activeClipDeleteBtn.disabled = true;
      activeClipDeleteBtn.style.opacity = '0.5';
    }
  }

  // Delete clip action
  if (activeClipDeleteBtn) {
    activeClipDeleteBtn.addEventListener('click', async () => {
      if (!activeClip) return;
      if (!confirm(`Are you sure you want to delete "${activeClip.title}"?`)) return;

      try {
        const res = await fetch(`/api/clips/${activeClip.id}`, { method: 'DELETE' });
        if (res.ok) {
          clips = clips.filter(c => c.id !== activeClip.id);
          updateClipsBadges(clips.length);
          renderClipsList(searchInput ? searchInput.value : '');
          if (clips.length > 0) {
            selectClip(clips[0]);
          } else {
            activeClip = null;
            renderEmptyClipsState();
          }
          showToast('Clip deleted from library.', 'normal');
        } else {
          showToast('Failed to delete clip.', 'error');
        }
      } catch {
        showToast('Error deleting clip.', 'error');
      }
    });
  }

  // Search input filter
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderClipsList(searchInput.value);
    });
  }

  // Direct upload to stored clips
  if (directUploadInput) {
    directUploadInput.addEventListener('change', async () => {
      const file = directUploadInput.files[0];
      if (!file) return;

      const fd = new FormData();
      fd.append('video', file);

      showToast('Uploading clip to library…', 'normal');

      try {
        const res = await fetch('/api/clips/upload', {
          method: 'POST',
          body: fd,
        });

        const data = await res.json();
        if (res.ok && data.clip) {
          clips.unshift(data.clip);
          updateClipsBadges(clips.length);
          renderClipsList(searchInput ? searchInput.value : '');
          selectClip(data.clip);
          showToast('Clip uploaded and saved to library!', 'success');
        } else {
          showToast(data.error || 'Failed to upload clip', 'error');
        }
      } catch {
        showToast('Error uploading clip.', 'error');
      } finally {
        directUploadInput.value = '';
      }
    });
  }

  // ==========================================
  //  INITIALIZATION
  // ==========================================

  // Check initial hash route
  const initHash = window.location.hash.replace('#', '');
  if (views.includes(initHash)) {
    go(initHash);
  } else {
    go('home');
  }

  // Pre-load clips count
  loadClips();

})();
