// 앱에 함께 넣는 기본 카탈로그·가격표·예시 프로젝트. 엔진과 같은 검증(engine/data.ts)을 거친다.
import { buildCatalog, buildLaws, buildPrices, type JsonFile } from '../../engine/data';

const files = (glob: Record<string, unknown>): JsonFile[] =>
  Object.entries(glob).map(([path, data]) => ({ name: path.split('/').pop()!, data }));

export const catalog = buildCatalog(files(import.meta.glob('../../data/catalog/*.json', { eager: true, import: 'default' })));
export const prices = buildPrices(files(import.meta.glob('../../data/prices/*.json', { eager: true, import: 'default' })));
export const examples = files(import.meta.glob('../../examples/*.json', { eager: true, import: 'default' }));
export const laws = buildLaws(files(import.meta.glob('../../data/laws/*.json', { eager: true, import: 'default' })));
export const engineData = { catalog: catalog.byId, rules: catalog.rules, prices, laws };
