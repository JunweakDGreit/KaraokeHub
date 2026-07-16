@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo(
echo ====================================
echo         KaraokeHub Launcher
echo ====================================
echo(

REM -- Step 1: Self-healing virtual environment --
set "NEED_SETUP=0"
if exist "venv\Scripts\python.exe" (
    venv\Scripts\python -c "import flask" >nul 2>&1
    if errorlevel 1 (
        echo Virtual environment is broken - rebuilding...
        set "NEED_SETUP=1"
        rmdir /s /q venv
    )
) else (
    set "NEED_SETUP=1"
)

if "!NEED_SETUP!"=="1" (
    echo Creating Python virtual environment...
    py -3.13 -m venv venv >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Python 3.13 is not installed.
        echo(
        echo Download it from: https://www.python.org/downloads/
        echo Then re-run run.bat.
        pause
        exit /b 1
    )
    echo Installing dependencies...
    venv\Scripts\python -m pip install -r requirements.txt --quiet
    if errorlevel 1 (
        echo [ERROR] Failed to install Python dependencies.
        pause
        exit /b 1
    )
    echo Virtual environment ready.
)

REM -- Step 2: Check ffmpeg --
set "FFMPEG_OK=0"
if exist "%~dp0bin\ffmpeg.exe" set "FFMPEG_OK=1"
if "!FFMPEG_OK!"=="0" (
    where ffmpeg >nul 2>&1
    if not errorlevel 1 set "FFMPEG_OK=1"
)
if "!FFMPEG_OK!"=="1" (
    echo ffmpeg: found
) else (
    echo(
    echo [WARN] ffmpeg not found. Vocal reduction will not work.
    echo Run: download_ffmpeg.bat to get it.
    echo(
)

REM -- Step 3: Kill old instance --
powershell -NoProfile -Command "$p=(netstat -ano|Select-String ':5000.*LISTENING').Line -split '\s+'|Where-Object{$_ -match '^\d+$'}|Select-Object -Last 1;if($p){Write-Host \"Stopping old instance (PID $p)...\";taskkill /F /PID $p >$null 2>&1}"

REM -- Step 4: Detect / select browser --
set "BRAVE_EXE="
if exist "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE_EXE=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
if exist "C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE_EXE=C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe"
if exist "%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe" set "BRAVE_EXE=%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe"

if not "!BRAVE_EXE!"=="" (
    echo Brave detected.
    set "BROWSER_MODE=brave"
    goto start_server
)

echo Brave browser is NOT installed.
echo(
echo    [1] Install Brave (opens download page)
echo    [2] Use default browser
echo(
choice /c 12 /n /m "Choose (1 or 2): "
if errorlevel 2 (
    echo Using default browser.
    set "BROWSER_MODE=default"
    goto start_server
)
start "" https://brave.com/download
echo After installing Brave, re-run run.bat.
pause
exit /b 0

:start_server
echo(
echo Starting server in background...
powershell -NoProfile -Command "Start-Process -FilePath 'venv\Scripts\python.exe' -ArgumentList 'app.py','--browser=!BROWSER_MODE!' -WindowStyle Hidden"

echo Waiting for server to be ready...
set "WAIT_COUNT=0"
:wait_loop
timeout /t 2 /nobreak >nul
powershell -NoProfile -Command "try {$r=Invoke-WebRequest 'http://localhost:5000' -TimeoutSec 3 -UseBasicParsing;exit 0}catch{exit 1}" >nul 2>&1
if not errorlevel 1 goto server_ready
set /a WAIT_COUNT+=2
if !WAIT_COUNT! geq 20 (
    echo Server failed to start within 20s.
    echo Check that Python and dependencies are installed correctly.
    pause
    exit /b 1
)
goto wait_loop

:server_ready
echo Server is ready.
if "!BROWSER_MODE!"=="brave" (
    start "" "!BRAVE_EXE!" --app=http://localhost:5000 --new-window
) else (
    start "" http://localhost:5000
)
exit
