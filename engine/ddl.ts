// 테이블 명세 → DB별 스키마(CREATE TABLE·INDEX, 주석)와 데이터 사전 CSV
import { csvCell, safe, uniqueNames } from './interfaces';
import { featureTables } from './tables';
import { fitsType, isNullText, nodeStorageProfile, storageOf, type CatalogItem, type Column, type Project, type ProjectNode, type Table } from './schema';

/** postgres·mysql·sqlite는 그 문법 그대로, generic은 표준 SQL에 가까운 형태(대상 시스템에 맞게 고쳐 씀). document·kv 저장소와 캐시는 DDL이 없다 */
export type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'generic';
// CockroachDB는 PostgreSQL 문법(와이어 호환)을 쓴다
const FAMILY: Record<string, Dialect> = { postgresql: 'postgres', mysql: 'mysql', sqlite: 'sqlite', cockroachdb: 'postgres' };

/** 노드 주 항목에서 SQL 방언을 정한다 (Neon·Supabase → PostgreSQL처럼 same_as를 따라감). 문서·키값 저장소와 캐시 노드면 undefined */
export function dialectOf(n: ProjectNode, byId: Map<string, CatalogItem>): Dialect | undefined {
  if (n.layer === 'cache') return undefined;
  const it = n.primary ? byId.get(n.primary) : undefined;
  const st = it?.storage;
  const id = st && 'same_as' in st ? st.same_as : it?.id;
  const layout = st && 'same_as' in st ? (byId.get(st.same_as)?.storage as { layout?: string } | undefined)?.layout : st?.layout;
  if (layout === 'document' || layout === 'kv') return undefined;
  return (id && FAMILY[id]) || 'generic';
}

const q = (d: Dialect, s: string) => (d === 'mysql' ? `\`${s.replace(/`/g, '``')}\`` : `"${s.replace(/"/g, '""')}"`);
// MySQL은 문자열 안의 백슬래시를 이스케이프로 읽는다
const lit = (s: string, d: Dialect) => `'${(d === 'mysql' ? s.replace(/\\/g, '\\\\') : s).replace(/'/g, "''")}'`;
/** 기본 키·인덱스에 쓰이는 컬럼 */
export const keyCols = (t: Table) => new Set([...t.primary_key, ...t.indexes.flatMap((ix) => ix.columns)]);

/** 컬럼의 DB 타입. 길이(max_length)는 바이트 값 그대로 씀. 고정장 테이블의 text·bytes는 CHAR(n)·BINARY(n).
 *  key: 기본 키·인덱스 컬럼 (MySQL은 길이 없는 TEXT·BLOB을 키로 못 써서 VARCHAR·VARBINARY(255)) */
export function sqlType(c: Column, d: Dialect, fixed = false, key = false): string {
  const n = c.max_length;
  const blob = storageOf(c) === 'blob', txt = storageOf(c) === 'text';
  // MySQL의 CHAR·BINARY는 255까지
  const fix = fixed && !(d === 'mysql' && (n ?? 0) > 255);
  switch (c.type) {
    case 'int': return d === 'mysql' ? 'INT' : 'INTEGER';
    case 'bigint': return d === 'sqlite' ? 'INTEGER' : 'BIGINT';
    case 'float': return d === 'mysql' ? 'DOUBLE' : d === 'sqlite' ? 'REAL' : 'DOUBLE PRECISION';
    // MySQL의 정밀도 없는 DECIMAL은 소수점이 없어(DECIMAL(10,0)) 금액에 흔한 19,4를 씀
    case 'numeric': return d === 'mysql' ? 'DECIMAL(19,4)' : 'NUMERIC';
    case 'bool': return d === 'sqlite' ? 'INTEGER' : 'BOOLEAN';
    case 'uuid': return d === 'postgres' ? 'UUID' : d === 'sqlite' ? (txt ? 'TEXT' : 'BLOB') : blob ? 'BINARY(16)' : 'CHAR(36)';
    case 'timestamp': return d === 'postgres' ? 'TIMESTAMPTZ' : d === 'mysql' ? 'DATETIME(6)' : d === 'sqlite' ? (txt ? 'TEXT' : 'INTEGER') : 'TIMESTAMP';
    case 'date': return d === 'sqlite' ? (txt ? 'TEXT' : 'INTEGER') : 'DATE';
    case 'json': return d === 'postgres' ? 'JSONB' : d === 'mysql' ? 'JSON' : 'TEXT';
    case 'text':
      if (d === 'sqlite') return 'TEXT';
      if (n) return `${fix ? 'CHAR' : 'VARCHAR'}(${n})`;
      return d === 'generic' ? 'VARCHAR(4000)' : d === 'mysql' && key ? 'VARCHAR(255)' : 'TEXT';
    case 'bytes':
      if (d === 'postgres') return 'BYTEA';
      if (d === 'sqlite') return 'BLOB';
      if (n) return `${fix ? 'BINARY' : 'VARBINARY'}(${n})`;
      return d === 'mysql' && key ? 'VARBINARY(255)' : 'BLOB';
  }
}

/** 지금 시각·날짜. SQLite 정수는 epoch 밀리초·1970-01-01부터 날 수, 실수는 율리우스일 (SQLite 실험의 가짜 값과 같은 뜻) */
function nowSql(c: Column, d: Dialect, date: boolean): string {
  const s = storageOf(c);
  if (d === 'sqlite' && s === 'integer') return date ? "(CAST(julianday('now') - 2440587.5 AS INTEGER))" : "(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))";
  if (d === 'sqlite' && s === 'real') return date ? "(julianday('now', 'start of day'))" : "(julianday('now'))";
  // MySQL DATETIME(6)은 같은 정밀도의 CURRENT_TIMESTAMP(6)만, DATE는 괄호 식으로만 받는다
  if (d === 'mysql') return date ? '(CURRENT_DATE)' : 'CURRENT_TIMESTAMP(6)';
  return date ? 'CURRENT_DATE' : 'CURRENT_TIMESTAMP';
}
/** 값 하나(기본값·코드 값)를 컬럼 타입대로: 숫자는 그대로, bool은 참·거짓, 시각·날짜 키워드는 지금, 나머지는 문자열. 타입에 안 맞는 값(checkTable이 알림)은 문자열 */
function valueSql(c: Column, v: string, d: Dialect): string {
  if (!fitsType(c.type, v)) return lit(v, d);
  switch (c.type) {
    case 'int': case 'bigint': case 'float': case 'numeric': return v;
    case 'bool': { const yes = /^(true|1)$/i.test(v); return d === 'sqlite' ? (yes ? '1' : '0') : yes ? 'TRUE' : 'FALSE'; }
    case 'timestamp': return /^current_timestamp$/i.test(v) ? nowSql(c, d, false) : lit(v, d);
    case 'date': return /^current_date$/i.test(v) ? nowSql(c, d, true) : lit(v, d);
    default: return lit(v, d);
  }
}
/** 기본값. MySQL은 TEXT·BLOB·JSON 컬럼의 기본값을 괄호 식으로만 받는다 (8.0.13부터) */
function defaultSql(c: Column, d: Dialect, type: string): string {
  if (isNullText(c.default_value!)) return 'NULL';
  const v = valueSql(c, c.default_value!, d);
  return d === 'mysql' && /^(TEXT|BLOB|JSON)$/.test(type) && !v.startsWith('(') ? `(${v})` : v;
}
const comment = (x: { label?: string; description?: string }) => [x.label, x.description].filter(Boolean).join(' — ');

/** withIndexes: false면 CREATE INDEX를 뺀다 (열 저장 분석 DB는 행 인덱스가 없음) */
export function tableDdl(t: Table, d: Dialect, withIndexes = true): string {
  const fixed = t.record === 'fixed', keys = keyCols(t);
  const cols = t.columns.map((c) => {
    const type = sqlType(c, d, fixed, keys.has(c.name));
    const parts = [q(d, c.name), type];
    if (!c.nullable) parts.push('NOT NULL');
    if (c.default_value !== undefined) parts.push(`DEFAULT ${defaultSql(c, d, type)}`);
    if (c.codes?.length) parts.push(`CHECK (${q(d, c.name)} IN (${c.codes.map((x) => valueSql(c, x.code, d)).join(', ')}))`);
    if (d === 'mysql' && comment(c)) parts.push(`COMMENT ${lit(comment(c), d)}`);
    return `  ${parts.join(' ')}`;
  });
  if (t.primary_key.length) cols.push(`  PRIMARY KEY (${t.primary_key.map((c) => q(d, c)).join(', ')})`);
  // SQLite는 주석 문법이 없어 줄 끝 주석으로 남긴다
  const body = d === 'sqlite'
    ? cols.map((l, k) => { const c = t.columns[k]; return `${l}${k < cols.length - 1 ? ',' : ''}${c && comment(c) ? ` -- ${comment(c).replace(/\r?\n/g, ' ')}` : ''}`; }).join('\n')
    : cols.join(',\n');
  const out = [`${d === 'sqlite' && comment(t) ? `-- ${comment(t).replace(/\r?\n/g, ' ')}\n` : ''}CREATE TABLE ${q(d, t.name)} (\n${body}\n)${d === 'mysql' && comment(t) ? ` COMMENT=${lit(comment(t), d)}` : ''};`];
  for (const ix of withIndexes ? t.indexes : []) out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(d, ix.name)} ON ${q(d, t.name)} (${ix.columns.map((c) => q(d, c)).join(', ')});`);
  if (d === 'postgres' || d === 'generic') {
    if (comment(t)) out.push(`COMMENT ON TABLE ${q(d, t.name)} IS ${lit(comment(t), d)};`);
    for (const c of t.columns) if (comment(c)) out.push(`COMMENT ON COLUMN ${q(d, t.name)}.${q(d, c.name)} IS ${lit(comment(c), d)};`);
  }
  return out.join('\n');
}

const DIALECT_NAME: Record<Dialect, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', generic: '표준 SQL에 가까운 형태 (대상 시스템에 맞게 고쳐 쓰세요)' };

/** 노드별 schema-노드.sql (안전한 이름이 겹치면 -2, -3). 문서·키값 저장소와 캐시 노드는 건너뛴다 (데이터 사전에는 나옴) */
export function ddlFiles(p: Project, byId: Map<string, CatalogItem>): { name: string; text: string }[] {
  return uniqueNames(p.nodes.filter((n) => n.tables.length).flatMap((n) => {
    const d = dialectOf(n, byId);
    if (!d) return [];
    const columnar = nodeStorageProfile(n, byId)?.layout === 'columnar';
    const head = [`-- ${(n.name.includes(n.id) ? n.name : `${n.name} (${n.id})`).replace(/[\r\n]+/g, ' ')} · ${DIALECT_NAME[d]}`, '-- 길이는 테이블 명세의 최대 길이(바이트)를 그대로 씀. PostgreSQL·MySQL의 VARCHAR(n)은 글자 수라 한글(UTF-8 3바이트)이면 넉넉함', '-- 파티션·보관 기간은 넣지 않음'].join('\n');
    return [{ name: `schema-${safe(n.id)}.sql`, text: [head, ...n.tables.map((t) => tableDdl(t, d, !columnar))].join('\n\n') + '\n' }];
  }));
}

/** 데이터 사전(CSV, BOM): 컬럼마다 한 줄. 쓰는·읽는 기능은 행동과 인터페이스의 테이블 연결에서 */
export function dataDictionaryCsv(p: Project, byId: Map<string, CatalogItem>): string {
  const feats = featureTables(p);
  const who = (node: string, table: string, op: 'read' | 'write') => feats.filter((f) => f.tables.some((t) => t.node === node && t.table === table && t.op === op)).map((f) => f.name).join(' / ');
  const cols = ['노드', '테이블', '테이블 논리명', '테이블 설명', '장 형식', '순번', '컬럼', '논리명', '타입', 'DB 타입', '최대 길이(B)', '필수', '기본값', 'PK', '도메인', '코드 값', '개인정보', '설명', '쓰는 기능', '읽는 기능'];
  const rows = p.nodes.flatMap((n) => {
    const d = dialectOf(n, byId);
    return n.tables.flatMap((t) => t.columns.map((c, k) => [
      n.name, t.name, t.label, t.description, t.record === 'fixed' ? '고정장' : '가변장', k + 1, c.name, c.label, c.type, d ? sqlType(c, d, t.record === 'fixed', keyCols(t).has(c.name)) : '', c.max_length,
      c.nullable ? 'N' : 'Y', c.default_value, t.primary_key.includes(c.name) ? 'Y' : '', c.domain, c.codes?.map((x) => (x.label ? `${x.code}=${x.label}` : x.code)).join('; '),
      c.personal ? 'Y' : '', c.description, who(n.id, t.name, 'write'), who(n.id, t.name, 'read'),
    ]));
  });
  return '\uFEFF' + [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 내보낼 파일 전부: 노드별 schema-….sql과 data-dictionary.csv. 테이블이 없으면 빈 목록 */
export const schemaFiles = (p: Project, byId: Map<string, CatalogItem>) =>
  p.nodes.some((n) => n.tables.length) ? [...ddlFiles(p, byId), { name: 'data-dictionary.csv', text: dataDictionaryCsv(p, byId) }] : [];
