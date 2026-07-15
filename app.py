"""
KaraokeHub — local web app
Host runs this on a laptop. Guests join from phone/laptop on the same WiFi.
"""
import os
import re
import time
import socket
import sqlite3
import random
import string
import subprocess
import webbrowser
import platform
import mimetypes
from pathlib import Path

import qrcode
import qrcode.image.svg
from io import BytesIO
import base64

from flask import Flask, request, jsonify, render_template, send_from_directory
from flask_socketio import SocketIO, join_room as socket_join_room, emit

BASE_DIR = Path(__file__).parent
LIBRARY_DIR = BASE_DIR / "library"
DB_PATH = BASE_DIR / "library.db"
SUPPORTED_EXT = {".mp3", ".mp4", ".cdg", ".m4a", ".wav", ".webm"}

app = Flask(__name__)
app.config["SECRET_KEY"] = "karaokehub-dev-secret"
socketio = SocketIO(app, cors_allowed_origins="*")

# ---------------------------------------------------------------------------
# In-memory room/queue state (ephemeral, matches ARCHITECTURE.md section 6)
# ---------------------------------------------------------------------------
rooms = {}  # code -> {created_at, queue: [...], now_playing: {...} | None, next_item_id}
ROOM_TIMEOUT_SECONDS = 4 * 60 * 60


def get_local_ip():
    """Best-effort LAN IP so QR codes/links work for phones on the same WiFi."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def generate_room_code():
    while True:
        code = "".join(random.choices(string.digits, k=4))
        if code not in rooms:
            return code


def cleanup_stale_rooms():
    now = time.time()
    stale = [c for c, r in rooms.items() if now - r["created_at"] > ROOM_TIMEOUT_SECONDS]
    for c in stale:
        del rooms[c]


# ---------------------------------------------------------------------------
# Local library indexing (Phase 1 of ARCHITECTURE.md, simplified/inline here)
# ---------------------------------------------------------------------------
def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS songs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT,
            filepath TEXT NOT NULL UNIQUE
        )"""
    )
    conn.commit()
    conn.close()


def guess_title_artist(filename: str):
    """Parse 'Artist - Title.ext' or fall back to filename as title."""
    stem = Path(filename).stem
    stem = re.sub(r"[_]+", " ", stem)
    if " - " in stem:
        artist, title = stem.split(" - ", 1)
        return title.strip(), artist.strip()
    return stem.strip(), "Unknown"


def scan_library():
    """Re-scan the library folder and (re)build the SQLite index."""
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT filepath FROM songs")
    existing = {row[0] for row in cur.fetchall()}

    found = set()
    if LIBRARY_DIR.exists():
        for path in LIBRARY_DIR.rglob("*"):
            if path.is_file() and path.suffix.lower() in SUPPORTED_EXT:
                rel = str(path.relative_to(LIBRARY_DIR))
                found.add(rel)
                if rel not in existing:
                    title, artist = guess_title_artist(path.name)
                    cur.execute(
                        "INSERT INTO songs (title, artist, filepath) VALUES (?, ?, ?)",
                        (title, artist, rel),
                    )

    # remove entries for files that no longer exist
    removed = existing - found
    for rel in removed:
        cur.execute("DELETE FROM songs WHERE filepath = ?", (rel,))

    conn.commit()
    conn.close()
    return len(found)


def search_library(query: str, limit: int = 15):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    like = f"%{query}%"
    cur.execute(
        """SELECT id, title, artist, filepath FROM songs
           WHERE title LIKE ? OR artist LIKE ?
           LIMIT ?""",
        (like, like, limit),
    )
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


# ---------------------------------------------------------------------------
# YouTube fallback (Phase 4 stub — wire up yt-dlp on the host machine)
# ---------------------------------------------------------------------------
def has_internet():
    try:
        socket.setdefaulttimeout(1.5)
        socket.gethostbyname("www.youtube.com")
        return True
    except Exception:
        return False


def search_youtube(query: str, limit: int = 5):
    """Search YouTube via yt-dlp Python module. Returns [] if unavailable."""
    try:
        from yt_dlp import YoutubeDL

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": True,
            "skip_download": True,
        }
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{query} karaoke", download=False)
            results = []
            if info and "entries" in info:
                for entry in info["entries"]:
                    vid = entry.get("id", "")
                    title = entry.get("title", "Unknown")
                    results.append(
                        {"id": vid, "title": title, "artist": "",
                         "source": "youtube", "source_ref": vid}
                    )
            return results
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/host/<code>")
def host_page(code):
    if code not in rooms:
        return "Room not found or has expired.", 404
    local_ip = get_local_ip()
    join_url = f"http://{local_ip}:5000/join/{code}"
    qr_b64 = make_qr_base64(join_url)
    return render_template("host.html", code=code, join_url=join_url, qr_b64=qr_b64)


@app.route("/join/<code>")
def join_page(code):
    cleanup_stale_rooms()
    if code not in rooms:
        return render_template("join.html", code=code, room_missing=True)
    return render_template("join.html", code=code, room_missing=False)


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------
@app.route("/api/rooms", methods=["POST"])
def create_room():
    cleanup_stale_rooms()
    code = generate_room_code()
    rooms[code] = {"created_at": time.time(), "queue": [], "now_playing": None,
                    "next_item_id": 1}
    local_ip = get_local_ip()
    join_url = f"http://{local_ip}:5000/join/{code}"
    return jsonify({"code": code, "join_url": join_url})


@app.route("/api/rooms/<code>", methods=["GET"])
def get_room(code):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404
    return jsonify({"code": code, "queue": room["queue"], "now_playing": room["now_playing"]})


def scan_folder(folder_path: str):
    """Scan an arbitrary folder (e.g. USB drive) and add songs to the library
    using absolute paths. Skips files already indexed."""
    init_db()
    folder = Path(folder_path)
    if not folder.is_dir():
        return 0

    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT filepath FROM songs")
    existing = {row[0] for row in cur.fetchall()}

    count = 0
    for path in folder.rglob("*"):
        if path.is_file() and path.suffix.lower() in SUPPORTED_EXT:
            abspath = str(path.resolve())
            if abspath not in existing:
                title, artist = guess_title_artist(path.name)
                cur.execute(
                    "INSERT INTO songs (title, artist, filepath) VALUES (?, ?, ?)",
                    (title, artist, abspath),
                )
                count += 1
    conn.commit()
    conn.close()
    return count


def get_all_songs():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT id, title, artist, filepath FROM songs ORDER BY artist, title")
    rows = [dict(r) for r in cur.fetchall()]
    conn.close()
    return rows


@app.route("/api/library", methods=["GET"])
def api_browse_library():
    return jsonify({"songs": get_all_songs()})


@app.route("/api/library/scan", methods=["POST"])
def api_scan_library():
    count = scan_library()
    return jsonify({"indexed_files": count})


@app.route("/api/library/scan-path", methods=["POST"])
def api_scan_path():
    data = request.get_json(force=True)
    path = data.get("path", "").strip()
    if not path or not os.path.isdir(path):
        return jsonify({"error": "Folder not found"}), 400
    count = scan_folder(path)
    return jsonify({"indexed_files": count})


@app.route("/api/fs/drives")
def api_list_drives():
    if platform.system() == "Windows":
        import string as _s
        drives = []
        for letter in _s.ascii_uppercase:
            p = f"{letter}:\\"
            if os.path.isdir(p):
                drives.append(p)
        return jsonify({"drives": drives})
    return jsonify({"drives": ["/"]})


@app.route("/api/fs/list")
def api_list_dir():
    path = request.args.get("path", "").strip()
    if not path or not os.path.isdir(path):
        return jsonify({"error": "Path not found"}), 400
    try:
        entries = []
        for entry in sorted(os.listdir(path)):
            full = os.path.join(path, entry)
            if os.path.isdir(full):
                entries.append({"name": entry, "path": os.path.abspath(full)})
        return jsonify({"entries": entries, "current": os.path.abspath(path)})
    except PermissionError:
        return jsonify({"error": "Permission denied"}), 403


@app.route("/api/search")
def api_search():
    q = request.args.get("q", "").strip()
    if not q:
        return jsonify({"results": []})

    local_results = [
        {"id": r["id"], "title": r["title"], "artist": r["artist"],
         "source": "local", "source_ref": r["filepath"]}
        for r in search_library(q)
    ]

    results = local_results
    if len(local_results) < 3 and has_internet():
        results = results + search_youtube(q)

    return jsonify({"results": results})


def advance_queue(room, code):
    """Pop next from queue, set as now_playing, emit updates, return item or None."""
    if not room["queue"]:
        room["now_playing"] = None
        socketio.emit("now_playing_update", {"now_playing": None}, to=code)
        socketio.emit("queue_update", {"queue": []}, to=code)
        return None

    item = room["queue"].pop(0)
    room["now_playing"] = item

    if item["source"] == "local":
        item["media_url"] = f"/api/media?path={item['source_ref']}"
    elif item["source"] == "youtube":
        item["media_url"] = f"https://www.youtube.com/embed/{item['source_ref']}?autoplay=1&playsinline=1"

    play_media(item)
    socketio.emit("queue_update", {"queue": room["queue"]}, to=code)
    socketio.emit("now_playing_update", {"now_playing": item}, to=code)
    return item


@app.route("/api/media")
def api_serve_media():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "missing path"}), 400

    if os.path.isabs(path):
        filepath = path
    else:
        filepath = str(LIBRARY_DIR / path)

    if not os.path.isfile(filepath):
        return jsonify({"error": "file not found"}), 404

    mime, _ = mimetypes.guess_type(filepath)
    return send_file(filepath, mimetype=mime, conditional=True)


@app.route("/api/rooms/<code>/queue", methods=["POST"])
def add_to_queue(code):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404

    data = request.get_json(force=True)
    item = {
        "item_id": room["next_item_id"],
        "title": data.get("title", "Unknown"),
        "artist": data.get("artist", ""),
        "source": data.get("source", "local"),
        "source_ref": data.get("source_ref", ""),
        "requested_by": data.get("requested_by", "Guest"),
    }
    room["next_item_id"] += 1
    room["queue"].append(item)

    if room["now_playing"] is None:
        advance_queue(room, code)
    else:
        socketio.emit("queue_update", {"queue": room["queue"]}, to=code)

    return jsonify({"ok": True, "item": item})


@app.route("/api/rooms/<code>/queue/<int:item_id>", methods=["DELETE"])
def remove_from_queue(code, item_id):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404
    room["queue"] = [i for i in room["queue"] if i["item_id"] != item_id]
    socketio.emit("queue_update", {"queue": room["queue"]}, to=code)
    return jsonify({"ok": True})


@app.route("/api/rooms/<code>/play_next", methods=["POST"])
def play_next(code):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404
    item = advance_queue(room, code)
    return jsonify({"ok": True, "now_playing": item})


def play_media(item):
    """Best-effort playback on the host laptop via mpv. Silently no-ops if
    mpv isn't installed — the queue/UI still works for testing without audio."""
    try:
        if item["source"] == "local":
            ref = item["source_ref"]
            if os.path.isabs(ref):
                filepath = ref
            else:
                filepath = str(LIBRARY_DIR / ref)
            subprocess.Popen(["mpv", "--fullscreen", filepath])
        elif item["source"] == "youtube":
            url = f"https://www.youtube.com/watch?v={item['source_ref']}"
            subprocess.Popen(["mpv", "--fullscreen", url])
    except FileNotFoundError:
        print("mpv not found on this machine — install it to enable playback.")


def make_qr_base64(data: str) -> str:
    img = qrcode.make(data)
    buf = BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ---------------------------------------------------------------------------
# Socket.IO events
# ---------------------------------------------------------------------------
@socketio.on("join")
def on_join(data):
    code = data.get("code")
    if code in rooms:
        socket_join_room(code)
        emit("queue_update", {"queue": rooms[code]["queue"]})
        emit("now_playing_update", {"now_playing": rooms[code]["now_playing"]})


if __name__ == "__main__":
    import threading

    init_db()
    scan_library()
    ip = get_local_ip()
    print(f"\nKaraokeHub running.\n  On this laptop:  http://localhost:5000\n  On phones (same WiFi): http://{ip}:5000\n")

    def open_browser():
        import time as _t
        _t.sleep(1.5)
        webbrowser.open("http://localhost:5000")

    threading.Thread(target=open_browser, daemon=True).start()
    socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)
