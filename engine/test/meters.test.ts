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
// 하루 1,000만 요청, 피크 200 rps, 하루 송신 100GB, 저장 50GB
const t = { dailyRequests: m(1e7), peakRps: m(200), egressGbPerDay: m(100), storageGbWithOverhead: m(50) } as unknown as Traffic;
const load = (normal: number) => ({ rps: { normal } }) as unknown as NodeLoad;

const project = (nodes: unknown[], edges: unknown[] = [], cost: object = { region: 'aws:ap-northeast-2' }) =>
  parseProject({ name: 't', nodes, edges, cost }, catalog.items);
const run = (p: ReturnType<typeof project>, loads: Record<string, number>, hourly = [2, 3]) =>
  costLines(p, t, new Map(Object.entries(loads).map(([k, v]) => [k, load(v)])), catalog.byId, () => hourly, 1);

describe('과금 방식별 계량', () => {
  it('서버리스: 요청 수와 GB·초를 노드 부하 비율로 계산', () => {
    const p = project([{ id: 'fn', name: '함수', layer: 'backend', primary: 'serverless_functions', perf: { service_ms: 100, workers: 1 }, spec: { vcpu: 1, memGb: 0.5 } }]);
    const { lines, missing } = run(p, { fn: 100 });
    expect(missing).toEqual([]);
    // 노드 몫 = 100/200 → 월 요청 1.5억
    const q = Object.assign({}, ...lines.map((l) => l.quantities));
    expect(q.million_requests).toBeCloseTo(150);
    expect(q.gb_second).toBeCloseTo(1.5e8 * 0.1 * 0.5);
    const c = monthlyCost(lines, prices, '2026-10-23', missing);
    expect(c.total!.value).toBeCloseTo(150 * 0.2 + 7.5e6 * 0.0000167);
  });

  it('서버리스에 메모리 사양이 없으면 빠진 값으로 알림', () => {
    const p = project([{ id: 'fn', name: '함수', layer: 'backend', primary: 'serverless_functions', perf: { service_ms: 100, workers: 1 } }]);
    expect(run(p, { fn: 100 }).missing).toEqual(['함수: 메모리(GB) 사양 없음']);
  });

  it('서버: 시간대 대수 합 × 30시간', () => {
    const p = project([{ id: 'api', name: 'API', layer: 'backend', primary: 'api_autoscale' }]);
    const [l] = run(p, { api: 100 }).lines;
    expect(l).toMatchObject({ product: 'vm-2vcpu', region: 'aws:ap-northeast-2', quantities: { hour: 150, month: 3 } });
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
    // 월 요청 1.5억 × 요청당 1e-5 GB
    expect(tr[0].quantities.gb_interregion).toBeCloseTo(1500);
    expect(lines.some((l) => l.key === 'app')).toBe(false);
  });

  it('월 정액 항목: 그 리전 가격이 있으면 1개월분, 없으면 가격 없음', () => {
    const lh = { id: 'lh', name: '레이크하우스', layer: 'analytics', primary: 'databricks' };
    const seoul = run(project([lh]), {});
    expect(monthlyCost(seoul.lines, prices, '2026-10-23', seoul.missing).total!.value).toBe(500);
    const gcp = run(project([{ ...lh, region: 'gcp:asia-northeast3' }]), {});
    expect(monthlyCost(gcp.lines, prices, '2026-10-23', gcp.missing).missing[0]).toMatch(/가격 없음: databricks-workspace @ gcp/);
  });
});
