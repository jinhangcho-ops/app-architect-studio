// HTML 파일을 실제로 그려서(숨긴 iframe) 요소마다 자리·크기를 읽어 와이어프레임 상자로 만든다.
// 스크립트는 돌리지 않고(sandbox에 allow-scripts 없음), 바깥 주소에서 아무것도 받지 않는다(CSP). 함께 고른 CSS 파일은 <link> 자리에 넣는다.
// 화면 틀보다 긴 페이지는 틀 높이마다 한 장씩 나눈다. 그릴 수 없는 환경(레이아웃이 없는 테스트 DOM)에서는 undefined → 영역 규칙으로 배치(htmlToScreen).
import type { Screen, WireItem } from '../../engine/schema';
import { apiFor, clean, ROLE_KIND, roleOf } from './htmlImport';

type Kind = WireItem['kind'];
type Api = NonNullable<WireItem['api']>;
/** 그린 페이지에서 읽은 요소 하나 (y는 페이지 맨 위 기준) */
export type Entry = { kind: Kind; label: string; x: number; y: number; w: number; h: number; api?: Api };

const CONTROL = 'button, input:not([type=hidden]), select, textarea, a[href], img, svg, video, canvas';
const TEXT_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'P', 'LABEL', 'SPAN', 'LI', 'STRONG', 'EM', 'SMALL', 'DT', 'DD', 'FIGCAPTION', 'LEGEND', 'CAPTION', 'DIV']);
const ownText = (el: Element) => clean([...el.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent).join(' '));

/** 요소 하나의 상자 종류와 글. 상자로 만들지 않으면 undefined */
function classify(el: Element): { kind: Kind; label: string } | undefined {
  const tag = el.tagName;
  const role = roleOf(el);
  if (role) return { kind: ROLE_KIND[role], label: role };
  const type = (el.getAttribute('type') ?? '').toLowerCase();
  if (tag === 'BUTTON' || (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(type))) return { kind: 'button', label: clean(el.textContent) || el.getAttribute('value') || el.getAttribute('aria-label') || '버튼' };
  if (tag === 'INPUT' && type === 'checkbox') return { kind: 'checkbox', label: clean(el.closest('label')?.textContent) || el.getAttribute('name') || '' };
  if (tag === 'INPUT' && type === 'radio') return { kind: 'radio', label: clean(el.closest('label')?.textContent) || el.getAttribute('value') || '' };
  if (tag === 'INPUT' || tag === 'TEXTAREA') return { kind: 'input', label: el.getAttribute('placeholder') ?? el.getAttribute('name') ?? '' };
  if (tag === 'SELECT') return { kind: 'select', label: clean(el.querySelector('option')?.textContent) || el.getAttribute('name') || '' };
  if (['IMG', 'SVG', 'VIDEO', 'CANVAS'].includes(tag.toUpperCase())) return { kind: 'image', label: el.getAttribute('alt') ?? '이미지' };
  if (tag === 'A') return { kind: 'text', label: clean(el.textContent) };
  if (tag === 'UL' || tag === 'OL') return el.closest('nav') ? undefined : { kind: 'list', label: '목록' };
  // 글: 자기 글이 있고, 컨트롤 안이 아닐 때. div·span은 안에 다른 요소가 없을 때만 (큰 묶음 상자가 글로 잡히지 않게)
  // 체크박스를 감싼 label은 체크박스 글로 들어가므로 따로 만들지 않는다
  if (!TEXT_TAGS.has(tag) || !ownText(el) || el.parentElement?.closest('button, a, select, label')) return undefined;
  if ((tag === 'DIV' || tag === 'SPAN') && el.children.length) return undefined;
  if (tag === 'LABEL' && el.querySelector('input')) return undefined;
  return { kind: 'text', label: tag === 'DIV' || tag === 'SPAN' ? ownText(el) : clean(el.textContent) };
}

/** 그려진 문서에서 상자 후보를 읽는다 */
export function measure(doc: Document): Entry[] {
  const view = doc.defaultView!;
  const out: Entry[] = [];
  const usedForms = new Set<Element>();
  // 글 상자로 만든 요소. 그 안쪽 글(li 속 strong 등)은 겹치므로 만들지 않는다
  const texts = new Set<Element>();
  const inText = (el: Element) => { for (let x = el.parentElement; x; x = x.parentElement) if (texts.has(x)) return true; return false; };
  for (const el of doc.body.querySelectorAll('*')) {
    // 이미 상자로 만든 컨트롤 안쪽(버튼 속 아이콘 등)은 따로 만들지 않는다
    if (el.parentElement?.closest(CONTROL)) continue;
    const c = classify(el);
    if (!c) continue;
    if (c.kind === 'text') { if (inText(el)) continue; texts.add(el); }
    const st = view.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const w = r.width || Number(el.getAttribute('width')) || (c.kind === 'image' ? 160 : 0);
    const h = r.height || Number(el.getAttribute('height')) || (c.kind === 'image' ? 100 : 0);
    if (w < 2 || h < 2) continue;
    const api = apiFor(el, c.kind === 'button', usedForms);
    out.push({ ...c, x: Math.round(r.left + view.scrollX), y: Math.round(r.top + view.scrollY), w: Math.round(w), h: Math.round(h), ...(api && { api }) });
  }
  return out;
}

/** 틀 높이마다 한 장씩 나눈다. 상자는 위쪽 끝이 있는 장에 들어가고, 틀을 넘는 부분은 자른다 */
export function paginate(entries: Entry[], frame: { w: number; h: number }, name: string): Screen[] {
  const pages: Omit<WireItem, 'id'>[][] = [];
  for (const e of entries) {
    if (e.x >= frame.w) continue;
    const page = Math.max(0, Math.floor(e.y / frame.h));
    const y = e.y - page * frame.h;
    (pages[page] ??= []).push({ ...e, x: Math.max(0, e.x), y, w: Math.min(e.w, frame.w - Math.max(0, e.x)), h: Math.min(e.h, frame.h - y) });
  }
  // pages는 건너뛴 장이 비어 있는 희소 배열이라 map은 빈 자리를 건너뛴다 → Array.from으로 채운다
  const filled = Array.from(pages, (p) => p ?? []).filter((p, i, all) => p.length || i < all.length - 1);
  if (!filled.length) return [{ name, items: [] }];
  return filled.map((items, i) => ({
    name: filled.length > 1 ? `${name} (${i + 1}/${filled.length})` : name,
    items: items.map((it, j) => ({ ...it, id: `w${j + 1}` })),
  }));
}

/** 바깥 주소 읽기를 막고(CSP), 함께 고른 CSS 파일을 <link> 자리에 넣은 HTML */
export function prepareHtml(text: string, css: Record<string, string>, parser: DOMParser = new DOMParser()): string {
  const doc = parser.parseFromString(text, 'text/html');
  // meta refresh(다른 주소로 이동)·dns-prefetch 같은 link는 CSP가 막지 못해 바깥으로 요청이 나가므로 지운다
  for (const el of doc.querySelectorAll('script, iframe, frame, object, embed, base, meta[http-equiv], link:not([rel~="stylesheet"])')) el.remove();
  for (const link of doc.querySelectorAll('link[rel~="stylesheet"]')) {
    const file = (link.getAttribute('href') ?? '').split(/[?#]/)[0].split('/').pop() ?? '';
    if (css[file] !== undefined) { const st = doc.createElement('style'); st.textContent = css[file]; link.replaceWith(st); } else link.remove();
  }
  // 바깥 그림 주소는 CSP가 막으면서 콘솔 오류를 남기므로 미리 지운다 (크기는 width·height·CSS로 잡힌다)
  for (const el of doc.querySelectorAll('[src], [srcset]')) {
    if (!(el.getAttribute('src') ?? '').startsWith('data:')) el.removeAttribute('src');
    el.removeAttribute('srcset');
  }
  const meta = doc.createElement('meta');
  meta.setAttribute('http-equiv', 'Content-Security-Policy');
  meta.setAttribute('content', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:");
  doc.head.prepend(meta);
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** 숨긴 iframe에 그려 상자 후보를 읽는다. 레이아웃이 없는 환경이면 undefined */
export async function renderHtml(text: string, frame: { w: number; h: number }, css: Record<string, string> = {}): Promise<Entry[] | undefined> {
  const f = document.createElement('iframe');
  // allow-same-origin만: 문서를 읽을 수는 있고 스크립트는 돌지 않는다
  f.setAttribute('sandbox', 'allow-same-origin');
  f.style.cssText = `position:fixed;left:-30000px;top:0;width:${frame.w}px;height:${frame.h}px;border:0;visibility:hidden;pointer-events:none`;
  f.srcdoc = prepareHtml(text, css);
  try {
    document.body.appendChild(f);
    await new Promise<void>((ok) => { f.onload = () => ok(); setTimeout(ok, 5000); });
    const doc = f.contentDocument;
    if (!doc?.body) return undefined;
    const out = measure(doc);
    // 모든 상자가 0 크기면 레이아웃이 없는 환경이다
    return out.length ? out : undefined;
  } catch {
    return undefined;
  } finally {
    f.remove();
  }
}
