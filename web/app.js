// ==========================================================================
// 10mb.video — Application Controller (Private, Leak-Free Unified SPA)
// ==========================================================================

(() => {
  'use strict';

  // ---- Application State ----
  let currentView = 'home';
  let selectedFile = null;
  let uploadedFileId = null;
  let eventSource = null;
  let activeBatchEventSource = null;
  let activeUploadXhr = null;
  let videoObjectUrl = null;
  let outputObjectUrl = null;
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
  let searchDebounceTimer = null;
  let confirmResolver = null;

  // ---- DOM Elements ----
  const views = ['home', 'studio', 'batch', 'clips'];
  const navLinks = document.querySelectorAll('.links button');
  const navClipBadge = document.getElementById('navClipBadge');
  const navBatchBadge = document.getElementById('navBatchBadge');
  const homeClipCount = document.getElementById('homeClipCount');
  const themeToggle = document.getElementById('themeToggle');
  const purgePrivacyBtn = document.getElementById('purgePrivacyBtn');

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
  const changeFileBtn = document.getElementById('changeFileBtn');
  const fmtBtns = document.querySelectorAll('#fmt button');
  const qualityEst = document.getElementById('qualityEst');
  const szEl = document.getElementById('sz');
  const sz2El = document.getElementById('sz2');
  const slider = document.getElementById('slider');
  const presetChips = document.querySelectorAll('#chips .chip');
  const resolutionSelect = document.getElementById('resolutionSelect');
  const encoderSelect = document.getElementById('encoderSelect');
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
  const saveClipDefaultHTML = saveClipBtn ? saveClipBtn.innerHTML : '';
  const openCompareBtn = document.getElementById('openCompareBtn');

  // Comparison Modal
  const compareModal = document.getElementById('compareModal');
  const closeCompareModal = document.getElementById('closeCompareModal');
  const compareOriginal = document.getElementById('compareOriginal');
  const compareOutput = document.getElementById('compareOutput');
  const comparePlayBtn = document.getElementById('comparePlayBtn');
  const comparePlayText = document.getElementById('comparePlayText');

  // Confirmation Modal
  const confirmModal = document.getElementById('confirmModal');
  const confirmModalTitle = document.getElementById('confirmModalTitle');
  const confirmModalMessage = document.getElementById('confirmModalMessage');
  const confirmCancelBtn = document.getElementById('confirmCancelBtn');
  const confirmCancelX = document.getElementById('confirmCancelX');
  const confirmAcceptBtn = document.getElementById('confirmAcceptBtn');

  // Clips Page
  const ytVideo = document.getElementById('ytVideo');
  const ytGifPreview = document.getElementById('ytGifPreview');
  const ytAudioPlaceholder = document.getElementById('ytAudioPlaceholder');
  const ytAudio = document.getElementById('ytAudio');
  const activeClipTitle = document.getElementById('activeClipTitle');
  const activeClipMeta = document.getElementById('activeClipMeta');
  const activeClipDownloadBtn = document.getElementById('activeClipDownloadBtn');
  const activeClipDeleteBtn = document.getElementById('activeClipDeleteBtn');
  const sidebarCount = document.getElementById('sidebarCount');
  const searchInput = document.getElementById('searchInput');
  const clipsList = document.getElementById('clipsList');
  const directUploadInput = document.getElementById('directUploadInput');

  // Batch Queue
  const startBatchBtn = document.getElementById('startBatchBtn');
  const batchAddInput = document.getElementById('batchAddInput');
  const clearBatchBtn = document.getElementById('clearBatchBtn');
  const batchList = document.getElementById('batchList');
  const batchChips = document.querySelectorAll('#batchChips .chip');
  let batchQueue = [];
  let isProcessingBatch = false;

  // Toast
  const toastEl = document.getElementById('toast');

  // ==========================================
  //  SECURITY & MEMORY CLEANUP HELPERS
  // ==========================================

  function isSafeMediaUrl(url) {
    if (typeof url !== 'string' || !url) return false;
    return url.startsWith('/api/') || url.startsWith('/tmp/') || url.startsWith('blob:');
  }

  function revokeUrl(url) {
    if (url && typeof url === 'string' && url.startsWith('blob:')) {
      try { URL.revokeObjectURL(url); } catch (_) {}
    }
  }

  function releaseVideoElement(videoEl) {
    if (!videoEl) return;
    try {
      videoEl.pause();
      videoEl.removeAttribute('src');
      videoEl.load();
    } catch (_) {}
  }

  function closeActiveEventSource() {
    if (eventSource) {
      try { eventSource.close(); } catch (_) {}
      eventSource = null;
    }
  }

  function apiHeaders(extra = {}) {
    return {
      'X-Requested-With': '10mb-client',
      ...extra,
    };
  }

  function resetSaveClipButton() {
    if (!saveClipBtn) return;
    saveClipBtn.disabled = false;
    saveClipBtn.innerHTML = saveClipDefaultHTML;
  }

  // Clean up all ObjectURLs, SSE streams, and XHRs when leaving page
  window.addEventListener('pagehide', () => {
    stopPreviewLoop();
    closeActiveEventSource();
    if (activeBatchEventSource) {
      try { activeBatchEventSource.close(); } catch (_) {}
      activeBatchEventSource = null;
    }
    if (activeUploadXhr) {
      try { activeUploadXhr.abort(); } catch (_) {}
      activeUploadXhr = null;
    }
    revokeUrl(videoObjectUrl);
    videoObjectUrl = null;
    revokeUrl(outputObjectUrl);
    outputObjectUrl = null;
  });

  // ==========================================
  //  IN-APP CONFIRMATION MODAL (NO window.confirm)
  // ==========================================

  function closeConfirmModal(accepted) {
    if (!confirmModal) return;
    confirmModal.classList.remove('visible');
    document.body.style.overflow = '';
    const resolve = confirmResolver;
    confirmResolver = null;
    if (resolve) resolve(Boolean(accepted));
  }

  function openConfirmModal({ title = 'Confirm action', message = '', confirmLabel = 'Confirm', danger = false }) {
    if (!confirmModal) return Promise.resolve(false);
    confirmModalTitle.textContent = title;
    confirmModalMessage.textContent = message;
    confirmAcceptBtn.textContent = confirmLabel;
    confirmAcceptBtn.className = danger ? 'btn btn-danger-solid' : 'btn';
    confirmModal.classList.add('visible');
    document.body.style.overflow = 'hidden';
    confirmAcceptBtn.focus();

    return new Promise((resolve) => {
      confirmResolver = resolve;
    });
  }

  if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', () => closeConfirmModal(false));
  if (confirmCancelX) confirmCancelX.addEventListener('click', () => closeConfirmModal(false));
  if (confirmAcceptBtn) confirmAcceptBtn.addEventListener('click', () => closeConfirmModal(true));
  if (confirmModal) {
    confirmModal.addEventListener('click', (e) => {
      if (e.target === confirmModal) closeConfirmModal(false);
    });
  }

  // ==========================================
  //  ROUTING & VIEW MANAGEMENT
  // ==========================================

  function go(viewName) {
    if (!views.includes(viewName)) viewName = 'home';
    currentView = viewName;

    views.forEach(v => {
      const el = document.getElementById(v);
      if (el) el.classList.toggle('on', v === viewName);
    });

    navLinks.forEach(b => {
      if (b.dataset.go === viewName) {
        b.setAttribute('aria-current', 'page');
      } else {
        b.removeAttribute('aria-current');
      }
    });

    if (viewName !== 'studio') {
      if (videoPreview && !videoPreview.paused) {
        videoPreview.pause();
      }
      isPlayingPreview = false;
      stopPreviewLoop();
      updatePlayPauseIcon();
    }

    if (viewName !== 'clips') {
      if (ytVideo && !ytVideo.paused) ytVideo.pause();
      if (ytAudio && !ytAudio.paused) ytAudio.pause();
    }

    if (viewName === 'clips') {
      loadClips();
    } else if (viewName === 'batch') {
      updateBatchBadges();
      renderBatchList();
    }

    if (window.location.hash !== `#${viewName}`) {
      window.location.hash = viewName;
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  document.querySelectorAll('[data-go]').forEach(b => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      go(b.dataset.go);
    });
  });

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace('#', '');
    if (views.includes(hash) && hash !== currentView) {
      go(hash);
    }
  });

  // ==========================================
  //  THEME TOGGLE & PERSISTENCE
  // ==========================================

  function applyTheme(theme) {
    const safeTheme = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', safeTheme);
    try { localStorage.setItem('10mb_theme', safeTheme); } catch (_) {}
  }

  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') ||
        (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      applyTheme(current === 'dark' ? 'light' : 'dark');
    });
  }

  try {
    const savedTheme = localStorage.getItem('10mb_theme');
    if (savedTheme === 'dark' || savedTheme === 'light') {
      applyTheme(savedTheme);
    }
  } catch (_) {}

  // ==========================================
  //  FORMAT UTILITIES & TOAST
  // ==========================================

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 MB';
    const k = 1024;
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(k)));
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
    const NS = 'http://www.w3.org/2000/svg';
    const N = 64;
    const frag = document.createDocumentFragment();
    for (let i = 0; i < N; i++) {
      const t = i / N;
      const r = Math.round(242 - (242 - 140) * t);
      const g = Math.round(85 + (110 - 85) * t);
      const b = Math.round(44 + (120 - 44) * t);
      const angle = (i * 180 / N).toFixed(1);
      const tx = (Math.sin(t * Math.PI * 2) * 6).toFixed(1);
      const ellipse = document.createElementNS(NS, 'ellipse');
      ellipse.setAttribute('rx', '78');
      ellipse.setAttribute('ry', '28');
      ellipse.setAttribute('fill', 'none');
      ellipse.setAttribute('stroke', `rgb(${r},${g},${b})`);
      ellipse.setAttribute('stroke-width', '0.75');
      ellipse.setAttribute('transform', `rotate(${angle}) translate(${tx} 0)`);
      frag.appendChild(ellipse);
    }
    ringSvg.replaceChildren(frag);
  }

  // ==========================================
  //  HARDWARE ENCODER AVAILABILITY DETECTION
  // ==========================================

  async function detectEncoders() {
    if (!encoderSelect) return;
    try {
      const res = await fetch('/api/encoders');
      if (!res.ok) return;
      const enc = await res.json();
      const map = { nvenc: enc.nvenc, qsv: enc.qsv, amf: enc.amf };
      Array.from(encoderSelect.options).forEach(opt => {
        if (Object.prototype.hasOwnProperty.call(map, opt.value) && !map[opt.value]) {
          opt.disabled = true;
          if (!opt.textContent.includes('unavailable')) {
            opt.textContent = `${opt.textContent} (unavailable)`;
          }
        }
      });
    } catch (_) {}
  }

  // ==========================================
  //  FILE SELECTION & DRAG-AND-DROP
  // ==========================================

  function isVideoFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith('video/')) return true;
    const ext = (file.name || '').split('.').pop().toLowerCase();
    return ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'ts', 'mpg', 'mpeg'].includes(ext);
  }

  function resetStudioEmptyState() {
    selectedFile = null;
    uploadedFileId = null;
    videoDuration = 0;
    trimStartRatio = 0;
    trimEndRatio = 1;
    isPlayingPreview = false;
    stopPreviewLoop();
    closeActiveEventSource();

    revokeUrl(videoObjectUrl);
    videoObjectUrl = null;
    revokeUrl(outputObjectUrl);
    outputObjectUrl = null;

    releaseVideoElement(videoPreview);
    releaseVideoElement(compareOriginal);
    releaseVideoElement(compareOutput);

    if (fileName) fileName.textContent = 'No video selected';
    if (fileSize) fileSize.textContent = 'Pick a video from Upload to begin';
    if (changeFileBtn) changeFileBtn.textContent = 'Choose file';
    if (studioDuration) studioDuration.textContent = 'Length 0:00';
    if (trimStartTime) trimStartTime.textContent = '0:00';
    if (trimCurrentTime) trimCurrentTime.textContent = '0:00';
    if (trimEndTime) trimEndTime.textContent = '0:00';
    if (qualityEst) qualityEst.textContent = 'Select a video to estimate bitrate';
    if (progressCard) progressCard.classList.remove('visible');
    if (resultCard) resultCard.classList.remove('visible');
    if (compressBtn) compressBtn.disabled = true;
    resetSaveClipButton();
    updatePlayPauseIcon();
  }

  function handleVideoFile(file) {
    if (!file) return;
    if (!isVideoFile(file)) {
      showToast('Please upload a valid video file (MP4, MOV, AVI, MKV, WebM, etc.).', 'error');
      return;
    }

    closeActiveEventSource();
    selectedFile = file;
    uploadedFileId = null;

    fileName.textContent = file.name;
    fileSize.textContent = formatBytes(file.size);
    if (changeFileBtn) changeFileBtn.textContent = 'Change file';

    revokeUrl(videoObjectUrl);
    revokeUrl(outputObjectUrl);
    outputObjectUrl = null;
    videoObjectUrl = URL.createObjectURL(file);

    videoPreview.src = videoObjectUrl;
    if (compareOriginal) compareOriginal.src = videoObjectUrl;
    releaseVideoElement(compareOutput);

    trimStartRatio = 0;
    trimEndRatio = 1;
    isPlayingPreview = false;
    stopPreviewLoop();
    updatePlayPauseIcon();

    outputVolume = 100;
    isMuted = false;
    updateVolumeUI();

    progressCard.classList.remove('visible');
    resultCard.classList.remove('visible');
    resetSaveClipButton();
    compressBtn.disabled = false;

    go('studio');
  }

  function onVideoMetadataLoaded() {
    if (!selectedFile) return;
    videoDuration = Number.isFinite(videoPreview.duration) ? videoPreview.duration : 0;
    studioDuration.textContent = `Length ${formatTime(videoDuration)}`;

    trimStartRatio = 0;
    trimEndRatio = 1;

    updateTrimUI();
    updatePlayheadUI();

    videoPreview.currentTime = 0;

    const fileMB = Math.ceil(selectedFile.size / (1024 * 1024));
    const sliderMax = Math.min(500, Math.max(100, fileMB));
    slider.max = String(sliderMax);

    setTargetSize(10);
  }

  // Register loadedmetadata ONCE to prevent listener accumulation
  if (videoPreview) {
    videoPreview.addEventListener('loadedmetadata', onVideoMetadataLoaded);
  }

  if (chooseFileBtn && fileInput) {
    chooseFileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
  }

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        fileInput.click();
      }
    });
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
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        if (e.dataTransfer.files.length > 1) {
          addFilesToBatch(e.dataTransfer.files);
        } else {
          handleVideoFile(e.dataTransfer.files[0]);
        }
      }
    });
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        if (fileInput.files.length > 1) {
          addFilesToBatch(fileInput.files);
        } else {
          handleVideoFile(fileInput.files[0]);
        }
      }
      fileInput.value = '';
    });
  }

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
    trimHandleStart.setAttribute('aria-valuenow', String(Math.round(startPct)));
    trimHandleEnd.setAttribute('aria-valuenow', String(Math.round(endPct)));

    trimSelected.style.left = `${startPct}%`;
    trimSelected.style.width = `${endPct - startPct}%`;

    trimStartTime.textContent = formatTime(getTrimStartSeconds());
    trimEndTime.textContent = formatTime(getTrimEndSeconds());
    studioDuration.textContent = `Length ${formatTime(getTrimDuration())}`;

    updateQualityEstimate();
  }

  function updatePlayheadUI() {
    if (!videoDuration) return;
    const currentRatio = Math.max(0, Math.min(1, videoPreview.currentTime / videoDuration));
    trimPlayhead.style.left = `${currentRatio * 100}%`;
    trimCurrentTime.textContent = formatTime(videoPreview.currentTime);
  }

  function startPreviewLoop() {
    stopPreviewLoop();
    function tick() {
      updatePlayheadUI();
      const endSec = getTrimEndSeconds();
      const startSec = getTrimStartSeconds();
      if (videoPreview.currentTime >= endSec - 0.05) {
        videoPreview.currentTime = startSec;
      }
      if (!videoPreview.paused) {
        previewRafId = requestAnimationFrame(tick);
      } else {
        previewRafId = null;
      }
    }
    previewRafId = requestAnimationFrame(tick);
  }

  function stopPreviewLoop() {
    if (previewRafId !== null) {
      cancelAnimationFrame(previewRafId);
      previewRafId = null;
    }
  }

  function updatePlayPauseIcon() {
    if (!playIcon || !playBtn) return;
    if (!videoPreview || videoPreview.paused) {
      playIcon.innerHTML = '<path d="M7 4l13 8-13 8z"/>';
      playBtn.classList.remove('hidden');
      playBtn.setAttribute('aria-label', 'Play preview');
    } else {
      playIcon.innerHTML = '<rect x="6" y="5" width="4" height="14" rx="1" fill="#f2552c"/><rect x="14" y="5" width="4" height="14" rx="1" fill="#f2552c"/>';
      playBtn.classList.add('hidden');
      playBtn.setAttribute('aria-label', 'Pause preview');
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

  function getTrimBarRatio(clientX) {
    const rect = trimBar.getBoundingClientRect();
    if (!rect.width) return 0;
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
      trimStartRatio = Math.max(0, Math.min(ratio, trimEndRatio - MIN_GAP));
      videoPreview.currentTime = getTrimStartSeconds();
    } else {
      trimEndRatio = Math.min(1, Math.max(ratio, trimStartRatio + MIN_GAP));
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

  function handleTrimKeyboard(type, e) {
    if (!videoDuration) return;
    const step = e.shiftKey ? 0.05 : 0.01;
    const MIN_GAP = 0.01;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (type === 'start') {
        trimStartRatio = Math.max(0, trimStartRatio - step);
        videoPreview.currentTime = getTrimStartSeconds();
      } else {
        trimEndRatio = Math.max(trimStartRatio + MIN_GAP, trimEndRatio - step);
        videoPreview.currentTime = getTrimEndSeconds();
      }
      updateTrimUI();
      updatePlayheadUI();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (type === 'start') {
        trimStartRatio = Math.min(trimEndRatio - MIN_GAP, trimStartRatio + step);
        videoPreview.currentTime = getTrimStartSeconds();
      } else {
        trimEndRatio = Math.min(1, trimEndRatio + step);
        videoPreview.currentTime = getTrimEndSeconds();
      }
      updateTrimUI();
      updatePlayheadUI();
    }
  }

  if (trimHandleStart && trimHandleEnd && trimBar) {
    trimHandleStart.addEventListener('mousedown', (e) => onTrimDragStart('start', e));
    trimHandleEnd.addEventListener('mousedown', (e) => onTrimDragStart('end', e));
    trimHandleStart.addEventListener('touchstart', (e) => onTrimDragStart('start', e), { passive: false });
    trimHandleEnd.addEventListener('touchstart', (e) => onTrimDragStart('end', e), { passive: false });
    trimHandleStart.addEventListener('keydown', (e) => handleTrimKeyboard('start', e));
    trimHandleEnd.addEventListener('keydown', (e) => handleTrimKeyboard('end', e));

    document.addEventListener('mousemove', (e) => {
      if (isDraggingTrim) onTrimDragMove(e.clientX);
    });
    document.addEventListener('touchmove', (e) => {
      if (isDraggingTrim && e.touches[0]) onTrimDragMove(e.touches[0].clientX);
    }, { passive: false });

    document.addEventListener('mouseup', onTrimDragEnd);
    document.addEventListener('touchend', onTrimDragEnd);

    trimBar.addEventListener('click', (e) => {
      if (!videoDuration || isDraggingTrim || e.target.closest('.trim-handle')) return;
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
    volumeSlider.value = String(outputVolume);

    if (videoPreview) {
      videoPreview.volume = Math.min(outputVolume / 100, 1);
      videoPreview.muted = isMuted || outputVolume === 0;
    }

    audioIcon.innerHTML = (isMuted || outputVolume === 0) ? VOL_ICON_MUTE : VOL_ICON_HIGH;
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
    if (!selectedFile) {
      qualityEst.textContent = 'Select a video to estimate bitrate';
      return;
    }
    const duration = getTrimDuration() || videoDuration || 5;
    const targetMB = parseInt(slider.value, 10) || 10;
    const speed = parseFloat(speedSelect.value) || 1.0;
    const effectiveSec = duration / speed;

    const totalBits = targetMB * 1024 * 1024 * 8 * 0.95;
    const kbps = Math.floor(totalBits / effectiveSec / 1000);

    if (selectedFormat === 'mp3') {
      const aRate = audioSelect.value === 'mute' ? 128 : (parseInt(audioSelect.value, 10) || 128);
      qualityEst.textContent = `MP3 audio extraction (${aRate} kbps)`;
    } else if (selectedFormat === 'gif') {
      qualityEst.textContent = 'Animated GIF (15 fps optimized palette)';
    } else if (kbps >= 2500) {
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
    const clamped = Math.max(10, Math.min(2000, parseInt(mb, 10) || 10));
    slider.value = String(clamped);
    szEl.textContent = String(clamped);
    sz2El.textContent = String(clamped);

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

  fmtBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      fmtBtns.forEach(b => {
        b.classList.remove('on');
        b.setAttribute('aria-pressed', 'false');
      });
      btn.classList.add('on');
      btn.setAttribute('aria-pressed', 'true');
      selectedFormat = btn.dataset.format || 'mp4';

      if (selectedFormat === 'mp3') {
        resolutionSelect.disabled = true;
        if (encoderSelect) encoderSelect.disabled = true;
        fpsSelect.disabled = true;
        aspectSelect.disabled = true;
      } else if (selectedFormat === 'gif') {
        resolutionSelect.disabled = false;
        if (encoderSelect) encoderSelect.disabled = true;
        fpsSelect.disabled = true;
        aspectSelect.disabled = false;
      } else {
        resolutionSelect.disabled = false;
        if (encoderSelect) encoderSelect.disabled = false;
        fpsSelect.disabled = false;
        aspectSelect.disabled = false;
      }

      updateQualityEstimate();
    });
  });

  if (speedSelect) speedSelect.addEventListener('change', updateQualityEstimate);
  if (audioSelect) audioSelect.addEventListener('change', updateQualityEstimate);

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
      stopPreviewLoop();
      updatePlayPauseIcon();
    }

    compressBtn.disabled = true;
    resultCard.classList.remove('visible');
    progressCard.classList.add('visible');
    resetSaveClipButton();
    setProgress(0, 'Uploading video…');

    try {
      const uploadData = await uploadFile(selectedFile, (pct) => {
        setProgress(pct, 'Uploading video…');
      });
      uploadedFileId = uploadData.id;

      setProgress(0, 'Compressing with FFmpeg…');
      const trimStart = getTrimStartSeconds();
      const trimEnd = getTrimEndSeconds();
      const shouldTrim = videoDuration > 0 && (trimStart > 0.1 || (videoDuration - trimEnd) > 0.1);
      const vol = isMuted ? 0 : outputVolume;

      const opts = {
        format: selectedFormat,
        speed: parseFloat(speedSelect.value) || 1.0,
        aspectRatio: aspectSelect.value,
        resolution: resolutionSelect.value,
        fps: fpsSelect.value,
        encoder: encoderSelect ? encoderSelect.value : 'auto',
      };

      if (audioSelect.value === 'mute') {
        opts.muteAudio = true;
      } else {
        opts.audioBitrate = parseInt(audioSelect.value, 10) || 128;
      }

      subscribeProgress(uploadedFileId);
      await requestCompression(
        uploadedFileId,
        parseInt(slider.value, 10),
        shouldTrim ? trimStart : null,
        shouldTrim ? trimEnd : null,
        vol,
        opts
      );

    } catch (err) {
      closeActiveEventSource();
      showToast(err.message || 'Compression failed. Please try again.', 'error');
      progressCard.classList.remove('visible');
      compressBtn.disabled = false;
    }
  }

  function uploadFile(file, onUploadProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      activeUploadXhr = xhr;
      const fd = new FormData();
      fd.append('video', file);

      xhr.open('POST', '/api/upload', true);
      xhr.setRequestHeader('X-Requested-With', '10mb-client');

      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable && typeof onUploadProgress === 'function') {
          onUploadProgress((e.loaded / e.total) * 100);
        }
      });

      const finish = () => {
        if (activeUploadXhr === xhr) activeUploadXhr = null;
      };

      xhr.addEventListener('load', () => {
        finish();
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

      xhr.addEventListener('error', () => {
        finish();
        reject(new Error('Network error during file upload.'));
      });
      xhr.addEventListener('abort', () => {
        finish();
        reject(new Error('Upload cancelled.'));
      });

      xhr.send(fd);
    });
  }

  async function requestCompression(id, targetMB, trimStart, trimEnd, vol, extraOpts = {}) {
    const body = { id, targetMB, ...extraOpts };

    if (typeof trimStart === 'number' && typeof trimEnd === 'number' && trimEnd > trimStart) {
      body.trimStart = trimStart;
      body.trimEnd = trimEnd;
    }

    const volumeMultiplier = vol / 100;
    if (Math.abs(volumeMultiplier - 1) > 0.01) {
      body.volume = volumeMultiplier;
    }

    const res = await fetch('/api/compress', {
      method: 'POST',
      headers: apiHeaders({ 'Content-Type': 'application/json' }),
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
    closeActiveEventSource();

    eventSource = new EventSource(`/api/progress/${encodeURIComponent(id)}`);

    eventSource.addEventListener('progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        const percent = data.percent || 0;
        const stage = data.stage || 'compressing';
        const stageMap = {
          trimming: 'Trimming clip…',
          analyzing: 'Analyzing streams…',
          compressing: 'Encoding video…',
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
      closeActiveEventSource();
    });

    eventSource.addEventListener('error', (e) => {
      if (resultCard && resultCard.classList.contains('visible')) {
        closeActiveEventSource();
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
      closeActiveEventSource();
      progressCard.classList.remove('visible');
      compressBtn.disabled = false;
    });
  }

  function onCompressionDone(data) {
    const origBytes = data.originalSize || (selectedFile ? selectedFile.size : 0);
    const compBytes = data.compressedSize || 0;
    const downloadUrl = isSafeMediaUrl(data.downloadUrl) ? data.downloadUrl : '#';
    const outputUrl = isSafeMediaUrl(data.outputUrl) ? data.outputUrl : '';
    const format = data.format || 'mp4';

    originalSize.textContent = formatBytes(origBytes);
    compressedSize.textContent = formatBytes(compBytes);

    if (origBytes > 0 && compBytes > 0) {
      const saved = ((1 - compBytes / origBytes) * 100).toFixed(1);
      compressionRatio.textContent = Number(saved) >= 0
        ? `${saved}% smaller`
        : `${Math.abs(Number(saved)).toFixed(1)}% larger`;
    } else {
      compressionRatio.textContent = 'Optimized';
    }

    downloadBtn.href = downloadUrl;
    resetSaveClipButton();

    if (format === 'mp4' && outputUrl) {
      openCompareBtn.style.display = 'inline-flex';
      compareOutput.src = outputUrl;
      compareOriginal.src = videoObjectUrl || '';
      const startSec = getTrimStartSeconds();
      compareOriginal.currentTime = startSec;
      compareOutput.currentTime = 0;
    } else {
      openCompareBtn.style.display = 'none';
      releaseVideoElement(compareOutput);
    }

    progressCard.classList.remove('visible');
    resultCard.classList.add('visible');
    compressBtn.disabled = false;
    setProgress(100, 'Complete!');
    showToast('Video compression complete! Source file purged.', 'success');
  }

  // ==========================================
  //  SAVE TO PRIVATE STORED CLIPS
  // ==========================================

  if (saveClipBtn) {
    saveClipBtn.addEventListener('click', async () => {
      if (!uploadedFileId) {
        showToast('No compressed clip available to save.', 'error');
        return;
      }

      saveClipBtn.disabled = true;
      saveClipBtn.textContent = 'Saving to Private Library…';

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
          headers: apiHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(payload),
        });

        const data = await res.json();
        if (res.ok && data.success) {
          saveClipBtn.textContent = '✓ Saved to Stored Clips';
          showToast('Saved to your private Stored Clips library!', 'success');
          loadClips();
        } else {
          showToast(data.error || 'Failed to save clip.', 'error');
          resetSaveClipButton();
        }
      } catch (err) {
        showToast(err.message || 'Error saving clip.', 'error');
        resetSaveClipButton();
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
    if (comparePlayText) comparePlayText.textContent = 'Play Both';
  }

  if (openCompareBtn) openCompareBtn.addEventListener('click', openComparisonModal);
  if (closeCompareModal) closeCompareModal.addEventListener('click', closeComparisonModal);
  if (compareModal) {
    compareModal.addEventListener('click', (e) => {
      if (e.target === compareModal) closeComparisonModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (confirmModal && confirmModal.classList.contains('visible')) {
        closeConfirmModal(false);
      } else if (compareModal && compareModal.classList.contains('visible')) {
        closeComparisonModal();
      }
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
      if (endSec > 0 && compareOriginal.currentTime >= endSec - 0.05) {
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
  //  PRIVATE STORED CLIPS LIBRARY
  // ==========================================

  function clearClipsListDom() {
    if (!clipsList) return;
    // Release any active <video> decoders before detaching nodes to prevent memory leaks
    clipsList.querySelectorAll('video').forEach(releaseVideoElement);
    clipsList.replaceChildren();
  }

  async function loadClips() {
    try {
      const res = await fetch('/api/clips', { cache: 'no-store' });
      if (!res.ok) throw new Error('Failed to load stored clips');
      const data = await res.json();
      clips = Array.isArray(data) ? data : [];
      updateClipsBadges(clips.length);
      renderClipsList(searchInput ? searchInput.value : '');

      if (clips.length > 0) {
        const stillExists = activeClip && clips.find(c => c.id === activeClip.id);
        selectClip(stillExists || clips[0]);
      } else {
        activeClip = null;
        renderEmptyClipsState();
      }
    } catch (err) {
      updateClipsBadges(0);
      renderEmptyClipsState();
    }
  }

  function updateClipsBadges(count) {
    if (navClipBadge) navClipBadge.textContent = String(count);
    if (homeClipCount) homeClipCount.textContent = `${count} clip${count === 1 ? '' : 's'} saved`;
    if (sidebarCount) sidebarCount.textContent = `${count} clip${count === 1 ? '' : 's'}`;
  }

  function renderClipsList(filterText = '') {
    if (!clipsList) return;
    clearClipsListDom();

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
        const emptyMsg = document.createElement('div');
        emptyMsg.style.cssText = 'padding: 24px; text-align: center; color: var(--mute)';
        emptyMsg.textContent = `No clips matching "${filterText}"`;
        clipsList.appendChild(emptyMsg);
      }
      return;
    }

    const frag = document.createDocumentFragment();

    filtered.forEach(clip => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = `row ${activeClip && activeClip.id === clip.id ? 'active' : ''}`;
      row.dataset.id = clip.id;

      const thumb = document.createElement('div');
      thumb.className = 'thumb';

      const fmt = String(clip.format || 'mp4').toLowerCase();
      const rawStream = clip.streamUrl || `/api/clips/stream/${encodeURIComponent(clip.filename || '')}`;
      const streamUrl = isSafeMediaUrl(rawStream) ? rawStream : '';

      if (fmt === 'gif' && streamUrl) {
        const img = document.createElement('img');
        img.src = streamUrl;
        img.alt = clip.title || 'GIF clip thumbnail';
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else if (fmt === 'mp3') {
        const badge = document.createElement('div');
        badge.className = 'thumb-audio-label';
        badge.textContent = 'MP3';
        thumb.appendChild(badge);
      } else if (streamUrl) {
        const vid = document.createElement('video');
        vid.src = `${streamUrl}#t=0.5`;
        vid.preload = 'metadata';
        vid.muted = true;
        vid.playsInline = true;
        thumb.appendChild(vid);
      }

      const durBadge = document.createElement('span');
      durBadge.textContent = formatTime(clip.duration);
      thumb.appendChild(durBadge);

      const info = document.createElement('div');
      info.style.cssText = 'flex:1;overflow:hidden;text-align:left';

      const titleEl = document.createElement('b');
      titleEl.textContent = clip.title || clip.originalName || 'Untitled Clip';

      const dateStr = clip.createdAt
        ? new Date(clip.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
        : 'Recently';
      const metaEl = document.createElement('span');
      metaEl.className = 'small';
      metaEl.textContent = `${fmt.toUpperCase()}  •  ${formatBytes(clip.size)}  •  ${dateStr}`;

      info.appendChild(titleEl);
      info.appendChild(metaEl);

      row.appendChild(thumb);
      row.appendChild(info);
      row.addEventListener('click', () => selectClip(clip));
      frag.appendChild(row);
    });

    clipsList.appendChild(frag);
  }

  function selectClip(clip) {
    if (!clip) return;
    activeClip = clip;

    document.querySelectorAll('.clips-list .row').forEach(r => {
      r.classList.toggle('active', r.dataset.id === clip.id);
    });

    const fmt = String(clip.format || 'mp4').toLowerCase();
    const dateStr = clip.createdAt
      ? new Date(clip.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : 'Recently';

    activeClipTitle.textContent = clip.title || clip.originalName || 'Untitled Clip';
    activeClipMeta.textContent = `${fmt.toUpperCase()}  •  ${formatBytes(clip.size)}  •  ${dateStr}`;

    const rawDownload = clip.downloadUrl || `/api/clips/download/${encodeURIComponent(clip.filename || '')}`;
    const safeDownload = isSafeMediaUrl(rawDownload) ? rawDownload : '#';
    const rawStream = clip.streamUrl || `/api/clips/stream/${encodeURIComponent(clip.filename || '')}`;
    const safeStream = isSafeMediaUrl(rawStream) ? rawStream : '';

    if (activeClipDownloadBtn) {
      activeClipDownloadBtn.href = safeDownload;
      activeClipDownloadBtn.style.pointerEvents = '';
      activeClipDownloadBtn.style.opacity = '1';
    }
    if (activeClipDeleteBtn) {
      activeClipDeleteBtn.disabled = false;
      activeClipDeleteBtn.style.opacity = '1';
    }

    // Render the correct media player for MP4, GIF, or MP3
    releaseVideoElement(ytVideo);
    if (ytAudio) {
      ytAudio.pause();
      ytAudio.removeAttribute('src');
      ytAudio.load();
    }
    if (ytGifPreview) {
      ytGifPreview.hidden = true;
      ytGifPreview.removeAttribute('src');
    }
    if (ytAudioPlaceholder) ytAudioPlaceholder.hidden = true;

    if (fmt === 'gif' && ytGifPreview && safeStream) {
      ytVideo.hidden = true;
      ytGifPreview.src = safeStream;
      ytGifPreview.hidden = false;
    } else if (fmt === 'mp3' && ytAudio && ytAudioPlaceholder && safeStream) {
      ytVideo.hidden = true;
      ytAudio.src = safeStream;
      ytAudio.load();
      ytAudioPlaceholder.hidden = false;
    } else if (ytVideo && safeStream) {
      ytVideo.hidden = false;
      ytVideo.src = safeStream;
      ytVideo.load();
    }
  }

  function renderEmptyClipsState() {
    clearClipsListDom();
    if (clipsList) {
      const box = document.createElement('div');
      box.style.cssText = 'padding: 32px 16px; text-align: center; color: var(--mute)';
      const p = document.createElement('p');
      p.style.marginBottom = '12px';
      p.textContent = 'No stored clips yet.';
      const span = document.createElement('span');
      span.className = 'small';
      span.textContent = 'Your saved clips are private to this browser session.';
      box.appendChild(p);
      box.appendChild(span);
      clipsList.appendChild(box);
    }
    if (activeClipTitle) activeClipTitle.textContent = 'No clips stored';
    if (activeClipMeta) activeClipMeta.textContent = '—';
    releaseVideoElement(ytVideo);
    if (ytVideo) ytVideo.hidden = false;
    if (ytGifPreview) {
      ytGifPreview.hidden = true;
      ytGifPreview.removeAttribute('src');
    }
    if (ytAudio) {
      ytAudio.pause();
      ytAudio.removeAttribute('src');
      ytAudio.load();
    }
    if (ytAudioPlaceholder) ytAudioPlaceholder.hidden = true;
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

  // Delete clip action (using accessible in-app confirmation modal)
  if (activeClipDeleteBtn) {
    activeClipDeleteBtn.addEventListener('click', async () => {
      if (!activeClip) return;
      const targetClip = activeClip;
      const confirmed = await openConfirmModal({
        title: 'Delete clip',
        message: `Permanently delete "${targetClip.title}" from your private library?`,
        confirmLabel: 'Delete clip',
        danger: true,
      });
      if (!confirmed) return;

      try {
        const res = await fetch(`/api/clips/${encodeURIComponent(targetClip.id)}`, {
          method: 'DELETE',
          headers: apiHeaders(),
        });
        if (res.ok) {
          clips = clips.filter(c => c.id !== targetClip.id);
          updateClipsBadges(clips.length);
          renderClipsList(searchInput ? searchInput.value : '');
          if (clips.length > 0) {
            selectClip(clips[0]);
          } else {
            activeClip = null;
            renderEmptyClipsState();
          }
          showToast('Clip permanently deleted.', 'normal');
        } else {
          showToast('Failed to delete clip.', 'error');
        }
      } catch {
        showToast('Error deleting clip.', 'error');
      }
    });
  }

  // Debounced search input filter (avoids thrashing video decoders on every keystroke)
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        renderClipsList(searchInput.value);
      }, 150);
    });
  }

  // Direct upload to private stored clips
  if (directUploadInput) {
    directUploadInput.addEventListener('change', async () => {
      const file = directUploadInput.files[0];
      if (!file) return;

      if (!isVideoFile(file)) {
        showToast('Please select a valid video file.', 'error');
        directUploadInput.value = '';
        return;
      }

      const fd = new FormData();
      fd.append('video', file);

      showToast('Uploading clip to your private library…', 'normal');

      try {
        const res = await fetch('/api/clips/upload', {
          method: 'POST',
          headers: apiHeaders(),
          body: fd,
        });

        const data = await res.json();
        if (res.ok && data.clip) {
          clips.unshift(data.clip);
          updateClipsBadges(clips.length);
          renderClipsList(searchInput ? searchInput.value : '');
          selectClip(data.clip);
          showToast('Clip uploaded to your private library!', 'success');
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
  //  ONE-CLICK FULL PRIVACY DATA PURGE
  // ==========================================

  if (purgePrivacyBtn) {
    purgePrivacyBtn.addEventListener('click', async () => {
      const confirmed = await openConfirmModal({
        title: 'Clear all my data',
        message: 'This will permanently delete all of your stored clips, clear any temporary files on the server, clear the batch queue, and rotate your private session.',
        confirmLabel: 'Delete everything',
        danger: true,
      });
      if (!confirmed) return;

      try {
        const res = await fetch('/api/privacy/purge', {
          method: 'POST',
          headers: apiHeaders(),
        });
        if (!res.ok) throw new Error('Failed to purge session data.');

        batchQueue = [];
        updateBatchBadges();
        renderBatchList();
        resetStudioEmptyState();

        clips = [];
        activeClip = null;
        updateClipsBadges(0);
        renderEmptyClipsState();

        showToast('All your files and clips have been permanently wiped.', 'success');
      } catch (err) {
        showToast(err.message || 'Error clearing session data.', 'error');
      }
    });
  }

  // ==========================================
  //  BATCH COMPRESSION QUEUE CONTROLLER
  // ==========================================

  function updateBatchBadges() {
    const count = batchQueue.length;
    if (navBatchBadge) {
      navBatchBadge.textContent = String(count);
      navBatchBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }
    if (startBatchBtn) {
      const pending = batchQueue.filter(i => i.status === 'ready' || i.status === 'error').length;
      startBatchBtn.textContent = isProcessingBatch
        ? 'Processing Batch…'
        : `Start Batch (${pending} file${pending === 1 ? '' : 's'})`;
      startBatchBtn.disabled = isProcessingBatch || pending === 0;
    }
    if (clearBatchBtn) {
      clearBatchBtn.disabled = isProcessingBatch || count === 0;
    }
  }

  function addFilesToBatch(files) {
    if (!files || files.length === 0) return;
    let added = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!isVideoFile(file)) continue;

      batchQueue.push({
        uid: (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8),
        file,
        name: file.name,
        size: file.size,
        targetMB: 10,
        format: 'mp4',
        status: 'ready', // 'ready' | 'uploading' | 'compressing' | 'done' | 'error'
        percent: 0,
        downloadUrl: null,
        compressedSize: 0,
        error: null,
      });
      added++;
    }

    if (added === 0) {
      showToast('No valid video files detected.', 'error');
      return;
    }

    showToast(`Added ${added} video${added === 1 ? '' : 's'} to batch queue`, 'normal');
    updateBatchBadges();
    renderBatchList();
    go('batch');
  }

  function updateBatchRowProgress(item, labelPrefix) {
    const row = document.getElementById(`batch-item-${item.uid}`);
    if (!row) return;
    const fill = row.querySelector('.batch-item-progress-fill');
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, item.percent))}%`;
    const badge = row.querySelector('.batch-status-badge');
    if (badge) badge.textContent = `${labelPrefix} ${Math.round(item.percent)}%`;
  }

  function renderBatchList() {
    if (!batchList) return;
    batchList.replaceChildren();

    if (batchQueue.length === 0) {
      const emptyBox = document.createElement('div');
      emptyBox.style.cssText = 'padding: 48px 16px; text-align: center; color: var(--mute); border: 1px dashed var(--line); border-radius: 12px';
      const p = document.createElement('p');
      p.style.cssText = 'font-size: 17px; margin-bottom: 8px';
      p.textContent = 'Batch queue is empty';
      const span = document.createElement('span');
      span.className = 'small';
      span.textContent = 'Click "+ Add Files" or drop multiple videos on the upload page to start batch encoding.';
      emptyBox.appendChild(p);
      emptyBox.appendChild(span);
      batchList.appendChild(emptyBox);
      return;
    }

    const frag = document.createDocumentFragment();

    batchQueue.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = `batch-item ${item.status === 'compressing' || item.status === 'uploading' ? 'active' : ''} ${item.status === 'done' ? 'done' : ''}`;
      row.id = `batch-item-${item.uid}`;

      const canEdit = !isProcessingBatch && (item.status === 'ready' || item.status === 'error');

      // Column 1: File info + progress bar
      const infoCol = document.createElement('div');
      infoCol.className = 'batch-item-info';

      const nameEl = document.createElement('b');
      nameEl.title = item.name;
      nameEl.textContent = item.name;

      const sizeEl = document.createElement('span');
      sizeEl.className = 'small';
      sizeEl.style.marginTop = '2px';
      sizeEl.textContent = formatBytes(item.size);

      const progWrap = document.createElement('div');
      progWrap.className = 'batch-item-progress';
      const progFill = document.createElement('div');
      progFill.className = 'batch-item-progress-fill';
      progFill.style.width = `${Math.min(100, Math.max(0, item.percent))}%`;
      progWrap.appendChild(progFill);

      infoCol.appendChild(nameEl);
      infoCol.appendChild(sizeEl);
      infoCol.appendChild(progWrap);

      // Column 2: Target Size select
      const targetCol = document.createElement('div');
      const targetLabel = document.createElement('label');
      targetLabel.className = 'small';
      targetLabel.style.cssText = 'display:block;margin-bottom:4px';
      targetLabel.textContent = 'Target Size';

      const targetSel = document.createElement('select');
      targetSel.className = 'batch-target-select';
      targetSel.disabled = !canEdit;
      targetSel.setAttribute('aria-label', `Target size for ${item.name}`);
      targetSel.style.cssText = 'padding:6px 10px;font-size:13px;width:100%';
      [10, 16, 20, 50, 100].forEach(mb => {
        const opt = document.createElement('option');
        opt.value = String(mb);
        opt.textContent = `${mb} MB`;
        opt.selected = item.targetMB === mb;
        targetSel.appendChild(opt);
      });
      targetSel.addEventListener('change', () => {
        item.targetMB = parseInt(targetSel.value, 10) || 10;
      });
      targetCol.appendChild(targetLabel);
      targetCol.appendChild(targetSel);

      // Column 3: Format select
      const fmtCol = document.createElement('div');
      const fmtLabel = document.createElement('label');
      fmtLabel.className = 'small';
      fmtLabel.style.cssText = 'display:block;margin-bottom:4px';
      fmtLabel.textContent = 'Format';

      const fmtSel = document.createElement('select');
      fmtSel.className = 'batch-format-select';
      fmtSel.disabled = !canEdit;
      fmtSel.setAttribute('aria-label', `Format for ${item.name}`);
      fmtSel.style.cssText = 'padding:6px 10px;font-size:13px;width:100%';
      [
        { v: 'mp4', l: 'MP4' },
        { v: 'gif', l: 'GIF' },
        { v: 'mp3', l: 'MP3' },
      ].forEach(entry => {
        const opt = document.createElement('option');
        opt.value = entry.v;
        opt.textContent = entry.l;
        opt.selected = item.format === entry.v;
        fmtSel.appendChild(opt);
      });
      fmtSel.addEventListener('change', () => {
        item.format = fmtSel.value;
      });
      fmtCol.appendChild(fmtLabel);
      fmtCol.appendChild(fmtSel);

      // Column 4: Status badge
      const statusCol = document.createElement('div');
      statusCol.style.textAlign = 'center';
      const badge = document.createElement('span');
      badge.className = 'batch-status-badge';
      if (item.status === 'ready') {
        badge.textContent = 'Ready';
      } else if (item.status === 'uploading') {
        badge.classList.add('working');
        badge.textContent = `Uploading ${Math.round(item.percent)}%`;
      } else if (item.status === 'compressing') {
        badge.classList.add('working');
        badge.textContent = `Encoding ${Math.round(item.percent)}%`;
      } else if (item.status === 'done') {
        badge.classList.add('done');
        const saved = item.size > 0 && item.compressedSize > 0
          ? ` (${((1 - item.compressedSize / item.size) * 100).toFixed(0)}% saved)`
          : '';
        badge.textContent = `✓ ${formatBytes(item.compressedSize)}${saved}`;
      } else if (item.status === 'error') {
        badge.classList.add('failed');
        badge.title = item.error || 'Failed';
        badge.textContent = 'Failed';
      }
      statusCol.appendChild(badge);

      // Column 5: Action button / Download link
      const actionCol = document.createElement('div');
      actionCol.style.textAlign = 'right';
      if (item.status === 'done' && isSafeMediaUrl(item.downloadUrl)) {
        const dl = document.createElement('a');
        dl.className = 'btn';
        dl.href = item.downloadUrl;
        dl.setAttribute('download', '');
        dl.style.cssText = 'padding:6px 14px;font-size:13px;text-decoration:none';
        dl.textContent = 'Download';
        actionCol.appendChild(dl);
      } else {
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'btn ghost danger batch-remove-btn';
        removeBtn.disabled = isProcessingBatch;
        removeBtn.style.cssText = 'padding:6px 12px;font-size:13px';
        removeBtn.textContent = 'Remove';
        removeBtn.setAttribute('aria-label', `Remove ${item.name}`);
        removeBtn.addEventListener('click', () => {
          batchQueue.splice(index, 1);
          updateBatchBadges();
          renderBatchList();
        });
        actionCol.appendChild(removeBtn);
      }

      row.appendChild(infoCol);
      row.appendChild(targetCol);
      row.appendChild(fmtCol);
      row.appendChild(statusCol);
      row.appendChild(actionCol);
      frag.appendChild(row);
    });

    batchList.appendChild(frag);
  }

  if (batchChips) {
    batchChips.forEach(chip => {
      chip.addEventListener('click', () => {
        const mb = parseInt(chip.dataset.batchV, 10) || 10;
        batchQueue.forEach(item => {
          if (item.status === 'ready' || item.status === 'error') item.targetMB = mb;
        });
        renderBatchList();
        showToast(`Set all pending items to ${mb}MB target`, 'normal');
      });
    });
  }

  if (clearBatchBtn) {
    clearBatchBtn.addEventListener('click', async () => {
      if (isProcessingBatch || batchQueue.length === 0) return;
      const confirmed = await openConfirmModal({
        title: 'Clear batch queue',
        message: `Remove all ${batchQueue.length} file${batchQueue.length === 1 ? '' : 's'} from the batch queue?`,
        confirmLabel: 'Clear queue',
        danger: true,
      });
      if (!confirmed) return;

      batchQueue = [];
      updateBatchBadges();
      renderBatchList();
    });
  }

  if (batchAddInput) {
    batchAddInput.addEventListener('change', () => {
      if (batchAddInput.files && batchAddInput.files.length > 0) {
        addFilesToBatch(batchAddInput.files);
      }
      batchAddInput.value = '';
    });
  }

  async function startBatch() {
    if (isProcessingBatch) return;
    const pending = batchQueue.filter(i => i.status === 'ready' || i.status === 'error');
    if (pending.length === 0) {
      showToast('No pending files to compress.', 'normal');
      return;
    }

    isProcessingBatch = true;
    updateBatchBadges();
    renderBatchList();

    for (let i = 0; i < batchQueue.length; i++) {
      const item = batchQueue[i];
      if (item.status === 'done' || !item.file) continue;

      item.status = 'uploading';
      item.error = null;
      item.percent = 0;
      renderBatchList();

      try {
        const uploadData = await uploadFile(item.file, (pct) => {
          item.percent = pct;
          updateBatchRowProgress(item, 'Uploading');
        });
        const uploadedId = uploadData.id;

        item.status = 'compressing';
        item.percent = 10;
        renderBatchList();

        await new Promise((resolve, reject) => {
          const sse = new EventSource(`/api/progress/${encodeURIComponent(uploadedId)}`);
          activeBatchEventSource = sse;

          const closeSse = () => {
            try { sse.close(); } catch (_) {}
            if (activeBatchEventSource === sse) activeBatchEventSource = null;
          };

          sse.addEventListener('progress', (e) => {
            try {
              const d = JSON.parse(e.data);
              item.percent = d.percent || 10;
              updateBatchRowProgress(item, 'Encoding');
            } catch (_) {}
          });

          sse.addEventListener('done', (e) => {
            closeSse();
            try {
              const d = JSON.parse(e.data);
              item.status = 'done';
              item.percent = 100;
              item.downloadUrl = isSafeMediaUrl(d.downloadUrl) ? d.downloadUrl : null;
              item.compressedSize = d.compressedSize || 0;
              item.file = null; // Release File handle to free memory
              resolve();
            } catch (err) {
              reject(err);
            }
          });

          sse.addEventListener('error', (e) => {
            closeSse();
            let msg = 'Encoding failed';
            try {
              if (e.data) msg = JSON.parse(e.data).message || msg;
            } catch (_) {}
            reject(new Error(msg));
          });

          // Pass null trim bounds so Studio's videoDuration never leaks into batch items
          requestCompression(uploadedId, item.targetMB, null, null, 100, {
            format: item.format,
            encoder: encoderSelect ? encoderSelect.value : 'auto',
          }).catch((err) => {
            closeSse();
            reject(err);
          });
        });

      } catch (err) {
        item.status = 'error';
        item.error = err.message || 'Compression failed';
      }

      renderBatchList();
    }

    isProcessingBatch = false;
    updateBatchBadges();
    renderBatchList();
    showToast('Batch compression completed!', 'success');
  }

  if (startBatchBtn) {
    startBatchBtn.addEventListener('click', startBatch);
  }

  // ==========================================
  //  INITIALIZATION
  // ==========================================

  const initHash = window.location.hash.replace('#', '');
  if (views.includes(initHash)) {
    go(initHash);
  } else {
    go('home');
  }

  loadClips();
  detectEncoders();
  updateBatchBadges();
  renderBatchList();

})();
