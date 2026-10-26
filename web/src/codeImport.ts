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

/** skipped: 순환 import라 넣지 않은 연결선 수 (순환이 있으면 부하 계산 전체가 멈춘다) */
export function mergeCodeAnalysis(p: Project, data: unknown): { project: Project; skipped: number } {
  const a = parseOrThrow(CodeAnalysis, data, '코드 분석 JSON');
  const have = new Set(p.nodes.map((n) => n.id));
  const nodes = [...p.nodes];
  const edges = [...p.edges];
  let skipped = 0;
  const addNode = (raw: object) => { const n = NodeSchema.parse(raw); if (!have.has(n.id)) { nodes.push(n); have.add(n.id); } };
  /** to에서 연결선을 따라 from에 닿으면 from → to가 순환을 만든다 */
  const reaches = (start: string, goal: string) => {
    const seen = new Set<string>();
    const stack = [start];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === goal) return true;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const e of edges) if (e.from === id) stack.push(e.to);
    }
    return false;
  };
  const addEdge = (from: string, to: string) => {
    if (edges.some((e) => e.from === from && e.to === to)) return;
    if (reaches(to, from)) { skipped++; return; }
    edges.push(EdgeSchema.parse({ from, to }));
  };

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
  return { project: { ...p, nodes, edges }, skipped };
}
