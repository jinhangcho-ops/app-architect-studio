import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { entryServers, type Project, type ProjectNode } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// phase3: web → lb(게이트웨이) → api → db. 게이트웨이 주 항목을 nginx(기준값 1,000 Mbps·10,000 연결)로 바꾼다
const phase3 = loadProject(root('examples/phase3.json'), catalog.items);
const patch = (p: Project, id: string, x: Partial<ProjectNode>): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...x } : n)) });
const base = patch(phase3, 'lb', { primary: 'nginx', extras: [] });
const run = (p: Project) => analyze(p, d, '2026-10-28');
const pick = (a: ReturnType<typeof run>, p: Project, id: string) =>
  a.judgements.find((j) => j.nodeId === id)!.items.find((i) => i.itemId === p.nodes.find((n) => n.id === id)!.primary)!;

describe('대역폭·동시 연결 한도 (진입 서버 노드)', () => {
  const a = run(base), lb = a.nodes.lb, N = lb.instances!;

  it('진입 노드가 하나면 그 노드 대역폭·동시 연결 = 트래픽 전체', () => {
    const t = a.traffic!;
    expect(lb.net!.mbps.event.value).toBeCloseTo(t.bandwidthMbpsEvent.value, 6);
    expect(lb.net!.mbps.normal.value * (t.peakRpsEvent.value / t.peakRps.value)).toBeCloseTo(t.bandwidthMbpsEvent.value, 6);
    expect(lb.net!.conns.normal.value).toBeCloseTo(t.concurrentPeak.value, 6);
    expect(lb.net!.conns.event.value).toBeCloseTo(t.concurrentPeakEvent.value, 6);
    expect(entryServers(base).map((n) => n.id)).toEqual(['lb']);
  });

  // 대수가 대역폭·연결로도 늘어나므로 최대 대수(nginx 20대)로도 못 받을 때만 걸린다
  it('대역폭 한도를 평소보다 낮게 → 평소 안 됨 + 문구, 이벤트에서만 넘게 → 조건부', () => {
    const mb = lb.net!.mbps;
    const low = patch(base, 'lb', { net: { max_mbps: mb.normal.value / 20 / 2 } });
    const j = pick(run(low), low, 'lb');
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toMatch(/^평소 피크에 응답 대역폭 .+ Mbps가 \d+대 한도 .+ Mbps를 넘습니다 \(대당 .+ Mbps\) — 대수·네트워크 사양을 올리거나 응답을 줄이세요\(압축·CDN\)$/);
    const mid = patch(base, 'lb', { net: { max_mbps: (mb.normal.value + mb.event.value) / 2 / 20 } });
    const k = pick(run(mid), mid, 'lb');
    expect(k.verdict).toBe('conditional');
    expect(k.reasons.some((r) => r.startsWith('이벤트 피크에 응답 대역폭'))).toBe(true);
  });

  it('동시 연결 한도를 넘으면 문구', () => {
    const low = patch(base, 'lb', { net: { max_connections: Math.floor(lb.net!.conns.normal.value / 20 / 2) } });
    const j = pick(run(low), low, 'lb');
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toMatch(/^평소 피크에 동시 연결 .+개가 \d+대 한도 .+개를 넘습니다 \(대당 .+\) — 대수나 대당 연결 한도\(worker_connections·ulimit\)를 올리세요$/);
  });

  it('카탈로그 기준값(nginx 1,000 Mbps·10,000 연결 × 대수)을 쓰고, 노드 칸이 이김', () => {
    expect(lb.net!.maxMbps!.normal.value).toBe(1000 * N.normal.value);
    expect(lb.net!.maxMbps!.event.value).toBe(1000 * N.event.value);
    expect(lb.net!.maxConns!.event.value).toBe(10000 * N.event.value);
    expect(a.scenarios.lb.normal).toMatchObject({ max_mbps_per: 1000, max_conns_per: 10000, net_instances: N.normal.value, max_mbps_total: 1000 * N.normal.value });
    const own = run(patch(base, 'lb', { net: { max_mbps: 300 } })), oN = own.nodes.lb.instances!.event.value;
    expect(own.nodes.lb.net!.maxMbps!.event.value).toBe(300 * oN);
    expect(own.nodes.lb.net!.maxConns!.event.value).toBe(10000 * oN);
  });

  it('한도가 없으면(backend 진입, 카탈로그 기준값 없음) 규칙 없음, net 결과는 있음', () => {
    const direct: Project = { ...base, nodes: base.nodes.filter((n) => n.id !== 'lb'),
      edges: [{ ...base.edges[0], to: 'api' }, ...base.edges.filter((e) => e.from !== 'web' && e.from !== 'lb')] };
    const b = run(direct), api = b.nodes.api.net!;
    expect(api.mbps.event.value).toBeGreaterThan(0);
    expect(api.maxMbps).toBeUndefined();
    expect(api.maxConns).toBeUndefined();
    expect(b.scenarios.api.event.peak_mbps).toBe(api.mbps.event.value);
    expect(b.scenarios.api.event.max_mbps_total).toBeUndefined();
    expect(pick(b, direct, 'api').reasons.join()).not.toMatch(/대역폭|동시 연결/);
  });

  it('내부 노드(화면에서 오지 않음)는 net 없음', () => {
    expect(a.nodes.api.net).toBeUndefined();
    expect(a.nodes.db.net).toBeUndefined();
    expect(a.scenarios.api.event.peak_mbps).toBeUndefined();
  });

  it('한계 사용자가 연결 한도로 줄어듦 (최대 대수 20대에서: 사용자 × 대당 한도 × 20 / 이벤트 동시 연결)', () => {
    const low = patch(base, 'lb', { net: { max_connections: 3000 } });
    const lim = run(low).nodes.lb.limitUsers!.value;
    expect(lim).toBeLessThan(lb.limitUsers!.value);
    expect(lim / ((base.scale!.users * 3000 * 20) / lb.net!.conns.event.value)).toBeCloseTo(1, 6);
    const slim = run(patch(base, 'lb', { net: { max_mbps: 1 } })).nodes.lb.limitUsers!.value;
    expect(slim).toBeLessThan(lb.limitUsers!.value);
  });

  it('진입 노드가 둘이면 동시 연결을 화면에서 직접 오는 흐름 비율로 나눔 (lb가 넘긴 부하는 api 연결에 세지 않음), 대역폭은 노드 전체', () => {
    const two: Project = { ...base, edges: [...base.edges, { ...base.edges[0], to: 'api' }] };
    const b = run(two), t = b.traffic!;
    expect(entryServers(two).map((n) => n.id).sort()).toEqual(['api', 'lb']);
    // web→lb, web→api가 같은 흐름이므로 반씩
    expect(b.nodes.lb.net!.conns.event.value).toBeCloseTo(t.concurrentPeakEvent.value / 2, 6);
    expect(b.nodes.api.net!.conns.event.value).toBeCloseTo(t.concurrentPeakEvent.value / 2, 6);
    expect(b.nodes.api.net!.mbps.event.value).toBeCloseTo(2 * b.nodes.lb.net!.mbps.event.value, 6);
  });

  describe('대수가 대역폭·연결로도 늘어남 (사용자 100만, nginx 기준값)', () => {
    const big: Project = { ...base, scale: { ...base.scale!, users: 1_000_000 } };
    const b = run(big), x = b.nodes.lb, u = big.target_utilization;
    it('대수 = ceil(동시 연결 / (10,000 × 목표 사용률)), RPS로 정한 대수보다 많음', () => {
      expect(x.instances!.normal.value).toBe(Math.ceil(x.net!.conns.normal.value / (10000 * u)));
      expect(x.instances!.event.value).toBe(Math.min(20, Math.ceil(x.net!.conns.event.value / (10000 * u))));
      expect(x.instances!.normal.value).toBeGreaterThan(Math.max(2, Math.ceil(x.load!.rps.normal / (20000 * u))));
    });
    it('평소 안 됨이 뜨지 않고, 한계 사용자는 최대 대수 20대 × 10,000 연결에서', () => {
      expect(pick(b, big, 'lb').reasons.join()).not.toMatch(/동시 연결|대역폭/);
      expect(x.limitUsers!.value / ((big.scale!.users * 20 * 10000) / x.net!.conns.event.value)).toBeCloseTo(1, 4);
    });
    it('비용 시간대별 대수에도 반영 (한도를 아주 크게 하면 비용이 줄어듦)', () => {
      const loose = run(patch(big, 'lb', { net: { max_mbps: 1e9, max_connections: 1e9 } }));
      expect(b.cost!.parts.lb.value).toBeGreaterThan(loose.cost!.parts.lb.value);
    });
  });
});
