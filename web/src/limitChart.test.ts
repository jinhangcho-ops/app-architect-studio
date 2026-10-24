import { describe, expect, it } from 'vitest';
import { parseProject } from '../../engine/data';
import { catalog, examples } from './data';
import { run } from './edit';
import { limitSeries } from './Overview';

const today = '2026-10-24';
const ex = examples.find((e) => e.name === 'phase3.json')!;
const p = parseProject(ex.data, catalog.items, ex.name);
const a = run(p, today).analysis!;
const users = p.scale!.users;

describe('한계 그래프 곡선', () => {
  it('지금 사용자 수에서는 엔진의 이벤트 피크 사용률·p99와 같은 값', () => {
    for (const kind of ['util', 'p99'] as const) {
      const lines = limitSeries(p, a, catalog.byId, [users], kind);
      expect(lines.length).toBeGreaterThan(0);
      for (const l of lines) {
        const na = a.nodes[l.id];
        const want = kind === 'util' ? na.utilization!.event.value : na.p99!.event.value;
        expect(l.pts[0][1]).toBeCloseTo(want, 6);
      }
    }
  });

  it('사용률은 대수가 늘 때 꺾여 내려가고(직선이 아님), p99는 갈수록 가파르게 오름', () => {
    const xs = Array.from({ length: 400 }, (_, i) => (users * 20 * (i + 1)) / 400);
    const util = limitSeries(p, a, catalog.byId, xs, 'util');
    expect(util.some((l) => l.pts.some(([, v], i) => i > 0 && v < l.pts[i - 1][1] - 1e-9))).toBe(true);
    const p99 = limitSeries(p, a, catalog.byId, xs, 'p99');
    // 유한한 구간에서 기울기가 커진다 (볼록)
    const curved = p99.some((l) => {
      const f = l.pts.filter(([, v]) => Number.isFinite(v));
      const slope = (i: number) => (f[i + 1][1] - f[i][1]) / (f[i + 1][0] - f[i][0]);
      return f.length > 10 && slope(f.length - 2) > slope(0) * 1.5;
    });
    expect(curved).toBe(true);
  });
});
