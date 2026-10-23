// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { checkProject } from '../../engine/schema';
import { catalog, examples } from './data';
import { addEdge, addWire, bindApi, removeEdge, removeNode, run } from './edit';
import { htmlToScreen } from './htmlImport';
import { drawOrder, drawScreen, frameOf, type Ctx } from './wireDraw';

const today = '2026-10-24';
const ex = examples.find((e) => e.name === 'global-commerce.json')!;
const p0 = parseProject(ex.data, catalog.items, ex.name);
const ui = p0.nodes.find((n) => n.layer === 'ui')!.id;
const gw = p0.edges.find((e) => e.from === ui)!.to;
const be = p0.nodes.find((n) => n.layer === 'backend')!.id;

/** 화면에 GET(→ 게이트웨이, 3회)과 POST(→ 백엔드, 1회)를 붙인 프로젝트 */
function withCalls() {
  let p = addWire(p0, ui, 0, { kind: 'list', label: '상품 목록', x: 0, y: 0, w: 300, h: 200 });
  p = addWire(p, ui, 0, { kind: 'button', label: '주문', x: 0, y: 220, w: 120, h: 40 });
  p = bindApi(p, ui, 0, 'w1', { method: 'GET', path: '/api/products', to: gw, per_session: 3 });
  p = bindApi(p, ui, 0, 'w2', { method: 'POST', path: '/api/orders', to: be, per_session: 1 });
  return p;
}

describe('와이어프레임 API 호출 → 연결선·부하', () => {
  it('받는 블록을 고르면 화면 → 그 블록 연결선이 생김', () => {
    expect(p0.edges.some((e) => e.from === ui && e.to === be)).toBe(false);
    expect(withCalls().edges.some((e) => e.from === ui && e.to === be)).toBe(true);
  });

  it('읽기는 GET 호출로, 쓰기는 POST 호출로 나뉘어 받는 블록 부하가 됨', () => {
    const p = withCalls();
    const a = run(p, today).analysis!;
    const l = a.nodes[ui].load!;
    const reads = l.rps.normal - l.writeRps.normal;
    const a0 = run(p0, today).analysis!;
    // 게이트웨이는 화면에서 읽기만 받고, 백엔드는 화면에서 쓰기를 직접 받는다
    expect(a.api.map((c) => [c.item, c.to])).toEqual([['w1', gw], ['w2', be]]);
    expect(a.api[0].rps.value).toBeCloseTo(reads);
    expect(a.api[1].rps.value).toBeCloseTo(l.writeRps.normal);
    expect(a.nodes[gw].load!.writeRps.normal).toBe(0);
    expect(a.nodes[gw].load!.rps.normal).toBeCloseTo(reads);
    expect(a0.nodes[gw].load!.rps.normal).toBeCloseTo(l.rps.normal);
  });

  it('연결선을 지우면 그 호출은 계산에서 빠지고, 호출이 없으면 예전처럼 callRatio', () => {
    const p = removeEdge(withCalls(), ui, be);
    const a = run(p, today).analysis!;
    expect(a.api.map((c) => c.item)).toEqual(['w1']);
    // 쓰기 호출이 없으니 GET 호출이 쓰기까지 나눠 받음
    expect(a.nodes[gw].load!.rps.normal).toBeCloseTo(a.nodes[ui].load!.rps.normal);
  });

  it('받는 블록을 지우면 호출 대상이 비고, 없는 대상은 검사에서 걸림', () => {
    const p = removeNode(withCalls(), be);
    const items = p.nodes.find((n) => n.id === ui)!.wireframe!.screens[0].items;
    expect(items[1].api!.to).toBeUndefined();
    const bad = bindApi(addWire(p0, ui, 0, { kind: 'button', label: 'x', x: 0, y: 0, w: 10, h: 10 }), ui, 0, 'w1', { method: 'GET', path: '', to: 'nope', per_session: 1 });
    expect(checkProject(addEdge(bad, ui, gw), catalog.items).some((e) => e.includes('API 대상 노드 nope'))).toBe(true);
  });
});

describe('HTML → 와이어프레임', () => {
  const html = readFileSync(join(process.cwd(), 'examples/html/order_checkout.html'), 'utf8');
  const frame = frameOf('web');
  const s = htmlToScreen(html, frame);

  it('영역과 컨트롤이 틀 안에, 컨트롤은 자기 영역 안에', () => {
    expect(s.name).toBe('화이트라벨 주문/결제 화면');
    expect(s.items.filter((i) => ['header', 'nav', 'main', 'form', 'table', 'sidebar', 'footer'].includes(i.kind)).map((i) => i.kind).sort())
      .toEqual(['footer', 'form', 'header', 'main', 'nav', 'sidebar', 'table']);
    for (const i of s.items) {
      expect(i.x).toBeGreaterThanOrEqual(0);
      expect(i.x + i.w).toBeLessThanOrEqual(frame.w);
    }
    const form = s.items.find((i) => i.kind === 'form')!;
    const pay = s.items.find((i) => i.label === '결제 요청')!;
    expect(pay.x >= form.x && pay.y >= form.y && pay.x + pay.w <= form.x + form.w && pay.y + pay.h <= form.y + form.h).toBe(true);
  });

  it('폼 action은 첫 버튼에, data-api는 그 버튼에 API로 붙음', () => {
    expect(s.items.find((i) => i.label === '결제 요청')!.api).toMatchObject({ method: 'POST', path: '/api/v2/orders' });
    expect(s.items.find((i) => i.label === '현지 통화·VAT 계산')!.api).toMatchObject({ method: 'GET', path: '/api/v2/pricing' });
    expect(new Set(s.items.map((i) => i.id)).size).toBe(s.items.length);
  });
});

describe('PNG 그리기', () => {
  it('큰 상자부터 그리고 상자마다 글을 씀', () => {
    const texts: string[] = [];
    const noop = () => {};
    const ctx = { fillRect: noop, strokeRect: noop, beginPath: noop, moveTo: noop, lineTo: noop, stroke: noop, setLineDash: noop, save: noop, restore: noop, rect: noop, clip: noop, scale: noop,
      fillText: (t: string) => texts.push(t), fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textBaseline: 'top', textAlign: 'left' } as unknown as Ctx;
    const items = [
      { id: 'w1', kind: 'button' as const, label: '주문', x: 0, y: 0, w: 120, h: 40, api: { method: 'POST' as const, path: '/api/orders', per_session: 1 } },
      { id: 'w2', kind: 'main' as const, label: '본문', x: 0, y: 0, w: 800, h: 500 },
    ];
    drawScreen(ctx, { name: 's', items }, frameOf('web'));
    expect(drawOrder(items).map((i) => i.id)).toEqual(['w2', 'w1']);
    expect(texts).toEqual(['본문', '주문  ·  POST /api/orders']);
  });
});
