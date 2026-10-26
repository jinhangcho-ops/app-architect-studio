import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { impactOf, monthlyDowntimeHours, nodeAvailability, pathAvailability } from '../availability';
import { instancesNeeded } from '../capacity';
import { monthlyCost } from '../cost';
import { monthsToLimit, timeline } from '../growth';
import { loadCatalog, loadPrices, loadProject } from '../io';
import { nodeP99 } from '../latency';
import { limitFactor } from '../limits';
import { Project, type PriceRow } from '../schema';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const catalog = loadCatalog(here('../../data/catalog'));
const prices = loadPrices(here('../../data/prices'));

// 설계서 5절 이후 예시는 고정 규모를 쓴다: 활성 사용자 10만, 피크 300 / 프로모션 900 RPS, 쓰기 19 / 58건/초
const USERS = 100_000;
const node = (over: object) => Project.parse({ name: 't', nodes: [{ id: 'n', name: 'n', ...over }] }).nodes[0];

describe('관문: 9절 필요 대수', () => {
  it('900 RPS, 대당 500, 목표 사용률 70% → 3대', () => {
    expect(instancesNeeded(900, 500, 0.7)).toBe(3);
    expect(instancesNeeded(900, 500, 0.7, 1, 2)).toBe(2); // 최대 대수로 자름
  });
});

describe('관문: 12절 지연시간 (λ, S = 20ms, 대당 동시 처리 8)', () => {
  it('평소 300 RPS, 서버 1대(c=8) → 약 128ms', () => {
    expect(nodeP99(300, 20, 8).value).toBeCloseTo(127.9, 1);
  });
  it('프로모션 900 RPS, 서버 1대 → ρ ≥ 1, 끝없이 길어짐', () => {
    expect(nodeP99(900, 20, 8).value).toBe(Infinity);
  });
  it('프로모션 900 RPS, 서버 3대(c=24) → 약 101ms', () => {
    expect(nodeP99(900, 20, 24).value).toBeCloseTo(100.6, 1);
  });
});

describe('관문: 13절 가용성 (1대 99.9%)', () => {
  // 한 달 = 730시간 (감사 5 M7)
  it('3개 노드 직렬 → 99.70%, 월 약 2.19시간 중단', () => {
    const a = pathAvailability([0.999, 0.999, 0.999]).value;
    expect(a).toBeCloseTo(0.997003, 6);
    expect(monthlyDowntimeHours(a).value).toBeCloseTo(0.002997001 * 730, 6);
  });
  it('DB만 2대로 이중화 → 99.80%, 월 약 1.46시간', () => {
    const a = pathAvailability([0.999, 0.999, nodeAvailability(0.999, 2)]).value;
    expect(a).toBeCloseTo(0.998, 5);
    expect(monthlyDowntimeHours(a).value).toBeCloseTo(1.46, 2);
  });
  it('장애 영향: 동기로 닿는 화면은 멈춤, 비동기를 거치면 지연', () => {
    const p = Project.parse({
      name: 'p',
      nodes: [{ id: 'w', name: 'w', layer: 'ui' }, { id: 'q', name: 'q', layer: 'queue' }, { id: 'd', name: 'd', layer: 'db' }, { id: 'a', name: 'a', layer: 'backend' }],
      edges: [{ from: 'w', to: 'a' }, { from: 'a', to: 'q', sync: false }, { from: 'q', to: 'd' }],
    });
    expect(impactOf(p, ['a'])).toEqual({ w: 'stopped' });
    expect(impactOf(p, ['d'])).toEqual({ w: 'delayed' });
  });
});

describe('관문: 8절 한계 사용자 (활성 사용자 10만, 이벤트 900 RPS·쓰기 58건/초)', () => {
  const limit = (over: object, normal: object, event: object) =>
    USERS * limitFactor(node(over), catalog.byId, { normal: normal as never, event: event as never })!;

  it('API 서버 1대(500 RPS) → 약 5.6만', () => {
    expect(limit({ layer: 'backend', primary: 'api_single' }, { peak_rps: 300 }, { peak_rps: 900 })).toBeCloseTo(55_555.6, 0);
  });
  it('SQLite(쓰는 노드 1개, 기준 50건/초) → 약 8.6만', () => {
    const v = { writer_nodes: 1 };
    expect(limit({ layer: 'db', primary: 'sqlite' }, { ...v, peak_write_rps: 19 }, { ...v, peak_write_rps: 58 })).toBeCloseTo(86_206.9, 0);
  });
  it('오토스케일링 최대 20대 → 약 111만', () => {
    expect(limit({ layer: 'backend', primary: 'api_autoscale' }, { peak_rps: 300 }, { peak_rps: 900 })).toBeCloseTo(1_111_111, -1);
  });
  it('Kafka(브로커 클러스터 2만 RPS) → 약 222만: API 외 노드도 한계가 나옴', () => {
    expect(limit({ layer: 'queue', primary: 'kafka' }, { peak_rps: 300 }, { peak_rps: 900 })).toBeCloseTo(2_222_222, -1);
  });
  it('부하와 무관하게 안 되면 0, 부하 변수가 없으면 한계 없음', () => {
    expect(limitFactor(node({ layer: 'db', primary: 'sqlite' }), catalog.byId,
      { normal: { writer_nodes: 2, peak_write_rps: 1 }, event: { writer_nodes: 2, peak_write_rps: 1 } })).toBe(0);
    expect(limitFactor(node({ layer: 'gateway', primary: 'round_robin' }), catalog.byId,
      { normal: { service_time_cv: 0.3 }, event: { service_time_cv: 0.3 } })).toBeUndefined();
  });
  it('100만 배까지 버티면 Infinity(한계 없음), 모름(undefined)과 나눔 (리뷰 4 L2)', () => {
    expect(limitFactor(node({ layer: 'backend', primary: 'api_autoscale' }), catalog.byId,
      { normal: { peak_rps: 1e-6 }, event: { peak_rps: 1e-6 } })).toBe(Infinity);
  });
});

describe('관문: 14절 성장 (월 10%)', () => {
  it('최대 10대(약 55.6만) 18개월째·착수 15, 최대 20대(약 111만) 26개월째·착수 23', () => {
    expect(monthsToLimit(USERS, 555_556, 0.1)).toBe(18);
    expect(timeline([{ nodeId: 'a', limitUsers: 1_111_111 }, { nodeId: 'b', limitUsers: 555_556 }], USERS, 0.1, 3))
      .toEqual([
        { nodeId: 'b', limitUsers: 555_556, month: 18, startMonth: 15 },
        { nodeId: 'a', limitUsers: 1_111_111, month: 26, startMonth: 23 },
      ]);
  });
  it('이미 넘었으면 0, 성장하지 않으면 도달하지 않음', () => {
    expect(monthsToLimit(USERS, 50_000, 0.1)).toBe(0);
    expect(monthsToLimit(USERS, 200_000, 0)).toBeUndefined();
  });
});

describe('관문: 9절 월 비용', () => {
  const row = (id: string, unit: PriceRow['unit'], price: number, as_of = '2026-10-01'): PriceRow =>
    ({ id, region: 'aws:ap-northeast-2', unit, price, currency: 'USD', as_of, source: '예시' });

  const inst = (key: string, product: string, hourly: number[]) =>
    ({ key, product, quantities: { hour: hourly.reduce((s, x) => s + x, 0) * 30, month: Math.max(...hourly) }, how: {} });

  it('하루 송신 144GB → 월 4,320GB, 시간당 과금은 30일 × 시간대 대수 합', () => {
    const c = monthlyCost([
      inst('api', 'h', Array(24).fill(2)),
      { key: '송신', product: 'e', quantities: { gb: 144 * 30 }, how: {} },
    ], [row('h', 'hour', 0.1), row('e', 'gb', 0.1)], '2026-10-23');
    expect(Object.values(c.parts['송신'].inputs)[0]).toBe(4320);
    expect(c.parts.api.value).toBeCloseTo(30 * 48 * 0.1, 6);
    expect(c.total!.value).toBeCloseTo(144 + 432, 6);
  });

  it('가격표에 없는 상품은 0이 아니라 missing, 90일 넘은 가격은 stale, 월 정액은 최대 대수', () => {
    const c = monthlyCost([inst('a', 'nope', [1]), inst('b', 'old', [1, 3])], [row('old', 'month', 10, '2026-01-01')], '2026-10-23', ['b: 메모리 사양 없음']);
    expect(c.missing).toEqual(['b: 메모리 사양 없음', '가격 없음: nope']);
    expect(c.stale).toEqual(['old (2026-01-01)']);
    expect(c.parts.a).toBeUndefined();
    expect(c.parts.b.value).toBe(30);
  });

  it('단위가 맞지 않는 상품이나 통화가 섞이면 오류', () => {
    expect(() => monthlyCost([{ key: '송신', product: 'h', quantities: { gb: 1 }, how: {} }], [row('h', 'hour', 1)], '2026-10-23')).toThrow('단위');
    expect(() => monthlyCost([inst('a', 'x', [1]), inst('b', 'y', [1])],
      [row('x', 'hour', 1), { ...row('y', 'hour', 1), currency: 'KRW' }], '2026-10-23')).toThrow('통화');
  });
});

describe('analyze: 예시 프로젝트 전체', () => {
  const p = loadProject(here('../../examples/phase3.json'), catalog.items);
  const a = analyze(p, { catalog: catalog.byId, rules: catalog.rules, prices }, '2026-10-23');

  it('비용·한계·성장·지연·가용성이 모두 나옴', () => {
    expect(a.cost!.total!.value).toBeGreaterThan(0);
    expect(a.cost!.missing).toEqual([]);
    expect(a.nodes.api.p99!.normal.value).toBeGreaterThan(0);
    expect(a.paths[0].availability.value).toBeCloseTo(0.999 * nodeAvailability(0.999, 2) ** 2, 9); // lb·db 이중화, api 1대
    expect(a.bottleneck).toBeDefined();
    expect(a.growth!.milestones.length).toBeGreaterThan(0);
    expect(a.growth!.monthlyCost).toHaveLength(25);
    expect(a.spof).toEqual(['api']);
  });

  it('판정 변수에 사용률·노드 p99·경로 가용성이 들어감 (실측 vars가 없으면 계산값)', () => {
    const api = a.judgements.find((j) => j.nodeId === 'api')!;
    expect(api.items[0].verdict).toBe('ok');
  });

  it('결과의 모든 Metric에 공식이 붙어 있음', () => {
    const walk = (x: unknown, path: string): void => {
      if (!x || typeof x !== 'object') return;
      if ('value' in x && 'unit' in x && 'formula' in x) expect((x as { formula: string }).formula, path).not.toBe('');
      for (const [k, v] of Object.entries(x)) walk(v, `${path}.${k}`);
    };
    walk(a, 'analysis');
  });
});

describe('이중화 대수가 비용에 들어감', () => {
  it('3단계 예시의 PostgreSQL 2대 → 2대 × 730시간 × 0.2', () => {
    const p = loadProject(here('../../examples/phase3.json'), catalog.items);
    const a = analyze(p, { catalog: catalog.byId, rules: catalog.rules, prices }, '2026-10-23');
    expect(a.cost!.parts.db.value).toBeCloseTo(2 * 730 * 0.2);
  });
});

describe('성장 그래프의 월별 비용', () => {
  it('0개월째는 지금 비용과 같고, 사용자가 늘면 비용도 늘어남', () => {
    const p = loadProject(here('../../examples/phase3.json'), catalog.items);
    const a = analyze(p, { catalog: catalog.byId, rules: catalog.rules, prices }, '2026-10-23');
    const series = a.growth!.monthlyCost.map((x) => x!.value);
    expect(series[0]).toBeCloseTo(a.cost!.total!.value);
    expect(series.at(-1)!).toBeGreaterThan(series[0]);
  });
});
