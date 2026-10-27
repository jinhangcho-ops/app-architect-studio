// 이미 읽은 JSON을 검증해 엔진 입력으로 바꾼다. 파일을 모르므로 Node(io.ts)와 브라우저(web)가 함께 쓴다.
import { z } from 'zod';
import { CatalogItem, LawRow, PriceRow, Project, Rule, checkCatalog, checkProject } from './schema';

export type JsonFile = { name: string; data: unknown };

export function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, where: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`${where} 검증 실패\n${lines.join('\n')}`);
  }
  return r.data;
}

/** rules.json은 구조 규칙, 나머지는 카탈로그 항목 배열이다. */
export function buildCatalog(files: JsonFile[]) {
  const items: CatalogItem[] = [];
  let rules: Rule[] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    if (f.name === 'rules.json') rules = parseOrThrow(z.array(Rule), f.data, f.name);
    else items.push(...parseOrThrow(z.array(CatalogItem), f.data, f.name));
  }
  const errors = checkCatalog(items);
  if (errors.length) throw new Error(`카탈로그 오류\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return { items, rules, byId: new Map(items.map((i) => [i.id, i])) };
}

/** id가 겹치면 어느 값을 쓸지 모호하므로 거부한다. */
export function buildPrices(files: JsonFile[]): PriceRow[] {
  const rows = [...files].sort((a, b) => a.name.localeCompare(b.name)).flatMap((f) => parseOrThrow(z.array(PriceRow), f.data, f.name));
  const dup = rows.map((r) => r.id).filter((id, i, all) => all.indexOf(id) !== i);
  if (dup.length) throw new Error(`가격표에 중복된 id: ${[...new Set(dup)].join(', ')}`);
  return rows;
}

/** 저장 파일 형식 버전. 저장 파일의 모양이 바뀌면(필드 이름·뜻이 바뀜) 올리고 MIGRATIONS에 옛 모양을 새 모양으로 바꾸는 함수를 더한다.
 *  format_version이 없는 파일은 1 (버전을 넣기 전에 만든 파일) */
export const FORMAT_VERSION = 3;
type Raw = Record<string, unknown>;
/** MIGRATIONS[v]: 형식 v인 파일을 v + 1로 바꾼다 */
export const MIGRATIONS: Record<number, (d: Raw) => Raw> = {
  // 2: 고정장·데이터 사전·테이블 연결이 새로 생김. 모양은 그대로라 바꿀 것이 없고, 옛 앱이 새 칸을 지우며 저장하지 않게 버전만 올림
  1: (d) => d,
  // 3: 노드의 requirements·python(FastAPI 뼈대를 버전에 맞춤)이 새로 생김. 바꿀 것 없이 버전만 올림 (2와 같은 이유)
  2: (d) => d,
};

/** 저장 파일을 지금 형식으로 바꾼다. 이 앱보다 새 버전에서 만든 파일은 모르는 값이 버려져 다시 저장할 때 사라지므로 열지 않는다 */
export function migrate(data: unknown, where = '프로젝트', current = FORMAT_VERSION, steps = MIGRATIONS): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  let d = data as Raw, v = d.format_version ?? 1;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${where}: 형식 버전(format_version)이 올바르지 않습니다: ${String(v)}`);
  if (v > current) throw new Error(`${where}: 더 새 버전의 앱에서 만든 파일입니다 (파일 형식 ${v}, 이 앱은 ${current}까지). 앱을 최신으로 바꾼 뒤 여세요`);
  for (; v < current; v++) {
    if (!steps[v]) throw new Error(`${where}: 형식 ${v} → ${v + 1} 변환이 없습니다`);
    d = steps[v](d);
  }
  const { format_version: _v, ...rest } = d;
  return rest;
}

/** 숫자 칸의 범위·정수 오류면 사람이 읽는 이유(받침에 맞춘 한 줄), 다른 종류면 undefined. 화면 알림도 같은 말을 쓰게 내보낸다 */
export function numberRangeWhy(i: z.core.$ZodIssue): string | undefined {
  if (i.code === 'too_big' && i.origin === 'number') return i.inclusive ? `${i.maximum} 이하여야 함` : `${i.maximum}보다 작아야 함`;
  if (i.code === 'too_small' && i.origin === 'number') return i.inclusive ? `${i.minimum} 이상이어야 함` : `${i.minimum}보다 커야 함`;
  if (i.code === 'invalid_type' && i.expected === 'int') return '정수여야 함';
  return undefined;
}

/** 방식을 바꿀 때 화면이 넣는 경로 기본값 (web/src/InterfacesPanel.tsx와 같게) */
const DEFAULT_PATH: Record<string, string> = { rest: '/path', grpc: 'Method1', message: 'topic.name', file: 'FILE_ID' };
type Obj = Record<PropertyKey, unknown>;
const at = (root: unknown, path: PropertyKey[]) => path.reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Obj)[k] : undefined), root);

/** 범위 밖 숫자를 경계 안으로: 정수 아님은 반올림, 포함 경계면 그 값, 0 초과처럼 열린 경계면 경계 + 1 */
function fitNumber(v: number, issues: z.core.$ZodIssue[]): number {
  if (issues.some((i) => i.code === 'invalid_type')) v = Math.round(v);
  for (const i of issues) {
    if (i.code === 'too_small') v = Math.max(v, Number(i.minimum) + (i.inclusive ? 0 : 1));
    if (i.code === 'too_big') v = Math.min(v, Number(i.maximum) - (i.inclusive ? 0 : 1));
  }
  return v;
}

/** 화면 편집으로 생길 수 있는 모양 오류를 고친 사본. 고칠 수 없는 오류가 하나라도 있으면 undefined */
function repair(src: unknown, issues: z.core.$ZodIssue[], lines: string[]): unknown {
  const copy = structuredClone(src);
  const nums = new Map<string, { path: PropertyKey[]; issues: z.core.$ZodIssue[] }>();
  const drops: { list: unknown[]; k: number }[] = [];
  for (const i of issues) {
    const o = at(copy, i.path.slice(0, -1)) as Obj, key = i.path.at(-1), where = i.path.join('.');
    if (!o || typeof o !== 'object' || key === undefined) return undefined;
    const listOf = i.path.at(-3);
    if (numberRangeWhy(i)) {
      // 한 칸에 오류가 둘(정수 아님 + 범위 밖)이면 한 번에 고친다
      const e = nums.get(where) ?? { path: i.path, issues: [] };
      e.issues.push(i);
      nums.set(where, e);
    } else if (i.code === 'too_small' && i.origin === 'string') {
      // 비운 필수 글자 칸: 이름은 id나 '이름 없음', 인터페이스 경로는 방식 기본값, 그 밖은 '-'
      o[key] = key === 'name' ? (typeof o.id === 'string' && o.id ? o.id : '이름 없음') : key === 'path' ? DEFAULT_PATH[String(o.kind)] ?? '-' : '-';
      lines.push(`${where}: 비어 있어 채웠습니다 → "${String(o[key])}"`);
    } else if (i.code === 'invalid_format' && key === 'name' && (listOf === 'request' || listOf === 'response')) {
      const list = at(copy, i.path.slice(0, -2)) as Obj[];
      let n = 1;
      while (list.some((f) => f.name === `field${n}`)) n++;
      lines.push(`${where} = "${String(o.name)}": 필드 이름은 영문·숫자·_ → field${n} 이름으로 바꿨습니다`);
      o.name = `field${n}`;
    } else if (i.code === 'invalid_format' && key === 'python' && i.path[0] === 'nodes') {
      // 손으로 고친 파일의 "3.x" 같은 값: 빼면 3.9 이상으로 본다
      lines.push(`${where} = "${String(o.python)}": Python 버전은 3.12처럼 → 빼고 열었습니다`);
      delete o.python;
    } else if (i.code === 'invalid_format' && key === 'code' && listOf === 'errors') {
      lines.push(`${where} = "${String(o.code)}": 에러 코드는 영문·숫자·_.- → 빼고 열었습니다`);
      delete o.code;
    } else if (i.code === 'too_small' && i.origin === 'array' && key === 'columns' && listOf === 'indexes') {
      drops.push({ list: at(copy, i.path.slice(0, -2)) as unknown[], k: i.path.at(-2) as number });
      lines.push(`${i.path.slice(0, -1).join('.')}: 인덱스 컬럼이 비어 있어 인덱스를 지웠습니다`);
    } else if (i.code === 'too_small' && i.origin === 'array' && key === 'columns' && listOf === 'tables') {
      o.columns = [{ name: 'id', type: 'bigint' }];
      lines.push(`${where}: 컬럼이 없어 id(bigint) 컬럼 하나를 넣었습니다`);
    } else return undefined;
  }
  if (nums.size) {
    // 선택 칸은 빼고(기본값이 있으면 기본값), 빼면 다시 실패하는 필수 칸과 배열 안 숫자(빼면 순서가 밀림)는 경계값으로 맞춘다
    const probe = structuredClone(copy);
    for (const { path } of nums.values()) if (typeof path.at(-1) === 'string') delete (at(probe, path.slice(0, -1)) as Obj)[path.at(-1)!];
    const missing = new Set((Project.safeParse(probe).error?.issues ?? []).map((i) => i.path.join('.')));
    for (const [where, { path, issues: list }] of nums) {
      const o = at(copy, path.slice(0, -1)) as Obj, key = path.at(-1)!, v = o[key];
      const why = [...new Set(list.map(numberRangeWhy))].join(', ');
      if (typeof key === 'string' && !missing.has(where)) {
        delete o[key];
        lines.push(`${where} = ${String(v)}: ${why} → 빼고 열었습니다 (기본값이 있으면 기본값)`);
      } else {
        if (typeof v !== 'number') return undefined;
        o[key] = fitNumber(v, list);
        lines.push(`${where} = ${v}: ${why} → ${String(o[key])} 값으로 맞췄습니다`);
      }
    }
  }
  // 지울 인덱스는 뒤에서부터 (앞을 지우면 번호가 밀림)
  for (const { list, k } of drops.sort((a, b) => b.k - a.k)) list.splice(k, 1);
  return copy;
}

/** 앱이 파일·저장 기록을 열 때: 형식 변환과 모양만 검사 (checkProject 오류는 계산 때 배너로 보여 고칠 수 있게).
 *  화면 편집으로 생길 수 있는 모양 오류(범위 밖 숫자, 비운 글자 칸, 한글 필드 이름, 빈 컬럼 목록 …)는 고쳐 열고 고친 것을 notes에 한 줄씩 적는다 */
export function readProject(data: unknown, _items: CatalogItem[], where = '프로젝트', notes?: string[]): Project {
  const d = migrate(data, where);
  const lines: string[] = [];
  let cur: unknown = d;
  // 고친 값이 새 오류를 낼 수 있어(정수 칸 0.4 → 반올림 0 → 0보다 커야 함) 몇 번 되풀이한다
  for (let pass = 0; pass < 3 && cur !== undefined; pass++) {
    const r = Project.safeParse(cur);
    if (r.success) { notes?.push(...lines); return r.data; }
    cur = repair(cur, r.error.issues, lines);
  }
  return parseOrThrow(Project, d, where);
}

export function parseProject(data: unknown, items: CatalogItem[], where = '프로젝트'): Project {
  // CLI·예시는 엄격하게: 범위 밖 숫자 칸을 빼고 여는 것은 앱 열기(readProject)만
  const p = parseOrThrow(Project, migrate(data, where), where);
  const errors = checkProject(p, items);
  if (errors.length) throw new Error(`프로젝트 오류\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return p;
}

export const buildLaws = (files: JsonFile[]): LawRow[] =>
  [...files].sort((a, b) => a.name.localeCompare(b.name)).flatMap((f) => parseOrThrow(z.array(LawRow), f.data, f.name));
