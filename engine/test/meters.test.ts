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
// 한 달 = 730시간 = 730/24일 (감사 5 M7)
const D = 730 / 24;
// 하루 1,000만 요청, 피크 200 rps, 하루 송신 100GB, 저장 50GB
const t = { dailyRequests: m(1e7), peakRps: m(200), egressGbPerDay: m(100), storageGbWithOverhead: m(50) } as unknown as Traffic;
const load = (normal: number, write = 0) => ({ rps: { normal }, writeRps: { normal: write } }) as unknown as NodeLoad;

const project = (nodes: unknown[], edges: unknown[] = [], cost: object = { region: 'aws:ap-northeast-2' }) =>
  parseProject({ name: 't', nodes, edges, cost }, catalog.items);
const run = (p: ReturnType<typeof project>, loads: Record<string, number | [number, number]>, hourly = [2, 3]) =>
  costLines(p, t, new Map(Object.entries(loads).map(([k, v]) => [k, typeof v === 'number' ? load(v) : load(...v)])), catalog.byId, () => hourly, 1);

describe('과금 방식별 계량', () => {
  it('서버리스: 요청 수와 GB·초를 노드 부하 비율로 계산', () => {
    const p = project([{ id: 'fn', name: '함수', layer: 'backend', primary: 'serverless_functions', perf: { service_ms: 100, workers: 1 }, spec: { vcpu: 1, memGb: 0.5 } }]);
    const { lines, missing } = run(p, { fn: 100 });
    expect(missing).toEqual([]);
    // 노드 몫 = 100/200 → 월 요청 500만 × 730/24일 ≈ 1.52억
    const q = Object.assign({}, ...lines.map((l) => l.quantities));
    expect(q.million_requests).toBeCloseTo(5 * D);
    expect(q.gb_second).toBeCloseTo(5e6 * D * 0.1 * 0.5);
    const c = monthlyCost(lines, prices, '2026-10-23', missing);
    expect(c.total!.value).toBeCloseTo(5 * D * 0.2 + 5e6 * D * 0.05 * 0.0000167);
  });

  it('트래픽이 없으면 요청 과금은 0원이 아니라 "사용량 모름"', () => {
    const p = project([{ id: 'kv', name: 'KV', layer: 'db', primary: 'dynamodb' }]);
    const { lines, missing } = costLines(p, undefined, undefined, catalog.byId, () => [1], 1);
    expect(lines).toEqual([]);
    expect(missing).toEqual(['KV: 트래픽(규모·페르소나)이 없어 사용량을 모름']);
  });

  it('서버리스에 메모리 사양이 없으면 빠진 값으로 알림', () => {
    const p = project([{ id: 'fn', name: '함수', layer: 'backend', primary: 'serverless_functions', perf: { service_ms: 100, workers: 1 } }]);
    expect(run(p, { fn: 100 }).missing).toEqual(['함수: 메모리(GB) 사양 없음']);
  });

  it('서버: 시간대 대수 합 × 730/24일', () => {
    const p = project([{ id: 'api', name: 'API', layer: 'backend', primary: 'api_autoscale' }]);
    const [l] = run(p, { api: 100 }).lines;
    expect(l).toMatchObject({ product: 'vm-2vcpu', region: 'aws:ap-northeast-2', quantities: { month: 3 } });
    expect(l.quantities.hour).toBeCloseTo(5 * D);
  });

  it('리전 간 전송은 리전이 다른 연결선에만, local 노드는 제외', () => {
    const p = project(
      [
        { id: 'api', name: 'API', layer: 'backend', primary: 'api_autoscale' },
        { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', region: 'aws:ap-northeast-1' },
        { id: 'app', name: '앱', layer: 'backend', primary: 'api_autoscale', region: 'local' },
      ],
      [{ from: 'api', to: 'db' }, { from: 'app', to: 'db' }],
      { region: 'aws:ap-northeast-2', transfer: 'transfer-interregion' },
    );
    const { lines } = run(p, { api: 100, db: 100, app: 100 });
    const tr = lines.filter((l) => l.key === '리전 간 전송');
    expect(tr).toHaveLength(1);
    // 월 요청 500만 × 730/24일 × 요청당 1e-5 GB
    expect(tr[0].quantities.gb_interregion).toBeCloseTo(50 * D);
    expect(lines.some((l) => l.key === 'app')).toBe(false);
  });

  it('쓰기만 나르는 연결선은 쓰기 몫만 전송량에 넣음', () => {
    const p = project(
      [
        { id: 'w', name: '워커', layer: 'batch', primary: 'on_demand_worker' },
        { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', region: 'aws:ap-northeast-1' },
      ],
      [{ from: 'w', to: 'db', carries: 'write' }],
      { region: 'aws:ap-northeast-2', transfer: 'transfer-interregion' },
    );
    // 워커 100 RPS 중 쓰기 10 → 50 × 730/24 GB의 10분의 1
    const tr = run(p, { w: [100, 10], db: 100 }).lines.find((l) => l.key === '리전 간 전송')!;
    expect(tr.quantities.gb_interregion).toBeCloseTo(5 * D);
  });

  it('화면 와이어프레임 호출이 있으면 그 호출 몫만 전송량에 넣음 (부하 전파와 같은 규칙)', () => {
    const p = project(
      [
        { id: 'ui', name: '화면', layer: 'ui', wireframe: { screens: [{ name: 's', items: [
          { id: 'w1', kind: 'button', x: 0, y: 0, w: 10, h: 10, api: { method: 'GET', path: '/a', to: 'api', per_session: 3 } },
          { id: 'w2', kind: 'button', x: 0, y: 0, w: 10, h: 10, api: { method: 'GET', path: '/b', to: 'db', per_session: 1 } },
        ] }] } },
        { id: 'api', name: 'API', layer: 'backend', primary: 'api_autoscale' },
        { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', region: 'aws:ap-northeast-1' },
      ],
      [{ from: 'ui', to: 'api' }, { from: 'ui', to: 'db' }],
      { region: 'aws:ap-northeast-2', transfer: 'transfer-interregion' },
    );
    // 화면 200 RPS(전부 읽기) 중 db로 가는 몫 1/4 → 월 요청 1,000만 × 730/24일 × 1/4 × 요청당 1e-5 GB
    const tr = run(p, { ui: 200, api: 150, db: 50 }).lines.filter((l) => l.key === '리전 간 전송');
    expect(tr).toHaveLength(1);
    expect(tr[0].quantities.gb_interregion).toBeCloseTo(25 * D);
  });

  it('리전을 모르면 다른 리전 가격을 대신 쓰지 않음 (id로 직접 지정한 행만)', () => {
    const p = project([{ id: 'db', name: 'DB', layer: 'db', primary: 'postgresql' }], [], {});
    const { lines, missing } = run(p, { db: 1 });
    expect(lines).toEqual([]);
    expect(missing[0]).toMatch(/리전 없음/);
  });

  it('월 정액 항목: 그 리전 가격이 있으면 1개월분, 없으면 가격 없음', () => {
    const lh = { id: 'lh', name: '레이크하우스', layer: 'analytics', primary: 'databricks' };
    const seoul = run(project([lh]), {});
    expect(monthlyCost(seoul.lines, prices, '2026-10-23', seoul.missing).total!.value).toBe(500);
    const gcp = run(project([{ ...lh, region: 'gcp:asia-northeast3' }]), {});
    expect(monthlyCost(gcp.lines, prices, '2026-10-23', gcp.missing).missing[0]).toMatch(/가격 없음: databricks-workspace @ gcp/);
  });
});
