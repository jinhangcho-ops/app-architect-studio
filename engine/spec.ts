// 데이터 명세서 → 테이블. 엑셀에서 복사한 표(TSV), CSV, JSON을 받는다.
// 읽을 수 없는 줄은 건너뛰고 "N번째 줄: 이유"로 알려 준다. 가정값은 채우지 않는다(크기 계산이 따로 표시한다).
import { z } from 'zod';
import { Column, STORAGE_FORMATS, Table, checkTable, type Table as TableT } from './schema';

export type SpecResult = { tables: TableT[]; errors: string[] };

/** 머리글 이름(한글·영문) → 필드 */
const HEADERS: Record<string, string[]> = {
  table: ['테이블', '테이블명', 'table', 'table_name'],
  column: ['컬럼', '컬럼명', '필드', 'column', 'column_name', 'name', 'field'],
  type: ['타입', '데이터 타입', '자료형', 'type', 'data_type'],
  size: ['크기', '길이', '최대 길이', 'size', 'length', 'max_length'],
  avg: ['평균 길이', '평균 크기', '평균', 'avg', 'avg_bytes', 'avg_length'],
  storage: ['저장 형식', '저장형식', 'storage', 'format'],
  nullable: ['null', 'nullable', 'null 허용'],
  keys: ['키·인덱스', '키/인덱스', '키', '인덱스', 'key', 'keys', 'index'],
  description: ['설명', '비고', 'description', 'comment'],
};
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** 선언 타입(VARCHAR(200), DECIMAL(10,2) …) → 엔진 타입과 길이 */
const TYPE_RULES: [RegExp, Column['type']][] = [
  // 단어 단위로 맞춘다 (interval이 int로, datetime2가 date로 읽히지 않게)
  [/^(bigint|int8|long|bigserial)\b/, 'bigint'],
  [/^(int|integer|int4|int2|smallint|tinyint|mediumint|serial)\b/, 'int'],
  [/^(bool|boolean)\b/, 'bool'],
  [/^(float|float4|float8|double|double precision|real)\b/, 'float'],
  [/^(decimal|numeric|number|money)\b/, 'numeric'],
  [/^uuid\b/, 'uuid'],
  [/^(timestamp|timestamptz|datetime|datetime2)\b/, 'timestamp'],
  [/^date\b/, 'date'],
  [/^(json|jsonb)\b/, 'json'],
  [/^(blob|bytea|binary|varbinary|bytes|raw|long raw)\b/, 'bytes'],
  [/^(varchar|varchar2|nvarchar2|char|text|string|nvarchar|nchar|clob|nclob|character varying|character)\b/, 'text'],
];
function parseType(raw: string): { type: Column['type']; length?: number } | undefined {
  const s = norm(raw);
  const rule = TYPE_RULES.find(([re]) => re.test(s));
  if (!rule) return undefined;
  const len = s.match(/\((\d+)/)?.[1];
  return { type: rule[1], ...(len && (rule[1] === 'text' || rule[1] === 'bytes') && { length: Number(len) }) };
}

const STORAGE_WORDS: [RegExp, (typeof STORAGE_FORMATS)[number]][] = [
  [/integer|int|정수/, 'integer'],
  [/real|float|double|실수/, 'real'],
  [/blob|binary|바이너리|이진/, 'blob'],
  [/text|string|문자/, 'text'],
];
const parseStorage = (raw: string) => STORAGE_WORDS.find(([re]) => re.test(norm(raw)))?.[1];

const parseBool = (raw: string): boolean | undefined => {
  const s = norm(raw);
  if (['y', 'yes', 'true', 'o', '1', 'null', '허용'].includes(s)) return true;
  if (['n', 'no', 'false', 'x', '0', 'not null', '불가'].includes(s)) return false;
  return undefined;
};

/** 키 칸: "PK", "PK:2", "UQ:uq_email", "idx_user_time:2". 숫자는 키 안의 컬럼 순서 */
type KeyRef = { kind: 'pk' | 'index'; name: string; unique: boolean; order: number };
function parseKeys(raw: string): KeyRef[] | string {
  const out: KeyRef[] = [];
  for (const tok of raw.split(/[,\s]+/).filter(Boolean)) {
    const parts = tok.split(':');
    const head = parts[0].toUpperCase();
    const [name, order] = head === 'PK' ? ['PK', parts[1]] : head === 'UQ' ? [parts[1], parts[2]] : [parts[0], parts[1]];
    if (!name || !/^[A-Za-z_]\w*$/.test(name) || (order !== undefined && !/^\d+$/.test(order)) || parts.length > (head === 'UQ' ? 3 : 2)) {
      return `키 표기를 읽을 수 없음: ${tok} (예: PK, PK:2, UQ:uq_email, idx_user_time:2)`;
    }
    out.push({ kind: head === 'PK' ? 'pk' : 'index', name, unique: head === 'PK' || head === 'UQ', order: Number(order ?? 1) });
  }
  return out;
}

/** 따옴표("a,b")와 따옴표 안 줄바꿈을 처리하는 작은 구분자 파서 */
function splitRows(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export function parseSpec(text: string): SpecResult {
  // 앞 빈 줄과 머리 줄 앞 탭 아닌 공백(BOM 포함, \s에 듦)·뒤 공백만 지운다. trim()은 머리 줄 앞 탭까지 지워 빈 첫 열을 붙여 넣으면 칸이 밀렸다
  const trimmed = text.replace(/^(?:\s*\n)?[^\S\t]*/, '').trimEnd();
  if (!trimmed.trim()) return { tables: [], errors: ['명세서가 비어 있음'] };
  if (/^\s*[[{]/.test(trimmed)) return parseJson(trimmed);
  return parseDelimited(trimmed, trimmed.split('\n')[0].includes('\t') ? '\t' : ',');
}

function parseJson(text: string): SpecResult {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { return { tables: [], errors: [`JSON을 읽을 수 없음: ${(e as Error).message}`] }; }
  const list = Array.isArray(data) ? data : (data as { tables?: unknown }).tables;
  if (!Array.isArray(list)) return { tables: [], errors: ['JSON은 테이블 배열이거나 { "tables": [...] } 이어야 함'] };
  const tables: TableT[] = [];
  const errors: string[] = [];
  list.forEach((raw, i) => {
    const r = Table.safeParse(raw);
    const name = (raw as { name?: string })?.name ?? `${i + 1}번째 테이블`;
    if (!r.success) errors.push(...r.error.issues.map((x) => `${name}: ${x.path.join('.')} ${x.message}`));
    else {
      const bad = checkTable(r.data);
      if (bad.length) errors.push(...bad.map((e) => `${name}: ${e}`));
      else tables.push(r.data);
    }
  });
  return { tables, errors };
}

function parseDelimited(text: string, sep: string): SpecResult {
  const rows = splitRows(text, sep);
  const header = rows[0].map(norm);
  const col: Partial<Record<keyof typeof HEADERS, number>> = {};
  for (const [field, names] of Object.entries(HEADERS)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) col[field as keyof typeof HEADERS] = i;
  }
  const missing = (['table', 'column', 'type'] as const).filter((f) => col[f] === undefined);
  if (missing.length) return { tables: [], errors: [`첫 줄에 머리글이 필요함: ${missing.map((f) => HEADERS[f][0]).join(', ')}`] };

  const errors: string[] = [];
  // 테이블 이름 → 컬럼과 키 참조(표에 나온 순서 유지)
  const byTable = new Map<string, { columns: z.input<typeof Column>[]; keys: (KeyRef & { column: string })[] }>();
  rows.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (f: keyof typeof HEADERS) => (col[f] === undefined ? '' : (cells[col[f]!] ?? '').trim());
    if (cells.every((c) => !c.trim())) return;
    const table = get('table'), name = get('column'), rawType = get('type');
    if (!table || !name || !rawType) return errors.push(`${line}번째 줄: 테이블·컬럼·타입이 모두 있어야 함`);
    const t = parseType(rawType);
    if (!t) return errors.push(`${line}번째 줄: 모르는 타입 ${rawType}`);
    const size = get('size'), avg = get('avg'), storage = get('storage'), nullable = get('nullable'), keys = get('keys');
    const num = (s: string, what: string) => {
      const v = Number(s.replace(/[^\d.]/g, ''));
      if (!(v > 0)) { errors.push(`${line}번째 줄: ${what}가 숫자가 아님 (${s})`); return undefined; }
      return v;
    };
    const length = t.length ?? (size && (t.type === 'text' || t.type === 'bytes') ? num(size, '크기') : undefined);
    const avgBytes = avg ? num(avg, '평균 길이') : undefined;
    const st = storage ? parseStorage(storage) : undefined;
    if (storage && !st) errors.push(`${line}번째 줄: 모르는 저장 형식 ${storage} (기본값 사용)`);
    const nb = nullable ? parseBool(nullable) : false;
    if (nb === undefined) errors.push(`${line}번째 줄: NULL 칸을 읽을 수 없음 ${nullable} (NOT NULL로 봄)`);
    const k = keys ? parseKeys(keys) : [];
    if (typeof k === 'string') return errors.push(`${line}번째 줄: ${k}`);

    const entry = byTable.get(table) ?? { columns: [], keys: [] };
    entry.columns.push({
      name, type: t.type,
      ...(st && { storage: st }),
      ...(length && { max_length: Math.round(length) }),
      ...(avgBytes && { avg_bytes: avgBytes }),
      nullable: nb ?? false,
      ...(get('description') && { description: get('description') }),
    });
    entry.keys.push(...k.map((x) => ({ ...x, column: name })));
    byTable.set(table, entry);
  });

  const tables: TableT[] = [];
  for (const [name, { columns, keys }] of byTable) {
    const ordered = (ks: typeof keys) => [...ks].sort((a, b) => a.order - b.order).map((x) => x.column);
    const indexNames = [...new Set(keys.filter((x) => x.kind === 'index').map((x) => x.name))];
    const r = Table.safeParse({
      name, columns,
      primary_key: ordered(keys.filter((x) => x.kind === 'pk')),
      indexes: indexNames.map((ix) => {
        const ks = keys.filter((x) => x.kind === 'index' && x.name === ix);
        return { name: ix, columns: ordered(ks), unique: ks.some((x) => x.unique) };
      }),
    });
    if (!r.success) { errors.push(...r.error.issues.map((x) => `${name}: ${x.path.join('.')} ${x.message}`)); continue; }
    const bad = checkTable(r.data);
    if (bad.length) errors.push(...bad.map((e) => `${name}: ${e}`));
    else tables.push(r.data);
  }
  return { tables, errors };
}
