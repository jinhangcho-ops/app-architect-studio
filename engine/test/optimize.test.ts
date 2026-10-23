import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog, loadPrices, loadProject } from '../io';
import { itemScore, optimize, weightsFrom } from '../optimize';
import type { Project } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const data = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')) };
const base = loadProject(root('examples/phase3.json'), catalog.items);
const today = '2026-10-23';
const withOpt = (o: Partial<Project['optimize']>): Project => ({ ...base, optimize: { priorities: [], ...o } });

describe('우선순위 가중치', () => {
  it('1위 = 목표 수, 마지막 = 1, 비우면 모두 1', () => {
    expect(weightsFrom(['비용', '확장성', '지연시간'], [])).toEqual({ 비용: 3, 확장성: 2, 지연시간: 1 });
    expect(weightsFrom([], ['a', 'b'])).toEqual({ a: 1, b: 1 });
  });

  it('항목 점수 = Σ 가중치 × 등급, 등급 없는 목표는 보통', () => {
    const sqlite = catalog.byId.get('sqlite')!; // 메모리 좋음, 동시성 나쁨
    expect(itemScore(sqlite, { 메모리: 3, 동시성: 2, 없는목표: 1 })).toBe(3 * 2 + 2 * 0 + 1 * 1);
  });
});

describe('관문: 최선 조합', () => {
  it('빔이 좁아도 전수 조사와 같은 최선 점수 (조건 없음)', () => {
    const exhaustive = optimize(base, data, today, { beam: 100_000, perNode: 2 });
    const narrow = optimize(base, data, today, { beam: 5, perNode: 2 });
    expect(narrow.best!.score).toBe(Math.max(...exhaustive.evaluated.filter((x) => !x.violations.length).map((x) => x.score)));
  });

  it('우선순위를 바꾸면 최선안이 바뀜', () => {
    const cost = optimize(withOpt({ priorities: ['비용'] }), data, today).best!.assignment;
    const scale = optimize(withOpt({ priorities: ['확장성', '가용성'] }), data, today).best!.assignment;
    expect(cost).not.toEqual(scale);
  });

  it('후보는 지금 항목과 같은 종류끼리만 (게이트웨이 알고리즘 자리에 도구가 오지 않음)', () => {
    for (const x of optimize(base, data, today).evaluated) expect(catalog.byId.get(x.assignment.lb)!.kind).toBe('알고리즘');
  });

  it('지금 설계는 늘 비교 대상에 들어감', () => {
    const current = Object.fromEntries(base.nodes.filter((n) => n.primary).map((n) => [n.id, n.primary]));
    expect(optimize(base, data, today, { beam: 1 }).evaluated.some((x) => JSON.stringify(x.assignment) === JSON.stringify(current))).toBe(true);
  });

  it('답이 없으면 최선안이 없고, 풀어야 할 조건과 양을 알려줌', () => {
    const r = optimize(withOpt({ budget_monthly: 100 }), data, today);
    expect(r.best).toBeUndefined();
    expect(r.relax[0]).toMatch(/^예산을 월 [\d,]+만큼 늘리면 가능$/);
  });

  it('최대 확장안은 한계를 아는 조합 중 한계가 가장 큰 것', () => {
    const r = optimize(base, data, today);
    const known = r.evaluated.filter((x) => !x.violations.length && x.metrics.limitUsers !== undefined).map((x) => x.metrics.limitUsers!);
    expect(r.scalable!.metrics.limitUsers).toBe(Math.max(...known));
  });

  it('조건을 어긴 조합은 이유가 남음 (p99 상한 1ms)', () => {
    const r = optimize(withOpt({ max_p99_ms: 1 }), data, today);
    expect(r.evaluated.every((x) => x.violations.includes('p99'))).toBe(true);
  });
});
