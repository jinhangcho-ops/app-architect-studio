// 9절 월 비용: 노드별 시간대 대수 × 가격표 + 저장 + 송신. 가격이 없으면 0으로 채우지 않고 missing에 남긴다.
import type { Metric } from './model';
import type { PriceRow } from './schema';

export type CostInput = {
  /** hourly = 0~23시 필요 대수 */
  nodes: { id: string; price?: string; hourly: number[] }[];
  storageGb?: number;
  storageProduct?: string;
  egressGbPerMonth?: number;
  egressProduct?: string;
};

export type CostResult = {
  total?: Metric;
  parts: Record<string, Metric>;
  /** 가격표에 없는 상품 id */
  missing: string[];
  /** 기준일이 오래된 가격 (id와 기준일) */
  stale: string[];
};

const DAY_MS = 86_400_000;

/** today는 'YYYY-MM-DD'. 순수 함수로 두려고 오늘 날짜를 인자로 받는다. */
export function monthlyCost(input: CostInput, prices: PriceRow[], today: string, staleDays = 90): CostResult {
  const byId = new Map(prices.map((p) => [p.id, p]));
  const parts: Record<string, Metric> = {};
  const missing: string[] = [];
  const used: PriceRow[] = [];

  const find = (id: string, units: PriceRow['unit'][]) => {
    const row = byId.get(id);
    if (!row) { missing.push(id); return undefined; }
    if (!units.includes(row.unit)) throw new Error(`가격 ${id}의 단위 ${row.unit}는 여기 쓸 수 없음 (${units.join('/')}만 가능)`);
    used.push(row);
    return row;
  };

  for (const n of input.nodes) {
    if (!n.price) continue;
    const row = find(n.price, ['hour', 'month']);
    if (!row) continue;
    const instanceHours = n.hourly.reduce((s, x) => s + x, 0) * 30;
    parts[n.id] = row.unit === 'hour'
      ? { value: instanceHours * row.price, unit: row.currency, formula: '30일 × Σ 시간대 대수 × 시간당 단가', inputs: { 대시간: instanceHours, 단가: row.price } }
      // shortcut: 월 정액은 하루 중 최대 대수만큼 상시 켠다고 본다. 시간대별로 끄고 켤 수 있으면 hour 단가로 넣는다
      : { value: Math.max(...n.hourly) * row.price, unit: row.currency, formula: '최대 대수 × 월 정액', inputs: { 최대대수: Math.max(...n.hourly), 단가: row.price } };
  }
  if (input.storageProduct && input.storageGb !== undefined) {
    const row = find(input.storageProduct, ['gb_month']);
    if (row) parts['저장'] = { value: input.storageGb * row.price, unit: row.currency, formula: '저장량(여유분 포함) × GB·월 단가', inputs: { GB: input.storageGb, 단가: row.price } };
  }
  if (input.egressProduct && input.egressGbPerMonth !== undefined) {
    const row = find(input.egressProduct, ['gb']);
    if (row) parts['송신'] = { value: input.egressGbPerMonth * row.price, unit: row.currency, formula: '월 송신 GB × GB 단가', inputs: { GB: input.egressGbPerMonth, 단가: row.price } };
  }

  const currencies = new Set(used.map((r) => r.currency));
  if (currencies.size > 1) throw new Error(`가격표 통화가 섞여 있어 합칠 수 없음: ${[...currencies].join(', ')}`);
  const cutoff = Date.parse(today) - staleDays * DAY_MS;
  const stale = [...new Set(used.filter((r) => Date.parse(r.as_of) < cutoff).map((r) => `${r.id} (${r.as_of})`))];

  const values = Object.values(parts);
  const total = values.length
    ? { value: values.reduce((s, m) => s + m.value, 0), unit: values[0].unit, formula: '노드 + 저장 + 송신 합계', inputs: Object.fromEntries(Object.entries(parts).map(([k, m]) => [k, m.value])) }
    : undefined;
  return { total, parts, missing: [...new Set(missing)], stale };
}
