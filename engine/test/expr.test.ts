import { describe, expect, it } from 'vitest';
import { ExprError, MissingVar, evaluate, parse, test } from '../expr';

describe('조건식', () => {
  it('사칙연산 우선순위와 괄호', () => {
    expect(evaluate(parse('1 + 2 * 3'), {})).toBe(7);
    expect(evaluate(parse('(1 + 2) * 3'), {})).toBe(9);
    expect(evaluate(parse('-2 - -3'), {})).toBe(1);
  });

  it('설계서 SQLite 조건 (점이 든 변수 이름 포함)', () => {
    const src = 'peak_write_rps > th.write_rps or writer_nodes > 1';
    expect(test(src, { peak_write_rps: 58, 'th.write_rps': 50, writer_nodes: 1 })).toBe(true);
    expect(test(src, { peak_write_rps: 19, 'th.write_rps': 50, writer_nodes: 1 })).toBe(false);
  });

  it('문자열 비교와 not', () => {
    expect(test("from_layer == 'ui' and not (to_layer == 'gateway')", { from_layer: 'ui', to_layer: 'db' })).toBe(true);
  });

  it('and/or는 왼쪽으로 결정되면 오른쪽의 없는 변수를 보지 않음', () => {
    expect(test('false and missing > 1', {})).toBe(false);
    expect(test('true or missing > 1', {})).toBe(true);
  });

  it('없는 변수는 MissingVar', () => {
    expect(() => test('x > 1', {})).toThrow(MissingVar);
  });

  it('잘못된 식과 타입 오류는 거부', () => {
    for (const bad of ['1 +', 'a >', '(a > 1', 'a > 1 b', 'a ; b', 'and > 1']) {
      expect(() => parse(bad), bad).toThrow(ExprError);
    }
    expect(() => test('1 + 1', {})).toThrow(ExprError);
    expect(() => test("'a' > 1", {})).toThrow(ExprError);
  });
});
