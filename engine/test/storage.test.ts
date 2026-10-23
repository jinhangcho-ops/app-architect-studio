import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../io';
import { checkProject, Project, selectedFeatures, StorageProfile, storageProfileOf } from '../schema';

const catalog = loadCatalog(fileURLToPath(new URL('../../data/catalog', import.meta.url)));
const profile = (id: string) => storageProfileOf(catalog.byId.get(id), catalog.byId)!;
const ids = (fs: { id: string }[]) => fs.map((f) => f.id);

describe('시스템별 저장 프로필', () => {
  it('DB·분석 항목에 프로필이 있고, 같은 엔진은 same_as로 이어짐', () => {
    for (const id of ['sqlite', 'postgresql', 'mysql', 'mongodb', 'dynamodb', 'clickhouse', 'snowflake', 'databricks', 'bigquery']) {
      expect(profile(id), id).toBeDefined();
    }
    expect(profile('supabase')).toBe(profile('postgresql'));
    expect(profile('libsql_turso')).toBe(profile('sqlite'));
  });

  it('공식 문서 값: PostgreSQL 행 오버헤드 28(헤더 23→24 + 포인터 4), B-tree 채움률 90%, DynamoDB 항목당 100바이트', () => {
    expect(profile('postgresql')).toMatchObject({ row_overhead_bytes: 28, index_fill: 0.9 });
    expect(profile('dynamodb')).toMatchObject({ row_overhead_bytes: 100, stores_field_names: true });
    expect(profile('mysql').secondary_index_includes_pk).toBe(true);
  });

  it('모든 기능에 출처가 있음', () => {
    for (const it of catalog.items) {
      const sp = storageProfileOf(it, catalog.byId);
      for (const f of sp?.features ?? []) expect(f.source, `${it.id}.${f.id}`).toMatch(/^https:\/\//);
    }
  });

  it('하나만 고르는 묶음에 권장이 둘이면 읽을 때 거부', () => {
    const bad = { layout: 'row', row_overhead_bytes: 0, sources: ['s'], groups: { c: { label: '압축', one: true } },
      features: [{ id: 'a', group: 'c', label: 'A', recommended: true, source: 's' }, { id: 'b', group: 'c', label: 'B', recommended: true, source: 's' }] };
    expect(StorageProfile.safeParse(bad).success).toBe(false);
  });
});

describe('저장 기능 선택', () => {
  const sp = profile('postgresql');

  it('아무것도 안 고르면 권장 기능, 테이블 선택이 노드 선택보다 우선', () => {
    expect(ids(selectedFeatures(sp, {}))).toEqual(['toast_pglz', 'fill_100']);
    const node = { storage_features: ['toast_lz4', 'fill_100'] };
    expect(ids(selectedFeatures(sp, node))).toEqual(['toast_lz4', 'fill_100']);
    expect(ids(selectedFeatures(sp, node, { storage_features: ['toast_lz4', 'fill_90'] }))).toEqual(['toast_lz4', 'fill_90']);
  });

  it('없는 기능, 하나만 고르는 묶음에서 둘, 프로필 없는 항목에서 고르기를 찾아냄', () => {
    const p = Project.parse({
      name: 'p',
      nodes: [
        { id: 'db', name: 'DB', layer: 'db', primary: 'postgresql', storage_features: ['toast_pglz', 'toast_lz4', 'nope'],
          tables: [{ name: 't', columns: [{ name: 'a', type: 'int' }], storage_features: ['fill_90'] }] },
        { id: 'api', name: 'API', layer: 'backend', primary: 'api_single', storage_features: ['x'] },
      ],
    });
    expect(checkProject(p, catalog.items)).toEqual([
      'db: 없는 저장 기능 nope',
      'db: 큰 값 압축(TOAST)은 하나만 고를 수 있음',
      'api: 주 항목에 저장 프로필이 없어 저장 기능을 고를 수 없음',
    ]);
  });
});
