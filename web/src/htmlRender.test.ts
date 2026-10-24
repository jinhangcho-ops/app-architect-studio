// @vitest-environment happy-dom
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measure, paginate, prepareHtml } from './htmlRender';
import { DEVICES } from './wireDraw';

describe('HTML 그리기 준비', () => {
  it('스크립트를 빼고, 바깥 읽기를 막고, 함께 고른 CSS만 넣는다', () => {
    const out = prepareHtml('<html><head><link rel="stylesheet" href="css/site.css?v=2"><link rel="stylesheet" href="https://cdn.example.com/x.css"></head><body><script>alert(1)</script><iframe src="https://a.b"></iframe><p>hi</p></body></html>',
      { 'site.css': '.a{color:red}' });
    expect(out).toContain('Content-Security-Policy');
    expect(out).toContain("default-src 'none'");
    expect(out).toContain('<style>.a{color:red}</style>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('cdn.example.com');
    expect(prepareHtml('<img src="https://x.y/a.png" srcset="b.png 2x" width="10"><img src="data:image/png;base64,AA">', {})).not.toMatch(/x\.y|b\.png/);
  });
});

describe('그린 요소 → 상자', () => {
  // happy-dom은 레이아웃이 없어서, data-r="x,y,w,h"로 자리를 정해 둔다
  const orig = Element.prototype.getBoundingClientRect;
  beforeAll(() => {
    Element.prototype.getBoundingClientRect = function () {
      const [x, y, w, h] = (this.getAttribute('data-r') ?? '0,0,0,0').split(',').map(Number);
      return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) } as DOMRect;
    };
  });
  afterAll(() => { Element.prototype.getBoundingClientRect = orig; });

  it('영역·컨트롤·글을 실제 자리로, 겹치는 글과 숨은 요소는 빼고, 폼 action은 첫 버튼에', () => {
    document.body.innerHTML = `
      <header data-r="0,0,1280,60"><a href="/api/me" data-r="20,20,60,20">내 정보</a></header>
      <aside data-r="1000,60,280,700"><label data-r="1010,80,200,24"><input type="checkbox" name="agree" data-r="1010,84,16,16"> 약관 동의</label></aside>
      <main data-r="0,60,1000,700">
        <h1 data-r="20,80,400,40">주문하기</h1>
        <ul data-r="20,140,400,100"><li data-r="20,140,400,30"><strong data-r="20,140,60,30">상품</strong> 설명</li></ul>
        <form action="/api/orders" method="post" data-r="20,260,600,200">
          <input placeholder="주소" data-r="40,280,300,36">
          <button data-r="40,330,120,40"><span data-r="50,340,20,20">✓</span>주문</button>
          <button data-r="180,330,120,40">취소</button>
        </form>
        <img alt="배너" data-r="640,80,300,200">
        <div style="display:none" data-r="0,0,100,100">숨김</div>
      </main>`;
    const out = measure(document);
    const by = (label: string) => out.find((e) => e.label === label)!;
    expect(out.map((e) => e.kind).sort()).toEqual(['button', 'button', 'checkbox', 'form', 'header', 'image', 'input', 'list', 'main', 'sidebar', 'text', 'text', 'text'].sort());
    expect(by('사이드바')).toMatchObject({ x: 1000, y: 60, w: 280 });
    expect(by('약관 동의')).toMatchObject({ kind: 'checkbox', x: 1010 });
    expect(by('상품 설명')).toMatchObject({ kind: 'text' });
    expect(out.some((e) => e.label === '상품')).toBe(false);
    expect(by('✓주문')).toMatchObject({ kind: 'button', api: { method: 'POST', path: '/api/orders' } });
    expect(by('취소').api).toBeUndefined();
    expect(by('내 정보').api).toMatchObject({ method: 'GET', path: '/api/me' });
    expect(out.some((e) => e.label === '숨김' || e.label === '✓')).toBe(false);
  });
});

describe('긴 페이지 나누기', () => {
  it('틀 높이마다 한 장, 상자는 위쪽 끝이 있는 장에, 넘치는 부분은 자름', () => {
    const f = DEVICES.mobile;
    const pages = paginate([
      { kind: 'header', label: 'h', x: 0, y: 0, w: 390, h: 60 },
      { kind: 'button', label: 'a', x: 20, y: 800, w: 120, h: 80 },
      { kind: 'button', label: 'b', x: 20, y: 900, w: 500, h: 40 },
      { kind: 'text', label: 'far', x: 400, y: 10, w: 50, h: 20 },
    ], f, '홈');
    expect(pages.map((p) => p.name)).toEqual(['홈 (1/2)', '홈 (2/2)']);
    expect(pages[0].items.map((i) => [i.label, i.y, i.h])).toEqual([['h', 0, 60], ['a', 800, 44]]);
    expect(pages[1].items[0]).toMatchObject({ label: 'b', y: 56, w: 370 });
    expect(paginate([], f, '빈')).toEqual([{ name: '빈', items: [] }]);
  });
});
