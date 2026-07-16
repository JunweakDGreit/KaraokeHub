const socket = io();

socket.on('connect', () => {
  socket.emit('join', { code: CODE });
});

socket.on('queue_update', ({ queue }) => renderQueue(queue));
socket.on('now_playing_update', ({ now_playing }) => playMedia(now_playing));
socket.on('playback_update', ({ paused }) => {
  const media = document.getElementById('videoPlayer');
  if (!media.src) return;
  if (paused && !media.paused) media.pause();
  if (!paused && media.paused) media.play();
});

let vocalReduction = false;
let currentItem = null;
let playbackMode = "karaoke";
let wasPaused = false;

// --- Audio processing (Web Audio API) ---
let audioCtx = null;
let acSource = null;
let acSourceEl = null;
let acGainLR = null;
let acGainRL = null;

try {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
} catch (e) {}

document.addEventListener('click', () => {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
});

function teardownAudio() {
  if (acSource) {
    try { acSource.disconnect(); } catch (e) {}
    acSource = null;
    acSourceEl = null;
  }
  acGainLR = null;
  acGainRL = null;
}

function setupAudio(mediaEl) {
  teardownAudio();

  if (!audioCtx) {
    mediaEl.muted = false;
    return;
  }

  try {
    acSource = audioCtx.createMediaElementSource(mediaEl);
    acSourceEl = mediaEl;
    mediaEl.muted = true;

    const splitter = audioCtx.createChannelSplitter(2);
    const merger = audioCtx.createChannelMerger(2);

    const gainLL = audioCtx.createGain(); gainLL.gain.value = 1;
    const gainRR = audioCtx.createGain(); gainRR.gain.value = 1;
    acGainLR = audioCtx.createGain();
    acGainRL = audioCtx.createGain();
    applyVocalState();

    acSource.connect(splitter);

    splitter.connect(gainLL, 0, 0); gainLL.connect(merger, 0, 0);
    splitter.connect(acGainLR, 0, 0); acGainLR.connect(merger, 0, 1);
    splitter.connect(acGainRL, 1, 0); acGainRL.connect(merger, 0, 0);
    splitter.connect(gainRR, 1, 0); gainRR.connect(merger, 0, 1);

    merger.connect(audioCtx.destination);
  } catch (e) {
    console.warn('AudioContext setup failed, falling back to native audio:', e);
    mediaEl.muted = false;
    teardownAudio();
  }
}

function applyVocalState() {
  const val = vocalReduction ? -1 : 0;
  if (acGainLR) acGainLR.gain.value = val;
  if (acGainRL) acGainRL.gain.value = val;
}



function playMedia(item) {
  const container = document.getElementById('mediaContainer');
  const idle = document.getElementById('idleOverlay');
  const audioDiv = document.getElementById('playerAudio');
  const videoDiv = document.getElementById('playerVideo');
  const ytDiv = document.getElementById('playerYoutube');
  const audioEl = document.getElementById('audioPlayer');
  const videoEl = document.getElementById('videoPlayer');
  const ytEl = document.getElementById('ytPlayer');
  const info = document.getElementById('nowPlayingInfo');

  [audioDiv, videoDiv, ytDiv].forEach(el => el.style.display = 'none');
  audioEl.pause(); audioEl.removeAttribute('src');
  videoEl.pause(); videoEl.removeAttribute('src');
  ytEl.src = '';

  if (!item) {
    currentItem = null;
    container.classList.remove('active');
    idle.classList.add('active');
    info.className = 'np-info-empty';
    info.textContent = 'Nothing playing';
    document.getElementById('progressBar').style.display = 'none';
    checkIdleState();
    return;
  }

  currentItem = item;
  idle.classList.remove('active');
  container.classList.add('active');
  checkIdleState();
  document.getElementById('progressBar').style.display = 'block';
  document.getElementById('progressFill').style.width = '0%';
  document.getElementById('currentTime').textContent = '0:00';
  document.getElementById('totalTime').textContent = '0:00';

  info.className = 'now-playing';
  info.innerHTML = `
    <div class="pulse"></div>
    <div>
      <div class="setlist-title">${escapeHtml(item.title)}</div>
      <div class="setlist-meta">${escapeHtml(item.artist || '')} &middot; ${escapeHtml(item.requested_by)}</div>
    </div>
  `;

  const mediaUrl = item.media_url || (
    item.source === 'local' ? `/api/media?path=${encodeURIComponent(item.source_ref)}` :
    item.source === 'youtube' ? `/api/stream/yt/${item.source_ref}` :
    ''
  );

  videoDiv.style.display = 'flex';
  videoEl.src = mediaUrl;
  videoEl.muted = true;
  wasPaused = false;
  videoEl.onplay = () => {
    if (!acSource) videoEl.muted = false;
    videoEl.onplay = null;
  };
  videoEl.play().catch(() => {});
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Host search ---
const hostSearch = document.getElementById('hostSearch');
const hostSearchClear = document.getElementById('hostSearchClear');
const hostSearchResults = document.getElementById('hostSearchResults');
const setlistSection = document.getElementById('setlistSection');
let hostSearchTimer;

function updateSearchUI(active) {
  hostSearchClear.classList.toggle('visible', active);
  if (active) {
    setlistSection.classList.add('hidden');
    hostSearchResults.style.maxHeight = '400px';
  } else {
    setlistSection.classList.remove('hidden');
    hostSearchResults.style.maxHeight = '150px';
  }
}

hostSearch.addEventListener('input', () => {
  clearTimeout(hostSearchTimer);
  const q = hostSearch.value.trim();
  document.getElementById('suggestions').innerHTML = '';
  updateSearchUI(!!q);
  if (!q) {
    hostSearchResults.innerHTML = '';
    checkIdleState();
    return;
  }
  hostSearchTimer = setTimeout(() => runHostSearch(q), 300);
});

hostSearchClear.addEventListener('click', () => {
  hostSearch.value = '';
  hostSearchResults.innerHTML = '';
  updateSearchUI(false);
  checkIdleState();
  hostSearch.focus();
});

const idleSearch = document.getElementById('idleSearch');
const idleSearchClear = document.getElementById('idleSearchClear');
let idleSearchTimer;

idleSearch.addEventListener('input', () => {
  clearTimeout(idleSearchTimer);
  const q = idleSearch.value.trim();
  idleSearchClear.classList.toggle('visible', !!q);
  if (!q) {
    document.getElementById('idleSearchResults').innerHTML = '';
    return;
  }
  idleSearchTimer = setTimeout(() => runHostSearch(q, 'idleSearchResults'), 300);
});

idleSearchClear.addEventListener('click', () => {
  idleSearch.value = '';
  document.getElementById('idleSearchResults').innerHTML = '';
  idleSearchClear.classList.remove('visible');
  idleSearch.focus();
});

async function runHostSearch(q, targetId) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&mode=${playbackMode}`);
  const data = await res.json();
  renderHostResults(data.results || [], targetId);
}

function renderHostResults(results, targetId) {
  const el = document.getElementById(targetId || 'hostSearchResults');
  if (!results.length) {
    el.innerHTML = '<div class="empty-state" style="padding:8px; font-size:12px;">No matches</div>';
    return;
  }
  el.innerHTML = results.map((r, i) => `
    <div class="host-result-row" style="animation-delay:${i * 30}ms;">
      <div class="host-result-info">
        <div class="host-result-title">${escapeHtml(r.title)}</div>
        <div class="host-result-artist">${escapeHtml(r.artist || '')}</div>
      </div>
      <button class="host-add-btn" onclick='hostAddToQueue(this, ${JSON.stringify(r).replace(/'/g, "&#39;")})'>+</button>
    </div>
  `).join('');
}

function flyToQueue(btn, song) {
  const ql = document.getElementById('queueList');
  if (!ql) return;
  const dest = ql.getBoundingClientRect();
  if (dest.width === 0 || dest.height === 0) return;
  const srcRect = btn.getBoundingClientRect();
  const lastItem = ql.querySelector('.setlist-item:last-child');
  const destRect = lastItem ? lastItem.getBoundingClientRect() : dest;
  const destTop = lastItem ? destRect.bottom + 4 : destRect.top + 8;

  const srcCenterX = srcRect.left - 10;
  const sweepX = window.innerWidth - 40 - srcCenterX;
  const arcY = (destTop - srcRect.top) * 0.4;

  const fly = document.createElement('div');
  fly.className = 'fly-clone';
  fly.innerHTML = `<div style="display:flex;align-items:center;gap:10px;"><div style="font-family:'Space Mono',monospace;color:var(--muted);font-size:12px;width:18px;flex-shrink:0;">#</div><div style="flex:1;min-width:0;"><div style="font-size:12px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(song.title)}</div><div style="font-size:10px;color:var(--muted);">${escapeHtml(song.artist || '')}</div></div></div>`;
  fly.style.left = srcCenterX + 'px';
  fly.style.top = srcRect.top + 'px';
  fly.style.width = '180px';
  document.body.appendChild(fly);

  requestAnimationFrame(() => {
    fly.style.transform = `translate(${sweepX}px, ${arcY}px) scale(0.85)`;
    fly.style.opacity = '0.4';
  });

  fly.addEventListener('transitionend', () => fly.remove(), { once: true });
}

async function hostAddToQueue(btn, song) {
  flyToQueue(btn, song);
  await fetch(`/api/rooms/${CODE}/queue`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({...song, requested_by: 'Host'})
  });
}

// --- Queue ---
let queueItems = [];

function renderQueue(queue) {
  queueItems = queue;
  const el = document.getElementById('queueList');
  if (!queue.length) {
    el.innerHTML = '<div class="empty-state" style="padding:20px 0;">No songs queued yet</div>';
  } else {
    el.innerHTML = queue.map((item, i) => `
      <div class="setlist-item" draggable="true"
           ondblclick="handleQueueDblClick(event, ${i})"
           ondragstart="handleDragStart(event, ${i})"
           ondragend="handleDragEnd(event)"
           ondragover="handleDragOver(event)"
           ondragleave="handleDragLeave(event)"
           ondrop="handleDrop(event, ${i})"
           style="padding:8px 4px; animation-delay:${i * 40}ms;">
        <div class="setlist-num" style="font-size:12px; width:18px;">${i + 1}</div>
        <div class="setlist-info">
          <div class="setlist-title" style="font-size:13px;">${escapeHtml(item.title)}</div>
          <div class="setlist-meta" style="font-size:11px;">${escapeHtml(item.artist || '')} &middot; ${item.requested_by}</div>
        </div>
        <button class="remove-btn" style="font-size:14px;" onclick="removeItem(${item.item_id})">✕</button>
      </div>
    `).join('');
  }
  checkIdleState();
}

async function removeItem(itemId) {
  await fetch(`/api/rooms/${CODE}/queue/${itemId}`, { method: 'DELETE' });
}

let dragSourceIdx = null;

function handleDragStart(e, idx) {
  dragSourceIdx = idx;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function handleDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.setlist-item.drag-over').forEach(el => el.classList.remove('drag-over'));
  dragSourceIdx = null;
}

function handleDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  e.currentTarget.classList.add('drag-over');
}

function handleDragLeave(e) {
  e.currentTarget.classList.remove('drag-over');
}

async function handleDrop(e, toIdx) {
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if (dragSourceIdx === null || dragSourceIdx === toIdx) return;
  await fetch(`/api/rooms/${CODE}/queue/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_index: dragSourceIdx, to_index: toIdx })
  });
  dragSourceIdx = null;
}

let contextMenuEl = null;

function handleQueueDblClick(e, idx) {
  e.stopPropagation();
  closeContextMenu();
  const menu = document.createElement('div');
  menu.className = 'queue-context-menu';
  menu.innerHTML = '<button onclick="playNext(event)">▶ Play Next</button>';
  menu.style.left = Math.min(e.clientX, window.innerWidth - 156) + 'px';
  menu.style.top = Math.min(e.clientY, window.innerHeight - 50) + 'px';
  menu._queueIdx = idx;
  document.body.appendChild(menu);
  contextMenuEl = menu;
  setTimeout(() => document.addEventListener('click', closeContextMenu, { once: true }), 0);
}

function closeContextMenu() {
  if (contextMenuEl) { contextMenuEl.remove(); contextMenuEl = null; }
}

async function playNext(e) {
  if (!contextMenuEl) return;
  const idx = contextMenuEl._queueIdx;
  closeContextMenu();
  e.stopPropagation();
  if (idx <= 0) return;
  await fetch(`/api/rooms/${CODE}/queue/reorder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ from_index: idx, to_index: 0 })
  });
}

function checkIdleState() {
  const sidebar = document.querySelector('.dash-sidebar');
  const idle = !currentItem && !queueItems.length;
  if (idle) {
    sidebar.classList.remove('collapsed');
    fetchSuggestions();
  } else {
    document.getElementById('suggestions').innerHTML = '';
  }
  document.getElementById('modePills').classList.toggle('hidden', idle);
  document.getElementById('hostSearch').classList.toggle('sink', idle);
  updateSidebarIcon();
}

async function fetchSuggestions() {
  const el = document.getElementById('suggestions');
  el.innerHTML = '<div class="empty-state" style="padding:8px; font-size:12px;">Loading suggestions…</div>';
  try {
    const res = await fetch('/api/top?limit=8');
    const data = await res.json();
    renderSuggestions(data.results || []);
  } catch (e) {
    el.innerHTML = '';
  }
}

function renderSuggestions(results) {
  const el = document.getElementById('suggestions');
  if (!results.length) {
    el.innerHTML = '<div class="empty-state" style="padding:8px; font-size:12px;">Play some songs to get suggestions</div>';
    return;
  }
  el.innerHTML = results.map((r, i) => `
    <div class="host-result-row" style="animation-delay:${i * 40}ms;">
      <div class="host-result-info">
        <div class="host-result-title">${escapeHtml(r.title)}</div>
        <div class="host-result-artist">${escapeHtml(r.artist || '')} &middot; ${r.play_count || 0} plays</div>
      </div>
      <button class="host-add-btn" onclick='hostAddSuggestion(${JSON.stringify(r).replace(/'/g, "&#39;")})'>+</button>
    </div>
  `).join('');
}

async function hostAddSuggestion(song) {
  await fetch(`/api/rooms/${CODE}/queue`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({...song, requested_by: 'Host'})
  });
}

// --- Auto-advance on media end ---
document.getElementById('videoPlayer').addEventListener('ended', async () => {
  await fetch(`/api/rooms/${CODE}/play_next`, { method: 'POST' });
});

document.getElementById('playNextBtn').addEventListener('click', async () => {
  await fetch(`/api/rooms/${CODE}/play_next`, { method: 'POST' });
});

// --- Play / Pause toggle ---
const playPauseBtn = document.getElementById('playPauseBtn');

playPauseBtn.addEventListener('click', () => {
  const media = document.getElementById('videoPlayer');
  if (!media.src) return;
  if (media.paused) {
    media.play();
  } else {
    media.pause();
  }
  fetch(`/api/rooms/${CODE}/playpause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: media.paused })
  }).catch(() => {});
});

function updatePlayPauseBtn(isPaused) {
  playPauseBtn.innerHTML = isPaused ? '▶ Play' : '⏸ Pause';
  const overlay = document.getElementById('pauseOverlay');
  const playAnim = document.getElementById('playAnim');
  if (isPaused) {
    wasPaused = true;
    playAnim.classList.remove('pop');
    overlay.classList.add('active');
  } else {
    overlay.classList.remove('active');
    if (wasPaused) {
      playAnim.classList.remove('pop');
      void playAnim.offsetWidth;
      playAnim.classList.add('pop');
    }
    wasPaused = false;
  }
}

['videoPlayer'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('play', () => updatePlayPauseBtn(false));
  el.addEventListener('pause', () => updatePlayPauseBtn(true));
  el.addEventListener('ended', () => updatePlayPauseBtn(true));
});

document.getElementById('pauseOverlay').addEventListener('click', () => {
  const media = document.getElementById('videoPlayer');
  if (media.src && media.paused) {
    media.play().catch(() => {});
  }
});

// --- Progress bar ---
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

document.getElementById('videoPlayer').addEventListener('timeupdate', () => {
  const video = document.getElementById('videoPlayer');
  if (!video.duration) return;
  const pct = (video.currentTime / video.duration) * 100;
  document.getElementById('progressFill').style.width = pct + '%';
  document.getElementById('currentTime').textContent = fmtTime(video.currentTime);
  document.getElementById('totalTime').textContent = fmtTime(video.duration);
});

document.getElementById('progressTrack').addEventListener('click', (e) => {
  const video = document.getElementById('videoPlayer');
  if (!video.duration) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  video.currentTime = pct * video.duration;
});

// --- Vocal reduction toggle ---
const vocalToggle = document.getElementById('vocalToggle');

vocalToggle.addEventListener('click', async () => {
  const media = document.getElementById('videoPlayer');
  if (!media.src) return;

  if (audioCtx && audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  vocalReduction = !vocalReduction;
  updateVocalToggle();

  if (!acSource || acSourceEl !== media) {
    setupAudio(media);
  }

  applyVocalState();
});

function updateVocalToggle() {
  vocalToggle.title = vocalReduction ? 'Voice: Off' : 'Voice: On';
  vocalToggle.classList.toggle('btn-voice-active', vocalReduction);
  vocalToggle.style.display = playbackMode === 'karaoke' ? 'none' : 'flex';
}

// --- Playback mode selector ---
document.querySelectorAll('.mode-pill').forEach(pill => {
  pill.addEventListener('click', function () {
    setPlaybackMode(this.dataset.mode);
  });
});

function setPlaybackMode(mode) {
  playbackMode = mode;
  document.querySelectorAll('.mode-pill').forEach(p => p.classList.toggle('active', p.dataset.mode === mode));
  updateVocalToggle();
  const q = hostSearch.value.trim();
  if (q) runHostSearch(q);
  const idleQ = document.getElementById('idleSearch').value.trim();
  if (idleQ) runHostSearch(idleQ, 'idleSearchResults');
}

// --- Keyboard shortcuts ---
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const video = document.getElementById('videoPlayer');
  const media = video && video.src ? video : null;

  switch (e.code) {
    case 'Space':
      e.preventDefault();
      if (media) media.paused ? media.play() : media.pause();
      break;
    case 'ArrowLeft':
      if (media) media.currentTime = Math.max(0, media.currentTime - 5);
      break;
    case 'ArrowRight':
      if (media) media.currentTime = Math.min(media.duration || 0, media.currentTime + 5);
      break;
    case 'KeyN':
      document.getElementById('playNextBtn').click();
      break;
    case 'KeyM':
      if (media) media.muted = !media.muted;
      break;
    case 'KeyF':
      e.preventDefault();
      if (media && media.tagName === 'VIDEO') {
        media.requestFullscreen ? media.requestFullscreen() :
        media.webkitRequestFullscreen ? media.webkitRequestFullscreen() : null;
      }
      break;
  }
});

// --- Folder browser (one-level pick + instant scan) ---
let drivesCache = [];

document.getElementById('browseBtn').addEventListener('click', async () => {
  const fb = document.getElementById('folderBrowser');
  if (fb.style.display === 'block') { fb.style.display = 'none'; return; }
  fb.style.display = 'block';
  fb.innerHTML = '<div class="empty-state" style="padding:6px;font-size:12px;">Loading drives…</div>';
  if (!drivesCache.length) {
    const res = await fetch('/api/fs/drives');
    const data = await res.json();
    drivesCache = data.drives || [];
  }
  showDrives();
});

function showDrives() {
  const fb = document.getElementById('folderBrowser');
  fb.innerHTML = '<div class="folder-browser-header">Pick a drive:</div>' +
    drivesCache.map(d => `<div class="folder-row" data-path="${d}">&#128193; ${d}</div>`).join('');
  fb.querySelectorAll('.folder-row').forEach(el => {
    el.addEventListener('click', () => showSubfolders(el.dataset.path));
  });
}

async function showSubfolders(drivePath) {
  const fb = document.getElementById('folderBrowser');
  fb.innerHTML = '<div class="empty-state" style="padding:6px;font-size:12px;">Loading…</div>';
  const res = await fetch('/api/fs/list?path=' + encodeURIComponent(drivePath));
  const data = await res.json();
  if (data.error) {
    fb.innerHTML = `<div class="empty-state" style="font-size:12px;">${data.error}</div>`;
    return;
  }
  let html = `<div class="folder-row back-drives">&#128281; ${drivePath} &mdash; back to drives</div>`;
  if (!data.entries.length) {
    html += '<div class="empty-state" style="padding:6px;font-size:12px;">No subfolders</div>';
  } else {
    html += '<div class="folder-entries">' +
      data.entries.map(e => `<div class="folder-row" data-path="${e.path}">&#128193; ${e.name}</div>`).join('') +
      '</div>';
  }
  fb.innerHTML = html;
  fb.querySelector('.back-drives').addEventListener('click', showDrives);
  fb.querySelectorAll('.folder-row:not(.back-drives)').forEach(el => {
    el.addEventListener('click', async () => scanFolder(el.dataset.path, el.textContent.trim()));
  });
}

async function scanFolder(path, name) {
  const fb = document.getElementById('folderBrowser');
  fb.innerHTML = '<div class="empty-state" style="padding:6px;font-size:12px;">Scanning…</div>';
  try {
    const r = await fetch('/api/library/scan-path', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({path})
    });
    const d = await r.json();
    if (d.error) {
      fb.innerHTML = `<div class="empty-state" style="font-size:12px;">Error: ${d.error}</div>`;
    } else {
      fb.innerHTML = `<div class="empty-state" style="padding:6px;font-size:12px;color:var(--gold);">Found ${d.indexed_files} songs in ${escapeHtml(name)}</div>
        <div class="folder-row back-drives" style="text-align:center;">&#128281; Back to drives</div>`;
      fb.querySelector('.back-drives').addEventListener('click', showDrives);
    }
  } catch(e) {
    fb.innerHTML = '<div class="empty-state" style="font-size:12px;">Scan failed</div>';
  }
}

// --- Sidebar toggle ---
function updateSidebarIcon() {
  const collapsed = document.querySelector('.dash-sidebar').classList.contains('collapsed');
  document.getElementById('toggleSidebar').classList.toggle('sidebar-closed', collapsed);
}

document.getElementById('toggleSidebar').addEventListener('click', () => {
  document.querySelector('.dash-sidebar').classList.toggle('collapsed');
  updateSidebarIcon();
});

document.getElementById('newRoomBtn').addEventListener('click', async () => {
  if (!confirm('Create a new room? This keeps the current room.')) return;
  const res = await fetch('/api/rooms/create', { method: 'POST' });
  const data = await res.json();
  if (data.code) window.location.href = `/host/${data.code}`;
});

// initial load
updateVocalToggle();
fetch(`/api/rooms/${CODE}`).then(r => r.json()).then(data => {
  if (data.queue) renderQueue(data.queue);
  if (data.now_playing !== undefined) playMedia(data.now_playing);
});
