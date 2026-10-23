// 프로젝트 하나와 화면 상태. 노드 위치는 계산과 무관하므로 프로젝트와 따로 둔다(끌 때마다 다시 계산하지 않도록).
import { create } from 'zustand';
import { parseProject } from '../../engine/data';
import type { Project } from '../../engine/schema';
import { catalog, examples } from './data';
import { autoLayout, type XY } from './layout';

export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | { kind: 'table'; node: string; table: string } | null;

type State = {
  project: Project;
  positions: Record<string, XY>;
  selected: Selection;
  /** 프로젝트 전체를 바꾼다(예시·파일 불러오기). 위치가 없으면 자동 배치 */
  load: (p: Project, positions?: Record<string, XY>) => void;
  edit: (fn: (p: Project) => Project) => void;
  move: (id: string, xy: XY) => void;
  relayout: () => void;
  select: (s: Selection) => void;
  /** 안으로 들어가 본 블록(노드 id). 없으면 전체 다이어그램 */
  focus?: string;
  setFocus: (id?: string) => void;
};

const first = examples.find((e) => e.name === 'phase3.json') ?? examples[0];
const initial = parseProject(first.data, catalog.items, first.name);

export const useStore = create<State>((set) => ({
  project: initial,
  positions: autoLayout(initial),
  selected: null,
  load: (p, positions) => set({ project: p, positions: { ...autoLayout(p), ...positions }, selected: null, focus: undefined }),
  edit: (fn) => set((s) => {
    const project = fn(s.project);
    // 새로 생긴 노드에만 자리를 준다
    const missing = project.nodes.filter((n) => !s.positions[n.id]);
    if (!missing.length) return { project };
    const fresh = autoLayout(project);
    return { project, positions: { ...s.positions, ...Object.fromEntries(missing.map((n) => [n.id, { x: fresh[n.id].x, y: fresh[n.id].y + 40 }])) } };
  }),
  move: (id, xy) => set((s) => ({ positions: { ...s.positions, [id]: xy } })),
  relayout: () => set((s) => ({ positions: autoLayout(s.project) })),
  select: (selected) => set({ selected }),
  setFocus: (focus) => set({ focus, selected: null }),
}));

/** 저장 파일: 프로젝트 + 노드 위치(pos). 엔진 스키마는 pos를 모르고 무시한다. */
export function exportProject(p: Project, positions: Record<string, XY>) {
  return { ...p, nodes: p.nodes.map((n) => ({ ...n, pos: positions[n.id] })) };
}
