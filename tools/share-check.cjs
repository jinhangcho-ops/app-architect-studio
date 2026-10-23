// 화면 공유 확인: 앱 창만 캡처해서(Zoom·Teams의 "창 공유"와 같은 방식) 팝업이 찍히는지 본다.
// 사용법: npm run dev 를 켠 상태에서  npx electron tools/share-check.cjs <저장 폴더>
// 찍는 것: 앱 드롭다운 펼침 · 기본 <select> 펼침 · 앱 툴팁 · 기본 title 툴팁 (비교용으로 기본 것은 잠깐 끼워 넣는다)
const { app, BrowserWindow, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const OUT = path.resolve(process.argv[process.argv.length - 1] || '.');
const URL = process.env.SHARE_CHECK_URL || 'http://localhost:5173';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1400, height: 900, x: 40, y: 40, alwaysOnTop: true });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const click = async (x, y) => {
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  };
  const centerOf = (selector) => js(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]; })()`);
  // 창 공유와 같은 "창 캡처"만 찍는다. 화면 전체는 찍지 않는다 (다른 프로그램 화면이 섞이지 않게)
  const shot = async (name) => {
    await sleep(900);
    const id = win.getMediaSourceId();
    const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1400, height: 900 } });
    fs.writeFileSync(path.join(OUT, `${name}.png`), sources.find((s) => s.id === id).thumbnail.toPNG());
    console.log('saved', name);
  };

  await win.loadURL(URL);
  await sleep(2000);
  await js(`[...document.querySelectorAll('.recovery button')].find((b) => b.textContent === '닫기')?.click(); 1`);
  await sleep(300);

  // 1) 앱 드롭다운 (페이지 안에 그림)
  const [ex, ey] = await centerOf('button.select[aria-label="예시 불러오기"]');
  await click(ex, ey);
  await shot('1-app-dropdown');
  await click(5, 890);
  await sleep(300);

  // 2) 기본 <select> (운영체제 팝업)
  await js(`(() => { const s = document.createElement('select'); s.id = 'native-test'; s.style.cssText = 'position:fixed;left:480px;top:300px;z-index:9999;font-size:16px';
    s.innerHTML = '<option>기본 드롭다운 1</option><option>기본 드롭다운 2</option><option>기본 드롭다운 3</option>'; document.body.appendChild(s); return 1; })()`);
  const [nx, ny] = await centerOf('#native-test');
  await click(nx, ny);
  await shot('2-native-dropdown');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  await sleep(300);

  // 3) 앱 툴팁: 지표 위에 마우스
  const [kx, ky] = await centerOf('.kpi:nth-child(3)');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: kx, y: ky });
  await shot('3-app-tooltip');

  // 4) 기본 title 툴팁: 앱 툴팁이 가로채지 않게 iframe 안에 둔다
  await js(`(() => { const f = document.createElement('iframe'); f.id = 'native-tip'; f.style.cssText = 'position:fixed;left:480px;top:420px;width:260px;height:60px;border:0;z-index:9999;background:#fff';
    f.srcdoc = '<button title="기본 title 툴팁입니다" style="font-size:16px;margin:12px">여기에 마우스</button>'; document.body.appendChild(f); return 1; })()`);
  await sleep(500);
  const [fx, fy] = await centerOf('#native-tip');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: fx - 40, y: fy });
  await sleep(1800);
  await shot('4-native-tooltip');

  app.quit();
});
