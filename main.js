const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

let pythonProcess = null;
let mainWindow = null;

const PORT = 5000;

function startPython() {
  const pythonExe = process.platform === 'win32'
    ? path.join(__dirname, 'venv', 'Scripts', 'python.exe')
    : path.join(__dirname, 'venv', 'bin', 'python');

  pythonProcess = spawn(pythonExe, ['app.py'], {
    cwd: __dirname,
    stdio: 'pipe',
  });

  pythonProcess.stdout.on('data', (d) => process.stdout.write(`[py] ${d}`));
  pythonProcess.stderr.on('data', (d) => process.stderr.write(`[py] ${d}`));

  pythonProcess.on('close', (code) => {
    console.log(`Python exited (code ${code})`);
    pythonProcess = null;
  });
}

function waitForServer(retries = 30) {
  return new Promise((resolve, reject) => {
    function check(n) {
      if (n <= 0) return reject(new Error('Server did not start'));
      http.get(`http://localhost:${PORT}`, (res) => {
        resolve();
      }).on('error', () => {
        setTimeout(() => check(n - 1), 500);
      });
    }
    check(retries);
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: 'KaraokeHub',
    autoHideMenuBar: true,
    backgroundColor: '#120E1A',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  mainWindow.setMenuBarVisibility(false);
  mainWindow.maximize();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  startPython();
  try {
    await waitForServer();
  } catch {
    console.error('Failed to reach server');
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (pythonProcess) pythonProcess.kill();
  app.quit();
});

app.on('before-quit', () => {
  if (pythonProcess) pythonProcess.kill();
});
