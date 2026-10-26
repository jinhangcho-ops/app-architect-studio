// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { addWire, bindApi } from './edit';
import { EdgePanel, NodePanel } from './NodePanel';
import { LAYER_NAMES } from '../../engine/model';
import { useStore } from './store';

describe('연결선 패널', () => {
  it('화면 와이어프레임 호출이 부하를 정하면 호출 비율·흐르는 요청 칸을 잠금', () => {
    const ex = examples.find((e) => e.name === 'global-commerce.json')!;
    const p0 = parseProject(ex.data, catalog.items, ex.name);
    const ui = p0.nodes.find((n) => n.layer === 'ui')!.id;
    const to = p0.edges.find((e) => e.from === ui)!.to;
    // 서버 렌더는 store의 처음 값을 읽으므로 실제 DOM에 그린다
    const html = (p: typeof p0) => {
      useStore.setState({ project: p });
      const el = document.createElement('div');
      const root = createRoot(el);
      flushSync(() => root.render(<EdgePanel from={ui} to={to} />));
      const out = el.innerHTML;
      root.unmount();
      return out;
    };
    expect(html(p0)).not.toContain('disabled');
    const p1 = bindApi(addWire(p0, ui, 0, { kind: 'button', label: 'b', x: 0, y: 0, w: 10, h: 10 }), ui, 0, 'w1', { method: 'GET', path: '/x', to, per_session: 1 });
    const out = html(p1);
    expect(out).toContain('API 호출이 이 연결의 부하를 정합니다');
    expect(out.match(/disabled/g)!.length).toBeGreaterThanOrEqual(2);
  });

  it('인터페이스 명세가 있으면 그 호출 수가 부하를 정해 호출 비율·흐르는 요청 칸을 잠금', () => {
    const ex = examples.find((e) => e.name === 'global-commerce.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    useStore.setState({ project: p });
    const el = document.createElement('div');
    const root = createRoot(el);
    flushSync(() => root.render(<EdgePanel from="N-03" to="N-09" />));
    const out = el.innerHTML;
    root.unmount();
    expect(out).toContain('인터페이스 명세 (1)');
    expect(out).toContain('인터페이스 명세의 호출 수가 이 연결의 부하를 정합니다');
    expect(out.match(/disabled/g)!.length).toBeGreaterThanOrEqual(2);
  });
});

describe('노드 패널 레이어', () => {
  it('테이블이 있는 노드는 db·cache·analytics 레이어만 고를 수 있음 (나머지는 비활성 + 이유)', () => {
    const ex = examples.find((e) => e.name === 'actions.json')!;
    const p = parseProject(ex.data, catalog.items, ex.name);
    const db = p.nodes.find((n) => n.tables.length)!;
    useStore.setState({ project: p });
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    flushSync(() => root.render(<NodePanel id={db.id} />));
    const pick = el.querySelector('button[title*="테이블"]') as HTMLButtonElement;
    expect(pick).toBeTruthy();
    flushSync(() => pick.click());
    const off = [...document.querySelectorAll('.select-list [role="option"][aria-disabled="true"]')].map((o) => o.textContent);
    expect(off).toContain(LAYER_NAMES.backend);
    expect(off).not.toContain(LAYER_NAMES.cache);
    root.unmount();
    el.remove();
  });
});
