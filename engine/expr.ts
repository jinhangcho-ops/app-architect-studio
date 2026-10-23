// 카탈로그 조건식 해석·평가기. eval을 쓰지 않고 숫자·문자열·변수·비교·and/or/not·사칙연산만 허용한다.
export type Value = number | boolean | string;
export type Vars = Record<string, Value>;
export type Ast =
  | { k: 'lit'; v: Value }
  | { k: 'var'; name: string }
  | { k: 'not'; e: Ast }
  | { k: 'neg'; e: Ast }
  | { k: 'bin'; op: string; l: Ast; r: Ast };

export class ExprError extends Error {}
export class MissingVar extends ExprError {
  constructor(public varName: string) {
    super(`값이 없는 변수: ${varName}`);
  }
}

type Tok = { t: 'num' | 'str' | 'id' | 'op'; v: string };
const TOKEN = /\s*(?:(\d+(?:\.\d+)?)|'([^']*)'|([A-Za-z_][\w.]*)|(==|!=|<=|>=|[<>+\-*/()]))/y;
const WORDS = new Set(['and', 'or', 'not', 'true', 'false']);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m) throw new ExprError(`해석할 수 없는 문자 (${at}번째): ${src.slice(at)}`);
    if (m[1] !== undefined) toks.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) toks.push({ t: 'str', v: m[2] });
    else if (m[3] !== undefined) toks.push({ t: 'id', v: m[3] });
    else toks.push({ t: 'op', v: m[4] });
  }
  return toks;
}

export function parse(src: string): Ast {
  const toks = tokenize(src);
  let i = 0;
  const is = (t: Tok['t'], v: string) => toks[i]?.t === t && toks[i].v === v;
  const fail = (what: string): never => {
    throw new ExprError(`${what} — 식: ${src}`);
  };

  const or = (): Ast => {
    let l = and();
    while (is('id', 'or')) { i++; l = { k: 'bin', op: 'or', l, r: and() }; }
    return l;
  };
  const and = (): Ast => {
    let l = not();
    while (is('id', 'and')) { i++; l = { k: 'bin', op: 'and', l, r: not() }; }
    return l;
  };
  const not = (): Ast => (is('id', 'not') ? (i++, { k: 'not', e: not() }) : cmp());
  const cmp = (): Ast => {
    const l = add();
    const op = toks[i];
    if (op?.t === 'op' && ['==', '!=', '<', '<=', '>', '>='].includes(op.v)) {
      i++;
      return { k: 'bin', op: op.v, l, r: add() };
    }
    return l;
  };
  const add = (): Ast => {
    let l = mul();
    while (is('op', '+') || is('op', '-')) { const op = toks[i++].v; l = { k: 'bin', op, l, r: mul() }; }
    return l;
  };
  const mul = (): Ast => {
    let l = unary();
    while (is('op', '*') || is('op', '/')) { const op = toks[i++].v; l = { k: 'bin', op, l, r: unary() }; }
    return l;
  };
  const unary = (): Ast => (is('op', '-') ? (i++, { k: 'neg', e: unary() }) : primary());
  const primary = (): Ast => {
    const tok = toks[i++];
    if (!tok) return fail('식이 중간에 끝남');
    if (tok.t === 'num') return { k: 'lit', v: Number(tok.v) };
    if (tok.t === 'str') return { k: 'lit', v: tok.v };
    if (tok.t === 'id') {
      if (tok.v === 'true' || tok.v === 'false') return { k: 'lit', v: tok.v === 'true' };
      if (WORDS.has(tok.v)) return fail(`예약어 위치가 잘못됨: ${tok.v}`);
      return { k: 'var', name: tok.v };
    }
    if (tok.v === '(') {
      const e = or();
      if (!is('op', ')')) fail('닫는 괄호가 없음');
      i++;
      return e;
    }
    return fail(`예상하지 못한 기호: ${tok.v}`);
  };

  const ast = or();
  if (i < toks.length) fail(`남은 토큰: ${toks[i].v}`);
  return ast;
}

const num = (v: Value, op: string): number => {
  if (typeof v !== 'number') throw new ExprError(`'${op}'에는 숫자가 필요함: ${String(v)}`);
  return v;
};
const bool = (v: Value, op: string): boolean => {
  if (typeof v !== 'boolean') throw new ExprError(`'${op}'에는 참/거짓이 필요함: ${String(v)}`);
  return v;
};

export function evaluate(ast: Ast, vars: Vars): Value {
  switch (ast.k) {
    case 'lit': return ast.v;
    case 'var':
      if (!(ast.name in vars)) throw new MissingVar(ast.name);
      return vars[ast.name];
    case 'not': return !bool(evaluate(ast.e, vars), 'not');
    case 'neg': return -num(evaluate(ast.e, vars), '-');
    case 'bin': {
      const { op } = ast;
      // and/or는 왼쪽만으로 결정되면 오른쪽을 보지 않는다 (없는 변수 오류를 피함)
      if (op === 'and') return bool(evaluate(ast.l, vars), op) && bool(evaluate(ast.r, vars), op);
      if (op === 'or') return bool(evaluate(ast.l, vars), op) || bool(evaluate(ast.r, vars), op);
      const l = evaluate(ast.l, vars);
      const r = evaluate(ast.r, vars);
      if (op === '==') return l === r;
      if (op === '!=') return l !== r;
      const a = num(l, op), b = num(r, op);
      switch (op) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
      }
    }
  }
  throw new ExprError('알 수 없는 식');
}

export function test(src: string | Ast, vars: Vars): boolean {
  return bool(evaluate(typeof src === 'string' ? parse(src) : src, vars), '조건식');
}
