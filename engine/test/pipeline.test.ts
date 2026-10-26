import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { autoscaleDay, type AutoscaleOpts } from '../pipeline';
import { Scale, type Project } from '../schema';
import { spikeFactors } from '../traffic';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// global-commerce: api → Kafka(N-04, 파티션 24) → 정산 워커(N-05, 6대 × 4, 40ms) / 레이크하우스(N-10, 60분마다 배치)
// 자동 확장을 끈 고정 6대 워커로 본다 (자동 확장은 따로 시험)
// 큐로 가는 연결선의 인터페이스 명세(주문 생성됨: 쓰기 요청에서만)를 빼, 모든 요청이 큐로 가는 예전 부하로 파이프라인 계산만 본다
const loaded = loadProject(root('examples/global-commerce.json'), catalog.items);
const gc: Project = { ...loaded, edges: loaded.edges.map((e) => (e.to === 'N-04' ? { ...e, interfaces: [] } : e)) };
const base: Project = { ...gc, nodes: gc.nodes.map((n) => (n.id === 'N-05' ? { ...n, autoscale: undefined, min_instances: 6 } : n)) };
const run = (p: Project) => analyze(p, d, '2026-10-25');
const node = (p: Project, id: string, patch: Partial<Project['nodes'][number]>): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
const flow = (a: ReturnType<typeof run>, to: string) => a.pipeline.find((f) => f.to === to)!;
const primaryOf = (a: ReturnType<typeof run>, id: string) => a.judgements.find((j) => j.nodeId === id)!.items[0];

describe('하루 적체 계산 (고정 대수)', () => {
  // 처리 1초 · 대당 1건 · 100대 고정 → 처리량 100건/초
  const fixed: AutoscaleOpts = { serviceMs: 1000, workers: 1, cap: Infinity, u: 0.7, min: 100, max: 100, delayS: 0, pollS: 30, cooldownS: 0 };
  const perMin = (hourly: number[]) => hourly.flatMap((x) => Array<number>(60).fill(x));
  it('처리량보다 많이 들어오는 시간에만 쌓이고, 남는 시간에 빠짐', () => {
    // 22시간은 50건/초, 2시간은 150건/초 → 2시간 동안 50 × 7200 = 36만 건 쌓이고, 빼는 데 3600초 + 1건 처리 1초
    const r = autoscaleDay(perMin([...Array(22).fill(50), 150, 150]), fixed);
    expect(r.backlog).toBeCloseTo(360000);
    expect(r.lag).toBeCloseTo(3601);
  });
  it('하루 평균 도착이 처리량 이상이면 끝없이 늘어남', () => {
    expect(autoscaleDay(perMin(Array(24).fill(100)), fixed).lag).toBe(Infinity);
  });
});

describe('큐 → 소비자', () => {
  it('예시: 파티션 24·워커 6대 × 4면 이벤트 피크도 쌓이지 않음', () => {
    const f = flow(run(base), 'N-05');
    expect(f.capacity!.value).toBe(600);
    expect(f.backlog!.event.value).toBe(0);
    expect(primaryOf(run(base), 'N-05').verdict).toBe('ok');
  });

  it('파티션이 12면 워커를 늘려도 처리량이 300에서 멈추고, 이벤트 때 허용 지연(60초)을 넘어 조건부', () => {
    const p = node(base, 'N-04', { partitions: 12 }), a = run(p), f = flow(a, 'N-05');
    expect(f.capacity!.value).toBe(300);
    expect(run(node(p, 'N-05', { min_instances: 20 })).pipeline.find((x) => x.to === 'N-05')!.capacity!.value).toBe(300);
    expect(f.lag!.event.value).toBeGreaterThan(60);
    const j = primaryOf(a, 'N-05');
    expect(j.verdict).toBe('conditional');
    expect(j.reasons[0]).toContain('이벤트 피크에 큐 지연');
  });

  it('평소에도 따라잡지 못하면 안 됨 (적체가 끝없이 늚)', () => {
    const a = run(node(base, 'N-05', { min_instances: 1, perf: { service_ms: 40, workers: 1 } }));
    expect(flow(a, 'N-05').lag!.normal.value).toBe(Infinity);
    const j = primaryOf(a, 'N-05');
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toContain('끝없이');
  });

  it('처리 시간을 모르면 지연을 계산하지 않고 판정도 그대로', () => {
    const a = run(node(base, 'N-05', { perf: undefined }));
    expect(flow(a, 'N-05').lag).toBeUndefined();
    expect(primaryOf(a, 'N-05').verdict).toBe('ok');
  });

  it('한계 사용자는 실제로 지연이 허용을 넘기 시작하는 곳', () => {
    const a = run(base), lim = a.nodes['N-05'].limitUsers!.value / base.scale!.users;
    const users = (x: number) => ({ ...base, scale: { ...base.scale!, users: base.scale!.users * x } });
    expect(primaryOf(run(users(lim * 0.97)), 'N-05').verdict).toBe('ok');
    expect(primaryOf(run(users(lim * 1.05)), 'N-05').verdict).not.toBe('ok');
  });
});

describe('배치', () => {
  it('1회 실행 = 주기 동안 들어온 양 / 처리량, 신선도 = 주기 + 실행', () => {
    const f = flow(run(base), 'N-10');
    expect(f.kind).toBe('batch');
    expect(f.limit).toBe(30 * 60);
    expect(f.lag!.normal.value).toBeCloseTo(3600 + f.run!.normal.value);
  });

  it('1회 양은 하루 평균이 아니라 주기 길이 창의 가장 큰 합: 60분 주기 ≈ 피크 1시간 양, 하루 주기는 하루 합 (감사 4 K3)', () => {
    const f = flow(run(loaded), 'N-10');
    // 피크 도착 40.006건/초 × 3600 ≈ 144,022건 (1분 기대 곡선이라 무작위 하루의 피크 시간과 조금 다름)
    expect(f.run!.normal.inputs.건수 / (f.arrival.normal * 3600)).toBeCloseTo(1, 1);
    const day = flow(run(node(loaded, 'N-10', { batch: { every_min: 1440 } })), 'N-10'), half = flow(run(node(loaded, 'N-10', { batch: { every_min: 30 } })), 'N-10');
    // 하루 주기 양 = 하루 합, 30분 주기 양은 60분의 절반 이상 (피크 근처라 평균보다 큼)
    expect(day.run!.normal.inputs.건수).toBeGreaterThan(f.run!.normal.inputs.건수 * 12);
    expect(half.run!.normal.inputs.건수).toBeGreaterThan(f.run!.normal.inputs.건수 / 2);
    expect(half.run!.normal.inputs.건수).toBeLessThan(f.run!.normal.inputs.건수);
  });

  it('실행 창을 1분으로 줄이면 평소에도 안 끝나 안 됨', () => {
    const j = primaryOf(run(node(base, 'N-10', { batch: { every_min: 60, window_min: 1 } })), 'N-10');
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toContain('실행 창');
  });
});

describe('소비자 자동 확장 (KEDA처럼)', () => {
  const auto = run(gc), af = flow(auto, 'N-05');
  // 처리 1초 · 대당 1건 · 목표 사용률 0.5 → 도착 x건/초면 2x대가 필요
  const o: AutoscaleOpts = { serviceMs: 1000, workers: 1, cap: Infinity, u: 0.5, min: 1, max: 100, delayS: 0, pollS: 10, cooldownS: 0 };
  const step = (lo: number, hi: number, from: number, to: number) => Array.from({ length: 1440 }, (_, i) => (i >= from && i < to ? hi : lo));

  it('대수는 트래픽에 따라 분 단위로 바뀌고, 1시간 평균 대수가 비용', () => {
    // 10시 30분부터 15분만 10건/초, 나머지 1건/초 → 그 15분만 20대, 나머지 2대
    const r = autoscaleDay(step(1, 10, 630, 645), o);
    expect([r.min, r.max]).toEqual([2, 20]);
    expect(Math.abs(r.hourly[10] - (2 + (18 * 15) / 60))).toBeLessThan(0.2);
    expect(r.hourly[11]).toBeCloseTo(2);
  });

  it('늘리는 시간(예시값) 동안은 이전 대수로 받아 적체가 생김', () => {
    // 1 → 10건/초로 뛰면 늘린 18대가 뜨는 60초 동안 2대(2건/초)로 받아 (10 − 2) × 60 = 480건 쌓이고, 20건/초로 빼도 24초 지연
    const r = autoscaleDay(step(1, 10, 630, 645), { ...o, delayS: 60 });
    expect(r.backlog).toBeGreaterThanOrEqual(480);
    expect(r.lag).toBeGreaterThanOrEqual(24);
    expect(autoscaleDay(step(1, 10, 630, 645), o).backlog).toBeLessThan(r.backlog / 1.5);
  });

  it('cooldown 동안은 줄이지 않아, 몰림이 끝나도 그만큼 더 떠 있어 비용이 늚', () => {
    const quick = autoscaleDay(step(1, 10, 630, 645), o), slow = autoscaleDay(step(1, 10, 630, 645), { ...o, cooldownS: 600 });
    // 20대가 10분 더 떠 있음 → 10시 평균이 (18대 × 10분 / 60) 더 큼
    expect(Math.abs(slow.hourly[10] - quick.hourly[10] - (18 * 10) / 60)).toBeLessThan(0.2);
  });

  it('최소 0대면 한가할 때 끄고, 첫 메시지는 새 소비자가 뜰 때까지 기다림', () => {
    const r = autoscaleDay(step(0, 5, 600, 610), { ...o, min: 0, delayS: 30 });
    expect(r.min).toBe(0);
    expect(r.lag).toBeGreaterThanOrEqual(30);
  });

  it('최대 대수에 막혀 하루에 다 못 빼면 끝없이 늚', () => {
    expect(autoscaleDay(Array(1440).fill(20), { ...o, max: 10 }).lag).toBe(Infinity);
  });

  it('예시: 사용자 패턴에서 대수가 나오고, 비용은 시간대별 평균 대수 × 30일', () => {
    expect(af.auto!.normal.min).toBeLessThan(af.auto!.normal.max);
    expect(af.auto!.event.max).toBe(6);
    expect(auto.nodes['N-05'].instances!.event.value).toBe(6);
    const qty = Object.entries(auto.cost!.parts['N-05'].inputs).find(([k]) => k.endsWith('수량'))![1];
    expect(qty).toBeCloseTo(af.auto!.normal.hourly.reduce((a, x) => a + x, 0) * 30);
    expect(auto.cost!.parts['N-05'].value).toBeLessThan(run(base).cost!.parts['N-05'].value);
    const calm = run({ ...gc, scale: { ...gc.scale!, event_multiplier: 1 } });
    expect(flow(calm, 'N-05').auto!.event.max).toBeLessThan(6);
  });
});

describe('계산 단위시간과 일시적 급증', () => {
  // 워커 2대 × 4 · 44ms → 처리량 182건/초. 평소 피크 176건/초라 급증이 피크 근처에 오면 쌓인다
  const tight = (scale: Partial<Project['scale']>) => {
    const p = { ...gc, nodes: gc.nodes.map((n) => (n.id === 'N-05' ? { ...n, autoscale: undefined, min_instances: 2, perf: { service_ms: 44, workers: 4 } } : n)), scale: { ...gc.scale!, ...scale } };
    return flow(run(p as Project), 'N-05').backlog!.normal.value;
  };
  const many = { count: 48, duration_min: 30, height: 1.2 };

  it('급증은 시드로 같은 시각, 산 모양이고 겹쳐도 높이를 넘지 않음', () => {
    const f = spikeFactors(many, 1);
    expect(f).toEqual(spikeFactors(many, 1));
    expect(Math.max(...f)).toBeLessThanOrEqual(1.2);
    expect(Math.max(...f)).toBeGreaterThan(1.15);
    expect(Math.min(...f)).toBe(1);
    expect(spikeFactors(many, 2)).not.toEqual(f);
  });

  it('급증 높이는 1.5배까지만 받음 (갑자기 두 배는 안 됨)', () => {
    expect(Scale.safeParse({ users: 1, spikes: { height: 2 } }).success).toBe(false);
    expect(Scale.safeParse({ users: 1, spikes: { height: 1.5 } }).success).toBe(true);
  });

  it('급증을 켜면 평소에 없던 적체가 생기고, 계산 단위가 짧을수록 몰림이 덜 뭉개져 적체가 큼', () => {
    expect(tight({})).toBe(0);
    const hour = tight({ spikes: many, queue_step_min: 60 }), minute = tight({ spikes: many, queue_step_min: 1 });
    expect(hour).toBeGreaterThan(0);
    expect(minute).toBeGreaterThan(hour);
  });
});
