const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const https = require('https');
const http = require('http');
const fs = require('fs');

let mainWindow;
const AUTH_FILE = path.join(app.getPath('userData'), 'stockkar_auth.json');

// ── Read/write auth file ──────────────────────────────────────────────────
function readAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function writeAuth(data) {
  try { fs.writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2)); return true; } catch { return false; }
}

// ── Make HTTPS request with cookies ─────────────────────────────────────
function httpsRequest(opts, body) {
  return new Promise((resolve) => {
    const lib = (opts.protocol||'https:') === 'https:' ? https : http;
    const req = lib.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, headers: res.headers, data }); }
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    if (body) req.write(body);
    req.end();
  });
}

// ── Refresh Stockkar token using stored cookies ──────────────────────────
async function refreshStockarToken(cookieString) {
  const r = await httpsRequest({
    hostname: 'apii.stockkar.in',
    port: 443,
    path: '/auth/refresh-token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieString,
      'Origin': 'https://www.stockkar.in',
      'Referer': 'https://www.stockkar.in/',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    }
  }, '{}');

  const token = r.headers?.authorization || r.headers?.['Authorization'] || null;
  console.log('[AUTH] refresh-token status:', r.status, 'token received:', !!token);
  return token;
}

// ── Auto token refresh every 6 hours ────────────────────────────────────
function scheduleAutoRefresh() {
  setInterval(async () => {
    const auth = readAuth();
    if (!auth?.cookies) return;
    console.log('[AUTH] Auto-refreshing Stockkar token...');
    const newToken = await refreshStockarToken(auth.cookies);
    if (newToken) {
      auth.token = newToken;
      auth.refreshedAt = new Date().toISOString();
      writeAuth(auth);
      console.log('[AUTH] Token auto-refreshed successfully');
    }
  }, 6 * 60 * 60 * 1000); // every 6 hours
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200, height: 800,
    minWidth: 900, minHeight: 650,
    backgroundColor: '#0a0a0a',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    scheduleAutoRefresh();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Window controls ──────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => mainWindow.minimize());
ipcMain.on('win-maximize', () => { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); });
ipcMain.on('win-close', () => mainWindow.close());

// ── Get current auth status ──────────────────────────────────────────────
ipcMain.handle('stockkar-auth-status', async () => {
  const auth = readAuth();
  if (!auth) return { loggedIn: false };
  return {
    loggedIn: !!auth.token,
    user: auth.user || null,
    refreshedAt: auth.refreshedAt || null,
    tokenPreview: auth.token ? auth.token.slice(-10) : null
  };
});

// ── Get current token ────────────────────────────────────────────────────
ipcMain.handle('stockkar-get-token', async () => {
  const auth = readAuth();
  return auth?.token || null;
});

// ── Open Stockkar login window ───────────────────────────────────────────
ipcMain.handle('stockkar-login', async () => {
  return new Promise((resolve) => {
    const loginWin = new BrowserWindow({
      width: 480,
      height: 680,
      title: 'Login to Stockkar',
      webPreferences: { nodeIntegration: false, contextIsolation: true },
      parent: mainWindow,
      modal: false,
    });

    loginWin.loadURL('https://www.stockkar.in/auth/login');

    let checkInterval = null;
    let resolved = false;

    const finish = async (success) => {
      if (resolved) return;
      resolved = true;
      if (checkInterval) clearInterval(checkInterval);

      if (success) {
        try {
          // Get all cookies from this window's session
          const cookies = await loginWin.webContents.session.cookies.get({ domain: 'stockkar.in' });
          const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          console.log('[AUTH] Got', cookies.length, 'cookies from login session');

          // Call refresh-token to get access token
          const token = await refreshStockarToken(cookieString);

          // Get user info
          let user = null;
          const userR = await httpsRequest({
            hostname: 'apii.stockkar.in', port: 443, path: '/api/user/me', method: 'GET',
            headers: {
              'Cookie': cookieString,
              'Origin': 'https://www.stockkar.in',
              'Authorization': token || '',
              'User-Agent': 'Mozilla/5.0'
            }
          });
          if (userR.status === 200) user = userR.data;

          const authData = {
            token,
            cookies: cookieString,
            user: { name: user?.name || user?.data?.name, email: user?.email || user?.data?.email },
            loggedAt: new Date().toISOString(),
            refreshedAt: new Date().toISOString(),
          };
          writeAuth(authData);
          console.log('[AUTH] Login successful, user:', authData.user?.name);
          loginWin.close();
          resolve({ ok: true, user: authData.user });
        } catch(e) {
          loginWin.close();
          resolve({ ok: false, error: e.message });
        }
      } else {
        loginWin.close();
        resolve({ ok: false, error: 'Login window closed' });
      }
    };

    // Detect successful login by monitoring navigation
    loginWin.webContents.on('did-navigate', (event, url) => {
      console.log('[AUTH] Navigated to:', url);
      if (!url.includes('/auth/login') && !url.includes('/auth/verify') && url.includes('stockkar.in')) {
        // User logged in successfully
        setTimeout(() => finish(true), 1500); // Wait for cookies to be set
      }
    });

    loginWin.on('closed', () => finish(false));

    // Timeout after 5 minutes
    setTimeout(() => finish(false), 5 * 60 * 1000);
  });
});

// ── Manual token refresh ─────────────────────────────────────────────────
ipcMain.handle('stockkar-refresh', async () => {
  const auth = readAuth();
  if (!auth?.cookies) return { ok: false, error: 'Not logged in' };

  const token = await refreshStockarToken(auth.cookies);
  if (token) {
    auth.token = token;
    auth.refreshedAt = new Date().toISOString();
    writeAuth(auth);
    return { ok: true, refreshedAt: auth.refreshedAt };
  }
  return { ok: false, error: 'Refresh failed' };
});

// ── Generic HTTP proxy ───────────────────────────────────────────────────
ipcMain.handle('http-request', async (event, { url, method, headers, body }) => {
  return new Promise((resolve) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === 'https:' ? https : http;
    const bodyData = body ? JSON.stringify(body) : null;
    const reqHeaders = {
      'Content-Type': 'application/json',
      ...(headers || {}),
      ...(bodyData ? { 'Content-Length': Buffer.byteLength(bodyData) } : {}),
    };
    const req = lib.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: method || 'GET',
      headers: reqHeaders,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ ok: true, status: res.statusCode, data: JSON.parse(data) }); }
        catch { resolve({ ok: true, status: res.statusCode, data }); }
      });
    });
    req.on('error', e => resolve({ ok: false, error: e.message }));
    if (bodyData) req.write(bodyData);
    req.end();
  });
});
