import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { autoscaleDay, type AutoscaleOpts } from '../pipeline';
import type { Project, ProjectNode } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// phase3: web → lb → api(api_autoscale, backend) → db. 급증을 켜고 api에 자동 확장을 단다
const base = loadProject(root('examples/phase3.json'), catalog.items);
const spiky: Project = { ...base, scale: { ...base.scale!, spikes: { count: 12, duration_min: 4, height: 1.5 } } };
const withApi = (p: Project, patch: Partial<ProjectNode>): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'api' ? { ...n, ...patch } : n)) });
const run = (p: Project) => analyze(p, d, '2026-10-25');
const apiPick = (a: ReturnType<typeof run>) => a.judgements.find((j) => j.nodeId === 'api')!.items.find((i) => i.itemId === 'api_autoscale')!;
// 사용자 10배·목표 사용률 0.9(여유 11%)에 뜨는 시간을 길게(10분) 두면 1.5배 급증 동안 늦게 뜨는 서버로 넘친다
const slow = withApi({ ...spiky, target_utilization: 0.9, scale: { ...spiky.scale!, users: spiky.scale!.users * 10 } }, { autoscale: { delay_s: 600 } });

describe('API 서버 자동 확장 하루', () => {
  it('급증이 있고 서버가 늦게 뜨면 넘치는 시간이 나오고 판정이 조건부 이상', () => {
    const a = run(slow), x = a.nodes.api.autoscale!;
    expect(x.event.overMin.value).toBeGreaterThan(0);
    expect(x.event.overMin.unit).toBe('분');
    expect(x.event.peakUtil.value).toBeGreaterThan(1);
    expect(x.event.peakUtil.unit).toBe('비율');
    expect(x.event.max).toBeGreaterThanOrEqual(x.event.min);
    expect(a.scenarios.api.event.autoscale_over_min).toBe(x.event.overMin.value);
    expect(a.scenarios.api.event.autoscale_peak_util).toBe(x.event.peakUtil.value);
    const pick = apiPick(a);
    expect(['conditional', 'fail']).toContain(pick.verdict);
    expect(pick.reasons.some((r) => r.includes('자동 확장이 따라오기 전') && r.includes('새 서버가 뜨는 동안 요청이 밀립니다'))).toBe(true);
    // 한계 탐색은 넘침을 보지 않음(사용자 수에 단조롭지 않음): 자동 확장을 뺀 분석과 같은 한계
    expect(a.nodes.api.limitUsers!.value).toBeGreaterThan(0);
    const plain = run(withApi(slow, { autoscale: undefined }));
    expect(a.nodes.api.limitUsers!.value).toBe(plain.nodes.api.limitUsers!.value);
  });

  it('최대 대수는 항목의 최대 대수를 넘지 않고, 최소가 최대보다 크면 최대로 자름', () => {
    const per = catalog.byId.get('api_autoscale')!.thresholds!.max_instances!.value!;
    const big = run(withApi({ ...slow, scale: { ...slow.scale!, users: slow.scale!.users * 100 } }, { autoscale: { max: 100 } }));
    expect(big.nodes.api.autoscale!.event.max).toBeLessThanOrEqual(per);
    const cut = run(withApi(slow, { min_instances: 50, autoscale: { max: 5 } })).nodes.api.autoscale!;
    expect(cut.normal.min).toBe(5);
    expect(cut.normal.max).toBe(5);
    expect(cut.event.min).toBe(5);
    expect(cut.event.max).toBe(5);
  });

  it('autoscale이 없으면 결과·판정 변수가 없고 판정은 그대로', () => {
    const a = run(spiky);
    expect(a.nodes.api.autoscale).toBeUndefined();
    expect(a.scenarios.api.event.autoscale_over_min).toBeUndefined();
    expect(apiPick(a).reasons.some((r) => r.includes('자동 확장이 따라오기 전'))).toBe(false);
    expect(apiPick(a).verdict).toBe(apiPick(run(base)).verdict);
  });

  it('최소 대수를 크게 올리면 넘치지 않음', () => {
    const a = run(withApi(slow, { min_instances: 20 }));
    expect(a.nodes.api.autoscale!.normal.overMin.value).toBe(0);
    expect(a.nodes.api.autoscale!.event.overMin.value).toBe(0);
    expect(a.nodes.api.autoscale!.event.min).toBe(20);
  });

  it('비용은 시뮬레이션의 시간대별 대수를 쓴다', () => {
    const hours = (p: Project) => {
      const part = run(p).cost!.parts.api;
      return Object.entries(part.inputs).find(([k]) => k.endsWith('수량'))![1];
    };
    const fixed = hours(spiky), sim = hours(withApi(spiky, { autoscale: {} }));
    expect(sim).not.toBe(fixed);
    // 시뮬레이션의 대수는 30초 칸 평균이라 정수 대수 × 시간이 아니다
    const ax = run(withApi(spiky, { autoscale: {} })).nodes.api.autoscale!.normal;
    expect(sim).toBeLessThanOrEqual(ax.max * 24 * 730 / 24 + 1e-6);
    expect(sim).toBeGreaterThanOrEqual(ax.min * 24 * 730 / 24 - 1e-6);
  });
});

describe('autoscaleDay 넘침 시간·최대 사용률', () => {
  // 대당 10건/초 고정 1대: 한 분만 20건/초 → 30초 칸 두 개(60초) 넘침, 최대 사용률 2
  const o: AutoscaleOpts = { serviceMs: 100, workers: 1, cap: Infinity, u: 0.7, min: 1, max: 1, delayS: 0, pollS: 30, cooldownS: 0 };
  it('한 칸만 처리량의 2배', () => {
    const lam = Array<number>(1440).fill(1);
    lam[600] = 20;
    const r = autoscaleDay(lam, o);
    expect(r.overS).toBe(60);
    expect(r.peakUtil).toBe(2);
  });
  it('떠 있는 대수가 0인데 도착이 있으면 최대 사용률 Infinity', () => {
    const lam = Array<number>(1440).fill(0);
    lam[600] = 1;
    const r = autoscaleDay(lam, { ...o, min: 0, max: 5, delayS: 60 });
    expect(r.overS).toBeGreaterThan(0);
    expect(r.peakUtil).toBe(Infinity);
  });
});
