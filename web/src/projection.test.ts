import { describe, expect, it } from 'vitest';
import { Project } from '../../engine/schema';
import { project3d, worldPositions } from './projection';

describe('관문: 3D 좌표가 v2(파이썬)와 같음', () => {
  // v2 project_3d_point로 계산한 값
  const golden: [Parameters<typeof project3d>, [number, number, number]][] = [
    [[100, 50, -250, -32, 24, 1], [748.937438, 456.274914, -124.935256]],
    [[-200, -80, 260, 45, -10, 0.8], [549.873453, 324.296464, 334.219405]],
    [[0, 0, 0, 0, 0, 1], [520, 340, 0]],
    [[-3000, 0, -3000, 0, 0, 1], [-8480, 340, -3000]], // 원근 계수 하한(450) 구간
  ];
  for (const [args, want] of golden) {
    it(`project3d(${args.join(', ')})`, () => {
      const got = project3d(...args);
      got.forEach((v, i) => expect(v).toBeCloseTo(want[i], 5));
    });
  }

  it('같은 레이어 노드는 235 간격, 뒤쪽 레이어일수록 위로', () => {
    const p = Project.parse({ name: 'p', nodes: [
      { id: 'a', name: 'a', layer: 'backend' }, { id: 'b', name: 'b', layer: 'backend' }, { id: 'd', name: 'd', layer: 'db' },
    ] });
    const w = worldPositions(p);
    expect(w.b[0] - w.a[0]).toBe(235);
    expect(w.d[1]).toBeLessThan(w.a[1]);
    expect(w.d[2]).toBe(260);
  });
});
