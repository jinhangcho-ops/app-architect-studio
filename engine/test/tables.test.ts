import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { analyze } from '../analyze';
import { loadCatalog, loadPrices } from '../io';
import { checkTable, Project, Table } from '../schema';
import { tableSizes } from '../tables';

const here = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));
const catalog = loadCatalog(here('../../data/catalog'));
const prices = loadPrices(here('../../data/prices'));

// 하루 100만 행을 1년 보관하는 주문 테이블 (값 50바이트: uuid 16 + bigint 8 + status 10 + numeric 8 + timestamp 8)
const orders = {
  name: 'orders',
  columns: [
    { name: 'id', type: 'uuid' }, { name: 'user_id', type: 'bigint' }, { name: 'status', type: 'text', avg_bytes: 10 },
    { name: 'amount', type: 'numeric' }, { name: 'created_at', type: 'timestamp' },
  ],
  primary_key: ['id'],
  indexes: [{ name: 'idx_user_time', columns: ['user_id', 'created_at'] }],
  measured: { rows_per_day: 1_000_000 },
};
const project = (primary: string, table: object = orders, extra: object = {}) => Project.parse({
  name: 'p', scale: { users: 100_000, retention_days: 365 },
  nodes: [{ id: 'db', name: 'DB', layer: primary === 'bigquery' || primary === 'snowflake' ? 'analytics' : 'db', primary, tables: [table], ...extra }],
});
const size = (primary: string, table?: object, extra?: object) => tableSizes(project(primary, table, extra), undefined, catalog.byId)[0];

describe('관문: 테이블 크기 (손 계산)', () => {
  it('PostgreSQL: 행 50 + 28 = 78바이트, 인덱스 2개 × (16 + 12) / 0.9, 1년 약 51.2GB, 월 파티션 13개', () => {
    const s = size('postgresql', { ...orders, partition: { column: 'created_at', interval: 'month' } });
    expect(s.rowBytes.value).toBe(78);
    expect(s.indexBytesPerRow.value).toBeCloseTo((2 * 28) / 0.9);
    expect(s.storedGb.value).toBeCloseTo((365e6 * (78 + (2 * 28) / 0.9)) / 1e9);
    expect(s.partitions!.count).toBe(13);
    expect(s.partitions!.gb.value).toBeCloseTo(s.storedGb.value / 13);
  });

  it('MySQL: 기본 키가 테이블(클러스터드)이라 키 인덱스 없음, 보조 인덱스는 기본 키 16바이트를 함께 저장', () => {
    const s = size('mysql');
    expect(s.rowBytes.value).toBe(50 + 18 + 5);
    expect(s.indexBytesPerRow.value).toBe(16 + 5 + 16);
  });

  it('SQLite: 정수 한 컬럼 기본 키는 rowid라 인덱스 없음, uuid 키는 인덱스가 따로 생기고 WITHOUT ROWID면 없어짐', () => {
    const t = { name: 't', columns: [{ name: 'id', type: 'bigint' }, { name: 'name', type: 'text', avg_bytes: 20 }], primary_key: ['id'], measured: { rows_per_day: 1 } };
    expect(size('sqlite', t).indexBytesPerRow.value).toBe(0);
    expect(size('sqlite', t).rowBytes.value).toBe(8 + 20 + 8 + 2);
    const u = { ...t, columns: [{ name: 'id', type: 'uuid' }, t.columns[1]] };
    expect(size('sqlite', u).indexBytesPerRow.value).toBe(16 + 8);
    expect(size('sqlite', u, { storage_features: ['without_rowid'] }).indexBytesPerRow.value).toBe(0);
  });

  it('MongoDB: 필드 이름을 행마다 저장하고 snappy(예시 0.6)로 압축', () => {
    const t = { name: 'c', columns: [{ name: 'a', type: 'int' }, { name: 'bb', type: 'text', avg_bytes: 10 }], measured: { rows_per_day: 1 } };
    // 값 14 + 문서 5 + 필드마다 2 × 2 + 이름 3 = 26 → × 0.6
    expect(size('mongodb', t).rowBytes.value).toBeCloseTo(26 * 0.6);
  });

  it('저장 형식이 크기를 바꿈: 시각을 ISO 문자열로 저장하면 8 → 24바이트', () => {
    const asText = { ...orders, columns: orders.columns.map((c) => (c.name === 'created_at' ? { ...c, storage: 'text' } : c)) };
    expect(size('postgresql', asText).rowBytes.value - size('postgresql').rowBytes.value).toBe(16);
  });

  it('Snowflake: 열 저장이라 인덱스 없음, 자동 압축(예시 0.25), 바뀐·지운 행을 Time Travel 1일 + Fail-safe 7일 더 보관', () => {
    const s = size('snowflake');
    expect(s.rowBytes.value).toBeCloseTo(50 * 0.25);
    expect(s.indexBytesPerRow.value).toBe(0);
    expect(s.storedGb.value).toBeCloseTo((1e6 * 365 * 12.5 + 1e6 * 8 * 12.5) / 1e9);
    expect(s.assumptions).toContain('열 저장 시스템이라 인덱스 크기는 넣지 않음');
  });

  it('평균 길이가 없으면 가정값을 쓰고 그렇다고 남김', () => {
    const t = { name: 't', columns: [{ name: 'memo', type: 'text', max_length: 200 }, { name: 'raw', type: 'json' }], measured: { rows_per_day: 1 } };
    expect(size('postgresql', t).assumptions).toEqual(['memo: 평균 길이 없음 → 최대 길이의 절반 100바이트', 'raw: 평균·최대 길이 없음 → 32바이트']);
  });
});

describe('table 범위 규칙·저장 비용·성장', () => {
  const data = { catalog: catalog.byId, rules: catalog.rules, prices };

  it('파티션 없는 테이블이 서버 메모리(8GB)를 넘으면 파티션 권장, 무작위 UUID 키에 쓰기가 많으면 UUIDv7 권장', () => {
    const p = Project.parse({
      name: 'p', scale: { users: 500_000, event_multiplier: 3 },
      personas: [{ name: '열성', pattern: 'power', share: 1, action_rates: { 주문: 1 } }],
      nodes: [{ id: 'ui', name: '화면', layer: 'ui' }, { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', spec: { memGb: 8 }, tables: [{ ...orders, measured: {} }] }],
      actions: [{ name: '주문', per_session: 1, writes: [{ node: 'db', table: 'orders' }] }],
    });
    const a = analyze(p, data, '2026-10-24');
    expect(a.rules.filter((r) => r.target === 'DB.orders').map((r) => r.ruleId)).toEqual(['table_partition_hint', 'table_random_uuid_pk']);
  });

  it('서버 메모리를 모르면 파티션 규칙만 건너뜀 (다른 규칙은 계속)', () => {
    const p = project('postgresql');
    expect(() => analyze(p, data, '2026-10-24')).not.toThrow();
  });

  it('테이블이 있으면 저장 비용은 테이블 합계(노드 리전), 페르소나 추정은 비교용으로 남음', () => {
    const p = Project.parse({
      name: 'p', scale: { users: 1000 }, personas: [{ name: '일반', pattern: 'regular', share: 1 }],
      cost: { region: 'aws:ap-northeast-2', storage: 'storage' },
      nodes: [{ id: 'ui', name: '화면', layer: 'ui' }, { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', tables: [orders] }],
    });
    const a = analyze(p, data, '2026-10-24');
    expect(a.cost!.parts['저장'].value).toBeCloseTo(a.tables[0].storedGb.value * 0.1);
    expect(a.storage!.tablesGb!.value).toBeCloseTo(a.tables[0].storedGb.value);
    expect(a.storage!.personaGb.value).toBeGreaterThan(0);
  });

  it('테이블이 일부 DB에만 있으면 나머지 DB 저장량은 "모름", 프로필 없는 DB(CockroachDB)도 "모름", 캐시는 저장 과금 없음', () => {
    const p = Project.parse({
      name: 'p', scale: { users: 1000 }, personas: [{ name: '일반', pattern: 'regular', share: 1 }],
      cost: { region: 'aws:ap-northeast-2', storage: 'storage' },
      nodes: [
        { id: 'ui', name: '화면', layer: 'ui' },
        { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', tables: [orders] },
        { id: 'db2', name: '로그 DB', layer: 'db', primary: 'mysql' },
        { id: 'cr', name: '분산 DB', layer: 'db', primary: 'cockroachdb', tables: [orders] },
        { id: 'c', name: '캐시', layer: 'cache', primary: 'valkey', tables: [orders] },
      ],
    });
    const c = analyze(p, data, '2026-10-24').cost!;
    expect(c.missing).toEqual([
      '로그 DB: 테이블이 없어 저장량을 모름 (테이블을 넣거나 테이블을 모두 비우면 페르소나 추정을 씀)',
      '분산 DB: 주 항목에 저장 프로필이 없어 테이블 저장량을 모름',
    ]);
    // 저장 과금은 PostgreSQL DB 한 곳만
    expect(c.parts['저장'].value).toBeCloseTo(tableSizes(p, undefined, catalog.byId).find((x) => x.nodeId === 'db')!.storedGb.value * 0.1);
  });

  it('프로필이 없어도 행·인덱스 크기를 둘 다 실측했으면 저장 비용에 넣음', () => {
    const measured = { ...orders, measured: { rows_per_day: 1000, row_bytes: 120, index_bytes: 40 } };
    const p = Project.parse({
      name: 'p', scale: { users: 1000 }, personas: [{ name: '일반', pattern: 'regular', share: 1 }],
      cost: { region: 'aws:ap-northeast-2', storage: 'storage' },
      nodes: [{ id: 'ui', name: '화면', layer: 'ui' }, { id: 'cr', name: '분산 DB', layer: 'db', primary: 'cockroachdb', tables: [measured] }],
    });
    const c = analyze(p, data, '2026-10-24').cost!;
    expect(c.missing).toEqual([]);
    expect(c.parts['저장'].value).toBeCloseTo(((1000 * 365 * 160) / 1e9) * 0.1);
  });

  it('성장: 크기는 사용자 수에 비례 → 메모리에 닿는 달 (8GB, 지금 4GB, 월 10% → 8개월째)', () => {
    const t = { ...orders, measured: { rows_per_day: 4e9 / 365 / (78 + (2 * 28) / 0.9) } };
    const p = Project.parse({
      name: 'p', scale: { users: 1000, retention_days: 365 }, personas: [{ name: '일반', pattern: 'regular', share: 1 }],
      growth: { monthly_rate: 0.1, lead_months: 2 },
      nodes: [{ id: 'ui', name: '화면', layer: 'ui' }, { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', spec: { memGb: 8 }, tables: [t] }],
    });
    const a = analyze(p, data, '2026-10-24');
    expect(a.tables[0].storedGb.value).toBeCloseTo(4);
    expect(a.growth!.tables).toEqual([{ nodeId: 'db.orders', limitUsers: 2000, month: 8, startMonth: 6 }]);
  });
});

describe('장 형식 (고정장·가변장)', () => {
  // status: 최대 20바이트, 실제 평균 10바이트
  const withMax = { ...orders, columns: orders.columns.map((c) => (c.name === 'status' ? { ...c, max_length: 20 } : c)) };
  const fixed = { ...withMax, record: 'fixed' };

  it('PostgreSQL·MySQL은 고정장 문자열을 선언 길이까지 채워 저장: 행이 (20 − 10)바이트 커짐', () => {
    for (const db of ['postgresql', 'mysql']) {
      const v = size(db, withMax), f = size(db, fixed);
      expect(f.rowBytes.value - v.rowBytes.value, db).toBeCloseTo(10 / (db === 'mysql' ? f.rowBytes.inputs['채움률'] : 1));
    }
  });

  it('SQLite는 고정장이어도 실제 길이로 저장: 크기는 같고, 그렇다고 알림', () => {
    const v = size('sqlite', withMax), f = size('sqlite', fixed);
    expect(f.rowBytes.value).toBe(v.rowBytes.value);
    expect(f.assumptions.join()).toContain('실제 길이로 저장');
  });

  it('고정장: 문자열·바이너리는 최대 길이가 있어야 하고 JSON은 넣을 수 없음, 코드 값은 중복 없이', () => {
    const t = Table.parse({ name: 't', record: 'fixed', columns: [
      { name: 'memo', type: 'text' }, { name: 'raw', type: 'json' }, { name: 'state', type: 'text', max_length: 1, codes: [{ code: 'A', label: '정상' }, { code: 'A', label: '중복' }] },
    ] });
    expect(checkTable(t)).toEqual(['고정장 테이블의 memo: 최대 길이(바이트)가 필요함', '고정장 테이블에 JSON 컬럼 raw은 넣을 수 없음 (길이가 정해지지 않음)', 'state: 코드 값 중복 A']);
    expect(checkTable(Table.parse({ name: 't', columns: [{ name: 'memo', type: 'text' }] }))).toEqual([]);
  });
});
