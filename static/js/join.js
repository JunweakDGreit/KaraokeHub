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
let debounceTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  const q = searchInput.value.trim();
  if (!q) { document.getElementById('results').innerHTML = ''; return; }
  debounceTimer = setTimeout(() => runSearch(q), 350);
});

async function runSearch(q) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
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
  searchInput.value = '';
  document.getElementById('results').innerHTML = '';
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
    <div class="setlist-item">
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

fetch(`/api/rooms/${CODE}`).then(r => r.json()).then(data => {
  if (data.queue) renderQueue(data.queue);
});

// load browse on first tab click
loadBrowse();
