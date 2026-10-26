// 새 버전 알림: 앱을 켤 때 GitHub Releases의 최신 버전을 한 번 보고, 지금보다 새 버전이면 화면에 알린다.
// 자동으로 받거나 설치하지 않는다 (받기는 브라우저에서 Releases 페이지를 연다). 인터넷이 안 되면 조용히 넘어간다
const RELEASES = 'https://github.com/jinhangcho-ops/app-architect-studio/releases/';
const LATEST = 'https://api.github.com/repos/jinhangcho-ops/app-architect-studio/releases/latest';

/** 'x.y.z' 또는 'x.y.z-꼬리표' 비교: a가 b보다 새것이면 양수. 꼬리표가 붙은 것(1.1.0-local)은 같은 번호의 정식(1.1.0)보다 낮다 */
function compareVersions(a, b) {
  const parse = (v) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v).trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] } : undefined;
  };
  const x = parse(a), y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] - y.n[i];
  if (!x.pre === !y.pre) return 0;
  return x.pre ? -1 : 1;
}

/** 지금 버전보다 새 Release가 있으면 { current, version, url }, 없거나 확인할 수 없으면 null */
async function checkUpdate(current, fetchImpl) {
  try {
    const r = await fetchImpl(LATEST, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'App-Architect-Studio' } });
    if (!r.ok) return null;
    const j = await r.json();
    const version = String(j.tag_name ?? '').replace(/^v/, ''), url = String(j.html_url ?? '');
    // 이 저장소의 Releases 주소가 아니면 믿지 않는다 (받기 버튼이 그 주소를 연다)
    if (!url.startsWith(RELEASES) || compareVersions(version, current) <= 0) return null;
    return { current, version, url };
  } catch {
    return null;
  }
}

/** Electron에 연결: 화면이 확인을 부르고, 받기 버튼은 이 저장소의 Releases 주소만 브라우저로 연다 */
function registerUpdateApi() {
  const { app, ipcMain, net, shell } = require('electron');
  ipcMain.handle('update:check', () => checkUpdate(app.getVersion(), net.fetch));
  ipcMain.handle('update:open', (_e, url) => {
    if (typeof url === 'string' && url.startsWith(RELEASES)) return shell.openExternal(url);
  });
}

module.exports = { compareVersions, checkUpdate, registerUpdateApi, RELEASES };
