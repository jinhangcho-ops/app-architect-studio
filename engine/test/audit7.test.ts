// 감사 6 (audit7): 큰 숫자 하나로 계산이 멈추지 않는지, 설계서·DDL 경고
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { readProject } from '../data';
import { schemaWarnings } from '../ddl';
import { loadCatalog, loadLaws, loadPrices } from '../io';
import { erlangC } from '../latency';
import { Project } from '../schema';
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
