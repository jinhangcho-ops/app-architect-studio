import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { dataDictionaryCsv, ddlFiles, dialectOf, schemaFiles, tableDdl } from '../ddl';
import { loadCatalog } from '../io';
import { Project, Table } from '../schema';
import { featureTables, unusedTables } from '../tables';

const catalog = loadCatalog(fileURLToPath(new URL('../../data/catalog', import.meta.url)));

// 데이터 사전 메타를 모두 쓴 고정장 테이블
const sales = Table.parse({
  name: 'sales', label: '매출', description: "하루 매출 (가게's)", record: 'fixed',
  columns: [
    { name: 'id', type: 'uuid', label: '매출 ID' },
    { name: 'shop_code', type: 'text', max_length: 10, label: '가게 코드', domain: '코드' },
    { name: 'pay', type: 'text', max_length: 1, codes: [{ code: 'C', label: '카드' }, { code: 'M', label: '현금' }], default_value: 'C' },
    { name: 'amount', type: 'numeric', default_value: '0' },
    { name: 'phone', type: 'text', max_length: 20, nullable: true, personal: true, description: '연락처' },
    { name: 'paid_at', type: 'timestamp' },
  ],
  primary_key: ['id'],
  indexes: [{ name: 'idx_shop_time', columns: ['shop_code', 'paid_at'] }],
});
const project = (primary: string) => Project.parse({
  name: 'p',
  nodes: [{ id: 'api', name: 'API', layer: 'backend' }, { id: 'db', name: '매출 DB', layer: 'db', primary, tables: [sales, { name: 'logs', columns: [{ name: 'x', type: 'int' }] }] }],
  actions: [{ name: '매출 입력', per_session: 1, writes: [{ node: 'db', table: 'sales' }] }],
  edges: [{ from: 'api', to: 'db', interfaces: [{ name: '매출 조회', kind: 'rest', method: 'GET', path: '/sales', tables: [{ node: 'db', table: 'sales', op: 'read' }] }] }],
});

describe('스키마(DDL)', () => {
  it('SQLite DDL은 실제 SQLite(sql.js)에서 실행되고, 코드 값 CHECK·기본값·NOT NULL이 동작함', async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(tableDdl(sales, 'sqlite'));
    db.run("INSERT INTO sales (id, shop_code, paid_at) VALUES (x'00', 'S1', 1)");
    expect(db.exec('SELECT pay, amount FROM sales')[0].values).toEqual([['C', 0]]);
    expect(() => db.run("INSERT INTO sales (id, shop_code, pay, paid_at) VALUES (x'01', 'S1', 'X', 1)")).toThrow(/CHECK/);
    expect(() => db.run("INSERT INTO sales (id, paid_at) VALUES (x'02', 1)")).toThrow(/NOT NULL/);
    expect(db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_shop_time'")[0].values).toHaveLength(1);
  });

  it('PostgreSQL: 고정장은 CHAR(n), 주석은 COMMENT ON, 작은따옴표는 두 번', () => {
    const s = tableDdl(sales, 'postgres');
    expect(s).toContain('"shop_code" CHAR(10) NOT NULL');
    expect(s).toContain('"id" UUID NOT NULL');
    expect(s).toContain(`"pay" CHAR(1) NOT NULL DEFAULT 'C' CHECK ("pay" IN ('C', 'M'))`);
    expect(s).toContain('"phone" CHAR(20),');
    expect(s).toContain(`COMMENT ON TABLE "sales" IS '매출 — 하루 매출 (가게''s)';`);
    expect(s).toContain(`COMMENT ON COLUMN "sales"."phone" IS '연락처';`);
  });

  it('MySQL: 줄 안 COMMENT, 가변장이면 VARCHAR', () => {
    const s = tableDdl({ ...sales, record: 'variable' }, 'mysql');
    expect(s).toContain("`shop_code` VARCHAR(10) NOT NULL COMMENT '가게 코드'");
    expect(s).toContain('`amount` DECIMAL(19,4) NOT NULL DEFAULT 0');
    expect(s).toMatch(/\) COMMENT='매출 — 하루 매출 \(가게''s\)';/);
  });

  it('방언: Supabase는 PostgreSQL, MongoDB는 DDL 없음, 분석 DB는 표준 형태', () => {
    const node = (primary: string) => ({ ...project(primary).nodes[1] });
    expect(dialectOf(node('supabase'), catalog.byId)).toBe('postgres');
    expect(dialectOf(node('mongodb'), catalog.byId)).toBeUndefined();
    expect(dialectOf(node('bigquery'), catalog.byId)).toBe('generic');
    expect(ddlFiles(project('mongodb'), catalog.byId)).toEqual([]);
    expect(schemaFiles(project('mysql'), catalog.byId).map((f) => f.name)).toEqual(['schema-db.sql', 'data-dictionary.csv']);
    expect(ddlFiles(project('mysql'), catalog.byId)[0].text).toMatch(/^-- 매출 DB \(db\) · MySQL\n-- 길이는[^\n]*\n-- 파티션[^\n]*\n\nCREATE TABLE/);
  });
});

describe('기능별 테이블 · 데이터 사전', () => {
  it('행동은 쓰기, 인터페이스는 고른 읽기·쓰기로 모이고, 아무 기능도 안 쓰는 테이블을 알림', () => {
    const p = project('postgresql');
    expect(featureTables(p)).toEqual([
      { name: '매출 입력', via: '행동', tables: [{ node: 'db', table: 'sales', op: 'write' }] },
      { name: '매출 조회', via: 'api → db', tables: [{ node: 'db', table: 'sales', op: 'read' }] },
    ]);
    expect(unusedTables(p)).toEqual(['db.logs']);
  });

  it('데이터 사전 CSV: 컬럼마다 한 줄, 코드 값·개인정보·쓰는·읽는 기능', () => {
    const lines = dataDictionaryCsv(project('postgresql'), catalog.byId).split('\r\n');
    expect(lines[0].startsWith('﻿노드,테이블')).toBe(true);
    expect(lines).toContain('매출 DB,sales,매출,하루 매출 (가게\'s),고정장,3,pay,,text,CHAR(1),1,Y,C,,,C=카드; M=현금,,,매출 입력,매출 조회');
    expect(lines).toContain('매출 DB,sales,매출,하루 매출 (가게\'s),고정장,5,phone,,text,CHAR(20),20,N,,,,,Y,연락처,매출 입력,매출 조회');
  });

  it('없는 테이블을 연결하면 검증 오류', async () => {
    const { checkProject } = await import('../schema');
    const p = project('postgresql');
    p.edges[0].interfaces[0].tables = [{ node: 'db', table: 'nope', op: 'read' }];
    expect(checkProject(p, catalog.items).join()).toMatch(/db에 없는 테이블 nope/);
  });
});
