// 테이블 명세 → DB별 스키마(CREATE TABLE·INDEX, 주석)와 데이터 사전 CSV
import { csvCell, safe } from './interfaces';
import { featureTables } from './tables';
import { storageOf, type CatalogItem, type Column, type Project, type ProjectNode, type Table } from './schema';

/** postgres·mysql·sqlite는 그 문법 그대로, generic은 표준 SQL에 가까운 형태(대상 시스템에 맞게 고쳐 씀). document·kv 저장소는 DDL이 없다 */
export type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'generic';
const FAMILY: Record<string, Dialect> = { postgresql: 'postgres', mysql: 'mysql', sqlite: 'sqlite' };

/** 노드 주 항목에서 SQL 방언을 정한다 (Neon·Supabase → PostgreSQL처럼 same_as를 따라감). 문서·키값 저장소면 undefined */
export function dialectOf(n: ProjectNode, byId: Map<string, CatalogItem>): Dialect | undefined {
  const it = n.primary ? byId.get(n.primary) : undefined;
  const st = it?.storage;
  const id = st && 'same_as' in st ? st.same_as : it?.id;
  const layout = st && 'same_as' in st ? (byId.get(st.same_as)?.storage as { layout?: string } | undefined)?.layout : st?.layout;
  if (layout === 'document' || layout === 'kv') return undefined;
  return (id && FAMILY[id]) || 'generic';
}

const q = (d: Dialect, s: string) => (d === 'mysql' ? `\`${s.replace(/`/g, '``')}\`` : `"${s.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** 컬럼의 DB 타입. 길이(max_length)는 바이트 값 그대로 씀. 고정장 테이블의 text·bytes는 CHAR(n)·BINARY(n) */
export function sqlType(c: Column, d: Dialect, fixed = false): string {
  const n = c.max_length;
  const blob = storageOf(c) === 'blob', txt = storageOf(c) === 'text';
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
      if (n) return `${fixed ? 'CHAR' : 'VARCHAR'}(${n})`;
      return d === 'generic' ? 'VARCHAR(4000)' : 'TEXT';
    case 'bytes':
      if (d === 'postgres') return 'BYTEA';
      if (d === 'sqlite') return 'BLOB';
      if (n) return `${fixed ? 'BINARY' : 'VARBINARY'}(${n})`;
      return 'BLOB';
  }
}

/** 기본값: 숫자·true/false/null·CURRENT_TIMESTAMP 같은 키워드는 그대로, 나머지는 문자열 */
const defaultSql = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) || /^(true|false|null|current_timestamp|current_date)$/i.test(v) ? v : lit(v));
const comment = (x: { label?: string; description?: string }) => [x.label, x.description].filter(Boolean).join(' — ');

export function tableDdl(t: Table, d: Dialect): string {
  const fixed = t.record === 'fixed';
  const cols = t.columns.map((c) => {
    const parts = [q(d, c.name), sqlType(c, d, fixed)];
    if (!c.nullable) parts.push('NOT NULL');
    if (c.default_value !== undefined) parts.push(`DEFAULT ${defaultSql(c.default_value)}`);
    if (c.codes?.length) parts.push(`CHECK (${q(d, c.name)} IN (${c.codes.map((x) => (c.type === 'int' || c.type === 'bigint') && /^-?\d+$/.test(x.code) ? x.code : lit(x.code)).join(', ')}))`);
    if (d === 'mysql' && comment(c)) parts.push(`COMMENT ${lit(comment(c))}`);
    return `  ${parts.join(' ')}`;
  });
  if (t.primary_key.length) cols.push(`  PRIMARY KEY (${t.primary_key.map((c) => q(d, c)).join(', ')})`);
  // SQLite는 주석 문법이 없어 줄 끝 주석으로 남긴다
  const body = d === 'sqlite'
    ? cols.map((l, k) => { const c = t.columns[k]; return `${l}${k < cols.length - 1 ? ',' : ''}${c && comment(c) ? ` -- ${comment(c).replace(/\r?\n/g, ' ')}` : ''}`; }).join('\n')
    : cols.join(',\n');
  const out = [`${d === 'sqlite' && comment(t) ? `-- ${comment(t).replace(/\r?\n/g, ' ')}\n` : ''}CREATE TABLE ${q(d, t.name)} (\n${body}\n)${d === 'mysql' && comment(t) ? ` COMMENT=${lit(comment(t))}` : ''};`];
  for (const ix of t.indexes) out.push(`CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(d, ix.name)} ON ${q(d, t.name)} (${ix.columns.map((c) => q(d, c)).join(', ')});`);
  if (d === 'postgres' || d === 'generic') {
    if (comment(t)) out.push(`COMMENT ON TABLE ${q(d, t.name)} IS ${lit(comment(t))};`);
    for (const c of t.columns) if (comment(c)) out.push(`COMMENT ON COLUMN ${q(d, t.name)}.${q(d, c.name)} IS ${lit(comment(c))};`);
  }
  return out.join('\n');
}

const DIALECT_NAME: Record<Dialect, string> = { postgres: 'PostgreSQL', mysql: 'MySQL', sqlite: 'SQLite', generic: '표준 SQL에 가까운 형태 (대상 시스템에 맞게 고쳐 쓰세요)' };

/** 노드별 schema-노드.sql. 문서·키값 저장소 노드는 건너뛴다 (데이터 사전에는 나옴) */
export function ddlFiles(p: Project, byId: Map<string, CatalogItem>): { name: string; text: string }[] {
  return p.nodes.filter((n) => n.tables.length).flatMap((n) => {
    const d = dialectOf(n, byId);
    if (!d) return [];
    const head = [`-- ${n.name.includes(n.id) ? n.name : `${n.name} (${n.id})`} · ${DIALECT_NAME[d]}`, '-- 길이는 테이블 명세의 최대 길이(바이트)를 그대로 씀. PostgreSQL·MySQL의 VARCHAR(n)은 글자 수라 한글(UTF-8 3바이트)이면 넉넉함', '-- 파티션·보관 기간은 넣지 않음'].join('\n');
    return [{ name: `schema-${safe(n.id)}.sql`, text: [head, ...n.tables.map((t) => tableDdl(t, d))].join('\n\n') + '\n' }];
  });
}

/** 데이터 사전(CSV, BOM): 컬럼마다 한 줄. 쓰는·읽는 기능은 행동과 인터페이스의 테이블 연결에서 */
export function dataDictionaryCsv(p: Project, byId: Map<string, CatalogItem>): string {
  const feats = featureTables(p);
  const who = (node: string, table: string, op: 'read' | 'write') => feats.filter((f) => f.tables.some((t) => t.node === node && t.table === table && t.op === op)).map((f) => f.name).join(' / ');
  const cols = ['노드', '테이블', '테이블 논리명', '테이블 설명', '장 형식', '순번', '컬럼', '논리명', '타입', 'DB 타입', '최대 길이(B)', '필수', '기본값', 'PK', '도메인', '코드 값', '개인정보', '설명', '쓰는 기능', '읽는 기능'];
  const rows = p.nodes.flatMap((n) => {
    const d = dialectOf(n, byId);
    return n.tables.flatMap((t) => t.columns.map((c, k) => [
      n.name, t.name, t.label, t.description, t.record === 'fixed' ? '고정장' : '가변장', k + 1, c.name, c.label, c.type, d ? sqlType(c, d, t.record === 'fixed') : '', c.max_length,
      c.nullable ? 'N' : 'Y', c.default_value, t.primary_key.includes(c.name) ? 'Y' : '', c.domain, c.codes?.map((x) => (x.label ? `${x.code}=${x.label}` : x.code)).join('; '),
      c.personal ? 'Y' : '', c.description, who(n.id, t.name, 'write'), who(n.id, t.name, 'read'),
    ]));
  });
  return '﻿' + [cols, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** 내보낼 파일 전부: 노드별 schema-….sql과 data-dictionary.csv. 테이블이 없으면 빈 목록 */
export const schemaFiles = (p: Project, byId: Map<string, CatalogItem>) =>
  p.nodes.some((n) => n.tables.length) ? [...ddlFiles(p, byId), { name: 'data-dictionary.csv', text: dataDictionaryCsv(p, byId) }] : [];
