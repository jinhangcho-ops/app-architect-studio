// 파일 읽기는 여기에만 둔다. 검증은 data.ts(브라우저와 공용)가 한다.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildCatalog, buildLaws, buildPrices, parseProject, type JsonFile } from './data';
import type { CatalogItem, LawRow, PriceRow, Project } from './schema';

// 메모장(UTF-8 BOM)으로 고친 파일도 읽게 맨 앞 BOM을 뺀다
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const readDir = (dir: string): JsonFile[] =>
  readdirSync(dir).filter((x) => x.endsWith('.json')).map((name) => ({ name, data: readJson(join(dir, name)) }));

export const loadCatalog = (dir: string) => buildCatalog(readDir(dir));
export const loadPrices = (dir: string): PriceRow[] => buildPrices(readDir(dir));
export const loadProject = (path: string, items: CatalogItem[]): Project => parseProject(readJson(path), items, path);
export const loadLaws = (dir: string): LawRow[] => buildLaws(readDir(dir));
