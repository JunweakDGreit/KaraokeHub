# KaraokeHub — Web App (Laptop + Phone)

Run this on the laptop that will act as the "host" (the screen everyone sings along to).
Guests join from their own phone or laptop over the same WiFi — no app install needed,
just a browser.

## 1. Install

Requires Python 3.9+.

```bash
cd karaokehub
python3 -m venv venv
source venv/bin/activate        # on Windows: venv\Scripts\activate
pip install -r requirements.txt
```

For actual audio/video playback, install **mpv** on the host laptop:
- macOS: `brew install mpv`
- Windows: https://mpv.io/installation/
- Linux: `sudo apt install mpv`

(Without mpv, everything still works — search, rooms, live queue — you just won't hear
anything play. Good enough for testing the flow.)

## 2. Add your songs

Drop your karaoke files (`.mp3`, `.mp4`, `.cdg`, `.m4a`, `.wav`, `.webm`) into the
`library/` folder. Subfolders are fine. Name them `Artist - Title.mp3` for best search
results — if there's no " - " in the filename, the whole filename is used as the title.

## 3. Run

```bash
python3 app.py
```

You'll see something like:
```
KaraokeHub running.
  On this laptop:  http://localhost:5000
  On phones (same WiFi): http://192.168.1.42:5000
```

- Open the **laptop URL** in a browser on the host laptop → click **Create a room** →
  this is your TV/host screen with the QR code.
- On your **phone**, connect to the same WiFi as the laptop, then either scan the QR
  code or open the "phones" URL shown above and tap **Join a room**, entering the code.

## How search works right now

1. Searches your local `library/` folder first (instant, no internet needed).
2. If there are fewer than 3 local matches **and** the host laptop has internet, it
   falls back to YouTube search (appends "karaoke" to your query) via `yt-dlp`.

Install `yt-dlp` on the host laptop to enable the YouTube fallback:
```bash
pip install yt-dlp
```
If it's not installed, YouTube fallback is silently skipped — local search still works.

## What's implemented vs. what's next

**Working now:**
- Room creation with 4-digit code + QR code
- Guest join page (search, add to queue) — works on phone or laptop browser
- Host screen — live "Now Playing" + set list, updates in real time via WebSockets
- Local library search + YouTube fallback (if `yt-dlp` + internet available)
- Basic playback trigger via `mpv` when host clicks "Play next"

**Not yet built (see ARCHITECTURE.md / agent prompts for later phases):**
- Running this on a Raspberry Pi instead of a laptop
- Pi as its own WiFi access point (works with any router right now)
- Skip-voting, singer rotation, song history (Phase 6 polish)

## Troubleshooting

- **Phone can't reach the laptop URL:** make sure both devices are on the *same* WiFi
  network, and your laptop's firewall isn't blocking port 5000.
- **No local IP detected / shows 127.0.0.1:** some VPNs or firewalls interfere with the
  IP auto-detection. Find your laptop's local IP manually (`ipconfig` on Windows,
  `ifconfig` or `ip a` on Mac/Linux) and use `http://<that-ip>:5000` on your phone.
- **Nothing plays when I click "Play next":** confirm `mpv` is installed and on your PATH.
