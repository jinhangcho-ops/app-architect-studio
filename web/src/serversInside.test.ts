import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { run, updateNode } from './edit';
import { serverLayout } from './ServersInside';

const today = '2026-10-24';
const ex = examples.find((e) => e.name === 'global-commerce.json')!;
const p0 = parseProject(ex.data, catalog.items, ex.name);
const a0 = run(p0, today).analysis!;

describe('세부 구성 (서버 구성)', () => {
  it('대수·사용률·한계는 엔진 계산값, 들어오고 나가는 곳은 연결선', () => {
    const s = serverLayout(p0, a0, catalog.byId, 'N-03');
    const na = a0.nodes['N-03'];
    expect(s.knob).toBe('min_instances');
    expect(s.count).toBe(na.instances!.event.value);
    expect(s.util).toBe(na.utilization!.event.value);
    expect(s.limitUsers).toBe(na.limitUsers?.value);
    const name = (id: string) => p0.nodes.find((n) => n.id === id)!.name;
    expect(s.inbound).toEqual(p0.edges.filter((e) => e.to === 'N-03').map((e) => name(e.from)));
    expect(s.outbound).toEqual(p0.edges.filter((e) => e.from === 'N-03').map((e) => name(e.to)));
    expect(s.methods.map((m) => m.id)).toContain(p0.nodes.find((n) => n.id === 'N-03')!.primary);
  });

  it('최소 대수를 늘리면 대수가 늘고 대마다 사용률이 내려감', () => {
    const s0 = serverLayout(p0, a0, catalog.byId, 'N-03');
    const p1 = updateNode(p0, 'N-03', { min_instances: s0.count + 2 });
    const s1 = serverLayout(p1, run(p1, today).analysis!, catalog.byId, 'N-03');
    expect(s1.count).toBe(s0.count + 2);
    expect(s1.util!).toBeLessThan(s0.util!);
  });

  it('모든 블록이 세부 구성을 그릴 값을 가짐', () => {
    for (const n of p0.nodes) {
      const s = serverLayout(p0, a0, catalog.byId, n.id);
      expect(s.count).toBeGreaterThanOrEqual(1);
      expect(s.max).toBeGreaterThanOrEqual(1);
    }
  });
});
