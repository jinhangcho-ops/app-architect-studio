// 앱 안 찾기 (Ctrl+F): 노드 이름·id, 노드에 고른 카탈로그 항목, 테이블, 컬럼을 찾는다. 대소문자와 띄어쓰기는 무시한다.
import { LAYER_NAMES } from '../../engine/model';
import { itemIds, type CatalogItem, type Project } from '../../engine/schema';

export type Hit =
  | { kind: 'node'; node: string; label: string; detail: string }
  | { kind: 'table'; node: string; table: string; label: string; detail: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');

export function searchProject(p: Project, byId: Map<string, CatalogItem>, query: string, limit = 30): Hit[] {
  const q = norm(query);
  if (!q) return [];
  const has = (s: string) => norm(s).includes(q);
  const hits: Hit[] = [];
  for (const n of p.nodes) {
    const items = itemIds(n).map((id) => byId.get(id)?.name ?? id);
    const item = items.find(has);
    if (has(n.name) || has(n.id) || item) {
      hits.push({ kind: 'node', node: n.id, label: n.name, detail: item ? `${LAYER_NAMES[n.layer]} · 항목 ${item}` : LAYER_NAMES[n.layer] });
    }
    for (const t of n.tables) {
      const cols = t.columns.filter((c) => has(c.name)).map((c) => c.name);
      if (has(t.name) || cols.length) {
        hits.push({ kind: 'table', node: n.id, table: t.name, label: `${n.name}.${t.name}`, detail: cols.length ? `컬럼 ${cols.join(', ')}` : `테이블 · 컬럼 ${t.columns.length}개` });
      }
    }
  }
  return hits.slice(0, limit);
}
