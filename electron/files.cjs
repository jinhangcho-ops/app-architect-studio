// 데스크톱 앱의 파일 저장: 프로젝트 파일(*.aas.json)과 같은 폴더의 .saves/(직접 저장)·.autosave/(자동 저장)에 시점 파일을 둔다.
// 화면은 열기·저장 창에서 사용자가 고른 경로로만 읽고 쓸 수 있다 (화면 코드가 아무 경로나 쓰지 못하게).
const fs = require('node:fs');
const path = require('node:path');

const KINDS = { manual: '.saves', auto: '.autosave' };
const allowed = new Set();

/** 열기·저장 창에서 고른 파일만 허용 목록에 넣는다 */
const allow = (file) => { allowed.add(path.resolve(file)); return path.resolve(file); };
const check = (file) => {
  const p = path.resolve(String(file));
  if (!allowed.has(p)) throw new Error('열기·저장 창에서 고른 파일이 아닙니다');
  return p;
};
/** 시점 파일 이름: 화면이 만든 시각 문자열만 받는다 (경로 문자가 섞이지 않게) */
const safeName = (name) => {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}$/.test(String(name))) throw new Error('시점 이름 형식이 아닙니다');
  return `${name}.json`;
};

const dirOf = (projectFile, kind) => {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('알 수 없는 저장 종류');
  return path.join(path.dirname(check(projectFile)), KINDS[kind]);
};

function writeSnapshot(projectFile, kind, name, text, max) {
  const dir = dirOf(projectFile, kind);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safeName(name)), text, 'utf8');
  // 이름이 시각이라 이름 순서 = 시간 순서. 오래된 것부터 지워 max개만 남긴다
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - max))) fs.rmSync(path.join(dir, f));
  return true;
}

function listSnapshots(projectFile, kind) {
  const dir = dirOf(projectFile, kind);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse()
    .map((f) => ({ name: f.slice(0, -5), text: fs.readFileSync(path.join(dir, f), 'utf8') }));
}

/** Electron에 연결: dialog를 쓰는 열기·저장과, 위 시점 함수들 */
function registerFileApi() {
  const { BrowserWindow, dialog, ipcMain } = require('electron');
  const filters = [{ name: 'App Architect Studio 프로젝트', extensions: ['json'] }];
  const win = () => BrowserWindow.getFocusedWindow() ?? undefined;
  ipcMain.handle('file:open', async () => {
    const r = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = allow(r.filePaths[0]);
    return { path: file, text: fs.readFileSync(file, 'utf8') };
  });
  ipcMain.handle('file:save', async (_e, file, text, suggested) => {
    let target = file ? check(file) : undefined;
    if (!target) {
      const r = await dialog.showSaveDialog(win(), { defaultPath: suggested, filters });
      if (r.canceled || !r.filePath) return null;
      target = allow(r.filePath);
    }
    fs.writeFileSync(target, text, 'utf8');
    return target;
  });
  ipcMain.handle('snap:write', (_e, file, kind, name, text, max) => writeSnapshot(file, kind, name, text, max));
  ipcMain.handle('snap:list', (_e, file, kind) => listSnapshots(file, kind));
}

module.exports = { registerFileApi, writeSnapshot, listSnapshots, allow };
