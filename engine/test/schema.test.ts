import { describe, expect, it } from 'vitest';
import { FORMAT_VERSION, migrate } from '../data';
import { CatalogItem, Project, Table, checkCatalog, checkProject, checkTable } from '../schema';

const item = {
  id: 'x', name: 'X', area: '서비스', role: '주', kind: '도구', attaches_to: ['db'], goals: {}, sources: ['s'],
};

describe('카탈로그·프로젝트 검증', () => {
  it('해석할 수 없는 조건식은 읽을 때 거부', () => {
    expect(CatalogItem.safeParse({ ...item, fails_when: [{ if: 'a >', why: 'w' }] }).success).toBe(false);
  });

  it('사양 보정을 하려면 base_spec에 해당 자원이 있어야 함', () => {
    const th = { value: 1, unit: 'u', bound_by: 'vcpu', base_spec: { memGb: 4 }, source: 's' };
    expect(CatalogItem.safeParse({ ...item, thresholds: { t: th } }).success).toBe(false);
  });

  it('없는 대안·없는 항목·맞지 않는 레이어를 찾아냄', () => {
    const it1 = CatalogItem.parse({ ...item, alternatives: [{ id: 'nope', better_for: [] }] });
    expect(checkCatalog([it1])).toEqual(['x: 없는 대안 nope']);
    const p = Project.parse({ name: 'p', nodes: [{ id: 'a', name: 'A', layer: 'ui', primary: 'x', extras: ['y'] }] });
    expect(checkProject(p, [it1])).toEqual(['a: x는 ui 노드에 붙일 수 없음', 'a: 없는 카탈로그 항목 y']);
  });
});

describe('테이블·연결 검증 (감사 2)', () => {
  const tbl = (name: string, extra: object = {}) => ({ name, columns: [{ name: 'k', type: 'int' }], ...extra });
  const proj = (extra: object) => Project.parse({ name: 'p', nodes: [
    { id: 'a', name: 'A', layer: 'backend' }, { id: 'db', name: 'DB', layer: 'db', tables: [tbl('s'), tbl('t', { indexes: [{ name: 's', columns: ['k'] }] })] },
  ], ...extra });

  it('기본값이 타입과 안 맞거나 NOT NULL인데 null이면 오류', () => {
    const t = Table.parse({ name: 't', columns: [
      { name: 'n', type: 'int', default_value: 'abc' }, { name: 'f', type: 'bool', default_value: 'Y' }, { name: 'x', type: 'text', default_value: 'null' },
      { name: 'r', type: 'numeric', default_value: '1.5' }, { name: 'ts', type: 'timestamp', default_value: 'CURRENT_TIMESTAMP' }, { name: 'd', type: 'date', default_value: 'CURRENT_TIMESTAMP' },
      { name: 'ok', type: 'text', nullable: true, default_value: 'NULL' },
    ] });
    expect(checkTable(t)).toEqual(['n: 기본값이 타입(int)과 안 맞음: abc', 'f: 기본값이 타입(bool)과 안 맞음: Y', 'x: 필수(NOT NULL)인데 기본값이 null', 'd: 기본값이 타입(date)과 안 맞음: CURRENT_TIMESTAMP']);
  });

  it('코드 값이 컬럼 타입과 안 맞으면 오류 (int에 글자, numeric에 글자, bool에 Y)', () => {
    const t = Table.parse({ name: 't', columns: [
      { name: 'st', type: 'int', codes: [{ code: 'A' }, { code: '1' }, { code: '1.5' }] }, { name: 'r', type: 'numeric', codes: [{ code: '-0.5' }, { code: 'x' }] },
      { name: 'yn', type: 'bool', codes: [{ code: 'Y' }] }, { name: 'c', type: 'text', codes: [{ code: 'A' }] },
    ] });
    expect(checkTable(t)).toEqual(['st: 코드 값이 타입(int)과 안 맞음: A', 'st: 코드 값이 타입(int)과 안 맞음: 1.5', 'r: 코드 값이 타입(numeric)과 안 맞음: x', 'yn: 코드 값이 타입(bool)과 안 맞음: Y']);
  });

  it('한 노드 안에서 인덱스 이름끼리, 인덱스와 테이블 이름이 겹치면 오류 (테이블 사이 포함)', () => {
    const p = Project.parse({ name: 'p', nodes: [{ id: 'db', name: 'DB', layer: 'db', tables: [
      tbl('a', { indexes: [{ name: 'ix', columns: ['k'] }] }), tbl('b', { indexes: [{ name: 'ix', columns: ['k'] }, { name: 'a', columns: ['k'] }] }),
    ] }] });
    expect(checkProject(p, [])).toEqual(['db: 테이블·인덱스 이름 중복 ix', 'db: 테이블·인덱스 이름 중복 a']);
  });

  it('파일·전문에 인증·에러가 있거나 구분자가 영문·숫자·_이면 오류', () => {
    const file = { name: 'f', kind: 'file', path: 'F1', request: [{ name: 'a', type: 'string' }] };
    const p = Project.parse({ name: 'p', nodes: [{ id: 'a', name: 'A', layer: 'backend' }, { id: 'b', name: 'B', layer: 'backend' }], edges: [{ from: 'a', to: 'b', interfaces: [
      { ...file, auth: 'bearer', errors: [{ status: 500, description: 'x' }] },
      { ...file, name: 'g', record: { format: 'delimited', delimiter: 'a' } },
      { ...file, name: 'h', record: { format: 'delimited', delimiter: '|' } },
    ] }] });
    expect(checkProject(p, [])).toEqual([
      '연결선 a → b f: 파일·전문은 인증·에러 응답이 없음 (보내고 끝)',
      '연결선 a → b g: 구분자 "a"에 영문·숫자·_를 쓸 수 없음',
    ]);
  });

  it('인터페이스의 같은 (노드, 테이블, 읽기·쓰기)와 행동의 같은 테이블 쓰기가 겹치면 오류', () => {
    const p = proj({
      actions: [{ name: '쓰기', per_session: 1, writes: [{ node: 'db', table: 's' }, { node: 'db', table: 's' }] }],
      edges: [{ from: 'a', to: 'db', interfaces: [{ name: '조회', kind: 'rest', method: 'GET', path: '/s',
        tables: [{ node: 'db', table: 's', op: 'read' }, { node: 'db', table: 's', op: 'read' }, { node: 'db', table: 's', op: 'write' }] }] }],
    });
    expect(checkProject(p, [])).toEqual(['연결선 a → db 조회: 테이블 연결 중복 db.s 읽기', 'db: 테이블·인덱스 이름 중복 s', '행동 쓰기: 쓰는 테이블 중복 db.s']);
  });

  it('형식 버전 2: 버전 1 파일(또는 버전 없음)은 그대로 열림', () => {
    expect(FORMAT_VERSION).toBe(2);
    expect(migrate({ name: 'p', format_version: 1 })).toEqual({ name: 'p' });
    expect(migrate({ name: 'p' })).toEqual({ name: 'p' });
  });
});
