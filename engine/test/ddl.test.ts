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

describe('DDL이 실제로 실행되게 (감사 2)', () => {
  it('MySQL: TEXT·JSON 기본값은 괄호 식, 키로 쓰는 길이 없는 text·bytes는 VARCHAR·VARBINARY(255), DATETIME(6)은 CURRENT_TIMESTAMP(6), 고정장 255 초과는 VAR', () => {
    const t = Table.parse({ name: 'm', columns: [
      { name: 'code', type: 'text', default_value: 'A' }, { name: 'memo', type: 'text', default_value: 'x' }, { name: 'j', type: 'json', default_value: '{}' },
      { name: 'ts', type: 'timestamp', default_value: 'CURRENT_TIMESTAMP' }, { name: 'd', type: 'date', default_value: 'current_date' }, { name: 'raw', type: 'bytes' },
    ], primary_key: ['code'], indexes: [{ name: 'ix_raw', columns: ['raw'] }] });
    const s = tableDdl(t, 'mysql');
    expect(s).toContain("`code` VARCHAR(255) NOT NULL DEFAULT 'A'");
    expect(s).toContain("`memo` TEXT NOT NULL DEFAULT ('x')");
    expect(s).toContain("`j` JSON NOT NULL DEFAULT ('{}')");
    expect(s).toContain('`ts` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)');
    expect(s).toContain('`d` DATE NOT NULL DEFAULT (CURRENT_DATE)');
    expect(s).toContain('`raw` VARBINARY(255) NOT NULL');
    const f = tableDdl(Table.parse({ name: 'f', record: 'fixed', columns: [
      { name: 'a', type: 'text', max_length: 300 }, { name: 'b', type: 'text', max_length: 10 }, { name: 'c', type: 'bytes', max_length: 300 },
    ] }), 'mysql');
    expect(f).toContain('`a` VARCHAR(300)');
    expect(f).toContain('`b` CHAR(10)');
    expect(f).toContain('`c` VARBINARY(300)');
  });

  it('기본값은 컬럼 타입대로: text는 늘 따옴표, bool은 참·거짓, 저장 형식이 정수인 SQLite 시각은 epoch 식 (sql.js에서 실행)', async () => {
    const t = Table.parse({ name: 'd', columns: [
      { name: 'code', type: 'text', default_value: '007' }, { name: 'ok', type: 'bool', default_value: 'true' }, { name: 'n', type: 'int', default_value: '5' },
      { name: 'ts', type: 'timestamp', default_value: 'CURRENT_TIMESTAMP' }, { name: 'day', type: 'date', default_value: 'CURRENT_DATE' },
      { name: 'ts_txt', type: 'timestamp', storage: 'text', default_value: 'current_timestamp' }, { name: 'memo', type: 'text', nullable: true, default_value: 'null' },
      { name: 'k', type: 'int' },
    ] });
    const pg = tableDdl(t, 'postgres');
    expect(pg).toContain(`"code" TEXT NOT NULL DEFAULT '007'`);
    expect(pg).toContain('"ok" BOOLEAN NOT NULL DEFAULT TRUE');
    expect(pg).toContain('"n" INTEGER NOT NULL DEFAULT 5');
    expect(pg).toContain('"memo" TEXT DEFAULT NULL');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(tableDdl(t, 'sqlite'));
    db.run('INSERT INTO d (k) VALUES (1)');
    const [code, ok, n, ts, day, tsTxt, memo] = db.exec('SELECT code, ok, n, ts, day, ts_txt, memo FROM d')[0].values[0];
    expect([code, ok, n, memo]).toEqual(['007', 1, 5, null]);
    // 정수 시각은 epoch 밀리초, 정수 날짜는 1970-01-01부터 지난 날 수 (SQLite 실험의 가짜 값과 같은 뜻)
    expect(Math.abs(Number(ts) - Date.now())).toBeLessThan(60_000);
    expect(day).toBe(Math.floor(Date.now() / 86_400_000));
    expect(String(tsTxt)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('코드 값 CHECK: 숫자 타입은 숫자로, bool은 참·거짓으로 (SQLite에서 숫자 코드 행이 들어감)', async () => {
    const t = Table.parse({ name: 'c', columns: [
      { name: 'st', type: 'int', codes: [{ code: '1' }, { code: '2' }] }, { name: 'rate', type: 'numeric', codes: [{ code: '1.5' }, { code: '2' }] },
      { name: 'yn', type: 'bool', codes: [{ code: 'true' }, { code: 'false' }] },
    ] });
    expect(tableDdl(t, 'postgres')).toContain('CHECK ("rate" IN (1.5, 2))');
    expect(tableDdl(t, 'postgres')).toContain('CHECK ("yn" IN (TRUE, FALSE))');
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    db.run(tableDdl(t, 'sqlite'));
    db.run('INSERT INTO c VALUES (1, 1.5, 1)');
    expect(() => db.run('INSERT INTO c VALUES (3, 1.5, 1)')).toThrow(/CHECK/);
  });

  it('MySQL 문자열의 백슬래시는 두 번 (다른 방언은 그대로)', () => {
    const t = Table.parse({ name: 'b', description: 'C:\\temp\\', columns: [{ name: 'x', type: 'int' }] });
    expect(tableDdl(t, 'mysql')).toContain("COMMENT='C:\\\\temp\\\\';");
    expect(tableDdl(t, 'postgres')).toContain("IS 'C:\\temp\\';");
  });

  it('캐시 노드는 DDL 없음(데이터 사전에는 나옴), CockroachDB는 PostgreSQL, 분석 DB는 CREATE INDEX 없음', () => {
    const one = (layer: string, primary: string) => Project.parse({ name: 'p', nodes: [{ id: 'n', name: 'N', layer, primary,
      tables: [{ name: 's', columns: [{ name: 'k', type: 'int' }], indexes: [{ name: 'ix_k', columns: ['k'] }] }] }] });
    expect(dialectOf(one('cache', 'redis_cache').nodes[0], catalog.byId)).toBeUndefined();
    expect(schemaFiles(one('cache', 'redis_cache'), catalog.byId).map((f) => f.name)).toEqual(['data-dictionary.csv']);
    expect(dialectOf(one('db', 'cockroachdb').nodes[0], catalog.byId)).toBe('postgres');
    const bq = ddlFiles(one('analytics', 'bigquery'), catalog.byId)[0].text;
    expect(bq).toContain('CREATE TABLE');
    expect(bq).not.toContain('CREATE INDEX');
  });

  it('머리 주석의 노드 이름 줄바꿈은 공백, 안전한 이름이 겹치는 노드(db-1, db_1)는 -2를 붙임', () => {
    const t = { name: 's', columns: [{ name: 'k', type: 'int' }] };
    const p = Project.parse({ name: 'p', nodes: [{ id: 'db-1', name: '첫\n번째', layer: 'db', primary: 'sqlite', tables: [t] }, { id: 'db_1', name: '둘', layer: 'db', primary: 'sqlite', tables: [t] }] });
    const files = schemaFiles(p, catalog.byId);
    expect(files.map((f) => f.name)).toEqual(['schema-db_1.sql', 'schema-db_1-2.sql', 'data-dictionary.csv']);
    expect(files[0].text.split('\n')[0]).toBe('-- 첫 번째 (db-1) · SQLite');
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
    expect(lines[0].startsWith('\uFEFF노드,테이블')).toBe(true);
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
