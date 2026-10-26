// 감사 6 (audit7): 큰 숫자 하나로 계산이 멈추지 않는지, 설계서·DDL 경고
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze, sizeAt } from '../analyze';
import { readProject } from '../data';
import { schemaWarnings, tableDdl } from '../ddl';
import { loadCatalog, loadLaws, loadPrices } from '../io';
import { erlangC } from '../latency';
import { optimize } from '../optimize';
import { Project, checkProject } from '../schema';
import { dayCurve, traffic } from '../traffic';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
const raw = (name: string) => JSON.parse(readFileSync(root(`examples/${name}.json`), 'utf8'));

describe('1 접속 시간(분)은 하루(1440분)까지', () => {
  it('스키마가 막고, 옛 파일은 그 칸을 빼고 열며, dayCurve는 하루로 자름', () => {
    const r = raw('global-commerce');
    r.personas[0].session_minutes = 1e21;
    expect(Project.safeParse(r).success).toBe(false);
    expect(readProject(r, catalog.items).personas[0].session_minutes).toBeUndefined();
    const p = readProject(raw('global-commerce'), catalog.items);
    const t0 = Date.now();
    dayCurve({ ...p, personas: p.personas.map((x) => ({ ...x, session_minutes: 1e9 })) });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('2 얼랑 C: 서버 수가 커도 바로 끝남', () => {
  const exact = (c: number, a: number) => { let b = 1; for (let k = 1; k <= c; k++) b = (a * b) / (k + a * b); return (c * b) / (c - a * (1 - b)); };
  it('c > 1000은 근사, 정확한 값과 가까움', () => {
    for (const [c, a] of [[2000, 1900], [5000, 4800], [1001, 900]]) expect(erlangC(c, a)).toBeCloseTo(exact(c, a), 1);
    const t0 = Date.now();
    for (let k = 0; k < 1000; k++) erlangC(1e9, 9e8);
    expect(Date.now() - t0).toBeLessThan(200);
  });
});

describe('3 깊은 호출 사슬: 경로가 많아도 계산이 끝남', () => {
  it('노드 30개 갈래 사슬 → 경로 500개에서 자르고 알림', () => {
    const p = readProject(raw('global-commerce'), catalog.items);
    const base = p.nodes.find((n) => n.id === 'N-03')!;
    const chain = Array.from({ length: 30 }, (_, k) => ({ ...base, id: `S-${k}`, name: `s${k}`, tables: [] }));
    const edge = (from: string, to: string) => ({ from, to, sync: true, callRatio: 1, carries: 'all' as const, rtt_ms: 1, interfaces: [] });
    const edges = [edge('N-02', 'S-0'), ...chain.flatMap((_, k) => [...(k + 1 < 30 ? [edge(`S-${k}`, `S-${k + 1}`)] : []), ...(k + 2 < 30 ? [edge(`S-${k}`, `S-${k + 2}`)] : [])])];
    const q = { ...p, nodes: [p.nodes.find((n) => n.id === 'N-02')!, ...chain], edges } as Project;
    const a = analyze(q, d, '2026-10-27');
    expect(a.paths.length).toBe(500);
    expect(a.pathsCut).toBe(true);
  });
});

describe('8 페르소나 패턴은 트래픽 결과에서 읽음 (0명 페르소나가 빠져도 안 밀림)', () => {
  it('첫 페르소나 비율 0', () => {
    const p = readProject(raw('phase3'), catalog.items);
    const q = { ...p, personas: p.personas.map((x, k) => (k === 0 ? { ...x, share: 0 } : k === 1 ? { ...x, share: x.share + p.personas[0].share } : x)) };
    const t = traffic(q)!;
    expect(t.personas.map((x) => x.pattern)).toEqual(q.personas.slice(1).map((x) => x.pattern));
  });
});

describe('10 기본값이 코드 값 목록에 없으면 경고', () => {
  it('status 코드 PAID;DONE, 기본값 NEW', () => {
    const p = readProject(raw('global-commerce'), catalog.items);
    const n = p.nodes.find((x) => x.layer === 'db')!;
    const t = { name: 'orders_x', columns: [{ name: 'id', type: 'bigint', nullable: false }, { name: 'status', type: 'text', nullable: false, default_value: 'NEW', codes: [{ code: 'PAID', label: '' }, { code: 'DONE', label: '' }] }], primary_key: ['id'], indexes: [] };
    const q = { ...p, nodes: p.nodes.map((x) => (x === n ? { ...x, tables: [t] } : x)) } as unknown as Project;
    expect(schemaWarnings(q, catalog.byId).map((w) => w.text)).toContain('status: 기본값 NEW가 코드 값 목록에 없음 (CHECK 제약 때문에 기본값으로 행을 넣지 못함)');
  });
});

describe('감사 9: 하루 접속이 잦은 페르소나도 트래픽 계산이 몇 초 안에 끝남', () => {
  it('사용자 1억, 페르소나 모두 하루 100회', () => {
    const p = readProject(raw('global-commerce'), catalog.items);
    const q = { ...p, scale: { ...p.scale!, users: 1e8 }, personas: p.personas.map((x) => ({ ...x, sessions_per_day: 100 })) };
    const t0 = Date.now();
    const t = traffic(q)!;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(t.peakRps.value).toBeGreaterThan(0);
  });
});

describe('감사 10: 큰 값에서도 계산이 바로 끝남', () => {
  it('큐 소비자 "줄이기 전 기다림" 하루(86400초)도 분석 1초 안', () => {
    const p = readProject(raw('global-commerce'), catalog.items);
    const q = { ...p, nodes: p.nodes.map((n) => (n.id === 'N-05' ? { ...n, autoscale: { ...n.autoscale, cooldown_s: 86400 } } : n)) };
    analyze(q, d, '2026-10-27');
    const t0 = Date.now();
    analyze(q, d, '2026-10-27');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('최선 조합은 성장 기간과 관계없이 같은 지표 (달마다 비용을 다시 계산하지 않음)', () => {
    const p = readProject(raw('global-commerce'), catalog.items);
    const long = { ...p, growth: { ...(p.growth ?? { monthly_rate: 0.05 }), months: 240 } } as Project;
    const metrics = (x: Project) => optimize(x, d, '2026-10-27').evaluated.map((e) => e.metrics);
    const timed = (x: Project) => { const t0 = performance.now(); const r = metrics(x); return { r, ms: performance.now() - t0 }; };
    timed(p);
    const a = timed({ ...p, growth: undefined }), b = timed(long);
    expect(b.r).toEqual(a.r);
    // 예전에는 240개월이면 조합마다 달별 비용을 다시 계산해 몇 배 느렸다
    expect(b.ms).toBeLessThan(2 * a.ms + 50);
  });
  it('같은 출발·도착 연결선이 둘이면 checkProject 오류', () => {
    const p = readProject(raw('phase3'), catalog.items);
    const q = { ...p, edges: [...p.edges, { ...p.edges[0], sync: !p.edges[0].sync }] };
    expect(checkProject(q, catalog.items).join()).toContain(`연결선 중복 ${p.edges[0].from}->${p.edges[0].to}`);
  });
});

describe('감사 9: 이중화 대수는 필요 대수·사용률에도 들어감', () => {
  it('replicas 3이면 부하가 작아도 3대, 사용률은 3대로 나눔', () => {
    const p = readProject(raw('actions'), catalog.items);
    const n = { ...p.nodes.find((x) => x.layer === 'backend')!, replicas: 3, min_instances: 1 };
    const r = sizeAt(n, 1000, 20, 300, 0.7);
    expect(r.N).toBe(3);
    expect(r.util).toBeCloseTo(300 / 3000);
  });
});

describe('감사 8: MySQL 설명은 컬럼 1024·테이블 2048글자까지', () => {
  it('긴 설명은 MySQL DDL에서만 자름', () => {
    const t = { name: 't', description: '가'.repeat(3000), columns: [{ name: 'id', type: 'bigint', nullable: false, description: '나'.repeat(1200) }], primary_key: ['id'], indexes: [] } as unknown as Parameters<typeof tableDdl>[0];
    const my = tableDdl(t, 'mysql');
    expect(my).toContain(`COMMENT '${'나'.repeat(1024)}'`);
    expect(my).not.toContain('나'.repeat(1025));
    expect(my).toContain(`COMMENT='${'가'.repeat(2048)}'`);
    expect(tableDdl(t, 'postgres')).toContain('나'.repeat(1200));
  });
});

describe('감사 7: 키에 같은 컬럼 두 번, 이름 길이 한도', () => {
  it('PostgreSQL DB 노드', () => {
    const p = readProject(raw('global-commerce'), catalog.items);
    const n = p.nodes.find((x) => x.layer === 'db')!;
    const long = 'x'.repeat(64);
    const t = { name: 'orders_x', columns: [{ name: 'id', type: 'bigint', nullable: false }, { name: long, type: 'text', nullable: true }], primary_key: ['id', 'id'], indexes: [] };
    const q = { ...p, nodes: p.nodes.map((x) => (x === n ? { ...x, tables: [t] } : x)) } as unknown as Project;
    const texts = schemaWarnings(q, catalog.byId).map((w) => w.text);
    expect(texts).toContain('기본 키: 컬럼 id가 두 번 들어 있음 (PostgreSQL·MySQL이 거부함)');
    expect(texts).toContain(`이름이 PostgreSQL 한도 63바이트를 넘음: ${long}`);
  });
});
