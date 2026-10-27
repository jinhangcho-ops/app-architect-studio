// 앱 안 찾기 (Ctrl+F): 노드 이름·id·설명, 노드에 고른 카탈로그 항목, 테이블, 컬럼, 설계 메모 장(제목·본문)을 찾는다. 대소문자와 띄어쓰기는 무시한다.
import { LAYER_NAMES } from '../../engine/model';
import { chapterTitle } from './notes';
import { itemIds, type CatalogItem, type Project } from '../../engine/schema';

export type Hit =
  | { kind: 'node'; node: string; label: string; detail: string }
  | { kind: 'table'; node: string; table: string; label: string; detail: string }
  | { kind: 'note'; index: number; label: string; detail: string };

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, '');
/** 찾은 곳 앞뒤 몇 글자 (긴 메모에서 어디가 맞았는지 보이게). 띄어쓰기를 무시하고 찾으므로 못 찾으면 앞부분 */
const around = (text: string, query: string) => {
  const i = text.toLowerCase().indexOf(query.trim().toLowerCase());
  const s = i < 0 ? text : text.slice(Math.max(0, i - 12), i + query.length + 20);
  return `${i > 12 ? '…' : ''}${s.replace(/\s+/g, ' ').slice(0, 40)}…`;
};

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
    } else if (n.description && has(n.description)) {
      hits.push({ kind: 'node', node: n.id, label: n.name, detail: `설명 ${around(n.description, query)}` });
    }
    for (const t of n.tables) {
      const cols = t.columns.filter((c) => has(c.name)).map((c) => c.name);
      if (has(t.name) || cols.length) {
        hits.push({ kind: 'table', node: n.id, table: t.name, label: `${n.name}.${t.name}`, detail: cols.length ? `컬럼 ${cols.join(', ')}` : `테이블 · 컬럼 ${t.columns.length}개` });
      }
    }
  }
  p.notes.forEach((note, index) => {
    if (has(note.title) || has(note.body)) hits.push({ kind: 'note', index, label: `설계 메모 ${index + 1}. ${chapterTitle(note.title)}`, detail: has(note.title) ? '장 제목' : around(note.body, query) });
  });
  return hits.slice(0, limit);
}
