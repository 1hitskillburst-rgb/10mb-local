// ============================================
// 10mb — YouTube-Style Stored Clips Controller
// ============================================

(() => {
  'use strict';

  // ---- State ----
  let clips = [];
  let activeClip = null;
  let isPlaying = false;
  let isDraggingProgress = false;
  let playbackSpeed = 1.0;

  // ---- DOM References ----
  const searchInput          = document.getElementById('searchInput');
  const directUploadInput    = document.getElementById('directUploadInput');
  const clipsListEl          = document.getElementById('clipsList');
  const sidebarCountEl       = document.getElementById('sidebarCount');

  // Player Elements
  const playerWrap           = document.getElementById('playerWrap');
  const ytVideo              = document.getElementById('ytVideo');
  const bigPlayBtn           = document.getElementById('bigPlayBtn');
  const playPauseBtn         = document.getElementById('playPauseBtn');
  const playPauseIcon        = document.getElementById('playPauseIcon');
  const nextClipBtn          = document.getElementById('nextClipBtn');
  const progressWrap         = document.getElementById('progressWrap');
  const progressBar          = document.getElementById('progressBar');
  const progressFilled       = document.getElementById('progressFilled');
  const progressHandle       = document.getElementById('progressHandle');
  const hoverTimeTooltip     = document.getElementById('hoverTimeTooltip');
  const currentTimeEl        = document.getElementById('currentTime');
  const durationTimeEl       = document.getElementById('durationTime');
  const muteBtn              = document.getElementById('muteBtn');
  const volumeIcon           = document.getElementById('volumeIcon');
  const volumeSlider         = document.getElementById('volumeSlider');
  const speedBtn             = document.getElementById('speedBtn');
  const speedMenu            = document.getElementById('speedMenu');
  const fullscreenBtn        = document.getElementById('fullscreenBtn');

  // Clip Info Elements
  const activeClipTitle      = document.getElementById('activeClipTitle');
  const activeClipFormat     = document.getElementById('activeClipFormat');
  const activeClipSize       = document.getElementById('activeClipSize');
  const activeClipDate       = document.getElementById('activeClipDate');
  const activeClipDownloadBtn = document.getElementById('activeClipDownloadBtn');
  const activeClipDeleteBtn  = document.getElementById('activeClipDeleteBtn');

  // Icons SVG
  const ICON_PLAY = '<path d="M8 5v14l11-7z"/>';
  const ICON_PAUSE = '<path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>';
  
  const ICON_VOL_HIGH = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/>';
  const ICON_VOL_MUTE = '<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/>';

  // ---- Utility: Format Bytes ----
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(i >= 2 ? 1 : 0) + ' ' + units[i];
  }

  // ---- Utility: Format Time ----
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const s = Math.floor(seconds);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // ---- Utility: Escape HTML (XSS Protection) ----
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

  // ---- Load Clips from Server ----
  async function loadClips() {
    try {
      const res = await fetch('/api/clips');
      if (!res.ok) throw new Error('Failed to fetch clips');
      clips = await res.json();
      renderClipsList();

      if (clips.length > 0) {
        // Check hash or pick first clip
        const hashId = window.location.hash.replace('#clip-', '');
        const found = clips.find(c => c.id === hashId);
        selectClip(found || clips[0]);
      } else {
        renderEmptyState();
      }
    } catch (err) {
      console.error('Error loading clips:', err);
      renderEmptyState();
    }
  }

  // ---- Render Sidebar Clips List ----
  function renderClipsList(filterText = '') {
    clipsListEl.innerHTML = '';
    const filtered = clips.filter(c => 
      c.title.toLowerCase().includes(filterText.toLowerCase()) ||
      c.format.toLowerCase().includes(filterText.toLowerCase())
    );

    sidebarCountEl.textContent = `${filtered.length} clip${filtered.length === 1 ? '' : 's'}`;

    if (filtered.length === 0) {
      if (clips.length === 0) {
        renderEmptyState();
      } else {
        clipsListEl.innerHTML = `<div class="yt-empty-text" style="padding: 20px 0;">No clips matching "${escapeHTML(filterText)}"</div>`;
      }
      return;
    }

    filtered.forEach(clip => {
      const card = document.createElement('div');
      card.className = `yt-card ${activeClip && activeClip.id === clip.id ? 'active' : ''}`;
      card.dataset.id = clip.id;

      const dateStr = clip.createdAt ? new Date(clip.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'Recently';
      const safeTitle = escapeHTML(clip.title || clip.originalName || 'Untitled Clip');
      const safeFormat = escapeHTML(clip.format || 'MP4').toUpperCase();
      const safeStreamUrl = encodeURI(clip.streamUrl || `/api/clips/stream/${clip.filename}`);
      const safeDownloadUrl = encodeURI(clip.downloadUrl || `/api/clips/download/${clip.filename}`);

      card.innerHTML = `
        <div class="yt-card-thumb-wrap">
          <video class="yt-card-thumb" src="${safeStreamUrl}#t=1" preload="metadata" muted></video>
          <span class="yt-card-duration">${formatTime(clip.duration)}</span>
        </div>
        <div class="yt-card-content">
          <h3 class="yt-card-title">${safeTitle}</h3>
          <div class="yt-card-meta">
            <span>${safeFormat}</span>
            <span>•</span>
            <span>${formatBytes(clip.size)}</span>
            <span>•</span>
            <span>${dateStr}</span>
          </div>
        </div>
        <a class="yt-card-quick-download" href="${safeDownloadUrl}" download title="Download clip" onclick="event.stopPropagation()">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2"/>
          </svg>
        </a>
      `;

      card.addEventListener('click', () => selectClip(clip));
      clipsListEl.appendChild(card);
    });
  }

  // ---- Empty State ----
  function renderEmptyState() {
    sidebarCountEl.textContent = '0 clips';
    clipsListEl.innerHTML = `
      <div class="yt-empty-state">
        <svg class="yt-empty-icon" width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="2" width="20" height="20" rx="5" ry="5"/>
          <polygon points="10 8 16 12 10 16 10 8"/>
        </svg>
        <p class="yt-empty-text">No stored clips yet. Upload or compress a video in 10mb Studio!</p>
        <a href="index.html" class="yt-empty-action">Go to Compressor Studio</a>
      </div>
    `;

    activeClipTitle.textContent = 'No clips stored';
    activeClipFormat.textContent = '—';
    activeClipSize.textContent = '0 MB';
    activeClipDate.textContent = '—';
    ytVideo.src = '';
    bigPlayBtn.classList.add('hidden');
  }

  // ---- Select Active Clip ----
  function selectClip(clip) {
    if (!clip) return;
    activeClip = clip;
    window.location.hash = `clip-${clip.id}`;

    // Highlight card in list
    document.querySelectorAll('.yt-card').forEach(card => {
      if (card.dataset.id === clip.id) card.classList.add('active');
      else card.classList.remove('active');
    });

    // Update info bar
    activeClipTitle.textContent = clip.title;
    activeClipFormat.textContent = (clip.format || 'MP4').toUpperCase();
    activeClipSize.textContent = formatBytes(clip.size);
    activeClipDate.textContent = clip.createdAt ? new Date(clip.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recently';

    activeClipDownloadBtn.href = clip.downloadUrl || `/api/clips/download/${clip.filename}`;

    // Load video stream into YouTube player
    ytVideo.src = clip.streamUrl || `/api/clips/stream/${clip.filename}`;
    ytVideo.playbackRate = playbackSpeed;

    ytVideo.load();
    ytVideo.play().then(() => {
      isPlaying = true;
      updatePlayPauseUI();
    }).catch(() => {
      isPlaying = false;
      updatePlayPauseUI();
    });
  }

  // ---- Player Controls Logic ----

  function togglePlay() {
    if (!ytVideo.src) return;
    if (ytVideo.paused) {
      ytVideo.play();
      isPlaying = true;
    } else {
      ytVideo.pause();
      isPlaying = false;
    }
    updatePlayPauseUI();
  }

  function updatePlayPauseUI() {
    if (ytVideo.paused) {
      playPauseIcon.innerHTML = ICON_PLAY;
      bigPlayBtn.classList.remove('hidden');
    } else {
      playPauseIcon.innerHTML = ICON_PAUSE;
      bigPlayBtn.classList.add('hidden');
    }
  }

  function updateProgressUI() {
    if (!ytVideo.duration) return;
    const pct = (ytVideo.currentTime / ytVideo.duration) * 100;
    progressFilled.style.width = pct + '%';
    progressHandle.style.left = pct + '%';
    currentTimeEl.textContent = formatTime(ytVideo.currentTime);
    durationTimeEl.textContent = formatTime(ytVideo.duration);

    if (activeClip && (!activeClip.duration || activeClip.duration === 0)) {
      activeClip.duration = ytVideo.duration;
    }
  }

  function seekVideo(clientX) {
    const rect = progressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    if (ytVideo.duration) {
      ytVideo.currentTime = ratio * ytVideo.duration;
      updateProgressUI();
    }
  }

  // Event Listeners for Player
  bigPlayBtn.addEventListener('click', togglePlay);
  ytVideo.addEventListener('click', togglePlay);
  playPauseBtn.addEventListener('click', togglePlay);

  ytVideo.addEventListener('timeupdate', () => {
    if (!isDraggingProgress) updateProgressUI();
  });

  ytVideo.addEventListener('loadedmetadata', () => {
    durationTimeEl.textContent = formatTime(ytVideo.duration);
    updateProgressUI();
  });

  ytVideo.addEventListener('ended', () => {
    isPlaying = false;
    updatePlayPauseUI();
    playNextClip();
  });

  function playNextClip() {
    if (!activeClip || clips.length <= 1) return;
    const currentIndex = clips.findIndex(c => c.id === activeClip.id);
    const nextIndex = (currentIndex + 1) % clips.length;
    selectClip(clips[nextIndex]);
  }

  if (nextClipBtn) {
    nextClipBtn.addEventListener('click', playNextClip);
  }

  // Timeline Drag & Hover
  progressWrap.addEventListener('mousemove', (e) => {
    const rect = progressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (ytVideo.duration) {
      hoverTimeTooltip.textContent = formatTime(ratio * ytVideo.duration);
      hoverTimeTooltip.style.left = (ratio * 100) + '%';
    }
  });

  progressWrap.addEventListener('mousedown', (e) => {
    isDraggingProgress = true;
    progressWrap.classList.add('dragging');
    seekVideo(e.clientX);
  });

  document.addEventListener('mousemove', (e) => {
    if (isDraggingProgress) seekVideo(e.clientX);
  });

  document.addEventListener('mouseup', () => {
    if (isDraggingProgress) {
      isDraggingProgress = false;
      progressWrap.classList.remove('dragging');
    }
  });

  // Volume & Mute
  volumeSlider.addEventListener('input', () => {
    const val = volumeSlider.value / 100;
    ytVideo.volume = val;
    ytVideo.muted = val === 0;
    volumeIcon.innerHTML = (val === 0) ? ICON_VOL_MUTE : ICON_VOL_HIGH;
  });

  muteBtn.addEventListener('click', () => {
    ytVideo.muted = !ytVideo.muted;
    if (ytVideo.muted) {
      volumeIcon.innerHTML = ICON_VOL_MUTE;
      volumeSlider.value = 0;
    } else {
      volumeIcon.innerHTML = ICON_VOL_HIGH;
      volumeSlider.value = (ytVideo.volume * 100) || 100;
    }
  });

  // Playback Speed
  speedBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    speedMenu.classList.toggle('visible');
  });

  document.addEventListener('click', () => speedMenu.classList.remove('visible'));

  document.querySelectorAll('.yt-speed-opt').forEach(opt => {
    opt.addEventListener('click', () => {
      const spd = parseFloat(opt.dataset.speed) || 1.0;
      playbackSpeed = spd;
      ytVideo.playbackRate = spd;
      speedBtn.textContent = `${spd}x`;
      document.querySelectorAll('.yt-speed-opt').forEach(b => b.classList.remove('active'));
      opt.classList.add('active');
    });
  });

  // Fullscreen
  fullscreenBtn.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      playerWrap.requestFullscreen().catch(err => console.error(err));
    } else {
      document.exitFullscreen();
    }
  });

  // Keyboard Shortcuts (Space, k, f, m)
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      togglePlay();
    } else if (e.key === 'f') {
      e.preventDefault();
      fullscreenBtn.click();
    } else if (e.key === 'm') {
      e.preventDefault();
      muteBtn.click();
    }
  });

  // Delete Clip Action
  activeClipDeleteBtn.addEventListener('click', async () => {
    if (!activeClip) return;
    if (!confirm(`Are you sure you want to delete "${activeClip.title}" from stored clips?`)) {
      return;
    }

    try {
      const res = await fetch(`/api/clips/${activeClip.id}`, { method: 'DELETE' });
      if (res.ok) {
        clips = clips.filter(c => c.id !== activeClip.id);
        renderClipsList(searchInput.value);
        if (clips.length > 0) selectClip(clips[0]);
        else renderEmptyState();
      } else {
        alert('Failed to delete clip.');
      }
    } catch (e) {
      alert('Error deleting clip.');
    }
  });

  // Search Filter
  searchInput.addEventListener('input', () => {
    renderClipsList(searchInput.value);
  });

  // Direct Upload Clip
  directUploadInput.addEventListener('change', async () => {
    const file = directUploadInput.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('video', file);

    activeClipTitle.textContent = 'Uploading new clip...';

    try {
      const res = await fetch('/api/clips/upload', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (res.ok && data.clip) {
        clips.unshift(data.clip);
        renderClipsList(searchInput.value);
        selectClip(data.clip);
      } else {
        alert(data.error || 'Failed to upload clip');
      }
    } catch {
      alert('Error uploading clip');
    } finally {
      directUploadInput.value = '';
    }
  });

  // Initial Boot
  loadClips();

})();
