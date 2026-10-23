// tools/analyze_py.py가 만든 JSON을 검증해 프로젝트에 합친다.
// 모듈 → 노드, 모듈끼리 import → 연결선, 라이브러리 → 카탈로그 항목 노드(같은 항목은 하나로).
import { z } from 'zod';
import { parseOrThrow } from '../../engine/data';
import type { Layer } from '../../engine/model';
import { EdgeSchema, NodeSchema, type Project } from '../../engine/schema';
import { catalog } from './data';

const CodeAnalysis = z.object({
  source: z.string(),
  modules: z.array(z.object({
    id: z.string(), file: z.string(), layer: z.enum(['backend', 'batch']),
    eager: z.array(z.string()), lazy: z.array(z.string()), privacy_hints: z.array(z.string()),
  })),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
  matches: z.array(z.object({ module: z.string(), library: z.string(), item: z.string(), eager: z.boolean() })),
});

export function mergeCodeAnalysis(p: Project, data: unknown): Project {
  const a = parseOrThrow(CodeAnalysis, data, '코드 분석 JSON');
  const have = new Set(p.nodes.map((n) => n.id));
  const nodes = [...p.nodes];
  const edges = [...p.edges];
  const addNode = (raw: object) => { const n = NodeSchema.parse(raw); if (!have.has(n.id)) { nodes.push(n); have.add(n.id); } };
  const addEdge = (from: string, to: string) => { if (!edges.some((e) => e.from === from && e.to === to)) edges.push(EdgeSchema.parse({ from, to })); };

  for (const m of a.modules) {
    const hints = m.privacy_hints.length ? `개인정보 후보(확인 필요): ${m.privacy_hints.join(', ')}` : '';
    const loading = `상시 로드: ${m.eager.join(', ') || '없음'} / 지연 로드: ${m.lazy.join(', ') || '없음'}`;
    addNode({ id: `py:${m.id}`, name: m.id, layer: m.layer, description: [`파일 ${m.file}`, loading, hints].filter(Boolean).join('\n') });
  }
  for (const e of a.edges) addEdge(`py:${e.from}`, `py:${e.to}`);
  for (const x of a.matches) {
    const item = catalog.byId.get(x.item);
    if (!item) continue; // 카탈로그에 없는 항목은 매칭하지 않는다
    const layer = item.attaches_to[0] as Layer;
    const id = `lib:${x.item}`;
    addNode({ id, name: item.name, layer, ...(item.role === '주' ? { primary: x.item } : { extras: [x.item] }), description: `코드에서 찾은 라이브러리: ${x.library}` });
    addEdge(`py:${x.module}`, id);
  }
  return { ...p, nodes, edges };
}
