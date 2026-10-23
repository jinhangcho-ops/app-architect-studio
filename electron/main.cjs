// 설치형 데스크톱 앱(Electron): 빌드한 화면(dist/)을 app:// 주소로 띄운다.
// file:// 대신 자체 주소를 쓰는 이유: sql.js가 WebAssembly 파일을 fetch로 받는데, file://에서는 fetch가 막힌다.
const { app, BrowserWindow, Menu, net, protocol, shell } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.join(__dirname, '..', 'dist');
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

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
    return net.fetch(pathToFileURL(file).toString());
  });
  // 기본 메뉴의 단축키(Ctrl+Z 등)가 앱의 단축키를 가로채지 않게 메뉴를 없앤다
  Menu.setApplicationMenu(null);
  createWindow();
});

app.on('window-all-closed', () => app.quit());
