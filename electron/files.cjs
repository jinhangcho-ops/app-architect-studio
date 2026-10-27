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

/** 원자적 쓰기: 같은 폴더의 임시 파일에 쓰고 디스크에 확정(fsync)한 뒤 이름을 바꿔 원본과 바꾼다.
 *  쓰는 도중 앱이 죽거나 전원이 나가도 원본은 예전 내용 그대로 남는다 (rename은 같은 볼륨 안에서 한 번에 바뀐다) */
function writeAtomic(target, data) {
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w');
    try { fs.writeSync(fd, typeof data === 'string' ? Buffer.from(data, 'utf8') : data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

// 프로젝트 파일마다 따로: .saves/<파일 이름>/ (같은 폴더의 다른 프로젝트가 기록을 지우거나 섞지 않게)
const dirOf = (projectFile, kind) => {
  if (!Object.hasOwn(KINDS, kind)) throw new Error('알 수 없는 저장 종류');
  const file = check(projectFile);
  return path.join(path.dirname(file), KINDS[kind], path.basename(file));
};

function writeSnapshot(projectFile, kind, name, text, max) {
  const dir = dirOf(projectFile, kind);
  fs.mkdirSync(dir, { recursive: true });
  writeAtomic(path.join(dir, safeName(name)), text);
  // 이름이 시각이라 이름 순서 = 시간 순서. 오래된 것부터 지워 max개만 남긴다
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - max))) fs.rmSync(path.join(dir, f));
  return true;
}

function listSnapshots(projectFile, kind) {
  let dir = dirOf(projectFile, kind);
  const has = (d) => fs.existsSync(d) && fs.readdirSync(d).some((f) => f.endsWith('.json'));
  // v1.2.0까지는 .saves/에 바로 두었다. 새 폴더에 아직 아무것도 없으면 그 기록을 보여 준다
  if (!has(dir)) dir = path.dirname(dir);
  if (!has(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && fs.statSync(path.join(dir, f)).isFile()).sort().reverse()
    .map((f) => ({ name: f.slice(0, -5), text: readText(path.join(dir, f)) }));
}

/** PNG 파일 이름: 경로·예약 문자를 빼고, 비면 '화면' */
const pngName = (name) => `${String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').slice(0, 120) || '화면'}.png`;

/** 겹치지 않는 PNG 이름들. Windows는 대소문자를 가리지 않아 소문자로 견주고,
 *  번호는 자른 이름 뒤에 붙인다 (긴 이름 뒤에 붙이면 120자에서 잘려 같은 이름이 되풀이되어 끝나지 않음) */
function pngNames(files) {
  const used = new Set();
  return files.map(({ name }) => {
    let file = pngName(name);
    for (let k = 2; used.has(file.toLowerCase()); k++) file = pngName(`${String(name).slice(0, 110)} ${k}`);
    used.add(file.toLowerCase());
    return file;
  });
}

/** 와이어프레임 PNG 쓰기: 고른 폴더에 이름이 겹치지 않게 (base64 PNG만 받는다). 하나라도 PNG가 아니면 아무것도 쓰지 않는다 */
function writePngs(dir, files) {
  const bufs = files.map(({ base64 }) => {
    const buf = Buffer.from(String(base64), 'base64');
    if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG가 아닙니다');
    return buf;
  });
  return pngNames(files).map((file, k) => {
    writeAtomic(path.join(dir, file), bufs[k]);
    return path.join(dir, file);
  });
}

/** 메모장(UTF-8 BOM)·PowerShell 5.1로 고친 파일도 열리게 맨 앞 BOM을 뺀다 (브라우저 File.text()와 같게) */
const readText = (file) => fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');

/** 명세 파일 쓰기: 이름은 영문·숫자·_.- 와 .json·.proto·.py·.csv·.sql만 (경로 문자가 섞이지 않게) */
function writeTexts(dir, files) {
  return files.map(({ name, text }) => {
    if (!/^[A-Za-z0-9_.-]+\.(json|proto|py|csv|sql)$/.test(String(name))) throw new Error(`명세 파일 이름 형식이 아닙니다: ${name}`);
    const file = path.join(dir, String(name));
    writeAtomic(file, String(text));
    return file;
  });
}

/** 고른 폴더에 이미 있는 명세 파일 이름 (덮어쓰기 전에 한 번 묻는다) */
const existingTexts = (dir, files) => files.map((f) => String(f.name)).filter((name) => fs.existsSync(path.join(dir, name)));

/** Electron에 연결: dialog를 쓰는 열기·저장과, 위 시점 함수들 */
function registerFileApi() {
  const { BrowserWindow, dialog, ipcMain } = require('electron');
  const filters = [{ name: 'App Architect Studio 프로젝트', extensions: ['json'] }];
  const win = () => BrowserWindow.getFocusedWindow() ?? undefined;
  /** 이미 있는 파일을 덮어쓸지 한 번 묻는다 (없으면 바로 true) */
  const confirmOverwrite = async (dup) => {
    if (!dup.length) return true;
    const list = dup.slice(0, 10).join('\n') + (dup.length > 10 ? `\n… 외 ${dup.length - 10}개` : '');
    const ok = await dialog.showMessageBox(win(), {
      type: 'question', buttons: ['덮어쓰기', '취소'], defaultId: 1, cancelId: 1,
      message: `이미 있는 파일 ${dup.length}개를 덮어쓸까요?`, detail: list,
    });
    return ok.response === 0;
  };
  ipcMain.handle('file:open', async () => {
    const r = await dialog.showOpenDialog(win(), { properties: ['openFile'], filters });
    if (r.canceled || !r.filePaths[0]) return null;
    const file = allow(r.filePaths[0]);
    return { path: file, text: readText(file) };
  });
  ipcMain.handle('file:save', async (_e, file, text, suggested) => {
    let target = file ? check(file) : undefined;
    if (!target) {
      const r = await dialog.showSaveDialog(win(), { defaultPath: suggested, filters });
      if (r.canceled || !r.filePath) return null;
      target = allow(r.filePath);
    }
    writeAtomic(target, text);
    return target;
  });
  // 한 장이면 저장 창, 여러 장이면 폴더를 한 번 골라 모두 쓴다
  ipcMain.handle('png:save', async (_e, files) => {
    if (!Array.isArray(files) || !files.length) return null;
    if (files.length === 1) {
      const r = await dialog.showSaveDialog(win(), { defaultPath: pngName(files[0].name), filters: [{ name: 'PNG 그림', extensions: ['png'] }] });
      if (r.canceled || !r.filePath) return null;
      const [out] = writePngs(path.dirname(r.filePath), [{ ...files[0], name: path.parse(r.filePath).name }]);
      return [out];
    }
    const r = await dialog.showOpenDialog(win(), { title: 'PNG를 저장할 폴더', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (!(await confirmOverwrite(existingTexts(r.filePaths[0], pngNames(files).map((name) => ({ name })))))) return null;
    return writePngs(r.filePaths[0], files);
  });
  ipcMain.handle('text:save', async (_e, files) => {
    if (!Array.isArray(files) || !files.length) return null;
    const r = await dialog.showOpenDialog(win(), { title: '명세 파일을 저장할 폴더', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (!(await confirmOverwrite(existingTexts(r.filePaths[0], files)))) return null;
    return writeTexts(r.filePaths[0], files);
  });
  ipcMain.handle('snap:write', (_e, file, kind, name, text, max) => writeSnapshot(file, kind, name, text, max));
  ipcMain.handle('snap:list', (_e, file, kind) => listSnapshots(file, kind));
}

module.exports = { registerFileApi, writeSnapshot, listSnapshots, allow, writePngs, pngName, pngNames, writeAtomic, writeTexts, existingTexts };
