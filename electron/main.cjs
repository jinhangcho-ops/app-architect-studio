// 설치형 데스크톱 앱(Electron): 빌드한 화면(dist/)을 app:// 주소로 띄운다.
// file:// 대신 자체 주소를 쓰는 이유: sql.js가 WebAssembly 파일을 fetch로 받는데, file://에서는 fetch가 막힌다.
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { registerFileApi } = require('./files.cjs');

const ROOT = path.join(__dirname, '..', 'dist');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

// 화면이 불러올 수 있는 것을 앱 안 파일로 묶는다 (HTML 가져오기·와이어프레임 그리기에 남의 코드가 섞여도 바깥으로 못 나가게).
// 'wasm-unsafe-eval': SQLite 실험(sql.js WebAssembly). 'unsafe-inline' 스타일: React의 style 속성과 가져온 HTML의 <style>
const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "font-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'App Architect Studio',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  // 바깥 링크는 앱 창이 아니라 기본 브라우저로 연다
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
  });
  win.loadURL('app://studio/index.html');
}

// 같은 앱을 두 번 실행하면 새 창을 띄우지 않고 열려 있는 창을 앞으로 가져온다 (임시 저장이 서로 덮어쓰지 않게)
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  protocol.handle('app', (req) => {
    const file = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url).pathname)));
    // dist 폴더 밖 파일은 내주지 않는다
    if (!file.startsWith(ROOT + path.sep)) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString()).then((res) => {
      const headers = new Headers(res.headers);
      headers.set('Content-Security-Policy', CSP);
      return new Response(res.body, { status: res.status, headers });
    });
  });
  registerFileApi();
  // 기본 메뉴의 단축키(Ctrl+Z 등)가 앱의 단축키를 가로채지 않게 메뉴를 없앤다
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
