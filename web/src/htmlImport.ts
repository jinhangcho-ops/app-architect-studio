// 11.4 HTML 와이어프레임: 시맨틱 태그와 클래스 이름으로 화면 영역을 뽑고, 폼·링크에서 API 경로를 찾는다.
// v2 파서를 옮기지 않고 영역 판별 규칙만 가져와 브라우저 DOMParser로 처리한다.
import type { Screen, WireItem } from '../../engine/schema';

export type Region = { role: string; selector: string; controls: string[] };
export type ApiCall = { method: string; path: string };

const TAG_ROLE: Record<string, string> = {
  header: '상단 헤더', nav: '네비게이션', aside: '사이드바', main: '메인', form: '입력 폼', table: '표', dialog: '모달', footer: '하단 푸터',
};
// v2 CLASS_ROLE_PATTERNS에 해당: 시맨틱 태그가 아닌 div도 클래스·id 이름으로 역할을 맞힌다
const CLASS_ROLE: [RegExp, string][] = [
  [/(^|[-_ ])(header|top-?bar)([-_ ]|$)/i, '상단 헤더'],
  [/(^|[-_ ])(gnb|nav|menu)([-_ ]|$)/i, '네비게이션'],
  [/(^|[-_ ])(sidebar|aside|side)([-_ ]|$)/i, '사이드바'],
  [/(^|[-_ ])(modal|dialog|popup)([-_ ]|$)/i, '모달'],
  [/(^|[-_ ])(footer)([-_ ]|$)/i, '하단 푸터'],
];

const selectorOf = (el: Element) =>
  `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : el.classList.length ? `.${el.classList[0]}` : ''}`;

function controlsOf(el: Element): string[] {
  const out: string[] = [];
  el.querySelectorAll('button, input, select, textarea, a[href], th').forEach((c) => {
    const tag = c.tagName.toLowerCase();
    const text = (c.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
    if (tag === 'button') out.push(`[버튼] ${text || c.getAttribute('aria-label') || ''}`);
    else if (tag === 'input') out.push(`[입력:${c.getAttribute('type') ?? 'text'}] ${c.getAttribute('placeholder') ?? c.getAttribute('name') ?? ''}`);
    else if (tag === 'select') out.push(`[선택창] ${c.getAttribute('name') ?? ''}`);
    else if (tag === 'textarea') out.push(`[입력:여러 줄] ${c.getAttribute('name') ?? ''}`);
    else if (tag === 'th') out.push(`[컬럼] ${text}`);
    else out.push(`[링크] ${text} → ${c.getAttribute('href')}`);
  });
  return out;
}

export function extractRegions(doc: Document): Region[] {
  const regions: Region[] = [];
  doc.body.querySelectorAll('*').forEach((el) => {
    const tag = el.tagName.toLowerCase();
    const name = `${el.id} ${el.className}`;
    const role = TAG_ROLE[tag] ?? CLASS_ROLE.find(([re]) => re.test(name))?.[1];
    if (role) regions.push({ role, selector: selectorOf(el), controls: controlsOf(el) });
  });
  return regions;
}

/** 폼 action, /api로 시작하는 링크, data-api 속성에서 API 경로를 찾는다. 연결선은 사용자가 확인해야 만든다 */
export function extractApiCalls(doc: Document): ApiCall[] {
  const calls: ApiCall[] = [];
  doc.querySelectorAll('form[action]').forEach((f) => calls.push({ method: (f.getAttribute('method') ?? 'GET').toUpperCase(), path: f.getAttribute('action')! }));
  doc.querySelectorAll('a[href^="/api"]').forEach((a) => calls.push({ method: 'GET', path: a.getAttribute('href')! }));
  doc.querySelectorAll('[data-api]').forEach((e) => {
    const [method, path] = e.getAttribute('data-api')!.split(/\s+/);
    calls.push(path ? { method: method.toUpperCase(), path } : { method: 'GET', path: method });
  });
  const seen = new Set<string>();
  return calls.filter((c) => !seen.has(`${c.method} ${c.path}`) && seen.add(`${c.method} ${c.path}`));
}

export function parseHtml(text: string, parser: DOMParser = new DOMParser()) {
  const doc = parser.parseFromString(text, 'text/html');
  return { regions: extractRegions(doc), apiCalls: extractApiCalls(doc), title: doc.title };
}

// ── HTML → 와이어프레임 한 장 ──
// 영역은 위 규칙으로 찾고, 자리는 화면 틀 안에 다시 잡는다: 헤더·네비는 위, 푸터는 아래, 사이드바는 왼쪽, 나머지는 본문에 차례로 쌓는다.
// 컨트롤은 가장 가까운 영역 안에 줄지어 놓는다. 폼 action은 그 폼의 첫 버튼에, data-api와 /api 링크는 그 컨트롤에 API로 붙인다(대상 노드는 사람이 고른다).
// shortcut: CSS 배치는 보지 않고 영역 종류로만 자리를 잡는다. 실제 모양이 필요하면 브라우저로 렌더링해 좌표를 읽는다
type Kind = WireItem['kind'];
type Api = NonNullable<WireItem['api']>;
const ROLE_KIND: Record<string, Kind> = { '상단 헤더': 'header', '네비게이션': 'nav', '사이드바': 'sidebar', '메인': 'main', '입력 폼': 'form', '표': 'table', '모달': 'modal', '하단 푸터': 'footer' };
const roleOf = (el: Element) => TAG_ROLE[el.tagName.toLowerCase()] ?? CLASS_ROLE.find(([re]) => re.test(`${el.id} ${el.className}`))?.[1];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const apiOf = (method: string, path: string): Api => ({ method: (METHODS as readonly string[]).includes(method) ? (method as Api['method']) : 'GET', path, per_session: 1 });
const dataApi = (el: Element): Api | undefined => {
  const v = el.getAttribute('data-api');
  if (!v) return undefined;
  const [a, b] = v.trim().split(/\s+/);
  return b ? apiOf(a.toUpperCase(), b) : apiOf('GET', a);
};

export function htmlToScreen(text: string, frame: { w: number; h: number }, name = '가져온 화면', parser: DOMParser = new DOMParser()): Screen {
  const doc = parser.parseFromString(text, 'text/html');
  const regions = [...doc.body.querySelectorAll('*')].filter((el) => roleOf(el));
  /** el을 감싸는 가장 가까운 영역 (among = 후보 영역) */
  const ownerIn = (among: Element[]) => (el: Element) => { let x = el.parentElement; while (x && !among.includes(x)) x = x.parentElement; return x; };
  const owner = ownerIn(regions);
  // 실제로 그리는 영역. 그 안에 든 다른 영역(헤더 안 nav 등)의 컨트롤은 바깥 영역에 놓는다
  let placed: Element[] = [];
  const usedForms = new Set<Element>();
  const items: Omit<WireItem, 'id'>[] = [];
  const G = 16;

  const controlsOf2 = (r: Element) => [...r.querySelectorAll('button, input:not([type=hidden]), select, textarea, a[href]')].filter((c) => ownerIn(placed)(c) === r);
  /** 영역 하나와 그 안의 컨트롤을 놓고 쓴 높이를 돌려준다 */
  const place = (r: Element, x: number, y: number, w: number, minH: number): number => {
    const kind = ROLE_KIND[roleOf(r)!];
    const formApi = r.tagName === 'FORM' && r.getAttribute('action') ? apiOf((r.getAttribute('method') ?? 'GET').toUpperCase(), r.getAttribute('action')!) : undefined;
    // 영역 이름이 왼쪽 위에 오므로 컨트롤은 그 아래부터 (막대는 낮아서 조금 더 위부터)
    let cx = x + G, cy = y + (['header', 'nav', 'footer'].includes(kind) ? 22 : 32), rowH = 0;
    for (const c of controlsOf2(r)) {
      const tag = c.tagName.toLowerCase();
      const t = (c.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30);
      const [k, cw, ch, label]: [Kind, number, number, string] =
        tag === 'button' || (tag === 'input' && ['submit', 'button'].includes(c.getAttribute('type') ?? '')) ? ['button', 120, 36, t || c.getAttribute('value') || c.getAttribute('aria-label') || '버튼']
        : tag === 'select' ? ['select', 200, 36, c.getAttribute('name') ?? '선택']
        : tag === 'textarea' ? ['input', 280, 72, c.getAttribute('placeholder') ?? c.getAttribute('name') ?? '']
        : tag === 'input' ? ['input', 240, 36, c.getAttribute('placeholder') ?? c.getAttribute('name') ?? '']
        : ['text', 160, 24, t];
      const width = Math.min(cw, w - 2 * G);
      if (cx + width > x + w - G) { cx = x + G; cy += rowH + 8; rowH = 0; }
      const href = tag === 'a' ? c.getAttribute('href') ?? '' : '';
      let api = dataApi(c) ?? (href.startsWith('/api') ? apiOf('GET', href) : undefined);
      // 폼 action은 그 폼의 첫 버튼이 가져간다 (폼이 다른 영역 안에 있어도)
      const fm = k === 'button' ? c.closest('form[action]') : null;
      if (!api && fm && !usedForms.has(fm)) { usedForms.add(fm); api = apiOf((fm.getAttribute('method') ?? 'GET').toUpperCase(), fm.getAttribute('action')!); }
      items.push({ kind: k, label, x: cx, y: cy, w: width, h: ch, ...(api && { api }) });
      cx += width + 8;
      rowH = Math.max(rowH, ch);
    }
    const h = Math.max(minH, rowH ? cy + rowH + G - y : 0);
    const api = dataApi(r) ?? (formApi && !usedForms.has(r) ? formApi : undefined);
    items.push({ kind, label: roleOf(r)!, x, y, w, h, ...(api && { api }) });
    return h;
  };

  const kinds = (ks: Kind[]) => regions.filter((r) => ks.includes(ROLE_KIND[roleOf(r)!]) && !owner(r));
  const bars = kinds(['header', 'nav']);
  const footer = kinds(['footer'])[0];
  const sides = kinds(['sidebar']);
  const main = kinds(['main'])[0];
  const body = regions.filter((r) => !['header', 'nav', 'footer', 'sidebar', 'main'].includes(ROLE_KIND[roleOf(r)!]) && (!owner(r) || owner(r) === main));
  placed = [...bars, ...(footer ? [footer] : []), ...sides, ...(main ? [main] : []), ...body];
  let top = 0;
  for (const r of bars) top += place(r, 0, top, frame.w, ROLE_KIND[roleOf(r)!] === 'header' ? 64 : 44);
  const bottom = footer ? frame.h - 56 : frame.h;
  if (footer) place(footer, 0, bottom, frame.w, 56);
  sides.forEach((r) => place(r, 0, top, 240, bottom - top));
  const x0 = sides.length ? 256 : G, w0 = frame.w - x0 - G;
  // 본문: main이 있으면 그 안에, 없으면 바로 쌓는다
  let y = top + G + (main ? 32 : 0);
  for (const r of body) y += place(r, x0 + (main ? G : 0), y, w0 - (main ? 2 * G : 0), ROLE_KIND[roleOf(r)!] === 'table' ? 200 : 120) + G;
  if (main) {
    const before = items.length;
    place(main, x0, top + G, w0, Math.max(bottom - top - 2 * G, y - top - G));
    // main 자신의 컨트롤은 안쪽 영역 아래로 옮긴다
    for (const it of items.slice(before, -1)) it.y += y - (top + G + 32);
  }
  return { name: doc.title || name, items: items.map((it, i) => ({ ...it, id: `w${i + 1}` })) };
}
