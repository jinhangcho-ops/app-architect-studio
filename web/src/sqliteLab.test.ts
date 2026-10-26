import initSqlJs from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { Table } from '../../engine/schema';
import { ddlFor, runSqliteLab } from './sqliteLab';

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => { SQL = await initSqlJs(); });

const table = (t: object) => Table.parse(t);
const intPk = table({ name: 'users', columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'text', avg_bytes: 20 }], primary_key: ['id'] });
const orders = table({
  name: 'orders',
  columns: [{ name: 'id', type: 'uuid' }, { name: 'user_id', type: 'bigint' }, { name: 'created_at', type: 'timestamp' }],
  primary_key: ['id'],
  indexes: [{ name: 'idx_user_time', columns: ['user_id', 'created_at'] }],
});

describe('SQLite 실험: 큰 행 (감사 11)', () => {
  it('최대 길이 1MB 본문 컬럼도 몇 초 안에 끝나고, 행 수를 줄여 행당 크기를 잼', () => {
    const big = table({ name: 'posts', columns: [{ name: 'id', type: 'bigint' }, { name: 'body', type: 'text', max_length: 1_000_000 }], primary_key: ['id'] });
    const t0 = performance.now();
    const r = runSqliteLab(SQL, big);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(r.rows).toBeLessThan(10_000);
    expect(r.rowBytes).toBeGreaterThan(400_000);
  });
  it('컬럼이 SQLite 한도(2000)를 넘으면 한국어로 알림', () => {
    const wide = table({ name: 'w', columns: Array.from({ length: 2001 }, (_, k) => ({ name: `c${k}`, type: 'bigint' })) });
    expect(() => runSqliteLab(SQL, wide)).toThrow('SQLite는 컬럼을 2000개까지만');
  });
});

describe('SQLite 실험 (sql.js)', () => {
  it('DDL: 정수 한 컬럼 기본 키는 테이블 안(rowid), uuid 기본 키는 고유 인덱스로 따로', () => {
    expect(ddlFor(intPk).table).toBe('CREATE TABLE "users" ("id" INTEGER NOT NULL, "name" TEXT NOT NULL, PRIMARY KEY ("id"))');
    expect(ddlFor(intPk).indexes).toEqual([]);
    expect(ddlFor(orders).indexes).toEqual([
      'CREATE UNIQUE INDEX "pk_orders" ON "orders" ("id")',
      'CREATE INDEX "idx_user_time" ON "orders" ("user_id", "created_at")',
    ]);
    expect(ddlFor(orders, true).table).toMatch(/PRIMARY KEY \("id"\)\) WITHOUT ROWID$/);
  });

  it('정수 기본 키 테이블: 인덱스 0, 행은 값 28바이트 + 오버헤드 근처', () => {
    const r = runSqliteLab(SQL, intPk, { rows: 5000 });
    expect(r.rows).toBe(5000);
    expect(r.indexBytes).toBe(0);
    expect(r.rowBytes).toBeGreaterThan(28);
    expect(r.rowBytes).toBeLessThan(50);
  });

  it('uuid 기본 키 + 복합 인덱스: 인덱스 크기가 따로 잡히고, WITHOUT ROWID면 키 인덱스가 없어져 줄어듦', () => {
    const plain = runSqliteLab(SQL, orders, { rows: 5000 });
    const wr = runSqliteLab(SQL, orders, { rows: 5000, withoutRowid: true });
    expect(plain.indexBytes).toBeGreaterThan(20);
    expect(wr.indexBytes).toBeLessThan(plain.indexBytes);
    expect(wr.ddl).toHaveLength(2);
  });

  it('시각을 ISO 문자열로 저장하면 정수보다 행이 커짐', () => {
    const asText = table({ ...orders, columns: orders.columns.map((c) => (c.name === 'created_at' ? { ...c, storage: 'text' } : c)), indexes: [] });
    const asInt = table({ ...orders, indexes: [] });
    expect(runSqliteLab(SQL, asText, { rows: 3000 }).rowBytes - runSqliteLab(SQL, asInt, { rows: 3000 }).rowBytes).toBeGreaterThan(12);
  });

  it('같은 시드면 같은 크기', () => {
    expect(runSqliteLab(SQL, orders, { rows: 2000, seed: 7 }).rowBytes).toBe(runSqliteLab(SQL, orders, { rows: 2000, seed: 7 }).rowBytes);
  });
});
