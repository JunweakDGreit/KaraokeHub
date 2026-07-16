const socket = io();
let myName = localStorage.getItem('karaokehub_name');
if (!myName) {
  myName = prompt("What's your name?", "Guest") || "Guest";
  localStorage.setItem('karaokehub_name', myName);
}

socket.on('connect', () => {
  socket.emit('join', { code: CODE });
});

socket.on('queue_update', ({ queue }) => renderQueue(queue));
socket.on('now_playing_update', ({ now_playing }) => updateNowPlaying(now_playing));
socket.on('playback_update', ({ paused }) => updatePlayPauseBtn(paused));

// --- Tab switching ---
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'browse') loadBrowse();
  });
});

// --- Search ---
const searchInput = document.getElementById('searchInput');
const joinSearchClear = document.getElementById('joinSearchClear');
const joinNowPlayingCard = document.getElementById('joinNowPlayingCard');
const joinSetlistCard = document.getElementById('joinSetlistCard');
const results = document.getElementById('results');
let debounceTimer;
let searchMode = "karaoke";

function updateJoinSearchUI(active) {
  joinSearchClear.classList.toggle('visible', active);
  joinNowPlayingCard.style.display = active ? 'none' : '';
  joinSetlistCard.style.display = active ? 'none' : '';
  results.style.maxHeight = active ? '520px' : '420px';
}

document.querySelectorAll('#joinModePills .mode-pill').forEach(pill => {
  pill.addEventListener('click', function () {
    searchMode = this.dataset.mode;
    document.querySelectorAll('#joinModePills .mode-pill').forEach(p => p.classList.toggle('active', p.dataset.mode === searchMode));
    const q = searchInput.value.trim();
    if (q) runSearch(q);
  });
});

searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  updateJoinSearchUI(!!q);
  if (!q) { results.innerHTML = ''; return; }
  debounceTimer = setTimeout(() => runSearch(q), 350);
});

joinSearchClear.addEventListener('click', () => {
  searchInput.value = '';
  results.innerHTML = '';
  updateJoinSearchUI(false);
  searchInput.focus();
});

async function runSearch(q) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&mode=${searchMode}`);
  const data = await res.json();
  renderResults(data.results || []);
}

function renderResults(results) {
  const el = document.getElementById('results');
  if (!results.length) {
    el.innerHTML = `<div class="empty-state">No matches yet — keep typing.</div>`;
    return;
  }
  el.innerHTML = results.map(r => `
    <div class="result-row">
      <div>
        <div class="result-title">${escapeHtml(r.title)}</div>
        <div class="result-artist">${escapeHtml(r.artist || '')} <span class="tag ${r.source === 'youtube' ? 'tag-youtube' : 'tag-local'}">${r.source}</span></div>
      </div>
      <button class="add-btn" onclick='addToQueue(${JSON.stringify(r).replace(/'/g, "&#39;")})'>+</button>
    </div>
  `).join('');
}

async function addToQueue(song) {
  await fetch(`/api/rooms/${CODE}/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...song, requested_by: myName })
  });
}

// --- Browse library ---
let browseCache = null;

async function loadBrowse() {
  const el = document.getElementById('browseList');
  if (browseCache) { renderBrowse(browseCache, el); return; }
  el.className = 'empty-state';
  el.textContent = 'Loading library…';
  const res = await fetch('/api/library');
  const data = await res.json();
  browseCache = data.songs || [];
  renderBrowse(browseCache, el);
}

function renderBrowse(songs, el) {
  if (!songs.length) {
    el.className = 'empty-state';
    el.textContent = 'No local songs found. Drop karaoke files into the library/ folder.';
    return;
  }
  el.className = '';
  const grouped = {};
  songs.forEach(s => {
    const key = s.artist || 'Unknown';
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(s);
  });
  const artists = Object.keys(grouped).sort();
  el.innerHTML = artists.map(artist => `
    <div class="browse-artist">
      <div class="browse-artist-name">${escapeHtml(artist)}</div>
      ${grouped[artist].map(s => `
        <div class="browse-song">
          <span class="browse-song-title">${escapeHtml(s.title)}</span>
          <button class="add-btn-sm" onclick='addToQueue(${JSON.stringify({id: s.id, title: s.title, artist: s.artist, source: "local", source_ref: s.filepath}).replace(/'/g, "&#39;")})'>+</button>
        </div>
      `).join('')}
    </div>
  `).join('');
}

// --- Queue ---
function renderQueue(queue) {
  const el = document.getElementById('queueList');
  if (!queue.length) {
    el.className = 'empty-state';
    el.textContent = 'No songs queued yet — search or browse above to add one.';
    return;
  }
  el.className = '';
  el.innerHTML = queue.map((item, i) => `
    <div class="setlist-item" draggable="true"
         ondblclick="handleQueueDblClick(event, ${i})"
         ondragstart="handleDragStart(event, ${i})"
         ondragend="handleDragEnd(event)"
         ondragover="handleDragOver(event)"
         ondragleave="handleDragLeave(event)"
         ondrop="handleDrop(event, ${i})">
      <div class="setlist-num">${i + 1}</div>
      <div class="setlist-info">
        <div class="setlist-title">${escapeHtml(item.title)}</div>
        <div class="setlist-meta">${escapeHtml(item.artist || '')} · ${item.requested_by}</div>
      </div>
    </div>
  `).join('');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
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

fetch(`/api/rooms/${CODE}`).then(r => r.json()).then(data => {
  if (data.queue) renderQueue(data.queue);
  if (data.now_playing !== undefined) updateNowPlaying(data.now_playing);
});

// load browse on first tab click
loadBrowse();

// --- Now Playing + controls ---
function updateNowPlaying(item) {
  const info = document.getElementById('joinNowPlayingInfo');
  const controls = document.getElementById('guestControls');
  if (!item) {
    info.className = 'empty-state';
    info.textContent = 'Nothing playing';
    controls.style.display = 'none';
    return;
  }
  info.className = '';
  info.innerHTML = `
    <div class="result-title" style="font-size:15px;">${escapeHtml(item.title)}</div>
    <div class="result-artist" style="font-size:12px;">${escapeHtml(item.artist || '')} &middot; ${escapeHtml(item.requested_by || '')}</div>
  `;
  controls.style.display = 'flex';
}

function updatePlayPauseBtn(paused) {
  const btn = document.getElementById('guestPlayPause');
  btn.innerHTML = paused ? '▶ Play' : '⏸ Pause';
}

document.getElementById('guestPlayPause').addEventListener('click', () => {
  const btn = document.getElementById('guestPlayPause');
  const isPaused = btn.innerHTML.includes('Play');
  fetch(`/api/rooms/${CODE}/playpause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paused: !isPaused })
  }).catch(() => {});
});

document.getElementById('guestNext').addEventListener('click', () => {
  fetch(`/api/rooms/${CODE}/play_next`, { method: 'POST' }).catch(() => {});
});
