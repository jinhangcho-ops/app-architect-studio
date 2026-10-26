// @vitest-environment happy-dom
// 감사 9: 지운 노드의 옛 결과를 그려도 패널이 깨지지 않음, HTML 가져오기에서 화면 밖 요소
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { DEVICES } from './wireDraw';
import { htmlToScreen } from './htmlImport';
import { paginate } from './htmlRender';
import { TableLab } from './ResultsPanel';
import { importProject, useStore } from './store';

describe('결과 패널: 지운 노드의 테이블', () => {
  it('노드가 없으면 실험 칸을 그리지 않고 오류도 없음', () => {
    const ex = examples.find((e) => e.name === 'global-commerce.json')!;
    useStore.setState({ project: parseProject(ex.data, catalog.items, ex.name), past: [], future: [] });
    const el = document.createElement('div');
    const errors: unknown[] = [];
    flushSync(() => createRoot(el, { onUncaughtError: (e) => errors.push(e) }).render(<TableLab nodeId="없는-노드" table="orders" />));
    expect(errors).toEqual([]);
    expect(el.innerHTML).toBe('');
  });
});

describe('감사 10: 파일 열기·HTML 대체 배치', () => {
  it('같은 출발·도착 연결선이 둘인 파일은 첫 줄만 남기고 알림', () => {
    const ex = examples.find((e) => e.name === 'phase3.json')!;
    const raw = JSON.parse(JSON.stringify(ex.data));
    raw.edges.push({ ...raw.edges[0], sync: !raw.edges[0].sync });
    const r = importProject(raw, 'x.json');
    expect(r.project.edges).toHaveLength(raw.edges.length - 1);
    expect(r.dropped).toContain('같은 노드 사이에 겹친 연결선 1개');
  });
  it('대체 배치가 틀보다 길면 여러 장으로 나누고, 틀 밖 요소의 API를 버리지 않음 (리뷰 11)', () => {
    const f = DEVICES.desktop;
    const forms = Array.from({ length: 8 }, (_, k) => `<form action="/api/f${k}" method="post"><input name="a${k}"><button>보내기${k}</button></form>`).join('');
    const html = `<header>${Array.from({ length: 200 }, (_, k) => `<a href="/m${k}">메뉴${k}</a>`).join('')}</header><main>${forms}<button data-api="POST /api/main-last">끝</button></main>`;
    const s = htmlToScreen(html, f);
    const pages = paginate(s.items, f, s.name);
    expect(pages.length).toBeGreaterThan(1);
    for (const it of pages.flatMap((p) => p.items)) expect(it.y + it.h).toBeLessThanOrEqual(f.h);
    const apis = (xs: { api?: { path: string } }[]) => xs.flatMap((x) => (x.api ? [x.api.path] : [])).sort();
    expect(apis(pages.flatMap((p) => p.items))).toEqual(apis(s.items));
    expect(apis(s.items)).toContain('/api/main-last');
  });
});

describe('HTML 가져오기: 화면 밖 요소', () => {
  it('위·왼쪽으로 숨긴 것과 30장보다 아래 둔 것은 빼서 빈 장을 만들지 않음', () => {
    const f = DEVICES.mobile;
    const pages = paginate([
      { kind: 'header', label: 'h', x: 0, y: 0, w: 390, h: 60 },
      { kind: 'text', label: '본문으로 건너뛰기', x: 0, y: -40, w: 100, h: 20 },
      { kind: 'text', label: 'left', x: -500, y: 10, w: 100, h: 20 },
      { kind: 'text', label: 'far', x: 0, y: f.h * 300, w: 100, h: 20 },
    ], f, '홈');
    expect(pages.map((p) => [p.name, p.items.map((i) => i.label)])).toEqual([['홈', ['h']]]);
  });
});
