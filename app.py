"""
KaraokeHub — local web app
Host runs this on a laptop. Guests join from phone/laptop on the same WiFi.
"""
import os
import re
import json
import time
import socket
import sqlite3
import random
import hashlib
import string
import sys
import subprocess
import platform
from urllib.parse import quote
import mimetypes
from pathlib import Path

import qrcode
import qrcode.image.svg
from io import BytesIO
import base64

from flask import Flask, request, jsonify, render_template, send_from_directory, send_file, redirect, Response
from flask_socketio import SocketIO, join_room as socket_join_room, emit

BASE_DIR = Path(__file__).parent
LIBRARY_DIR = BASE_DIR / "library"
DB_PATH = BASE_DIR / "library.db"
CACHE_DIR = BASE_DIR / "cache"
ROOMS_CACHE_PATH = CACHE_DIR / "rooms.json"
SUPPORTED_EXT = {".mp3", ".mp4", ".cdg", ".m4a", ".wav", ".webm"}

app = Flask(__name__)
app.config["SECRET_KEY"] = "karaokehub-dev-secret"
socketio = SocketIO(app, cors_allowed_origins="*")

# ---------------------------------------------------------------------------
# In-memory room/queue state (persisted to disk for crash recovery)
# ---------------------------------------------------------------------------
rooms = {}  # code -> {created_at, queue: [...], now_playing: {...} | None, next_item_id, paused}
ROOM_TIMEOUT_SECONDS = 7 * 24 * 60 * 60


def save_rooms():
    """Persist all room state to disk so playlists survive restarts."""
    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        with open(ROOMS_CACHE_PATH, "w") as f:
            json.dump(rooms, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
    except Exception as e:
        print(f"[save_rooms] {e}")


def load_rooms():
    """Restore room state from disk on startup."""
    if not ROOMS_CACHE_PATH.is_file():
        return
    try:
        with open(ROOMS_CACHE_PATH, "r") as f:
            data = json.load(f)
        now = time.time()
        loaded = 0
        for code, room in data.items():
            expired = now - room.get("created_at", 0) > ROOM_TIMEOUT_SECONDS
            room.setdefault("paused", False)
            room["expired"] = expired
            rooms[code] = room
            loaded += 1
        if loaded:
            print(f"[load_rooms] restored {loaded} room(s)")
    except Exception as e:
        print(f"[load_rooms] {e}")


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


def check_hardware_lock():
    """Two-factor lock: drive serial + license key in user home folder."""
    app_dir = os.path.dirname(os.path.abspath(__file__))
    lock_file = os.path.join(app_dir, ".hardware_lock")
    key_file = os.path.join(os.path.expanduser("~"), ".karaokehub_key")

    if not os.path.exists(key_file):
        print("\n  *** NO LICENSE KEY ***")
        print(f"  Expected at: {key_file}")
        print("  Run 'python app.py --init' on the original machine to create one.")
        print("  Then copy that file to the same path on other machines to authorize them.")
        return False

    with open(key_file) as f:
        key = f.read().strip()

    serial = os.stat(app_dir).st_dev
    expected = hashlib.sha256(f"{serial}{key}".encode()).hexdigest()

    if not os.path.exists(lock_file):
        with open(lock_file, "w") as f:
            f.write(expected)
        print(f"  [lock] This drive authorized with existing license")
        return True

    with open(lock_file) as f:
        stored = f.read().strip()

    if expected == stored:
        return True

    print(f"\n  *** UNAUTHORIZED DRIVE ***")
    print(f"  Drive serial:   {serial}")
    print(f"  Lock expected:  {stored[:16]}...")
    print(f"  Current hash:   {expected[:16]}...")
    return False


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
    try:
        conn.execute("ALTER TABLE songs ADD COLUMN play_count INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass
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


def search_youtube(query: str, limit: int = 5, suffix: str = ""):
    """Search YouTube via yt-dlp Python module. Returns [] if unavailable."""
    try:
        from yt_dlp import YoutubeDL

        q = f"ytsearch{limit}:{query}"
        if suffix:
            q += f" {suffix}"

        ydl_opts = {
            "quiet": True,
            "no_warnings": True,
            "extract_flat": True,
            "skip_download": True,
        }
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(q, download=False)
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
    room_list = sorted(rooms.items(), key=lambda x: x[1].get("created_at", 0), reverse=True)
    return render_template("index.html", room_list=room_list)


@app.route("/favicon.ico")
def favicon():
    return send_from_directory(BASE_DIR / "static", "favicon.ico")


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
                    "next_item_id": 1, "paused": False}
    save_rooms()
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
    mode = request.args.get("mode", "mtv")
    if not q:
        return jsonify({"results": []})

    local_results = [
        {"id": r["id"], "title": r["title"], "artist": r["artist"],
         "source": "local", "source_ref": r["filepath"]}
        for r in search_library(q)
    ]

    results = local_results
    if len(local_results) < 3 and has_internet():
        suffix = ""
        if mode == "karaoke":
            suffix = "karaoke"
        elif mode == "lyrics":
            suffix = "lyrics"
        results = results + search_youtube(q, suffix=suffix)

    return jsonify({"results": results})


@app.route("/api/top")
def api_top():
    limit = request.args.get("limit", 10, type=int)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, title, artist, filepath, play_count FROM songs WHERE play_count > 0 ORDER BY play_count DESC LIMIT ?",
        (limit,)
    ).fetchall()
    conn.close()
    results = [
        {"id": r["id"], "title": r["title"], "artist": r["artist"],
         "source": "local", "source_ref": r["filepath"], "play_count": r["play_count"]}
        for r in rows
    ]
    return jsonify({"results": results})


def advance_queue(room, code):
    """Pop next from queue, set as now_playing, emit updates, return item or None."""
    if not room["queue"]:
        room["now_playing"] = None
        socketio.emit("now_playing_update", {"now_playing": None}, to=code)
        socketio.emit("queue_update", {"queue": []}, to=code)
        save_rooms()
        return None

    item = room["queue"].pop(0)
    room["now_playing"] = item
    room["paused"] = False

    if item["source"] == "local":
        item["media_url"] = f"/api/media?path={quote(item['source_ref'], safe='')}"
        try:
            c = sqlite3.connect(DB_PATH)
            c.execute("UPDATE songs SET play_count = play_count + 1 WHERE filepath = ?", (item["source_ref"],))
            c.commit()
            c.close()
        except Exception:
            pass
    elif item["source"] == "youtube":
        item["media_url"] = f"/api/yt/{item['source_ref']}"

    play_media(item)
    socketio.emit("queue_update", {"queue": room["queue"]}, to=code)
    socketio.emit("now_playing_update", {"now_playing": item}, to=code)
    socketio.emit("playback_update", {"paused": False}, to=code)
    save_rooms()
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


@app.route("/api/yt/<vid>")
def api_yt_stream(vid):
    try:
        from yt_dlp import YoutubeDL
        ydl_opts = {"quiet": True, "no_warnings": True, "format": "best[ext=mp4][height<=720]/best[ext=mp4]/best"}
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            url = info.get("url")
            if not url:
                for fmt in info.get("formats", []):
                    if fmt.get("acodec") != "none" and fmt.get("vcodec") != "none":
                        url = fmt.get("url")
                        if url: break
            if url:
                return redirect(url)
    except Exception:
        pass
    return jsonify({"error": "stream unavailable"}), 500


@app.route("/api/stream/yt/<vid>")
def api_stream_yt(vid):
    try:
        from yt_dlp import YoutubeDL
        ydl_opts = {"quiet": True, "no_warnings": True, "format": "best[height<=720]/best"}
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            url = info.get("url")
            if not url:
                for fmt in info.get("formats", []):
                    if fmt.get("acodec") != "none" and fmt.get("vcodec") != "none":
                        url = fmt.get("url")
                        if url:
                            break
            if not url:
                return jsonify({"error": "no stream URL"}), 500

            cmd = [
                FFMPEG, "-i", url,
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-movflags", "frag_keyframe+empty_moov",
                "-f", "mp4",
                "pipe:1"
            ]
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

            def generate():
                try:
                    while True:
                        chunk = proc.stdout.read(8192)
                        if not chunk:
                            break
                        yield chunk
                except GeneratorExit:
                    pass
                finally:
                    try:
                        proc.kill()
                        proc.wait()
                    except Exception:
                        pass

            resp = Response(generate(), mimetype="video/mp4")
            resp.headers["Content-Disposition"] = "inline"
            return resp
    except Exception:
        return jsonify({"error": "stream unavailable"}), 500


@app.route("/api/media/vocal")
def api_vocal_media():
    path = request.args.get("path", "")
    if not path:
        return jsonify({"error": "missing path"}), 400

    if os.path.isabs(path):
        filepath = path
    else:
        filepath = str(LIBRARY_DIR / path)

    if not os.path.isfile(filepath):
        return jsonify({"error": "file not found"}), 404

    ext = Path(filepath).suffix.lower()
    is_video = ext in {'.mp4', '.webm', '.mkv', '.avi', '.mov'}

    return _stream_vocal_reduction(filepath, is_video=is_video)


@app.route("/api/media/vocal/yt/<vid>")
def api_vocal_yt(vid):
    try:
        from yt_dlp import YoutubeDL
        ydl_opts = {"quiet": True, "no_warnings": True, "format": "best[height<=720]/best"}
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
            url = info.get("url")
            if not url:
                for fmt in info.get("formats", []):
                    if fmt.get("acodec") != "none" and fmt.get("vcodec") != "none":
                        url = fmt.get("url")
                        if url:
                            break
            if not url:
                return jsonify({"error": "no stream URL"}), 500

            return _stream_vocal_reduction(url, is_video=True)
    except Exception as e:
        return jsonify({"error": f"stream unavailable: {str(e)}"}), 500


FFMPEG_BIN = os.path.join(os.path.dirname(__file__), "bin", "ffmpeg.exe")
FFMPEG = FFMPEG_BIN if os.path.isfile(FFMPEG_BIN) else "ffmpeg"


VOCAL_KILL = (
    "pan=stereo|c0=c0-c1|c1=c1-c0,"
    "equalizer=f=150:width_type=q:width=1:g=3,"
    "equalizer=f=600:width_type=q:width=1:g=-4,"
    "equalizer=f=1500:width_type=q:width=1.5:g=-8,"
    "equalizer=f=4000:width_type=q:width=1:g=-5"
)


def _stream_vocal_reduction(input_src, is_video=True):
    if is_video:
        cmd = [
            FFMPEG, "-i", input_src,
            "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
            "-af", VOCAL_KILL,
            "-f", "mp4", "-movflags", "frag_keyframe+empty_moov",
            "pipe:1"
        ]
        mimetype = "video/mp4"
    else:
        cmd = [
            FFMPEG, "-i", input_src,
            "-af", VOCAL_KILL,
            "-f", "mp3",
            "pipe:1"
        ]
        mimetype = "audio/mpeg"

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)

    def generate():
        try:
            while True:
                chunk = proc.stdout.read(8192)
                if not chunk:
                    break
                yield chunk
        except GeneratorExit:
            pass
        finally:
            try:
                proc.kill()
                proc.wait()
            except Exception:
                pass

    resp = Response(generate(), mimetype=mimetype)
    resp.headers["Content-Disposition"] = "inline"
    return resp


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

    save_rooms()
    return jsonify({"ok": True, "item": item})


@app.route("/api/rooms/<code>/queue/<int:item_id>", methods=["DELETE"])
def remove_from_queue(code, item_id):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404
    room["queue"] = [i for i in room["queue"] if i["item_id"] != item_id]
    socketio.emit("queue_update", {"queue": room["queue"]}, to=code)
    save_rooms()
    return jsonify({"ok": True})


@app.route("/api/rooms/<code>/queue/reorder", methods=["POST"])
def reorder_queue(code):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404
    data = request.get_json(force=True)
    from_index = data.get("from_index")
    to_index = data.get("to_index")
    if from_index is None or to_index is None:
        return jsonify({"error": "missing from_index/to_index"}), 400
    q = room["queue"]
    if not 0 <= from_index < len(q) or not 0 <= to_index < len(q):
        return jsonify({"error": "invalid index"}), 400
    item = q.pop(from_index)
    q.insert(to_index, item)
    socketio.emit("queue_update", {"queue": q}, to=code)
    save_rooms()
    return jsonify({"ok": True})


@app.route("/api/rooms/<code>/play_next", methods=["POST"])
def play_next(code):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404
    item = advance_queue(room, code)
    return jsonify({"ok": True, "now_playing": item})


@app.route("/api/rooms/<code>/playpause", methods=["POST"])
def playpause(code):
    room = rooms.get(code)
    if not room:
        return jsonify({"error": "room not found"}), 404
    data = request.get_json(silent=True) or {}
    paused = data.get("paused", False)
    room["paused"] = paused
    socketio.emit("playback_update", {"paused": paused}, to=code)
    save_rooms()
    return jsonify({"ok": True})


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
    import argparse

    if "--init" in sys.argv:
        key_file = os.path.join(os.path.expanduser("~"), ".karaokehub_key")
        if os.path.exists(key_file):
            print(f"License key already exists:\n  {key_file}\nDelete it first to re-init.")
            sys.exit(1)
        key = os.urandom(32).hex()
        with open(key_file, "w") as f:
            f.write(key)
        print(f"License key created at:\n  {key_file}")
        print("Keep this file secret. Copy it to ~/.karaokehub_key on other machines to run the app.")
        sys.exit(0)

    if not check_hardware_lock():
        sys.exit(1)

    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", choices=["brave", "default"], default=None,
                        help="Browser mode passed by launcher (handled externally)")
    parser.add_argument("--init", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()

    init_db()
    load_rooms()
    scan_library()
    ip = get_local_ip()
    print(f"\nKaraokeHub running.\n  On this laptop:  http://localhost:5000\n  On phones (same WiFi): http://{ip}:5000\n")

    browser_mode = args.browser or "none"
    print(f"Browser mode: {browser_mode}")

    socketio.run(app, host="0.0.0.0", port=5000, debug=False, allow_unsafe_werkzeug=True)
