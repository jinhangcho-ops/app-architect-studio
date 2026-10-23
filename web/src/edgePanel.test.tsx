// @vitest-environment happy-dom
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { addWire, bindApi } from './edit';
import { EdgePanel } from './NodePanel';
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
});
