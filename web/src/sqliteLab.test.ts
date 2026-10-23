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
