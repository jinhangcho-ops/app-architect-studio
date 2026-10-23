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
  /** 되돌리기(Ctrl+Z)·다시 하기(Ctrl+Y)용 이전·다음 프로젝트 */
  past: Project[];
  future: Project[];
  undo: () => void;
  redo: () => void;
  /** Ctrl+C로 복사한 노드 */
  clipboard?: Project['nodes'][number];
  /** 찾기에서 고른 노드로 캔버스를 옮기라는 요청 (캔버스가 처리하고 지운다) */
  flyTo?: string;
  set: (patch: Partial<Pick<State, 'clipboard' | 'flyTo'>>) => void;
};

const HISTORY = 100;
// 숫자 칸을 한 글자씩 고칠 때마다 기록이 쌓이지 않게, 이 시간 안에 이어진 편집은 한 번으로 묶는다
const MERGE_MS = 500;
let lastEdit = 0;
/** 지금 프로젝트를 되돌리기 기록에 넣는다 (바로 전 편집과 묶이면 넣지 않는다) */
const remember = (s: State, merge: boolean): Pick<State, 'past' | 'future'> => {
  const now = Date.now();
  const join = merge && now - lastEdit < MERGE_MS && s.past.length > 0;
  lastEdit = merge ? now : 0;
  return { past: join ? s.past : [...s.past, s.project].slice(-HISTORY), future: [] };
};

const first = examples.find((e) => e.name === 'phase3.json') ?? examples[0];
const initial = parseProject(first.data, catalog.items, first.name);

export const useStore = create<State>((set) => ({
  project: initial,
  past: [],
  future: [],
  positions: autoLayout(initial),
  selected: null,
  // 다른 프로젝트를 불러오는 것도 되돌릴 수 있다
  load: (p, positions) => set((s) => ({ ...remember(s, false), project: p, positions: { ...autoLayout(p), ...positions }, selected: null, focus: undefined })),
  edit: (fn) => set((s) => {
    const project = fn(s.project);
    if (project === s.project) return {};
    const history = remember(s, true);
    // 새로 생긴 노드에만 자리를 준다
    const missing = project.nodes.filter((n) => !s.positions[n.id]);
    if (!missing.length) return { project, ...history };
    const fresh = autoLayout(project);
    return { project, ...history, positions: { ...s.positions, ...Object.fromEntries(missing.map((n) => [n.id, { x: fresh[n.id].x, y: fresh[n.id].y + 40 }])) } };
  }),
  move: (id, xy) => set((s) => ({ positions: { ...s.positions, [id]: xy } })),
  relayout: () => set((s) => ({ positions: autoLayout(s.project) })),
  select: (selected) => set({ selected }),
  setFocus: (focus) => set({ focus, selected: null }),
  set: (patch) => set(patch),
  undo: () => set((s) => {
    if (!s.past.length) return {};
    lastEdit = 0;
    return { project: s.past.at(-1)!, past: s.past.slice(0, -1), future: [s.project, ...s.future] };
  }),
  redo: () => set((s) => {
    if (!s.future.length) return {};
    lastEdit = 0;
    return { project: s.future[0], future: s.future.slice(1), past: [...s.past, s.project] };
  }),
}));

/** 저장 파일: 프로젝트 + 노드 위치(pos). 엔진 스키마는 pos를 모르고 무시한다. */
export function exportProject(p: Project, positions: Record<string, XY>) {
  return { ...p, nodes: p.nodes.map((n) => ({ ...n, pos: positions[n.id] })) };
}
