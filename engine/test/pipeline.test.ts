import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { backlogDay } from '../pipeline';
import type { Project } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// global-commerce: api → Kafka(N-04, 파티션 24) → 정산 워커(N-05, 6대 × 4, 40ms) / 레이크하우스(N-10, 60분마다 배치)
// 자동 확장을 끈 고정 6대 워커로 본다 (자동 확장은 따로 시험)
const gc = loadProject(root('examples/global-commerce.json'), catalog.items);
const base: Project = { ...gc, nodes: gc.nodes.map((n) => (n.id === 'N-05' ? { ...n, autoscale: undefined, min_instances: 6 } : n)) };
const run = (p: Project) => analyze(p, d, '2026-10-25');
const node = (p: Project, id: string, patch: Partial<Project['nodes'][number]>): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
const flow = (a: ReturnType<typeof run>, to: string) => a.pipeline.find((f) => f.to === to)!;
const primaryOf = (a: ReturnType<typeof run>, id: string) => a.judgements.find((j) => j.nodeId === id)!.items[0];

describe('하루 적체 계산', () => {
  it('처리량보다 많이 들어오는 시간에만 쌓이고, 남는 시간에 빠짐', () => {
    // 22시간은 50건/초, 2시간은 150건/초, 처리량 100건/초 → 2시간 동안 50 × 7200 = 36만 건 쌓임
    const lambda = [...Array(22).fill(50), 150, 150];
    const r = backlogDay(lambda, 100, 0);
    expect(r.backlog).toBeCloseTo(360000);
    expect(r.lag).toBeCloseTo(3600);
  });
  it('하루 평균 도착이 처리량 이상이면 끝없이 늘어남', () => {
    expect(backlogDay(Array(24).fill(100), 100, 0).lag).toBe(Infinity);
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

  it('실행 창을 1분으로 줄이면 평소에도 안 끝나 안 됨', () => {
    const j = primaryOf(run(node(base, 'N-10', { batch: { every_min: 60, window_min: 1 } })), 'N-10');
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toContain('실행 창');
  });
});
