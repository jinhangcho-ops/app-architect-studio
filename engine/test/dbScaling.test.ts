import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze, DEFAULT_DB_POOL, POOLER_POOL, sizeAt } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { DEFAULT_HIT_RATIO } from '../load';
import { NodeSchema, type Project } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// phase3: web → lb → api → db(PostgreSQL), worker → db(쓰기, 비동기)
const base = loadProject(root('examples/phase3.json'), catalog.items);
const run = (p: Project) => analyze(p, d, '2026-10-25');
const users = (p: Project, x: number): Project => ({ ...p, scale: { ...p.scale!, users: p.scale!.users * x } });
const withDb = (p: Project, patch: Partial<Project['nodes'][number]>): Project => ({ ...p, nodes: p.nodes.map((n) => (n.id === 'db' ? { ...n, ...patch } : n)) });

describe('주 서버 1대 DB (single_primary)', () => {
  const n = NodeSchema.parse({ id: 'x', name: 'x', layer: 'db', primary: 'postgresql' });
  it('읽기 복제본이 없으면 대수가 늘지 않고 사용률이 1을 넘을 수 있음', () => {
    const r = sizeAt(n, 1000, 20, 5000, 0.7, { writeShare: 0.1, replicas: false });
    expect(r.N).toBe(1);
    expect(r.util).toBeCloseTo(5);
  });
  it('읽기 복제본이 있으면 쓰기는 주 서버, 읽기만 복제본 수로 나눔', () => {
    const r = sizeAt(n, 1000, 20, 5000, 0.7, { writeShare: 0.1, replicas: true });
    expect(r.N).toBe(1 + Math.ceil(4500 / 700));
    expect(r.util).toBeCloseTo(Math.max(500 / 1000, 4500 / (7 * 1000)));
  });

  it('사용자를 50배로 늘려도 PostgreSQL은 1대 그대로이고 주 서버 처리량을 넘어 안 됨이 됨 (예전에는 11대로 늘었다)', () => {
    const a = run(users(base, 50));
    expect(a.nodes.db.instances!.event.value).toBe(1);
    const pg = a.judgements.find((j) => j.nodeId === 'db')!.items[0];
    expect(pg.verdict).toBe('fail');
    expect(pg.reasons.join(' ')).toContain('주 DB 서버가 받는');
  });

  it('읽기 복제본을 붙이면 같은 부하에서 복제본이 늘고, 주 서버 판정은 쓰기만 봄', () => {
    const a = run(users(withDb(base, { extras: ['read_replica'] }), 50));
    expect(a.nodes.db.instances!.event.value).toBeGreaterThan(1);
    expect(a.scenarios.db.event.primary_rps).toBeCloseTo(a.nodes.db.load!.writeRps.event);
  });
});

describe('DB 연결 수 자동 계산', () => {
  it('부르는 노드 대수 × 연결 풀 (워커처럼 대수를 계산하지 않는 노드는 1대)', () => {
    const a = run(base);
    const api = a.nodes.api.instances!.event.value;
    expect(a.nodes.db.connections!.event.value).toBe(api * DEFAULT_DB_POOL + 1 * DEFAULT_DB_POOL);
    expect(a.scenarios.db.event.db_connections).toBe(a.nodes.db.connections!.event.value);
  });

  it('백엔드가 늘면 연결도 늘어 연결 한도(100)에서 걸림, 연결 풀러가 있으면 풀러 크기로 고정', () => {
    const big = users(base, 12);
    const conns = run(big).nodes.db.connections!.event.value;
    expect(conns).toBeGreaterThan(100);
    expect(run(big).judgements.find((j) => j.nodeId === 'db')!.items[0].reasons.join(' ')).toContain('연결 한도');
    expect(run(withDb(big, { extras: ['connection_pooler'] })).nodes.db.connections!.event.value).toBe(POOLER_POOL);
  });

  it('연결 풀 크기를 바꾸면 반영되고, 사람이 넣은 값은 계산보다 우선', () => {
    const small = { ...base, nodes: base.nodes.map((n) => (n.id === 'api' ? { ...n, db_pool: 3 } : n)) };
    expect(run(small).nodes.db.connections!.event.value).toBe(run(base).nodes.api.instances!.event.value * 3 + DEFAULT_DB_POOL);
    const manual = withDb(base, { vars: { normal: { db_connections: 7 }, event: { db_connections: 7 } } });
    expect(run(manual).scenarios.db.event.db_connections).toBe(7);
  });

  it('한계 사용자는 실제로 그 배수에서 다시 센 연결 수와 맞음 (한계를 조금 넘기면 걸리고, 조금 못 미치면 안 걸림)', () => {
    const a = run(base);
    const lim = a.nodes.db.limitUsers!.value / base.scale!.users;
    const verdict = (x: number) => run(users(base, x)).judgements.find((j) => j.nodeId === 'db')!.items[0].verdict;
    expect(verdict(lim * 0.97)).toBe('ok');
    expect(verdict(lim * 1.05)).not.toBe('ok');
  });
});

describe('캐시 적중률만큼 DB 읽기가 줄어듦', () => {
  // api가 캐시도 부르면(cache-aside) DB로 가는 읽기는 빗나간 몫만
  const withCache = (hit?: number): Project => ({
    ...base,
    nodes: [...base.nodes, NodeSchema.parse({ id: 'cache', name: '캐시', layer: 'cache', primary: 'redis_cache', ...(hit !== undefined && { hit_ratio: hit }) })],
    edges: [...base.edges, { from: 'api', to: 'cache', carries: 'read', callRatio: 1, sync: true, rtt_ms: 0 }],
  });
  it('쓰기는 그대로, 읽기는 (1 − 적중률)', () => {
    const plain = run(base).nodes.db.load!, cached = run(withCache(0.9)).nodes.db.load!;
    expect(cached.writeRps.event).toBeCloseTo(plain.writeRps.event);
    const reads = (l: typeof plain) => l.rps.event - l.writeRps.event;
    // 워커는 쓰기만 보내므로 DB 읽기는 모두 api에서 온다
    expect(reads(cached)).toBeCloseTo(reads(plain) * 0.1);
  });
  it('적중률을 안 정하면 기본값(예시값)으로 줄이고, 읽기 비율은 계산됨', () => {
    const plain = run(base), cached = run(withCache());
    const reads = (a: typeof plain) => a.nodes.db.load!.rps.event - a.nodes.db.load!.writeRps.event;
    expect(reads(cached)).toBeCloseTo(reads(plain) * (1 - DEFAULT_HIT_RATIO));
    expect(cached.scenarios.cache.event.read_ratio).toBeCloseTo(1);
  });
});
