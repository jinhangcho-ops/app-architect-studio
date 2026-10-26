import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { PITR_RPO_S } from '../failure';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import type { Project } from '../schema';

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
