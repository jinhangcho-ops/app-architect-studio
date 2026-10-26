// 감사 4: 대당 처리량(perf), 늘 떠 있는 대수(가용성·단일 장애점·존 장애), 한계 사용자를 모를 때 최선 조합 조건
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { parseProject } from '../data';
import { loadCatalog, loadPrices, loadProject } from '../io';
import { optimize } from '../optimize';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')) };
const today = '2026-10-27';
const proj = (users: number, api: object, extra: object = {}) => parseProject({
  name: 't', cost: { region: 'aws:ap-northeast-2' }, scale: { users }, personas: [{ name: 'a', share: 1, pattern: 'regular' }],
  nodes: [{ id: 'web', name: 'web', layer: 'ui' }, { id: 'api', name: 'api', layer: 'backend', ...api }], edges: [{ from: 'web', to: 'api' }], ...extra,
}, catalog.items);

describe('대당 처리량 = min(보정 rps, workers × 1000 / 처리 ms) (K2)', () => {
  it('처리 20ms × 4 workers = 200건/초가 카탈로그 500보다 작으면 대수·사용률·p99·판정이 모두 200을 씀', () => {
    const a = analyze(proj(300000, { primary: 'api_single', perf: { service_ms: 20, workers: 4 } }), d, today);
    const n = a.nodes.api;
    expect(n.perInstanceRps!.value).toBe(200);
    // 1대 고정(api_single)이라 사용률 = 부하 / 200, p99 대기열의 ρ와 같은 값
    expect(n.utilization!.normal.value).toBeCloseTo(n.load!.rps.normal / 200, 9);
    expect(n.utilization!.normal.value).toBeCloseTo(n.p99!.normal.inputs.ρ, 9);
    expect(n.utilization!.normal.value).toBeGreaterThan(1);
    expect(a.judgements.find((j) => j.nodeId === 'api')!.items[0].verdict).toBe('fail');
    // 한계 사용자는 지금 사용자보다 작다
    expect(n.limitUsers!.value).toBeLessThan(300000);
  });

  it('자동 확장 패턴은 대수 = ceil(부하 / (200 × 목표 사용률))', () => {
    const a = analyze(proj(300000, { primary: 'api_autoscale', perf: { service_ms: 20, workers: 4 } }), d, today);
    const n = a.nodes.api;
    expect(n.instances!.normal.value).toBe(Math.max(1, Math.ceil(n.load!.rps.normal / (200 * 0.7))));
  });

  it('perf가 카탈로그보다 크면 카탈로그 값 그대로', () => {
    const a = analyze(proj(1000, { primary: 'api_single', perf: { service_ms: 5, workers: 8 } }), d, today);
    expect(a.nodes.api.perInstanceRps!.value).toBe(500);
  });
});

describe('늘 떠 있는 대수 (K7·K10)', () => {
  it('자동 확장 최소 3대는 단일 장애점이 아니고 가용성도 3대로 셈', () => {
    const a = analyze(proj(1000, { primary: 'api_autoscale', min_instances: 3 }), d, today);
    expect(a.spof).toEqual([]);
    expect(a.nodes.api.availability.value).toBeCloseTo(1 - 0.001 ** 3, 12);
  });

  it('최대 1대 패턴에 최소 3대를 넣어도 용량 대수(1대)와 같게: 단일 장애점, 존 장애에 멈춤', () => {
    const a = analyze(proj(100000, { primary: 'api_single', min_instances: 3, zones: 3 }, { recovery: { survive: 'zone' } }), d, today);
    expect(a.nodes.api.instances!.normal.value).toBe(1);
    expect(a.spof).toEqual(['api']);
    expect(a.nodes.api.availability.value).toBeCloseTo(0.999, 12);
    const z = a.failure!.zone.find((x) => x.nodeId === 'api')!;
    expect(z).toMatchObject({ servers: 1, lost: 1, down: true });
  });
});

describe('한계 사용자를 모르면 "목표 한계 사용자"를 통과시키지 않음 (K8)', () => {
  it('규모가 없어 한계를 계산할 수 없는 조합은 모두 조건 위반', () => {
    const base = loadProject(root('examples/phase3.json'), catalog.items);
    const r = optimize({ ...base, scale: undefined, optimize: { priorities: [], min_limit_users: 1 } }, d, today, { perNode: 1 });
    expect(r.best).toBeUndefined();
    expect(r.evaluated.every((x) => x.violations.includes('한계 사용자'))).toBe(true);
  });

  it('항목이 없어 한계를 계산할 노드가 없으면 모름(통과 안 함), 계산한 노드가 모두 100만 배를 버티면 무한(통과) (리뷰 4 L2)', () => {
    const goal = { optimize: { priorities: [], min_limit_users: 1e12 } };
    const none = optimize(proj(1000, {}, goal), d, today).current;
    expect(none.metrics.limitUsers).toBeUndefined();
    expect(none.violations).toContain('한계 사용자');
    const big = analyze(proj(1, { primary: 'api_autoscale' }, goal), d, today);
    expect(big.bottleneck).toBeUndefined();
    expect(big.nodes.api.limitUsers).toBeUndefined();
    const cur = optimize(proj(1, { primary: 'api_autoscale' }, goal), d, today).current;
    expect(cur.metrics.limitUsers).toBe(Infinity);
    expect(cur.violations).not.toContain('한계 사용자');
  });
});

describe('리뷰 4: 비용 하한, 실측 rps 자름', () => {
  it('최대 1대 패턴(api_single)에 이중화 2를 넣어도 비용은 1대 (L3)', () => {
    const cost = (replicas: number) => analyze(proj(1000, { primary: 'api_single', replicas }), d, today).cost!.parts.api.value;
    expect(cost(2)).toBe(cost(1));
  });

  it('실측 rps가 처리 시간으로 잘리면 기준은 실측이 아니고, 같은 값이 inputs에 두 번 나오지 않음 (L5)', () => {
    const per = analyze(proj(1000, { primary: 'api_autoscale', perf: { service_ms: 20, workers: 4 }, measured: { rps: 1000 } }), d, today).nodes.api.perInstanceRps!;
    expect(per.value).toBe(200);
    expect(per.basis).toBeUndefined();
    expect(per.inputs).toEqual({ measured: 1000, workers: 4, 처리ms: 20 });
  });
});
