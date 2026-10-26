// 새 버전 확인과 업데이트 (설치 앱에서만).
// 확인: https://github.com/<저장소>/releases/latest 를 열면 .../releases/tag/v1.2.3 으로 넘어간다. 넘어간 주소의 마지막 조각에서 태그를 읽는다(API는 쓰지 않음).
//       새 버전일 때만 그 릴리스의 RELEASE_NOTES.md(추가·개선·삭제)를 받는다. 실행마다 한 번만 묻고, 인터넷·프록시 오류는 조용히 넘긴다.
// 업데이트: 설치 파일과 .sha256을 임시 폴더에 받아 지문이 맞을 때만 조용히 설치한다(NSIS /S, 끝나면 --force-run으로 앱을 다시 연다).
// GitHub에 보내는 것은 최신 릴리스 주소, (새 버전일 때) 노트, (업데이트할 때) 설치 파일·지문 요청뿐이다. 프로젝트·데이터 값은 보내지 않는다
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'jinhangcho-ops/app-architect-studio';
const RELEASES = `https://github.com/${REPO}/releases/`;
const HEADERS = { 'User-Agent': 'App-Architect-Studio' };
const NOTES_MAX = 50 * 1024;
const EXE_MAX = 400 * 1024 * 1024;
/** 받기·설치에 필요한 빈 공간 (설치 파일 120MB + 설치 중 풀린 파일 + 여유) */
const MIN_FREE = 600 * 1024 * 1024;
const TAG = /^v[0-9A-Za-z.+-]+$/;

/** '1.10.0' → [1, 10, 0]. 숫자가 아닌 조각(1.1.0-local, nightly)이 있으면 undefined (견주지 않는다) */
function parseVersion(v) {
  const parts = String(v).replace(/^v/, '').split('.');
  return parts.length && parts.every((x) => /^\d+$/.test(x)) ? parts.map(Number) : undefined;
}
/** 점으로 나눈 숫자 튜플로 견준다 (1.10 > 1.9). 견줄 수 없으면 0 */
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}
/** 넘어간 주소의 마지막 조각 → 태그. 모양이 다르면 undefined */
function tagFromUrl(url) {
  const m = /\/releases\/tag\/([^/?#]+)$/.exec(String(url));
  const tag = m && decodeURIComponent(m[1]);
  return tag && TAG.test(tag) && parseVersion(tag) ? tag : undefined;
}
/** 묻지 않는 경우의 이유 (없으면 undefined): 개발 실행, 버전을 모름, 태그 없이 만든 시험 빌드 */
function whyNotAsk(isPackaged, current) {
  if (!isPackaged) return '개발 실행에서는 확인하지 않아요';
  if (!parseVersion(current)) return '이 앱의 버전을 몰라요';
  if (parseVersion(current).every((n) => n === 0)) return '시험 빌드(0.0.0)예요';
  return undefined;
}

/** 응답 본문을 상한까지만 읽는다. 넘으면 undefined */
async function readCapped(res, max) {
  const len = Number(res.headers?.get?.('content-length'));
  if (len > max) return undefined;
  const buf = Buffer.from(await res.arrayBuffer());
  return buf.length > max ? undefined : buf;
}

/** deps: latestUrl(releases/latest가 넘어가는 주소), fetchImpl, getVersion, isPackaged, tempDir, installDir, freeBytes(dir), busy, spawn, quit */
function createUpdater(deps) {
  let asked; // 실행마다 한 번만 (메모리)
  let found; // 확인으로 찾은 새 버전 — 설치는 이 값으로만 한다 (화면이 넘긴 값은 쓰지 않음)

  async function check() {
    asked ??= (async () => {
      const current = deps.getVersion();
      if (whyNotAsk(deps.isPackaged(), current)) return null;
      try {
        const tag = tagFromUrl(await deps.latestUrl());
        if (!tag || compareVersions(tag, current) <= 0) return null;
        let notes;
        try {
          const n = await deps.fetchImpl(`${RELEASES}download/${tag}/RELEASE_NOTES.md`, { headers: HEADERS });
          const buf = n.ok ? await readCapped(n, NOTES_MAX) : undefined;
          notes = buf?.toString('utf8').trim() || undefined;
        } catch { /* 노트 없이 알린다 */ }
        found = { current, version: tag.slice(1), tag, notes };
        return found;
      } catch {
        return null; // 인터넷·프록시 오류는 조용히
      }
    })();
    return asked;
  }

  /** 지정 버전의 설치 파일을 받아 지문이 맞으면 조용히 설치한다. 결과 { ok, reason?, args? } */
  async function installVersion(version) {
    const current = deps.getVersion();
    const why = whyNotAsk(deps.isPackaged(), current);
    if (why) return { ok: false, reason: why };
    if (!parseVersion(version) || !TAG.test(`v${version}`)) return { ok: false, reason: '버전 글자가 올바르지 않아 받지 않았어요' };
    const busy = deps.busy?.();
    if (busy) return { ok: false, reason: busy };
    const installDir = deps.installDir();
    const free = deps.freeBytes(installDir);
    if (free < MIN_FREE) return { ok: false, reason: `설치 드라이브 공간이 모자라요 (남은 ${Math.floor(free / 1048576)}MB, 필요 ${MIN_FREE / 1048576}MB)` };

    const name = `App-Architect-Studio-Setup-${version}.exe`;
    const base = `${RELEASES}download/v${version}/${name}`;
    const dir = fs.mkdtempSync(path.join(deps.tempDir(), 'aas-update-'));
    const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    try {
      const timeout = { signal: AbortSignal.timeout(10 * 60 * 1000), headers: HEADERS };
      const [exe, sum] = await Promise.all([deps.fetchImpl(base, timeout), deps.fetchImpl(`${base}.sha256`, timeout)]);
      if (!exe.ok || !sum.ok) { cleanup(); return { ok: false, reason: `받지 못했어요 (${exe.status} / ${sum.status})` }; }
      const [exeBuf, sumBuf] = await Promise.all([readCapped(exe, EXE_MAX), readCapped(sum, 1024)]);
      const expected = sumBuf?.toString('utf8').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
      if (!exeBuf || !/^[0-9a-f]{64}$/.test(expected)) { cleanup(); return { ok: false, reason: '설치 파일이나 지문 파일이 올바르지 않아 실행하지 않았어요' }; }
      if (crypto.createHash('sha256').update(exeBuf).digest('hex') !== expected) { cleanup(); return { ok: false, reason: '받은 설치 파일의 지문이 .sha256과 달라 실행하지 않고 지웠어요' }; }
      const file = path.join(dir, name);
      fs.writeFileSync(file, exeBuf);

      // NSIS: /S 조용히, --force-run 끝나면 앱 다시 열기, /D=설치 폴더는 마지막에 따옴표 없이 (그래서 명령줄을 그대로 쓴다)
      const args = ['/S', '--force-run', `/D=${installDir}`];
      const child = deps.spawn(file, args, { argv0: `"${file}"`, windowsVerbatimArguments: true, detached: true, stdio: 'ignore' });
      // 2초 안에 실패 코드로 끝나면(권한 거절 등) 앱을 닫지 않고 알린다
      const early = await new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined), 2000);
        child.once('exit', (code) => { clearTimeout(t); resolve(code); });
        child.once('error', (e) => { clearTimeout(t); resolve(e); });
      });
      if (early instanceof Error) { cleanup(); return { ok: false, reason: `설치 프로그램을 띄우지 못했어요: ${early.message}` }; }
      if (typeof early === 'number' && early !== 0) { cleanup(); return { ok: false, reason: `설치 프로그램이 바로 끝났어요 (코드 ${early})` }; }
      child.unref?.();
      deps.quit();
      return { ok: true, args };
    } catch (e) {
      cleanup();
      return { ok: false, reason: `업데이트하지 못했어요: ${e.message}` };
    }
  }

  return { check, installVersion, install: () => (found ? installVersion(found.version) : Promise.resolve({ ok: false, reason: '먼저 새 버전을 확인해야 해요' })) };
}

/** releases/latest가 넘어가는 주소 (Location). HEAD라 페이지 본문은 받지 않는다.
 *  net.fetch는 넘어간 뒤의 주소(response.url)를 비워 두고 redirect: 'manual'에선 오류를 내서, net.request의 redirect 이벤트로 읽는다 */
function latestRedirect(net) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'HEAD', url: `${RELEASES}latest`, redirect: 'manual' });
    const timer = setTimeout(() => { req.abort(); reject(new Error('시간 초과')); }, 15000);
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    req.setHeader('User-Agent', HEADERS['User-Agent']);
    req.on('redirect', (_status, _method, url) => { req.abort(); done(resolve)(url); });
    req.on('response', () => done(resolve)(''));
    req.on('error', done(reject));
    req.end();
  });
}

/** 지난 업데이트가 남긴 설치 파일 폴더(이 앱이 mkdtemp로 만든 aas-update-*만)를 지운다. 설치가 끝나면 앱이 꺼져서 그때는 못 지운다 */
function removeOldDownloads(tempDir, now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(tempDir); } catch { return []; }
  return names.filter((n) => /^aas-update-[A-Za-z0-9]{6}$/.test(n)).filter((n) => {
    try {
      const dir = path.join(tempDir, n);
      // 10분 안에 바뀐 폴더는 다른 창이 받는 중일 수 있어 남긴다
      if (now - fs.statSync(dir).mtimeMs < 10 * 60 * 1000) return false;
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch { return false; }
  });
}

/** Electron에 연결 */
function registerUpdateApi() {
  const { app, ipcMain, net } = require('electron');
  removeOldDownloads(app.getPath('temp'));
  const updater = createUpdater({
    latestUrl: () => latestRedirect(net),
    fetchImpl: (url, init) => net.fetch(url, init),
    getVersion: () => app.getVersion(),
    isPackaged: () => app.isPackaged,
    tempDir: () => app.getPath('temp'),
    installDir: () => path.dirname(process.execPath),
    freeBytes: (dir) => { const s = fs.statfsSync(dir); return s.bavail * s.bsize; },
    spawn: (...a) => require('node:child_process').spawn(...a),
    // 응답을 보낸 뒤 닫는다. 창이 안 닫히면 10초 뒤 강제 종료
    quit: () => setTimeout(() => { app.quit(); setTimeout(() => app.exit(0), 10000); }, 300),
  });
  ipcMain.handle('update:check', () => updater.check());
  ipcMain.handle('update:install', () => updater.install());
}

module.exports = { parseVersion, compareVersions, tagFromUrl, createUpdater, registerUpdateApi, removeOldDownloads, RELEASES, MIN_FREE };
