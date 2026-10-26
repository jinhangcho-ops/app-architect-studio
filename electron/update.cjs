// 새 버전 알림과 업데이트: 앱을 켤 때 GitHub Releases의 최신 버전을 한 번 보고(설정에서 끌 수 있음), 지금보다 새 버전이면 화면에 알린다.
// [업데이트]를 누르면 그 Release의 설치 파일을 받아, Release의 .sha256과 GitHub가 계산한 지문 둘 다와 맞을 때만 설치 프로그램을 실행하고 앱을 닫는다.
// 인터넷이 안 되면 조용히 넘어가고, 이 저장소의 Releases 주소가 아닌 것은 받거나 열지 않는다. 보내는 것은 Releases API 요청 하나뿐(데이터 값은 보내지 않음)
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO = 'jinhangcho-ops/app-architect-studio';
const RELEASES = `https://github.com/${REPO}/releases/`;
const LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'App-Architect-Studio' };

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

/** 지금 버전보다 새 Release가 있으면 { current, version, url, installer? }, 없거나 확인할 수 없으면 null.
 *  installer: 설치 파일과 지문 파일의 주소, GitHub가 계산한 지문 (Release에 둘 다 있을 때만) */
async function checkUpdate(current, fetchImpl) {
  try {
    const r = await fetchImpl(LATEST, { headers: HEADERS });
    if (!r.ok) return null;
    const j = await r.json();
    const version = String(j.tag_name ?? '').replace(/^v/, ''), url = String(j.html_url ?? '');
    // 이 저장소의 Releases 주소가 아니면 믿지 않는다 (받기 버튼이 그 주소를 연다)
    if (!url.startsWith(RELEASES) || compareVersions(version, current) <= 0) return null;
    const name = `App-Architect-Studio-Setup-${version}.exe`;
    const asset = (n) => (j.assets ?? []).find((a) => a.name === n && String(a.browser_download_url).startsWith(`${RELEASES}download/`));
    const exe = asset(name), sum = asset(`${name}.sha256`);
    const digest = /^sha256:([0-9a-f]{64})$/.exec(String(exe?.digest ?? ''))?.[1];
    return { current, version, url, ...(exe && sum && digest && { installer: { name, url: exe.browser_download_url, sha256Url: sum.browser_download_url, digest } }) };
  } catch {
    return null;
  }
}

/** 받은 설치 파일이 두 지문과 같은지: Release의 .sha256 첫 칸, GitHub가 계산한 지문 */
function verifyInstaller(buf, sha256Text, digest) {
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  const listed = String(sha256Text).trim().split(/\s+/)[0]?.toLowerCase();
  return actual === listed && actual === digest;
}

/** [업데이트]: 설치 파일을 임시 폴더에 받아 지문을 대조하고, 맞으면 설치 프로그램을 띄운 뒤 앱을 닫는다. 실패하면 이유를 돌려준다 */
async function installUpdate(info, { fetchImpl, tempDir, launch, quit }) {
  const inst = info?.installer;
  if (!inst || !String(inst.url).startsWith(`${RELEASES}download/`) || !String(inst.sha256Url).startsWith(`${RELEASES}download/`)) return { ok: false, reason: '이 Release에는 설치 파일·지문이 없습니다' };
  try {
    const [exe, sum] = await Promise.all([fetchImpl(inst.url), fetchImpl(inst.sha256Url)]);
    if (!exe.ok || !sum.ok) return { ok: false, reason: `받지 못했습니다 (${exe.status} / ${sum.status})` };
    const buf = Buffer.from(await exe.arrayBuffer());
    if (!verifyInstaller(buf, await sum.text(), inst.digest)) return { ok: false, reason: '받은 파일의 지문이 Release와 다릅니다. 실행하지 않았습니다' };
    const dir = path.join(tempDir, 'app-architect-studio-update');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(inst.name));
    fs.writeFileSync(file, buf);
    await launch(file);
    quit();
    return { ok: true, file };
  } catch (e) {
    return { ok: false, reason: `업데이트하지 못했습니다: ${e.message}` };
  }
}

/** Electron에 연결: 확인, 업데이트(받기·대조·설치 실행), Releases 페이지 열기(이 저장소 주소만) */
function registerUpdateApi() {
  const { app, ipcMain, net, shell } = require('electron');
  let last = null; // 화면이 넘긴 값 대신, 확인할 때 받은 정보로만 설치한다
  ipcMain.handle('update:check', async () => (last = await checkUpdate(app.getVersion(), net.fetch)));
  ipcMain.handle('update:install', () => installUpdate(last, {
    fetchImpl: net.fetch, tempDir: app.getPath('temp'),
    launch: async (file) => { const err = await shell.openPath(file); if (err) throw new Error(err); },
    quit: () => setTimeout(() => app.quit(), 500),
  }));
  ipcMain.handle('update:open', (_e, url) => {
    if (typeof url === 'string' && url.startsWith(RELEASES)) return shell.openExternal(url);
  });
}

module.exports = { compareVersions, checkUpdate, verifyInstaller, installUpdate, registerUpdateApi, RELEASES };
