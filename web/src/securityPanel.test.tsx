// @vitest-environment happy-dom
// 네트워크·보안: 노드·연결선 패널 칸 → 저장·점검 결과, 캔버스 구역 틀 계산
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { run } from './edit';
import { EdgePanel, NodePanel } from './NodePanel';
import { useStore } from './store';
import { zoneAt, zoneRects } from './zones';

const ledger = () => { const ex = examples.find((e) => e.name === 'ledger-fastapi.json')!; return parseProject(ex.data, catalog.items, ex.name); };
const state = () => useStore.getState().project;
/** 집 Select(버튼 + 목록)에서 고르기 */
const choose = (el: Element, label: string, option: string) => {
  flushSync(() => (el.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement).click());
  flushSync(() => ([...document.querySelectorAll('.select-list [role="option"]')].find((o) => o.textContent === option) as HTMLElement).click());
};

describe('네트워크·보안 패널', () => {
  it('노드: 레이어에 맞는 칸만 보이고, 고르면 저장되며 점검 결과가 패널에 나옴. 미정으로 되돌리면 security가 지워짐', () => {
    useStore.setState({ project: ledger(), past: [], future: [] });
    const el = document.createElement('div'); document.body.append(el);
    const root = createRoot(el);
    const render = () => flushSync(() => root.render(<NodePanel id="D-01" analysis={run(state(), '2026-10-28').analysis} />));
    render();
    const labels = [...el.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'));
    // DB 노드 (store_id 컬럼 → 테넌트 분리도), WAF·속도 제한은 공개일 때만
    expect(labels).toEqual(expect.arrayContaining(['공개 범위', 'TLS', '저장 암호화', '테넌트 분리']));
    expect(labels).not.toContain('WAF');
    expect(el.textContent).toContain('보안 값 미정: 공개 범위·TLS·저장 암호화·테넌트 분리');

    choose(el, '공개 범위', '인터넷 공개'); render();
    expect(state().nodes.find((n) => n.id === 'D-01')!.security).toEqual({ exposure: 'public' });
    expect(el.textContent).toContain('인터넷에 열려 있어');
    choose(el, '공개 범위', '미정'); render();
    expect(state().nodes.find((n) => n.id === 'D-01')!.security).toBeUndefined();
    root.unmount(); el.remove();
  });

  it('연결선: 암호화·지나는 망, 비우면 짐작한 망을 안내하고 암호화 없음은 ❌', () => {
    useStore.setState({ project: ledger(), past: [], future: [] });
    const el = document.createElement('div'); document.body.append(el);
    const root = createRoot(el);
    const render = () => flushSync(() => root.render(<EdgePanel from="U-01" to="B-01" analysis={run(state(), '2026-10-28').analysis} />));
    render();
    expect(el.textContent).toContain('비우면 "인터넷"으로 짐작해요');
    choose(el, '암호화', '암호화 없음'); render();
    expect(state().edges.find((e) => e.from === 'U-01' && e.to === 'B-01')!.security).toEqual({ tls: 'none' });
    expect(el.textContent).toContain('❌');
    root.unmount(); el.remove();
  });
});

describe('캔버스 구역 틀', () => {
  const p = ledger();
  const sec = { 'B-01': 'public', 'D-01': 'private', 'J-01': 'internal' } as const;
  const nodes = p.nodes.map((n) => (n.id in sec ? { ...n, security: { exposure: sec[n.id as keyof typeof sec] } } : n));
  const pos = { 'U-01': { x: 0, y: 0 }, 'B-01': { x: 300, y: 0 }, 'D-01': { x: 600, y: 0 }, 'X-01': { x: 600, y: 200 }, 'J-01': { x: 0, y: 300 } };

  it('공개 범위마다 그 노드들을 감싸는 틀 (화면·외부 서비스는 넣지 않음)', () => {
    expect(zoneRects(nodes, pos)).toEqual([
      { zone: 'public', x: 276, y: -44, w: 248, h: 160 },
      { zone: 'internal', x: -24, y: 256, w: 248, h: 160 },
      { zone: 'private', x: 576, y: -44, w: 248, h: 160 },
    ]);
  });

  it('놓은 자리의 구역: 끄는 노드는 빼고 계산, 틀 밖이면 없음, 겹치면 안쪽 틀', () => {
    // J-01을 B-01 옆(공개 틀 안)으로
    expect(zoneAt(zoneRects(nodes, pos, 'J-01'), { x: 400, y: 50 })).toBe('public');
    // 자기 틀만 있던 노드를 끌면 자기 틀은 사라져 빈 곳이 됨
    expect(zoneAt(zoneRects(nodes, pos, 'J-01'), { x: 100, y: 350 })).toBeUndefined();
    const big = { zone: 'internal' as const, x: 0, y: 0, w: 1000, h: 1000 }, small = { zone: 'private' as const, x: 100, y: 100, w: 100, h: 100 };
    expect(zoneAt([big, small], { x: 150, y: 150 })).toBe('private');
  });
});
