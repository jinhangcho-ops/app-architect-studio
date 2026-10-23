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

export function parseProject(data: unknown, items: CatalogItem[], where = '프로젝트'): Project {
  const p = parseOrThrow(Project, data, where);
  const errors = checkProject(p, items);
  if (errors.length) throw new Error(`프로젝트 오류\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return p;
}

export const buildLaws = (files: JsonFile[]): LawRow[] =>
  [...files].sort((a, b) => a.name.localeCompare(b.name)).flatMap((f) => parseOrThrow(z.array(LawRow), f.data, f.name));
