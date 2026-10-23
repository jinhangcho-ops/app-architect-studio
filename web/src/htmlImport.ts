// 11.4 HTML 와이어프레임: 시맨틱 태그와 클래스 이름으로 화면 영역을 뽑고, 폼·링크에서 API 경로를 찾는다.
// v2 파서를 옮기지 않고 영역 판별 규칙만 가져와 브라우저 DOMParser로 처리한다.

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
