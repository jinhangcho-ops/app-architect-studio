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
export const FORMAT_VERSION = 2;
type Raw = Record<string, unknown>;
/** MIGRATIONS[v]: 형식 v인 파일을 v + 1로 바꾼다 */
export const MIGRATIONS: Record<number, (d: Raw) => Raw> = {
  // 2: 고정장·데이터 사전·테이블 연결이 새로 생김. 모양은 그대로라 바꿀 것이 없고, 옛 앱이 새 칸을 지우며 저장하지 않게 버전만 올림
  1: (d) => d,
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

/** 숫자 칸의 범위·정수 오류면 사람이 읽는 이유, 다른 종류면 undefined */
function numberRangeWhy(i: z.core.$ZodIssue): string | undefined {
  if (i.code === 'too_big' && i.origin === 'number') return `${i.maximum} ${i.inclusive ? '이하' : '미만'}여야 함`;
  if (i.code === 'too_small' && i.origin === 'number') return `${i.minimum} ${i.inclusive ? '이상' : '초과'}여야 함`;
  if (i.code === 'invalid_type' && i.expected === 'int') return '정수여야 함';
  return undefined;
}

/** 앱이 파일·저장 기록을 열 때: 형식 변환과 모양만 검사 (checkProject 오류는 계산 때 배너로 보여 고칠 수 있게).
 *  오류가 모두 선택 숫자 칸의 범위·정수 오류면 그 칸을 빼고(기본값이 있으면 기본값) 열고, 뺀 칸을 notes에 한 줄씩 적는다 */
export function readProject(data: unknown, _items: CatalogItem[], where = '프로젝트', notes?: string[]): Project {
  const d = migrate(data, where);
  const r = Project.safeParse(d);
  if (r.success) return r.data;
  // 화면에서 비운 이름 칸(name = '')은 필수라 뺄 수 없어서, id나 '이름 없음'으로 채운다
  const emptyName = (i: z.core.$ZodIssue) => i.code === 'too_small' && i.origin === 'string' && i.path.at(-1) === 'name';
  // 배열 칸(경로 끝이 번호)은 빼면 순서가 밀리므로 건너뛰지 않고 오류로 둔다
  if (r.error.issues.every((i) => emptyName(i) || (numberRangeWhy(i) && typeof i.path.at(-1) === 'string'))) {
    const copy = structuredClone(d) as Record<string, unknown>;
    const lines = r.error.issues.flatMap((i) => {
      const parent = i.path.slice(0, -1).reduce<Record<PropertyKey, unknown>>((o, k) => o[k] as Record<PropertyKey, unknown>, copy);
      const key = i.path.at(-1) as string, value = parent[key];
      if (emptyName(i)) {
        parent[key] = typeof parent.id === 'string' && parent.id ? parent.id : '이름 없음';
        return [`${i.path.join('.')}: 이름이 비어 있어 "${String(parent[key])}"로 채웠습니다`];
      }
      // 한 칸에 오류가 둘(정수 아님 + 범위 밖)이면 한 번만 적는다
      if (!(key in parent)) return [];
      delete parent[key];
      return [`${i.path.join('.')} = ${String(value)}: ${numberRangeWhy(i)} → 빼고 열었습니다 (기본값이 있으면 기본값)`];
    });
    // 뺀 칸이 필수 칸이면 다시 검사가 실패하므로 원래 오류를 던진다
    const again = Project.safeParse(copy);
    if (again.success) { notes?.push(...lines); return again.data; }
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
