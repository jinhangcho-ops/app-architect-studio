import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadLaws, loadPrices, loadProject } from '../io';
import { judgeNode } from '../judge';
import { NodeSchema, type Project } from '../schema';

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const catalog = loadCatalog(root('data/catalog'));
const d = { catalog: catalog.byId, rules: catalog.rules, prices: loadPrices(root('data/prices')), laws: loadLaws(root('data/laws')) };
// phase3: web → lb(Least-Connections) → api(오토스케일, 최대 20대) → db(PostgreSQL)
const base = loadProject(root('examples/phase3.json'), catalog.items);
const run = (p: Project) => analyze(p, d, '2026-10-25');
const users = (p: Project, x: number): Project => ({ ...p, scale: { ...p.scale!, users: p.scale!.users * x } });
const primaryOf = (a: ReturnType<typeof run>, p: Project, id: string) =>
  a.judgements.find((j) => j.nodeId === id)!.items.find((i) => i.itemId === p.nodes.find((n) => n.id === id)!.primary)!;

describe('게이트웨이 한계', () => {
  it('로드밸런서도 대당 처리량·필요 대수·한계 사용자가 나옴 (예전에는 한계 없음)', () => {
    const a = run(base);
    expect(a.nodes.lb.perInstanceRps?.value).toBeGreaterThan(0);
    expect(a.nodes.lb.instances?.event.value).toBeGreaterThanOrEqual(1);
    expect(a.nodes.lb.limitUsers?.value).toBeGreaterThan(0);
  });

  it('로드밸런서 1대만 쓸 수 있으면(최대 1대) 처리량을 넘는 순간 안 됨', () => {
    const one = { ...base, nodes: base.nodes.map((n) => (n.id === 'lb' ? { ...n, measured: { ...n.measured, max_instances: 1, rps: 300 } } : n)) };
    const pick = primaryOf(run(one), one, 'lb');
    expect(pick.verdict).toBe('fail');
    expect(pick.reasons[0]).toContain('사용률');
  });
});

describe('사용률 100%를 넘으면 안 됨', () => {
  it('백엔드가 최대 20대를 다 써도 넘치면(예전 211% = 조건부) 안 됨, 이유에 사용률', () => {
    const big = users(base, 50), a = run(big);
    expect(a.nodes.api.instances!.event.value).toBe(20);
    expect(a.nodes.api.utilization!.event.value).toBeGreaterThan(1);
    const pick = primaryOf(a, big, 'api');
    expect(pick.verdict).toBe('fail');
    expect(pick.reasons[0]).toContain('이벤트 피크에서 사용률');
  });

  it('한계 사용자 바로 아래는 됨, 넘기면 안 됨 (판정과 한계가 같은 규칙)', () => {
    const lim = run(base).nodes.api.limitUsers!.value / base.scale!.users;
    expect(primaryOf(run(users(base, lim * 0.97)), base, 'api').verdict).not.toBe('fail');
    expect(primaryOf(run(users(base, lim * 1.05)), base, 'api').verdict).toBe('fail');
  });

  it('넘쳐도 대안은 그 항목 자체의 조건으로 판정 (사용률을 물려받지 않음)', () => {
    // 서버 1대(api_single)가 넘친 상황: 대안 오토스케일은 자기 처리량(500 × 20대)으로 판정되어 됨
    const vars = { peak_rps: 800, utilization: 1.6 };
    const node = NodeSchema.parse({ id: 'x', name: 'x', layer: 'backend', primary: 'api_single' });
    const j = judgeNode(node, catalog.byId, { normal: vars, event: vars }).items[0];
    expect(j.verdict).toBe('fail');
    expect(j.alternatives).toEqual([{ id: 'api_autoscale', verdict: 'ok', note: undefined }]);
  });
});
