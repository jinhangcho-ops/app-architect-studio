import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { monthlyCost } from '../cost';
import { parseProject } from '../data';
import { loadCatalog, loadPrices } from '../io';
import type { NodeLoad } from '../load';
import { costLines } from '../meters';
import type { Traffic } from '../traffic';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const prices = loadPrices(root('data/prices'));
const m = (value: number) => ({ value });
const D = 730 / 24;
// 하루 1,000만 요청, 피크 200 rps, 하루 송신 100GB → 요청당 1e-5 GB
const t = { dailyRequests: m(1e7), peakRps: m(200), egressGbPerDay: m(100), storageGbWithOverhead: m(50) } as unknown as Traffic;
const load = (normal: number) => ({ rps: { normal }, writeRps: { normal: 0 } }) as unknown as NodeLoad;
const SEOUL = 'aws:ap-northeast-2';
const cost = { region: SEOUL, transfer: 'transfer-interregion', transfer_zone: 'transfer-interzone', logs: 'logs-storage' };

const project = (nodes: unknown[], edges: unknown[] = [], c: object = cost) => parseProject({ name: 't', nodes, edges, cost: c }, catalog.items);
const run = (p: ReturnType<typeof project>, loads: Record<string, number>) =>
  costLines(p, t, new Map(Object.entries(loads).map(([k, v]) => [k, load(v)])), catalog.byId, () => [1], 1);
const api = (patch: object = {}) => ({ id: 'api', name: 'API', layer: 'backend', primary: 'api_autoscale', zones: 2, ...patch });
const db = (patch: object = {}) => ({ id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', zones: 2, ...patch });
const zoneLines = (r: ReturnType<typeof run>) => r.lines.filter((l) => l.key === '존 간 전송');

describe('존 간 전송', () => {
  it('존 2개 서버 → 존 2개 DB: 존 간 GB = 전송량 × (1 − 1/2), 화면 연결선은 빼고', () => {
    const p = project([{ id: 'ui', name: '화면', layer: 'ui' }, api(), db()], [{ from: 'ui', to: 'api' }, { from: 'api', to: 'db' }]);
    const z = zoneLines(run(p, { ui: 200, api: 100, db: 100 }));
    expect(z).toHaveLength(1);
    // 전송량 = 월 요청 500만 × 730/24일 × 요청당 1e-5 GB = 50 × 730/24 GB, 그 절반
    expect(z[0]).toMatchObject({ product: 'transfer-interzone', region: SEOUL });
    expect(z[0].quantities.gb_interzone).toBeCloseTo(25 * D);
  });

  it('두 노드 중 큰 존 수를 쓴다 (존 3개 → 2/3)', () => {
    const z = zoneLines(run(project([api({ zones: 1 }), db({ zones: 3 })], [{ from: 'api', to: 'db' }]), { api: 100, db: 100 }));
    expect(z[0].quantities.gb_interzone).toBeCloseTo(50 * D * (2 / 3));
  });

  it('존이 1개면 줄 없음, 리전이 다르면 리전 간 전송만', () => {
    expect(zoneLines(run(project([api({ zones: 1 }), db({ zones: undefined })], [{ from: 'api', to: 'db' }]), { api: 100, db: 100 }))).toEqual([]);
    const r = run(project([api(), db({ region: 'aws:ap-northeast-1' })], [{ from: 'api', to: 'db' }]), { api: 100, db: 100 });
    expect(zoneLines(r)).toEqual([]);
    expect(r.lines.filter((l) => l.key === '리전 간 전송')[0].quantities.gb_interregion).toBeCloseTo(50 * D);
  });

  it('인터페이스 명세가 있는 연결선: 존 간 GB = 같은 명세의 리전 간 GB × (1 − 1/z)', () => {
    const edge = [{ from: 'api', to: 'db', interfaces: [{ name: '조회', kind: 'rest', method: 'GET', path: '/a', request_bytes: 200, response_bytes: 800 }] }];
    const same = run(project([api(), db()], edge), { api: 100, db: 100 });
    const cross = run(project([api(), db({ region: 'aws:ap-northeast-1' })], edge), { api: 100, db: 100 });
    const inter = cross.lines.find((l) => l.key === '리전 간 전송')!.quantities.gb_interregion;
    expect(inter).toBeGreaterThan(0);
    expect(zoneLines(same)[0].quantities.gb_interzone).toBeCloseTo(inter! / 2);
  });

  it('사용자 배수 2배면 존 간 전송·로그도 2배', () => {
    const p = project([api({ observability: { log_kb_per_req: 1 } }), db()], [{ from: 'api', to: 'db' }]);
    const at = (f: number) => costLines(p, t, new Map([['api', load(100)], ['db', load(100)]]), catalog.byId, () => [1], f).lines;
    const [a, b] = [at(1), at(2)];
    const q = (ls: typeof a, key: string, unit: 'gb_interzone' | 'gb_month') => ls.find((l) => l.key === key)!.quantities[unit]!;
    expect(q(b, '존 간 전송', 'gb_interzone')).toBeCloseTo(2 * q(a, '존 간 전송', 'gb_interzone'));
    expect(q(b, '로그 저장', 'gb_month')).toBeCloseTo(2 * q(a, '로그 저장', 'gb_month'));
  });

  it('관리형(provisioned가 아닌) 서비스로 가는 연결선은 줄 없음', () => {
    const dynamo = { id: 'db', name: 'DDB', layer: 'db', primary: 'dynamodb', zones: 2 };
    expect(zoneLines(run(project([api({ primary: 'spring_boot' }), dynamo], [{ from: 'api', to: 'db' }]), { api: 100, db: 100 }))).toEqual([]);
  });

  it('존 간 전송 상품이 비면 줄 없음', () => {
    const p = project([api(), db()], [{ from: 'api', to: 'db' }], { region: SEOUL });
    expect(zoneLines(run(p, { api: 100, db: 100 }))).toEqual([]);
  });
});

describe('로그 저장', () => {
  it('요청당 1KB·보관 30일 → 보관 중인 양 = 하루 로그 GB × 30', () => {
    const r = run(project([api({ observability: { log_kb_per_req: 1, log_retention_days: 30 } })]), { api: 100 });
    const l = r.lines.filter((x) => x.key === '로그 저장');
    expect(l).toHaveLength(1);
    // 월 요청 500만 × 730/24일 × 1KB = 5 × 730/24 GB/월 → 하루 5GB × 30일
    expect(l[0]).toMatchObject({ product: 'logs-storage', region: SEOUL });
    expect(l[0].quantities.gb_month).toBeCloseTo(150);
  });

  it('보관 일수가 없으면 30일, 요청당 KB가 없거나 상품이 없거나 화면 노드면 줄 없음', () => {
    const logs = (nodes: unknown[], c: object = cost) => run(project(nodes, [], c), { api: 100, ui: 100 }).lines.filter((x) => x.key === '로그 저장');
    expect(logs([api({ observability: { log_kb_per_req: 2 } })])[0].quantities.gb_month).toBeCloseTo(300);
    expect(logs([api({ observability: { log_retention_days: 7 } })])).toEqual([]);
    expect(logs([api()])).toEqual([]);
    // 요청당 1MB 초과는 받지 않음
    expect(() => project([api({ observability: { log_kb_per_req: 1025 } })])).toThrow();
    expect(() => project([api({ observability: { log_kb_per_req: 1024 } })])).not.toThrow();
    expect(logs([api({ observability: { log_kb_per_req: 1 } })], { region: SEOUL })).toEqual([]);
    expect(logs([{ id: 'ui', name: '화면', layer: 'ui', observability: { log_kb_per_req: 1 } }])).toEqual([]);
  });
});

describe('가격표와 월 비용', () => {
  it('예시 가격표 행으로 parts에 존 간 전송·로그가 나옴', () => {
    const p = project([api({ observability: { log_kb_per_req: 1 } }), db()], [{ from: 'api', to: 'db' }]);
    const r = run(p, { api: 100, db: 100 });
    const c = monthlyCost(r.lines, prices, '2026-10-28', r.missing);
    expect(c.parts['존 간 전송'].value).toBeCloseTo(25 * D * 0.02);
    expect(c.parts['로그 저장'].value).toBeCloseTo(150 * 0.03);
    expect(c.missing.filter((x) => x.startsWith('가격 없음'))).toEqual([]);
    expect(prices.filter((x) => x.unit === 'gb_interzone').map((x) => x.region).sort()).toEqual(['aws:ap-northeast-1', 'aws:ap-northeast-2']);
  });
});
