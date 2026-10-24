// SQLite 실험: 테이블 정의로 실제 SQLite(sql.js, WebAssembly)에 테이블을 만들고 가짜 데이터를 넣어 크기를 잰다.
// 테이블만 있는 DB(A)와 인덱스까지 있는 DB(B)에 같은 행을 차례로 넣고, 페이지 수 차이로 행·인덱스 크기를 나눈다.
// 인덱스를 나중에 한 번에 만들면 빽빽하게 채워져 실제(행이 하나씩 들어옴)보다 작게 나오므로 처음부터 만든다.
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import { storageOf, type Column, type Table } from '../../engine/schema';
import { intPk, valueBytes } from '../../engine/tables';
import { rng } from '../../engine/traffic';

export type LabResult = {
  rows: number;
  /** 행 1개당 테이블 바이트 (페이지 낭비 포함) */
  rowBytes: number;
  /** 행 1개당 인덱스 바이트 (테이블과 따로 저장되는 기본 키 포함) */
  indexBytes: number;
  /** 인덱스까지 있는 DB에 트랜잭션 하나로 넣은 속도. 브라우저·PC마다 달라 참고값 */
  insertsPerSec: number;
  pageSize: number;
  ddl: string[];
};

const AFFINITY = { integer: 'INTEGER', real: 'REAL', text: 'TEXT', blob: 'BLOB' } as const;
const q = (name: string) => `"${name.replace(/"/g, '""')}"`;


export function ddlFor(t: Table, withoutRowid = false): { table: string; indexes: string[] } {
  const inTable = intPk(t) || (withoutRowid && t.primary_key.length > 0);
  const cols = t.columns.map((c) => `${q(c.name)} ${AFFINITY[storageOf(c)]}${c.nullable ? '' : ' NOT NULL'}`);
  const pk = inTable ? [`PRIMARY KEY (${t.primary_key.map(q).join(', ')})`] : [];
  const table = `CREATE TABLE ${q(t.name)} (${[...cols, ...pk].join(', ')})${inTable && withoutRowid && !intPk(t) ? ' WITHOUT ROWID' : ''}`;
  const indexes = [
    ...(!inTable && t.primary_key.length ? [`CREATE UNIQUE INDEX ${q(`pk_${t.name}`)} ON ${q(t.name)} (${t.primary_key.map(q).join(', ')})`] : []),
    ...t.indexes.map((ix) => `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(ix.name)} ON ${q(t.name)} (${ix.columns.map(q).join(', ')})`),
  ];
  return { table, indexes };
}

/** 컬럼 하나의 가짜 값. 길이는 크기 계산(valueBytes)과 같은 값을 써서 실험과 계산이 같은 가정을 쓰게 한다 */
function fakeValue(c: Column, r: () => number, i: number, sequential: boolean): SqlValue {
  const storage = storageOf(c);
  const len = Math.max(1, Math.round(valueBytes(c)));
  const text = (n: number) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(r() * 26))).join('');
  const bytes = (n: number) => Uint8Array.from({ length: n }, () => Math.floor(r() * 256));
  const time = 1.7e12 + Math.floor(r() * 3e10);
  if (sequential) return i + 1;
  if (storage === 'integer') {
    if (c.type === 'bool') return r() < 0.5 ? 0 : 1;
    if (c.type === 'date') return 20_000 + Math.floor(r() * 1000);
    if (c.type === 'timestamp') return time;
    // shortcut: 정수는 1천만 미만 무작위 값으로 넣는다(SQLite는 크기에 따라 1~8바이트). 값 범위가 다르면 실측이 달라진다
    return Math.floor(r() * 1e7);
  }
  if (storage === 'real') return r() * 1e6;
  if (storage === 'text') {
    if (c.type === 'timestamp') return new Date(time).toISOString();
    if (c.type === 'date') return new Date(time).toISOString().slice(0, 10);
    if (c.type === 'uuid') return crypto.randomUUID();
    return text(len);
  }
  return c.type === 'uuid' ? bytes(16) : bytes(len);
}

const sizeOf = (db: Database) => Number(db.exec('PRAGMA page_count')[0].values[0][0]) * Number(db.exec('PRAGMA page_size')[0].values[0][0]);

export function runSqliteLab(SQL: SqlJsStatic, t: Table, opts: { rows?: number; seed?: number; withoutRowid?: boolean } = {}): LabResult {
  const rows = opts.rows ?? 10_000;
  const { table, indexes } = ddlFor(t, opts.withoutRowid);
  const a = new SQL.Database();
  const b = new SQL.Database();
  try {
    a.run(table);
    b.run(table);
    for (const ix of indexes) b.run(ix);
    const emptyA = sizeOf(a), emptyB = sizeOf(b);
    const insert = `INSERT OR IGNORE INTO ${q(t.name)} (${t.columns.map((c) => q(c.name)).join(', ')}) VALUES (${t.columns.map(() => '?').join(', ')})`;
    const sa = a.prepare(insert), sb = b.prepare(insert);
    const r = rng(opts.seed ?? 1);
    const seqPk = intPk(t) ? t.primary_key[0] : undefined;
    const data = Array.from({ length: rows }, (_, i) => t.columns.map((c) => fakeValue(c, r, i, c.name === seqPk)));

    a.run('BEGIN');
    for (const v of data) sa.run(v);
    a.run('COMMIT');
    const start = performance.now();
    b.run('BEGIN');
    for (const v of data) sb.run(v);
    b.run('COMMIT');
    const ms = performance.now() - start;
    sa.free(); sb.free();

    const count = Number(a.exec(`SELECT count(*) FROM ${q(t.name)}`)[0].values[0][0]);
    const tableBytes = sizeOf(a) - emptyA;
    return {
      rows: count,
      rowBytes: tableBytes / count,
      indexBytes: Math.max(0, sizeOf(b) - emptyB - tableBytes) / count,
      insertsPerSec: rows / (ms / 1000),
      pageSize: Number(a.exec('PRAGMA page_size')[0].values[0][0]),
      ddl: [table, ...indexes],
    };
  } finally {
    a.close();
    b.close();
  }
}

/** 브라우저에서 sql.js를 처음 쓸 때만 내려받는다 (약 1MB) */
let loading: Promise<SqlJsStatic> | undefined;
export function loadSqlJs(): Promise<SqlJsStatic> {
  loading ??= Promise.all([import('sql.js'), import('sql.js/dist/sql-wasm.wasm?url')])
    .then(([mod, wasm]) => mod.default({ locateFile: () => wasm.default }));
  return loading;
}
