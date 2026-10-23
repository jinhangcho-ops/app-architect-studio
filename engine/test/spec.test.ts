import { describe, expect, it } from 'vitest';
import { checkProject, Project } from '../schema';
import { parseSpec } from '../spec';

// 엑셀에서 복사한 표 (탭 구분)
const tsv = [
  '테이블\t컬럼\t타입\t크기\t평균 길이\t저장 형식\tNULL\t키·인덱스\t설명',
  'orders\tid\tUUID\t16\t\tBLOB\tN\tPK\t주문 번호',
  'orders\tuser_id\tBIGINT\t\t\t\tN\tidx_user_time:1\t',
  'orders\tcreated_at\tTIMESTAMP\t\t\t정수(epoch ms)\tN\tidx_user_time:2\t',
  'orders\tmemo\tVARCHAR(200)\t\t40\tTEXT(UTF-8)\tY\t\t',
  'order_items\torder_id\tUUID\t\t\t\tN\tPK:1\t',
  'order_items\tline_no\tINT\t\t\t\tN\tPK:2\t',
  'order_items\tsku\tVARCHAR\t32\t12\t\tN\tUQ:uq_sku:1\t',
].join('\n');

describe('데이터 명세서 → 테이블', () => {
  const r = parseSpec(tsv);

  it('엑셀 표(TSV): 테이블별로 묶고, 타입·길이·저장 형식·NULL을 읽음', () => {
    expect(r.errors).toEqual([]);
    expect(r.tables.map((t) => t.name)).toEqual(['orders', 'order_items']);
    const memo = r.tables[0].columns.find((c) => c.name === 'memo')!;
    expect(memo).toMatchObject({ type: 'text', max_length: 200, avg_bytes: 40, storage: 'text', nullable: true });
    expect(r.tables[0].columns.find((c) => c.name === 'created_at')).toMatchObject({ type: 'timestamp', storage: 'integer' });
    // 저장 형식을 안 적으면 비워 둔다(크기 계산에서 타입별 기본값)
    expect(r.tables[0].columns.find((c) => c.name === 'user_id')!.storage).toBeUndefined();
  });

  it('키 칸: 기본 키와 복합 인덱스의 컬럼 순서, 고유 인덱스', () => {
    expect(r.tables[0].primary_key).toEqual(['id']);
    expect(r.tables[0].indexes).toEqual([{ name: 'idx_user_time', columns: ['user_id', 'created_at'], unique: false }]);
    expect(r.tables[1].primary_key).toEqual(['order_id', 'line_no']);
    expect(r.tables[1].indexes).toEqual([{ name: 'uq_sku', columns: ['sku'], unique: true }]);
  });

  it('CSV(따옴표 안 쉼표)와 영문 머리글', () => {
    const csv = 'table,column,type,description\nusers,id,bigint,"번호, 자동 증가"\nusers,email,text,';
    const c = parseSpec(csv);
    expect(c.errors).toEqual([]);
    expect(c.tables[0].columns[0].description).toBe('번호, 자동 증가');
  });

  it('읽을 수 없는 줄은 줄 번호와 이유를 알려 주고 나머지는 가져옴', () => {
    const bad = parseSpec('테이블\t컬럼\t타입\t키·인덱스\nt\ta\tGEOMETRY\t\nt\tb\tINT\tPK:x\nt\tc\tINT\tPK');
    expect(bad.errors).toEqual(['2번째 줄: 모르는 타입 GEOMETRY', expect.stringMatching(/^3번째 줄: 키 표기를 읽을 수 없음: PK:x/)]);
    expect(bad.tables[0].columns.map((x) => x.name)).toEqual(['c']);
  });

  it('머리글이 없거나 키가 없는 컬럼을 가리키면 오류', () => {
    expect(parseSpec('a\tb\n1\t2').errors[0]).toMatch(/머리글이 필요함: 테이블, 컬럼, 타입/);
    const j = parseSpec(JSON.stringify([{ name: 't', columns: [{ name: 'a', type: 'int' }], primary_key: ['zz'] }]));
    expect(j.errors).toEqual(['t: 기본 키에 없는 컬럼 zz']);
  });
});

describe('행동·테이블 참조 검사', () => {
  const tables = parseSpec(tsv).tables;
  const base = {
    name: 'p',
    personas: [{ name: '열성', pattern: 'power', share: 1, action_rates: { 주문: 0.5, 없는행동: 1 } }],
    nodes: [{ id: 'db', name: 'DB', layer: 'db', tables }, { id: 'api', name: 'API', layer: 'backend', tables: [tables[0]] }],
    actions: [{ name: '주문', per_session: 0.2, writes: [{ node: 'db', table: 'orders' }, { node: 'db', table: 'nope', rows: 3 }] }],
  };

  it('없는 테이블·없는 행동·테이블을 둘 수 없는 노드를 찾아냄', () => {
    expect(checkProject(Project.parse(base), [])).toEqual([
      'api: 테이블은 db·cache·analytics 노드에만 둘 수 있음',
      '행동 주문: db에 없는 테이블 nope',
      '페르소나 열성: 없는 행동 없는행동',
    ]);
  });

  it('쓰기 행 수는 기본 1', () => {
    expect(Project.parse(base).actions[0].writes[0].rows).toBe(1);
  });
});
