// 테이블 명세 → DB별 스키마(CREATE TABLE·INDEX, 주석)와 데이터 사전 CSV
import { csvCell, safe, uniqueNames } from './interfaces';
import { featureTables } from './tables';
import { dupes, fitsType, isNullText, nodeStorageProfile, storageOf, type CatalogItem, type Column, type Project, type ProjectNode, type Table } from './schema';

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
  const blob = storageOf(c) === 'blob', txt = storageOf(c) === 'text', real = storageOf(c) === 'real';
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
    case 'timestamp': return d === 'postgres' ? 'TIMESTAMPTZ' : d === 'mysql' ? 'DATETIME(6)' : d === 'sqlite' ? (txt ? 'TEXT' : real ? 'REAL' : 'INTEGER') : 'TIMESTAMP';
    case 'date': return d === 'sqlite' ? (txt ? 'TEXT' : real ? 'REAL' : 'INTEGER') : 'DATE';
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

/** 지금 시각·날짜. SQLite 정수는 epoch 밀리초·1970-01-01부터 날 수, 실수는 율리우스일 (SQLite 실험의 가짜 값과 같은 뜻).
 *  at: SQLite 정수·실수 저장에서 지금 대신 쓸 날짜 글자 */
function nowSql(c: Column, d: Dialect, date: boolean, at = 'now'): string {
  const s = storageOf(c), j = `julianday(${lit(at, d)}`;
  if (d === 'sqlite' && s === 'integer') return date ? `(CAST(${j}) - 2440587.5 AS INTEGER))` : `(CAST((${j}) - 2440587.5) * 86400000 AS INTEGER))`;
  if (d === 'sqlite' && s === 'real') return date ? `(${j}, 'start of day'))` : `(${j}))`;
  // MySQL DATETIME(6)은 같은 정밀도의 CURRENT_TIMESTAMP(6)만, DATE는 괄호 식으로만 받는다
  if (d === 'mysql') return date ? '(CURRENT_DATE)' : 'CURRENT_TIMESTAMP(6)';
  return date ? 'CURRENT_DATE' : 'CURRENT_TIMESTAMP';
}
// MySQL·SQLite는 시간대를 +HH:MM으로만 읽는다 (Z·+09·+0900 → +00:00·+09:00)
const tz = (v: string) => v.replace(/(:\d{2}(?:\.\d+)?)(?:Z|([+-]\d{2}):?(\d{2})?)$/i, (_, t: string, h?: string, m?: string) => `${t}${h ?? '+00'}:${m ?? '00'}`);
/** 값 하나(기본값·코드 값)를 컬럼 타입대로: 숫자는 그대로, bool은 참·거짓, 시각·날짜 키워드는 지금, 나머지는 문자열. 타입에 안 맞는 값(schemaWarnings가 알림)은 문자열 */
function valueSql(c: Column, v: string, d: Dialect): string {
  if (!fitsType(c.type, v)) return lit(v, d);
  switch (c.type) {
    case 'int': case 'bigint': case 'float': case 'numeric': return v;
    case 'bool': { const yes = /^(true|1)$/i.test(v); return d === 'sqlite' ? (yes ? '1' : '0') : yes ? 'TRUE' : 'FALSE'; }
    case 'timestamp': case 'date': {
      const date = c.type === 'date';
      if (/^current_(timestamp|date)$/i.test(v)) return nowSql(c, d, date);
      // SQLite 정수·실수 저장은 지금 시각과 같은 숫자 식으로
      if (d === 'sqlite' && ['integer', 'real'].includes(storageOf(c))) return nowSql(c, d, date, tz(v));
      return lit(d === 'mysql' ? tz(v) : v, d);
    }
    case 'uuid': return d === 'mysql' && storageOf(c) === 'blob' ? `(UUID_TO_BIN(${lit(v, d)}))` : lit(v, d);
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

/** DDL·데이터 사전 품질 경고 (파일 열기·계산은 막지 않음). node = 노드 id, table = 테이블 이름(노드 전체 경고면 없음) */
export function schemaWarnings(p: Project, byId: Map<string, CatalogItem>): { node: string; table?: string; text: string }[] {
  const out: { node: string; table?: string; text: string }[] = [];
  for (const n of p.nodes) {
    const d = dialectOf(n, byId);
    for (const t of n.tables) {
      const warn = (text: string) => out.push({ node: n.id, table: t.name, text });
      for (const c of t.columns) {
        const v = c.default_value;
        if (v !== undefined && isNullText(v)) { if (!c.nullable) warn(`${c.name}: 필수(NOT NULL)인데 기본값이 null`); }
        else if (v !== undefined && !fitsType(c.type, v)) warn(`${c.name}: 기본값이 타입(${c.type})과 안 맞음: ${v}`);
        for (const x of c.codes ?? []) if (!fitsType(c.type, x.code)) warn(`${c.name}: 코드 값이 타입(${c.type})과 안 맞음: ${x.code}`);
      }
      // MySQL(InnoDB) 키 한도 3072바이트. utf8mb4 CHAR·VARCHAR(n)은 n × 4바이트
      if (d === 'mysql') {
        const keys = keyCols(t);
        const bytes = (col: string) => {
          const c = t.columns.find((x) => x.name === col);
          const m = c && /^(VAR)?(CHAR|BINARY)\((\d+)\)$/.exec(sqlType(c, d, t.record === 'fixed', keys.has(col)));
          return m ? Number(m[3]) * (m[2] === 'CHAR' ? 4 : 1) : 0;
        };
        for (const [name, cols] of [['기본 키', t.primary_key], ...t.indexes.map((ix) => [`인덱스 ${ix.name}`, ix.columns])] as [string, string[]][]) {
          const sum = cols.reduce((s, col) => s + bytes(col), 0);
          if (sum > 3072) warn(`${name} (${cols.join(', ')}): utf8mb4로 최대 ${sum}바이트라 MySQL 키 한도 3072바이트를 넘음 (최대 길이를 정하세요)`);
        }
      }
    }
    // PostgreSQL·SQLite는 테이블과 인덱스가 한 이름 공간이라 겹치면 DDL이 실패한다 (MySQL은 테이블마다 따로, 열 저장은 CREATE INDEX 없음)
    if ((d === 'postgres' || d === 'sqlite' || d === 'generic') && nodeStorageProfile(n, byId)?.layout !== 'columnar') {
      for (const x of dupes([...n.tables.map((t) => t.name), ...n.tables.flatMap((t) => [...new Set(t.indexes.map((ix) => ix.name))])])) out.push({ node: n.id, text: `테이블·인덱스 이름 중복 ${x} (이 DB는 한 이름 공간이라 DDL이 실패함)` });
    }
  }
  for (const e of p.edges) for (const i of e.interfaces) {
    // 필드 이름은 영문·숫자·_라서, 구분자가 그 밖의 글자여야 머리줄·값과 섞이지 않는다
    if (i.kind === 'file' && i.record?.format === 'delimited' && /[A-Za-z0-9_]/.test(i.record.delimiter)) out.push({ node: e.to, text: `${i.name}: 구분자 "${i.record.delimiter}"에 영문·숫자·_가 있어 필드 이름·값과 섞일 수 있음` });
  }
  return out;
}

/** 노드별 schema-노드.sql (안전한 이름이 겹치면 -2, -3). 문서·키값 저장소와 캐시 노드는 건너뛴다 (데이터 사전에는 나옴) */
export function ddlFiles(p: Project, byId: Map<string, CatalogItem>): { name: string; text: string }[] {
  const warns = schemaWarnings(p, byId);
  return uniqueNames(p.nodes.filter((n) => n.tables.length).flatMap((n) => {
    const d = dialectOf(n, byId);
    if (!d) return [];
    const columnar = nodeStorageProfile(n, byId)?.layout === 'columnar';
    const head = [`-- ${(n.name.includes(n.id) ? n.name : `${n.name} (${n.id})`).replace(/[\r\n]+/g, ' ')} · ${DIALECT_NAME[d]}`, '-- 길이는 테이블 명세의 최대 길이(바이트)를 그대로 씀. PostgreSQL·MySQL의 VARCHAR(n)은 글자 수라 한글(UTF-8 3바이트)이면 넉넉함', '-- 파티션·보관 기간은 넣지 않음',
      ...warns.filter((w) => w.node === n.id).map((w) => `-- 주의: ${w.table ? `${w.table}.` : ''}${w.text}`.replace(/[\r\n]+/g, ' '))].join('\n');
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
    return n.tables.flatMap((t) => { const keys = keyCols(t); return t.columns.map((c, k) => [
      n.name, t.name, t.label, t.description, t.record === 'fixed' ? '고정장' : '가변장', k + 1, c.name, c.label, c.type, d ? sqlType(c, d, t.record === 'fixed', keys.has(c.name)) : '', c.max_length,
      c.nullable ? 'N' : 'Y', c.default_value, t.primary_key.includes(c.name) ? 'Y' : '', c.domain, c.codes?.map((x) => (x.label ? `${x.code}=${x.label}` : x.code)).join('; '),
      c.personal ? 'Y' : '', c.description, who(n.id, t.name, 'write'), who(n.id, t.name, 'read'),
    ]); });
  });
  return '\uFEFF' + [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 내보낼 파일 전부: 노드별 schema-….sql과 data-dictionary.csv. 테이블이 없으면 빈 목록 */
export const schemaFiles = (p: Project, byId: Map<string, CatalogItem>) =>
  p.nodes.some((n) => n.tables.length) ? [...ddlFiles(p, byId), { name: 'data-dictionary.csv', text: dataDictionaryCsv(p, byId) }] : [];
