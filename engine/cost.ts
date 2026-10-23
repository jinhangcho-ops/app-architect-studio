// 9절 월 비용: 과금 방식별 계량 항목(대수×시간, 사용량, 정액, 저장, 송신, 리전 간 전송) × 가격표.
// 가격이나 계량에 필요한 값이 없으면 0으로 채우지 않고 missing에 이유를 남긴다.
import type { Metric } from './model';
import type { PriceRow } from './schema';

/** 한 줄 = 한 계량 항목. quantities는 가격표 행의 단위별 수량이다(대수 상품은 hour·month 둘 다 주고 행의 단위로 고른다). */
export type LineItem = {
  /** 결과 parts의 묶음 이름 (노드 id, '저장', '송신', '리전 간 전송') */
  key: string;
  /** 가격표 행 id 또는 상품 키 */
  product: string;
  region?: string;
  quantities: Partial<Record<PriceRow['unit'], number>>;
  /** 수량이 어떻게 나왔는지 (단위별) */
  how: Partial<Record<PriceRow['unit'], string>>;
};

export type CostResult = {
  total?: Metric;
  parts: Record<string, Metric>;
  /** 가격표에 없는 상품, 계량에 필요한 값이 없는 노드 */
  missing: string[];
  /** 기준일이 오래된 가격 (id와 기준일) */
  stale: string[];
};

const DAY_MS = 86_400_000;
const UNIT_NAME: Record<PriceRow['unit'], string> = {
  hour: '대·시간', month: '대(월 정액)', gb_month: 'GB·월', gb: '송신 GB', gb_interregion: '리전 간 GB',
  vcpu_second: 'vCPU·초', gb_second: 'GB·초', million_requests: '요청 100만 건', tb_scanned: '스캔 TB',
};

/** 행 찾기: id가 같으면 그 행, 아니면 같은 상품 키 + 같은 리전 */
export function findPrice(prices: PriceRow[], product: string, region?: string): PriceRow | undefined {
  return prices.find((r) => r.id === product)
    ?? prices.find((r) => (r.product ?? r.id) === product && (region === undefined || r.region === region));
}

/** today는 'YYYY-MM-DD'. missingInputs는 계량값을 못 구한 이유(분석 단계에서 넘김) */
export function monthlyCost(lines: LineItem[], prices: PriceRow[], today: string, missingInputs: string[] = [], staleDays = 90): CostResult {
  const parts: Record<string, Metric> = {};
  const missing = [...missingInputs];
  const used: PriceRow[] = [];

  for (const l of lines) {
    const row = findPrice(prices, l.product, l.region);
    if (!row) { missing.push(`가격 없음: ${l.product}${l.region ? ` @ ${l.region}` : ''}`); continue; }
    const qty = l.quantities[row.unit];
    if (qty === undefined) throw new Error(`가격 ${row.id}의 단위 ${row.unit}는 ${l.key}에 쓸 수 없음 (${Object.keys(l.quantities).join('/')}만 가능)`);
    used.push(row);
    const value = qty * row.price;
    const label = `${UNIT_NAME[row.unit]} ${row.id}`;
    const prev = parts[l.key];
    parts[l.key] = {
      value: (prev?.value ?? 0) + value,
      unit: row.currency,
      formula: [prev?.formula, `${l.how[row.unit] ?? row.unit} × ${UNIT_NAME[row.unit]} 단가`].filter(Boolean).join(' + '),
      inputs: { ...prev?.inputs, [`${label} 수량`]: qty, [`${label} 단가`]: row.price },
    };
  }

  const currencies = new Set(used.map((r) => r.currency));
  if (currencies.size > 1) throw new Error(`가격표 통화가 섞여 있어 합칠 수 없음: ${[...currencies].join(', ')}`);
  const cutoff = Date.parse(today) - staleDays * DAY_MS;
  const stale = [...new Set(used.filter((r) => Date.parse(r.as_of) < cutoff).map((r) => `${r.id} (${r.as_of})`))];

  const values = Object.values(parts);
  const total = values.length
    ? { value: values.reduce((s, m) => s + m.value, 0), unit: values[0].unit, formula: '노드별 과금 + 저장 + 송신 + 리전 간 전송', inputs: Object.fromEntries(Object.entries(parts).map(([k, m]) => [k, m.value])) }
    : undefined;
  return { total, parts, missing: [...new Set(missing)], stale };
}
