import { describe, expect, it } from 'vitest';
import { CatalogItem, Project, checkCatalog, checkProject } from '../schema';

const item = {
  id: 'x', name: 'X', area: '서비스', role: '주', kind: '도구', attaches_to: ['db'], goals: {}, sources: ['s'],
};

describe('카탈로그·프로젝트 검증', () => {
  it('해석할 수 없는 조건식은 읽을 때 거부', () => {
    expect(CatalogItem.safeParse({ ...item, fails_when: [{ if: 'a >', why: 'w' }] }).success).toBe(false);
  });

  it('사양 보정을 하려면 base_spec에 해당 자원이 있어야 함', () => {
    const th = { value: 1, unit: 'u', bound_by: 'vcpu', base_spec: { memGb: 4 }, source: 's' };
    expect(CatalogItem.safeParse({ ...item, thresholds: { t: th } }).success).toBe(false);
  });

  it('없는 대안·없는 항목·맞지 않는 레이어를 찾아냄', () => {
    const it1 = CatalogItem.parse({ ...item, alternatives: [{ id: 'nope', better_for: [] }] });
    expect(checkCatalog([it1])).toEqual(['x: 없는 대안 nope']);
    const p = Project.parse({ name: 'p', nodes: [{ id: 'a', name: 'A', layer: 'ui', primary: 'x', extras: ['y'] }] });
    expect(checkProject(p, [it1])).toEqual(['a: x는 ui 노드에 붙일 수 없음', 'a: 없는 카탈로그 항목 y']);
  });
});
