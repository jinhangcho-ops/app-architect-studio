// 테이블 크기: 컬럼 타입·저장 형식 → 행 크기, 인덱스 크기, 보관 기간 저장량, 파티션 크기.
// 시스템별 오버헤드·채움률·압축은 카탈로그 저장 프로필과 켠 기능에서 가져온다. 가정값을 쓰면 assumptions에 남긴다.
import type { Vars } from './expr';
import { metric, type Metric } from './model';
import { nodeStorageProfile, selectedFeatures, storageOf, type CatalogItem, type Column, type Project, type ProjectNode, type Table } from './schema';
import type { Traffic } from './traffic';

export type TableAnalysis = {
  /** '노드.테이블' */
  key: string;
  nodeId: string;
  table: string;
  newRowsPerDay: Metric;
  rowBytes: Metric;
  indexBytesPerRow: Metric;
  storedGb: Metric;
  partitions?: { count: number; gb: Metric };
  /** 하루에 쓰는 행 (새 행 + 갱신). 리전 복제 전송량에 쓴다 */
  writtenRowsPerDay: number;
  /** 피크 1시간의 초당 쓰기 행 (평소) */
  peakRowsPerSec: number;
  /** 평균 길이 없음, 저장 프로필 없음 같은 가정 */
  assumptions: string[];
  /** 주 항목에 저장 프로필이 있어 오버헤드·압축까지 계산했는지. 없으면 값 크기만이라 실제보다 작다 */
  profiled: boolean;
  /** table 범위 구조 규칙의 변수 */
  vars: Vars;
};

const INTERVAL_DAYS = { day: 1, week: 7, month: 30 } as const;
const TEXT_TYPES = new Set<Column['type']>(['text', 'json', 'bytes']);
// 가변 길이 값에 평균·최대 길이가 모두 없을 때 쓰는 가정값
const DEFAULT_VAR_BYTES = 32;

/** 값 하나의 바이트. 저장 형식이 크기를 정한다 (같은 시각도 정수 8바이트, ISO 문자열 24바이트) */
export function valueBytes(c: Column, assume: (s: string) => void = () => {}): number {
  const storage = storageOf(c);
  const variable = () => {
    if (c.avg_bytes) return c.avg_bytes;
    if (c.max_length) { assume(`${c.name}: 평균 길이 없음 → 최대 길이의 절반 ${c.max_length / 2}바이트`); return c.max_length / 2; }
    assume(`${c.name}: 평균·최대 길이 없음 → ${DEFAULT_VAR_BYTES}바이트`);
    return DEFAULT_VAR_BYTES;
  };
  if (storage === 'integer') return c.type === 'bool' ? 1 : c.type === 'int' || c.type === 'date' ? 4 : 8;
  if (storage === 'real') return 8;
  if (storage === 'text') {
    if (c.avg_bytes) return c.avg_bytes;
    if (c.type === 'timestamp') return 24; // 2026-10-24T09:00:00.000Z
    if (c.type === 'date') return 10;
    if (c.type === 'uuid') return 36;
    return variable();
  }
  // blob
  return c.type === 'uuid' ? 16 : TEXT_TYPES.has(c.type) ? variable() : 8;
}

const m = metric;

/** 기본 키가 정수 열 하나(정수로 저장)인지. SQLite는 이 키를 행 번호(rowid)로 써서 따로 인덱스를 두지 않는다 (SQLite 실험도 같은 규칙) */
export const intPk = (t: Table) => {
  const c = t.primary_key.length === 1 ? t.columns.find((x) => x.name === t.primary_key[0]) : undefined;
  return !!c && ['int', 'bigint'].includes(c.type) && (c.storage ?? 'integer') === 'integer';
};
const utf8 = (s: string) => new TextEncoder().encode(s).length;

export function tableSize(
  p: Project, node: ProjectNode, t: Table, byId: Map<string, CatalogItem>, traffic: Traffic | undefined, factor = 1,
): TableAnalysis {
  const nodeId = node.id;
  const key = `${nodeId}.${t.name}`;
  const assumptions: string[] = [];
  const assume = (s: string) => assumptions.push(s);
  const sp = nodeStorageProfile(node, byId);
  if (!sp) assume('주 항목에 저장 프로필이 없음 → 오버헤드·압축 없이 값 크기만');
  const fx = sp ? selectedFeatures(sp, node, t).map((f) => f.effect) : [];
  const eff = <K extends keyof (typeof fx)[number]>(k: K) => fx.find((e) => e[k] !== undefined)?.[k];

  // 행 크기
  const bytesOf = new Map(t.columns.map((c) => [c.name, valueBytes(c, assume)]));
  const data = t.columns.reduce((s, c) => s + bytesOf.get(c.name)!, 0);
  const textData = t.columns.filter((c) => TEXT_TYPES.has(c.type)).reduce((s, c) => s + bytesOf.get(c.name)!, 0);
  const names = sp?.stores_field_names ? t.columns.reduce((s, c) => s + utf8(c.name), 0) : 0;
  const overhead = (sp?.row_overhead_bytes ?? 0) + (eff('row_overhead_delta') ?? 0) + (sp?.per_column_overhead_bytes ?? 0) * t.columns.length + names;
  const raw = data + overhead;
  const ratio = eff('compression') ?? 1;
  const scope = eff('compression_scope') ?? 'all';
  const above = eff('applies_above_row_bytes') ?? 0;
  const saved = raw > above ? (1 - ratio) * (scope === 'text' ? textData : raw) : 0;
  const fill = eff('table_fill') ?? sp?.table_fill ?? 1;
  const computedRow = (raw - saved) / fill;
  const rowBytes = t.measured.row_bytes !== undefined
    ? m(t.measured.row_bytes, '바이트', '실측', { 실측: t.measured.row_bytes })
    : m(computedRow, '바이트', '(값 + 행·컬럼 오버헤드 + 필드 이름 − 압축 절감) / 채움률',
      { 값: data, 오버헤드: overhead, 필드이름: names, 압축절감: saved, 채움률: fill });

  // 인덱스: 기본 키(테이블과 따로 저장되는 경우) + 보조 인덱스. 열 저장은 행 인덱스가 없다
  const pkBytes = t.primary_key.reduce((s, c) => s + bytesOf.get(c)!, 0);
  const rowidPk = sp?.integer_pk_is_rowid && intPk(t);
  const pkSeparate = t.primary_key.length > 0 && sp?.layout !== 'columnar' && !sp?.pk_is_table && !eff('pk_is_table') && !rowidPk;
  const indexFill = eff('index_fill') ?? sp?.index_fill ?? 1;
  const entry = (cols: string[], secondary: boolean) =>
    (cols.reduce((s, c) => s + bytesOf.get(c)!, 0) + (sp?.index_entry_overhead_bytes ?? 0) + (secondary && sp?.secondary_index_includes_pk ? pkBytes : 0)) / indexFill;
  const indexes = sp?.layout === 'columnar' ? [] : [...(pkSeparate ? [entry(t.primary_key, false)] : []), ...t.indexes.map((ix) => entry(ix.columns, true))];
  if (sp?.layout === 'columnar' && t.indexes.length) assume('열 저장 시스템이라 인덱스 크기는 넣지 않음');
  const indexBytesPerRow = t.measured.index_bytes !== undefined
    ? m(t.measured.index_bytes, '바이트/행', '실측', { 실측: t.measured.index_bytes })
    : m(indexes.reduce((s, x) => s + x, 0), '바이트/행', 'Σ 인덱스마다 (키 컬럼 + 항목 오버헤드 [+ 기본 키]) / 인덱스 채움률',
      { 인덱스수: indexes.length, 채움률: indexFill });

  // 하루 새 행과 보관량
  const sim = traffic?.tables[key];
  if (t.measured.rows_per_day === undefined && !sim) assume('이 테이블에 쓰는 행동이 없음 → 하루 0행');
  const written = (t.measured.rows_per_day ?? sim?.rowsPerDay.value ?? 0) * factor;
  const newRows = written * (1 - t.update_ratio);
  const days = t.retention_days ?? p.scale?.retention_days ?? 365;
  const extraDays = eff('extra_retention_days') ?? 0;
  // 바뀌거나(갱신) 보관 기간이 지나 지워진 행이 extraDays만큼 더 과금된다
  const churn = written * t.update_ratio + newRows;
  const perRow = rowBytes.value + indexBytesPerRow.value;
  const bytes = newRows * days * perRow + churn * extraDays * rowBytes.value;
  const storedGb = m(bytes / 1e9, 'GB', '하루 새 행 × 보관 일수 × (행 + 인덱스) + 바뀐·지운 행 × 추가 보관 일수 × 행',
    { 하루새행: newRows, 보관일수: days, 행바이트: rowBytes.value, 인덱스바이트: indexBytesPerRow.value, 추가보관일수: extraDays });
  const partitions = t.partition && (() => {
    const count = Math.ceil(days / INTERVAL_DAYS[t.partition.interval]);
    return { count, gb: m(storedGb.value / count, 'GB', '저장량 / 파티션 수', { 저장GB: storedGb.value, 파티션수: count }) };
  })();

  const pkCol = t.primary_key.length === 1 ? t.columns.find((c) => c.name === t.primary_key[0]) : undefined;
  const peak = (sim?.peakRowsPerSec.value ?? 0) * factor;
  return {
    key, nodeId, table: t.name, newRowsPerDay: m(newRows, '행/일', '하루 쓰기 행 × (1 − 갱신 비율)', { 쓰기행: written, 갱신비율: t.update_ratio }),
    rowBytes, indexBytesPerRow, storedGb, partitions, writtenRowsPerDay: written, peakRowsPerSec: peak, assumptions: [...new Set(assumptions)],
    // 행·인덱스 크기를 둘 다 실측했으면 프로필이 없어도 크기를 안다
    profiled: !!sp || (t.measured.row_bytes !== undefined && t.measured.index_bytes !== undefined),
    vars: {
      system: node.primary ?? '',
      layout: sp?.layout ?? 'unknown',
      table_gb: storedGb.value,
      partitioned: !!partitions,
      partitions: partitions?.count ?? 0,
      partition_gb: partitions?.gb.value ?? storedGb.value,
      index_count: indexes.length,
      table_write_rps: peak * (p.scale?.event_multiplier ?? 1),
      pk_uuid: pkCol?.type === 'uuid',
      uuidv7: node.extras.includes('uuidv7_keys'),
      ...(node.spec?.memGb !== undefined && { server_mem_gb: node.spec.memGb }),
    },
  };
}

/** 프로젝트의 모든 테이블. factor = 사용자 배수(성장 타임라인) */
export function tableSizes(p: Project, traffic: Traffic | undefined, byId: Map<string, CatalogItem>, factor = 1): TableAnalysis[] {
  return p.nodes.flatMap((n) => n.tables.map((t) => tableSize(p, n, t, byId, traffic, factor)));
}
