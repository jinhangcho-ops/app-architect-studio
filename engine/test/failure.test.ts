import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { failureLines, PITR_RPO_S } from '../failure';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { NodeSchema, type Project } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// global-commerce: 존 장애를 견디는 목표(RTO 60분, RPO 60분). API(N-03)는 존 2개, DB(N-06)는 존 2개·시점 복구·서울 리전 대기 복사본, 레이크하우스(N-10)는 1대
const base = loadProject(root('examples/global-commerce.json'), catalog.items);
const run = (p: Project) => analyze(p, d, '2026-10-25');
const node = (p: Project, id: string, patch: Partial<Project['nodes'][number]>): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) });
const primaryOf = (a: ReturnType<typeof run>, id: string) => a.judgements.find((j) => j.nodeId === id)!.items[0];
const zoneOf = (a: ReturnType<typeof run>, id: string) => a.failure!.zone.find((z) => z.nodeId === id)!;

describe('존 하나 장애', () => {
  it('존이 1개면 화면이 멈춰 안 됨, 2개면 남은 서버 사용률 = 지금 × 대수 / 남은 대수', () => {
    const a = run(base), z = zoneOf(a, 'N-03'), na = a.nodes['N-03'];
    expect(z.down).toBe(false);
    expect(z.util!.normal.value).toBeCloseTo((na.utilization!.normal.value * z.servers) / (z.servers - z.lost));
    const one = run(node(base, 'N-03', { zones: 1 })), j = primaryOf(one, 'N-03');
    expect(zoneOf(one, 'N-03').down).toBe(true);
    expect(j.verdict).toBe('fail');
    expect(j.reasons[0]).toContain('화면이 멈춥니다');
  });

  it('비동기로만 닿는 노드가 멈추면 반영 지연이라 조건부', () => {
    const j = primaryOf(run(base), 'N-10');
    expect(j.verdict).toBe('conditional');
    expect(j.reasons.join()).toContain('반영이 늦어집니다');
  });

  it('남은 서버가 이벤트 피크를 못 받으면 조건부 (자동 확장이 채움), 한계 사용자는 그대로', () => {
    const a = run(base);
    expect(zoneOf(a, 'N-03').util!.event.value).toBeGreaterThan(1);
    expect(primaryOf(a, 'N-03').verdict).toBe('conditional');
    const none = run({ ...base, recovery: undefined });
    expect(primaryOf(none, 'N-03').verdict).toBe('ok');
    expect(a.nodes['N-03'].limitUsers!.value).toBe(none.nodes['N-03'].limitUsers!.value);
  });
});

describe('리전 장애', () => {
  it('복사본 없는 리전이 멈추면 그 리전 노드와 화면이 멈추고, 복사본이 있는 리전은 넘어감', () => {
    const f = run(base).failure!;
    const kr = f.regions.find((r) => r.region === 'aws:ap-northeast-2')!, jp = f.regions.find((r) => r.region === 'aws:ap-northeast-1')!;
    expect(kr.down).toContain('N-03');
    expect(kr.stopped).toEqual(['N-02']);
    expect(kr.rto!.value).toBe(Infinity);
    expect(jp.down).toEqual([]);
    expect(jp.failover).toEqual(['N-06']);
    expect(jp.rto!.value).toBe(900);
  });

  it('리전 장애를 견디는 목표면 복사본 없는 동기 노드는 안 됨, 대기 복사본이 목표 RTO보다 느리면 안 됨', () => {
    const p: Project = { ...base, recovery: { survive: 'region', rto_min: 10 } };
    expect(primaryOf(run(p), 'N-03').reasons.join()).toContain('다른 리전 복사본이 없어');
    const db = primaryOf(run(p), 'N-06');
    expect(db.verdict).toBe('fail');
    expect(db.reasons.join()).toContain('다른 리전 복사본으로 넘기는 데 15분');
  });
});

describe('백업·RPO', () => {
  it('시점 복구면 RPO는 리전 복제 지연(5초)과 로그 간격 중 짧은 것, 백업이 없으면 되살릴 수 없어 안 됨', () => {
    const f = run(base).failure!;
    expect(f.data.find((x) => x.nodeId === 'N-06')!.rpo.value).toBe(5);
    expect(run(node(base, 'N-06', { dr: undefined })).failure!.data.find((x) => x.nodeId === 'N-06')!.rpo.value).toBe(PITR_RPO_S);
    const j = primaryOf(run(node(base, 'N-06', { dr: undefined, backup: undefined })), 'N-06');
    expect(j.verdict).toBe('fail');
    expect(j.reasons.join()).toContain('되살릴 수 없습니다');
  });

  it('되살리기 = 준비 + 크기 / 속도, 목표 RTO를 넘으면 안 됨', () => {
    const slow = run(node(base, 'N-06', { backup: { every_h: 24, pitr: true, restore_mb_s: 1 } }));
    const r = slow.failure!.data.find((x) => x.nodeId === 'N-06')!.restore!;
    expect(r.value).toBeCloseTo(600 + r.inputs['데이터GB'] * 1024);
    expect(primaryOf(slow, 'N-06').reasons.join()).toContain('백업에서 되살리는 데');
  });
});

describe('캐시 장애', () => {
  // from이 캐시(적중률 0.8)도 부르면 cache-aside: N-03은 DB(N-06)를 부르므로 DB 읽기가 줄고, N-09는 DB를 안 불러 줄이는 것이 없다
  const withCache = (p: Project, from = 'N-03', hit = 0.8): Project => ({
    ...p,
    nodes: [...p.nodes, NodeSchema.parse({ id: 'C-1', name: '캐시', layer: 'cache', primary: 'redis_cache', hit_ratio: hit })],
    edges: [...p.edges, { from, to: 'C-1', carries: 'read', callRatio: 1, sync: true, rtt_ms: 0, interfaces: [] }],
  });
  const nameOf = (id: string) => withCache(base).nodes.find((n) => n.id === id)!.name;
  // 쓰기 연결선이 없고 대수대로 늘어나는 DB(cockroachdb): 캐시 없을 때 읽기만 늘어나 사용률을 넘기고 다른 이유는 없다
  const readOnlyDb = (q: Project, hit: number): Project => {
    const p0 = withCache(q, 'N-03', hit);
    return node({ ...p0, edges: p0.edges.filter((e) => !(e.from === 'N-05' && e.to === 'N-06')).map((e) => (e.to === 'N-06' ? { ...e, carries: 'read' as const } : e)) }, 'N-06', { primary: 'cockroachdb', extras: [] });
  };
  const MULT = 10;

  it('캐시가 멈추면 DB 부하 = 지금 읽기 / (1 − 적중률) + 쓰기', () => {
    const a = run(withCache(base)), c = a.failure!.cache;
    expect(c.map((x) => x.cacheId)).toEqual(['C-1']);
    expect(c[0].affected.map((x) => x.nodeId)).toEqual(['N-06']);
    const now = a.nodes['N-06'].load!, x = c[0].affected[0];
    for (const s of ['normal', 'event'] as const) {
      const without = (now.rps[s] - now.writeRps[s]) / 0.2 + now.writeRps[s];
      expect(x.rps[s].value).toBeCloseTo(without);
    }
    expect(x.util!.event.formula).toBe('max(쓰기 / 대당 처리량, 읽기 / (복제본 수 × 대당 처리량)), 대수 그대로');
  });

  it('장애 목표가 있고 캐시 없을 때 사용률 > 100%면 조건부, 목표가 없으면 줄은 나오되 판정 그대로', () => {
    // 적중률 0.99: 캐시가 멈추면 DB 읽기가 100배. 배수는 캐시 없을 때만 100%를 넘고 다른 이유는 없는 값
    const p = readOnlyDb({ ...base, scale: { ...base.scale!, users: base.scale!.users * MULT } }, 0.99);
    const a = run(p);
    expect(a.failure!.cache[0].affected[0].util!.event.value).toBeGreaterThan(1);
    const j = primaryOf(a, 'N-06');
    expect(j.verdict).toBe('conditional');
    expect(j.reasons.join()).toContain('캐시가 멈추면 캐시가 줄여 주던 읽기가 이 노드로 와 사용률');
    const none = run({ ...p, recovery: undefined });
    expect(none.failure!.cache[0].affected[0].nodeId).toBe('N-06');
    expect(primaryOf(none, 'N-06').reasons.join()).not.toContain('줄여 주던 읽기가');
  });

  it('지금 부하가 0이어도(쓰기 없는 DB·적중률 1) 사용률은 유한: 캐시 없을 때 부하 / (대수 × 대당 처리량)', () => {
    const a = run(readOnlyDb(base, 1)), x = a.failure!.cache[0].affected[0], na = a.nodes['N-06'];
    for (const s of ['normal', 'event'] as const) {
      expect(x.rps[s].inputs['지금부하']).toBe(0);
      expect(Number.isFinite(x.util![s].value)).toBe(true);
      expect(x.util![s].value).toBeCloseTo(x.rps[s].value / (na.instances![s].value * na.perInstanceRps!.value));
    }
  });

  it('주 서버 1대 DB(읽기 복제본 있음)는 max(쓰기 / 대당, 읽기 / ((대수 − 1) × 대당))', () => {
    const a = run(withCache(base)), x = a.failure!.cache[0].affected[0], na = a.nodes['N-06'], now = na.load!;
    for (const s of ['normal', 'event'] as const) {
      const N = na.instances![s].value, per = na.perInstanceRps!.value, w = now.writeRps[s], L = x.rps[s].value;
      expect(N).toBeGreaterThan(1);
      expect(x.util![s].value).toBeCloseTo(Math.max(w / per, (L - w) / ((N - 1) * per)));
    }
  });

  it('읽기 복제본 없는 주 서버 1대 DB(대기 서버 2대)는 대수와 상관없이 캐시 없을 때 부하 / 대당 처리량', () => {
    const p0 = withCache(base);
    const a = run(node(p0, 'N-06', { extras: p0.nodes.find((n) => n.id === 'N-06')!.extras.filter((e) => e !== 'read_replica') }));
    const x = a.failure!.cache[0].affected[0], na = a.nodes['N-06'];
    for (const s of ['normal', 'event'] as const) {
      expect(na.instances![s].value).toBeGreaterThan(1);
      expect(x.util![s].value).toBeCloseTo(x.rps[s].value / na.perInstanceRps!.value);
    }
  });

  it('DB 읽기를 줄이지 않는 캐시는 시나리오가 없음', () => {
    expect(run(withCache(base, 'N-09')).failure!.cache).toEqual([]);
    expect(run(base).failure!.cache).toEqual([]);
  });

  it('줄 꼴: 캐시 — 캐시 장애: 노드 부하 지금 → 캐시 없을 때 RPS, 사용률 평소 / 이벤트. id면 그 캐시·영향 노드만', () => {
    const a = run(withCache(base)), f = a.failure!, x = f.cache[0].affected[0];
    const lines = failureLines(f, nameOf).filter((l) => l.includes('캐시 장애'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^캐시 — 캐시 장애: 정산·원장 DB \\(N-06\\) 부하 [\\d,.]+ → [\\d,.]+ RPS, 사용률 ${Math.round(x.util!.normal.value * 100)}% / ${Math.round(x.util!.event.value * 100)}%$`));
    expect(failureLines(f, nameOf, 'C-1').some((l) => l.includes('캐시 장애'))).toBe(true);
    expect(failureLines(f, nameOf, 'N-06').some((l) => l.includes('캐시 장애'))).toBe(true);
    expect(failureLines(f, nameOf, 'N-03').some((l) => l.includes('캐시 장애'))).toBe(false);
  });
});

describe('리전 복사본의 비용과 처리량', () => {
  const hours = (a: ReturnType<typeof run>, id: string) => a.cost!.parts[id].inputs;
  it('standby는 대기 대수 × 730시간을 복사본 리전 가격으로 더하고, active는 같은 대수를 한 번 더', () => {
    const none = run(node(base, 'N-06', { dr: undefined })).cost!.parts['N-06'].value;
    const standby = run(node(base, 'N-06', { dr: { region: 'aws:ap-northeast-2', mode: 'standby', instances: 2 } }));
    expect(standby.cost!.parts['N-06'].value - none).toBeCloseTo(2 * 730 * 0.2);
    expect(hours(standby, 'N-06')['대·시간 aws-seoul-db-2vcpu 수량']).toBeCloseTo(2 * 730, 9);
    const active = run(node(base, 'N-03', { dr: { region: 'aws:ap-northeast-1', mode: 'active' } })).cost!.parts['N-03'].value;
    expect(active).toBeGreaterThan(run(base).cost!.parts['N-03'].value * 1.9);
  });

  it('복사본 데이터 노드는 복사본 리전에도 같은 저장량', () => {
    const a = run(base), b = run(node(base, 'N-06', { dr: undefined }));
    const gb = a.tables.filter((x) => x.nodeId === 'N-06').reduce((s2, x) => s2 + x.storedGb.value, 0);
    expect(a.cost!.parts['저장'].value - b.cost!.parts['저장'].value).toBeCloseTo(gb * 0.1);
  });

  it('데이터 노드 복사본은 하루 쓰는 행 × 행 크기 × 730/24일을 리전 간 전송으로 더함', () => {
    const a = run(base), b = run(node(base, 'N-06', { dr: undefined }));
    const gb = a.tables.filter((x) => x.nodeId === 'N-06').reduce((s2, x) => s2 + x.writtenRowsPerDay * x.rowBytes.value, 0) * (730 / 24) / 1e9;
    expect(gb).toBeGreaterThan(0);
    const price = d.prices.find((r) => (r.product ?? r.id) === base.cost.transfer && r.region === 'aws:ap-northeast-1')!.price;
    expect(a.cost!.parts['리전 간 전송'].value - b.cost!.parts['리전 간 전송'].value).toBeCloseTo(gb * price, 6);
  });

  it('standby로 넘긴 직후 사용률 = 지금 × 대수 / 대기 대수, 리전 목표에서 넘치면 조건부. active는 그대로', () => {
    const p = node({ ...base, recovery: { survive: 'region' } }, 'N-03', { dr: { region: 'aws:ap-northeast-1', mode: 'standby' } });
    const a = run(p), kr = a.failure!.regions.find((r) => r.region === 'aws:ap-northeast-2')!, na = a.nodes['N-03'];
    expect(kr.util['N-03'].event.value).toBeCloseTo(na.utilization!.event.value * na.instances!.event.value);
    expect(primaryOf(a, 'N-03').reasons.join()).toContain('대기 복사본으로 넘기면 사용률');
    const act = run(node(p, 'N-03', { dr: { region: 'aws:ap-northeast-1', mode: 'active' } }));
    expect(act.failure!.regions.find((r) => r.region === 'aws:ap-northeast-2')!.util['N-03'].event.value).toBeCloseTo(na.utilization!.event.value);
    expect(primaryOf(act, 'N-03').reasons.join()).not.toContain('대기 복사본');
  });
});
