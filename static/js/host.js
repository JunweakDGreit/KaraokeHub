const socket = io();

socket.on('connect', () => {
  socket.emit('join', { code: CODE });
});

socket.on('queue_update', ({ queue }) => renderQueue(queue));
socket.on('now_playing_update', ({ now_playing }) => playMedia(now_playing));

const VIDEO_EXT = {'.mp4':1, '.webm':1, '.mkv':1, '.avi':1, '.mov':1};

function getMediaType(item) {
  if (!item || !item.source) return null;
  if (item.source === 'youtube') return 'youtube';
  const ext = item.source_ref ? '.' + item.source_ref.split('.').pop().toLowerCase() : '';
  return VIDEO_EXT[ext] ? 'video' : 'audio';
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
  audioEl.pause(); audioEl.src = '';
  videoEl.pause(); videoEl.src = '';
  ytEl.src = '';

  if (!item) {
    container.style.display = 'none';
    idle.style.display = 'flex';
    info.className = 'np-info-empty';
    info.textContent = 'Nothing playing';
    return;
  }

  idle.style.display = 'none';
  container.style.display = 'flex';

  info.className = 'now-playing';
  info.innerHTML = `
    <div class="pulse"></div>
    <div>
      <div class="setlist-title">${escapeHtml(item.title)}</div>
      <div class="setlist-meta">${escapeHtml(item.artist || '')} &middot; ${escapeHtml(item.requested_by)}</div>
    </div>
  `;

  const type = getMediaType(item);

  if (type === 'youtube' && item.media_url) {
    ytDiv.style.display = 'block';
    ytEl.src = item.media_url;
    return;
  }

  if (type === 'video' && item.media_url) {
    videoDiv.style.display = 'flex';
    videoEl.src = item.media_url;
    videoEl.play().catch(() => {});
    return;
  }

  audioDiv.style.display = 'block';
  audioEl.src = item.media_url;
  audioEl.play().catch(() => {});
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// --- Host search ---
const hostSearch = document.getElementById('hostSearch');
let hostSearchTimer;
hostSearch.addEventListener('input', () => {
  clearTimeout(hostSearchTimer);
  const q = hostSearch.value.trim();
  if (!q) { document.getElementById('hostSearchResults').innerHTML = ''; return; }
  hostSearchTimer = setTimeout(() => runHostSearch(q), 300);
});

async function runHostSearch(q) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  renderHostResults(data.results || []);
}

function renderHostResults(results) {
  const el = document.getElementById('hostSearchResults');
  if (!results.length) {
    el.innerHTML = '<div class="empty-state" style="padding:8px; font-size:12px;">No matches</div>';
    return;
  }
  el.innerHTML = results.map(r => `
    <div class="host-result-row">
      <div class="host-result-info">
        <div class="host-result-title">${escapeHtml(r.title)}</div>
        <div class="host-result-artist">${escapeHtml(r.artist || '')}</div>
      </div>
      <button class="host-add-btn" onclick='hostAddToQueue(${JSON.stringify(r).replace(/'/g, "&#39;")})'>+</button>
    </div>
  `).join('');
}

async function hostAddToQueue(song) {
  await fetch(`/api/rooms/${CODE}/queue`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({...song, requested_by: 'Host'})
  });
  hostSearch.value = '';
  document.getElementById('hostSearchResults').innerHTML = '';
}

// --- Queue ---
function renderQueue(queue) {
  const el = document.getElementById('queueList');
  if (!queue.length) {
    el.innerHTML = '<div class="empty-state" style="padding:20px 0;">No songs queued yet</div>';
    return;
  }
  el.innerHTML = queue.map((item, i) => `
    <div class="setlist-item" style="padding:8px 4px;">
      <div class="setlist-num" style="font-size:12px; width:18px;">${i + 1}</div>
      <div class="setlist-info">
        <div class="setlist-title" style="font-size:13px;">${escapeHtml(item.title)}</div>
        <div class="setlist-meta" style="font-size:11px;">${escapeHtml(item.artist || '')} &middot; ${item.requested_by}</div>
      </div>
      <button class="remove-btn" style="font-size:14px;" onclick="removeItem(${item.item_id})">✕</button>
    </div>
  `).join('');
}

async function removeItem(itemId) {
  await fetch(`/api/rooms/${CODE}/queue/${itemId}`, { method: 'DELETE' });
}

// --- Auto-advance on media end ---
['audioPlayer', 'videoPlayer'].forEach(id => {
  document.getElementById(id).addEventListener('ended', async () => {
    await fetch(`/api/rooms/${CODE}/play_next`, { method: 'POST' });
  });
});

document.getElementById('playNextBtn').addEventListener('click', async () => {
  await fetch(`/api/rooms/${CODE}/play_next`, { method: 'POST' });
});

// --- Folder browser ---
let currentFolder = '';

document.getElementById('browseBtn').addEventListener('click', async () => {
  const fb = document.getElementById('folderBrowser');
  if (fb.style.display === 'block') { fb.style.display = 'none'; return; }
  fb.style.display = 'block';
  fb.innerHTML = '<div class="empty-state" style="padding:12px;">Loading drives&hellip;</div>';
  const res = await fetch('/api/fs/drives');
  const data = await res.json();
  renderDriveList(data.drives || []);
});

function renderDriveList(drives) {
  const fb = document.getElementById('folderBrowser');
  fb.innerHTML = '<div class="folder-browser-header">Select a drive:</div>' +
    drives.map(d => `<div class="folder-row" data-path="${d}" style="font-size:13px;">&#128193; ${d}</div>`).join('');
  fb.querySelectorAll('.folder-row').forEach(el => {
    el.addEventListener('click', () => loadFolder(el.dataset.path));
  });
}

async function loadFolder(path) {
  currentFolder = path;
  const fb = document.getElementById('folderBrowser');
  const st = document.getElementById('scanStatus');
  st.textContent = '';
  fb.innerHTML = '<div class="empty-state" style="padding:12px;">Loading&hellip;</div>';
  const res = await fetch('/api/fs/list?path=' + encodeURIComponent(path));
  const data = await res.json();
  if (data.error) { fb.innerHTML = `<div class="empty-state">${data.error}</div>`; return; }
  renderFolder(data);
}

function renderFolder(data) {
  const fb = document.getElementById('folderBrowser');
  const parts = data.current.split('\\').filter(Boolean);
  let bc = '<span class="folder-crumb" data-path="">&#128193;</span>';
  let acc = '';
  parts.forEach(p => {
    acc += '\\' + p;
    bc += ' <span class="folder-crumb sep">&#8250;</span> <span class="folder-crumb" data-path="' + acc + '\\">' + p + '</span>';
  });
  let html = '<div class="folder-breadcrumb">' + bc + '</div>';
  html += '<div class="folder-entries" style="max-height:160px;">';
  if (!data.entries.length) {
    html += '<div class="empty-state" style="padding:12px;">No subfolders</div>';
  } else {
    data.entries.forEach(e => {
      html += '<div class="folder-row" data-path="' + e.path + '" style="font-size:13px;">&#128193; ' + e.name + '</div>';
    });
  }
  html += '</div>';
  html += '<button class="btn btn-primary scan-folder-btn" style="padding:10px; font-size:13px;">Scan this folder</button>';
  fb.innerHTML = html;

  fb.querySelectorAll('.folder-row').forEach(el => el.addEventListener('click', () => loadFolder(el.dataset.path)));
  fb.querySelectorAll('.folder-crumb').forEach(el => el.addEventListener('click', () => loadFolder(el.dataset.path || '')));
  fb.querySelector('.scan-folder-btn').addEventListener('click', async () => {
    const st = document.getElementById('scanStatus');
    st.textContent = 'Scanning&hellip;';
    try {
      const r = await fetch('/api/library/scan-path', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({path: currentFolder})
      });
      const d = await r.json();
      st.textContent = d.error ? 'Error: ' + d.error : `Found ${d.indexed_files} new song(s).`;
    } catch(e) { st.textContent = 'Error scanning folder.'; }
  });
}

// --- Sidebar toggle ---
document.getElementById('toggleSidebar').addEventListener('click', () => {
  document.querySelector('.dash-sidebar').classList.toggle('collapsed');
});

// initial load
fetch(`/api/rooms/${CODE}`).then(r => r.json()).then(data => {
  if (data.queue) renderQueue(data.queue);
  if (data.now_playing !== undefined) playMedia(data.now_playing);
});
