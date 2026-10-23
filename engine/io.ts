// 파일 읽기는 여기에만 둔다. 나머지 엔진은 파일을 모르는 순수 함수다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { CatalogItem, Project, Rule, checkCatalog, checkProject } from './schema';

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

function parseOrThrow<T>(schema: z.ZodType<T>, data: unknown, where: string): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const lines = r.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`${where} 검증 실패\n${lines.join('\n')}`);
  }
  return r.data;
}

/** data/catalog의 rules.json은 구조 규칙, 나머지 *.json은 카탈로그 항목 배열이다. */
export function loadCatalog(dir: string) {
  const items: CatalogItem[] = [];
  let rules: Rule[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const data = readJson(join(dir, f));
    if (f === 'rules.json') rules = parseOrThrow(z.array(Rule), data, f);
    else items.push(...parseOrThrow(z.array(CatalogItem), data, f));
  }
  const errors = checkCatalog(items);
  if (errors.length) throw new Error(`카탈로그 오류\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return { items, rules, byId: new Map(items.map((i) => [i.id, i])) };
}

export function loadProject(path: string, items: CatalogItem[]): Project {
  const p = parseOrThrow(Project, readJson(path), path);
  const errors = checkProject(p, items);
  if (errors.length) throw new Error(`프로젝트 오류\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  return p;
}
