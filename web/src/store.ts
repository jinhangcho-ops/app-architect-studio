// 프로젝트 하나와 화면 상태. 노드 위치는 계산과 무관하므로 프로젝트와 따로 둔다(끌 때마다 다시 계산하지 않도록).
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { FORMAT_VERSION, numberRangeWhy, parseProject, readProject } from '../../engine/data';
import { Project as ProjectSchema, type Project } from '../../engine/schema';
import { catalog, examples } from './data';
import { autoLayout, type XY } from './layout';

export type DetailTab = 'servers' | 'tables' | 'parts' | 'wireframe';
export type Selection = { kind: 'node'; id: string } | { kind: 'edge'; from: string; to: string } | { kind: 'table'; node: string; table: string } | null;

type State = {
  project: Project;
  /** 마지막으로 불러온 프로젝트 (설정 화면이 "바뀐 항목"을 세고 되돌리는 기준) */
  baseline: Project;
  positions: Record<string, XY>;
  selected: Selection;
  /** 프로젝트 전체를 바꾼다(예시·파일 불러오기). 위치가 없으면 자동 배치.
   *  boundary=false: 같은 파일의 이전 시점 복구처럼 열린 파일 경로가 그대로 맞는 경우 (되돌려도 불러오기 경계로 치지 않음) */
  load: (p: Project, positions?: Record<string, XY>, boundary?: boolean) => void;
  edit: (fn: (p: Project) => Project) => void;
  move: (id: string, xy: XY) => void;
  relayout: () => void;
  select: (s: Selection) => void;
  /** 안으로 들어가 본 블록(노드 id). 없으면 전체 다이어그램 */
  focus?: string;
  /** 세부 구성에서 연 탭 */
  focusTab: DetailTab;
  setFocus: (id?: string, tab?: DetailTab) => void;
  /** 되돌리기(Ctrl+Z)·다시 하기(Ctrl+Y)용 이전·다음 프로젝트 */
  past: Project[];
  future: Project[];
  /** 되돌린 뒤 다른 프로젝트를 불러오기 전으로 넘어갔으면 true (열린 파일 경로가 더는 맞지 않는다) */
  undo: () => boolean;
  redo: () => boolean;
  /** Ctrl+C로 복사한 노드 */
  clipboard?: Project['nodes'][number];
  /** 찾기에서 고른 노드로 캔버스를 옮기라는 요청 (캔버스가 처리하고 지운다) */
  flyTo?: string;
  /** 저장하면 열 수 없는 값이라 적용하지 않은 편집의 알림 (App이 보이고, 다음 편집이 성공하거나 6초 뒤 지운다) */
  rejected?: string;
  set: (patch: Partial<Pick<State, 'clipboard' | 'flyTo' | 'focusTab' | 'rejected'>>) => void;
};

const HISTORY = 100;
// 숫자 칸을 한 글자씩 고칠 때마다 기록이 쌓이지 않게, 이 시간 안에 이어진 편집은 한 번으로 묶는다
const MERGE_MS = 500;
let lastEdit = 0;
/** load로 들어온 프로젝트. 되돌리기·다시 하기가 이것을 지나면 불러오기 경계를 넘은 것 */
const loaded = new WeakSet<Project>();
/** 지금 프로젝트를 되돌리기 기록에 넣는다 (바로 전 편집과 묶이면 넣지 않는다) */
const remember = (s: State, merge: boolean): Pick<State, 'past' | 'future'> => {
  const now = Date.now();
  const join = merge && now - lastEdit < MERGE_MS && s.past.length > 0;
  lastEdit = merge ? now : 0;
  return { past: join ? s.past : [...s.past, s.project].slice(-HISTORY), future: [] };
};

/** p의 모양(zod) 오류 (경로 → 한국어 이유). 글자 칸 비우기는 다시 치는 중이라 세지 않는다 (열 때 readProject가 채운다) */
function shapeIssues(p: Project): Map<string, string> {
  const r = ProjectSchema.safeParse(p);
  const out = new Map<string, string>();
  for (const i of r.success ? [] : r.error.issues) {
    if (i.code === 'too_small' && i.origin === 'string') continue;
    const why = numberRangeWhy(i)
      ?? (i.code === 'invalid_type' && i.expected === 'number' ? '숫자여야 함'
        : i.code === 'too_small' && i.origin === 'array' ? '하나 이상 있어야 함'
        : i.message);
    out.set(i.path.join('.'), why);
  }
  return out;
}

const first = examples.find((e) => e.name === 'phase3.json') ?? examples[0];
const initial = parseProject(first.data, catalog.items, first.name);

export const useStore = create<State>((set, get) => ({
  project: initial,
  baseline: initial,
  past: [],
  future: [],
  positions: autoLayout(initial),
  selected: null,
  // 다른 프로젝트를 불러오는 것도 되돌릴 수 있다
  load: (p, positions, boundary = true) => { if (boundary) loaded.add(p); set((s) => ({ ...remember(s, false), project: p, baseline: p, positions: { ...autoLayout(p), ...positions }, selected: null, focus: undefined })); },
  edit: (fn) => set((s) => {
    const project = fn(s.project);
    if (project === s.project) return {};
    // 모양이 틀린 값(비율 80, 필드 이름 한글, 마지막 컬럼 삭제 …)을 저장하면 그 파일·자동 저장 시점을 못 연다 → 새로 생기는 오류면 적용하지 않고 알림
    const bad = shapeIssues(project);
    if (bad.size) {
      const had = shapeIssues(s.project);
      const fresh = [...bad].filter(([k]) => !had.has(k));
      if (fresh.length) return { rejected: `저장하면 열 수 없는 값이라 바꾸지 않았어요: ${fresh.map(([k, why]) => `${k} (${why})`).join(', ')}` };
    }
    const history = remember(s, true);
    // 새로 생긴 노드에만 자리를 준다. 편집이 성공하면 지난 거절 알림은 지운다
    const missing = project.nodes.filter((n) => !s.positions[n.id]);
    if (!missing.length) return { project, ...history, rejected: undefined };
    const fresh = autoLayout(project);
    return { project, ...history, rejected: undefined, positions: { ...s.positions, ...Object.fromEntries(missing.map((n) => [n.id, { x: fresh[n.id].x, y: fresh[n.id].y + 40 }])) } };
  }),
  move: (id, xy) => set((s) => ({ positions: { ...s.positions, [id]: xy } })),
  relayout: () => set((s) => ({ positions: autoLayout(s.project) })),
  select: (selected) => set({ selected }),
  focusTab: 'servers',
  setFocus: (focus, tab = 'servers') => set({ focus, focusTab: tab, selected: null }),
  set: (patch) => set(patch),
  undo: () => {
    const s = get();
    if (!s.past.length) return false;
    lastEdit = 0;
    set({ project: s.past.at(-1)!, past: s.past.slice(0, -1), future: [s.project, ...s.future] });
    return loaded.has(s.project);
  },
  redo: () => {
    const s = get();
    if (!s.future.length) return false;
    lastEdit = 0;
    set({ project: s.future[0], future: s.future.slice(1), past: [...s.past, s.project] });
    return loaded.has(s.future[0]);
  },
}));

/** 저장 파일: 프로젝트 + 노드 위치(pos). 엔진 스키마는 pos를 모르고 무시한다. */
export function exportProject(p: Project, positions: Record<string, XY>) {
  return { format_version: FORMAT_VERSION, ...p, nodes: p.nodes.map((n) => ({ ...n, pos: positions[n.id] })) };
}

/** 저장 파일 → 프로젝트와 노드 위치 (exportProject의 반대). 모양이 틀린 파일이면 던지고, checkProject 오류는 run()이 배너로 보인다.
 *  화면에서 고를 수도 지울 수도 없는 것(없는 노드에 닿은 연결선, 페르소나의 없는 행동 비율)은 걸러 내고 dropped로 알린다 */
export function importProject(data: unknown, name: string): { project: Project; positions: Record<string, XY>; dropped?: string } {
  const raw = (data as { nodes?: { id: string; pos?: XY }[] }).nodes ?? [];
  const notes: string[] = [];
  const read = readProject(data, catalog.items, name, notes);
  // id가 겹친 노드는 둘째부터 -2, -3… (연결선·행동은 어느 쪽인지 모르므로 첫째에 남는다)
  const ids = new Set(read.nodes.map((n) => n.id));
  const seen = new Set<string>();
  let renamed = 0;
  const nodes = read.nodes.map((n) => {
    if (!seen.has(n.id)) { seen.add(n.id); return n; }
    let k = 2;
    while (ids.has(`${n.id}-${k}`)) k++;
    const id = `${n.id}-${k}`;
    ids.add(id); seen.add(id); renamed++;
    return { ...n, id };
  });
  const p = renamed ? { ...read, nodes } : read;
  // 위치도 바뀐 id로 (readProject는 노드 순서를 그대로 둔다)
  const positions = Object.fromEntries(raw.flatMap((n, k) => (n.pos && nodes[k] ? [[nodes[k].id, n.pos]] : [])));
  const acts = new Set(p.actions.map((a) => a.name));
  const edges = p.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  let rates = 0;
  const personas = p.personas.map((ps) => {
    const keep = Object.entries(ps.action_rates).filter(([k]) => acts.has(k));
    rates += Object.keys(ps.action_rates).length - keep.length;
    return keep.length < Object.keys(ps.action_rates).length ? { ...ps, action_rates: Object.fromEntries(keep) } : ps;
  });
  const lost = [p.edges.length > edges.length && `없는 노드에 닿은 연결선 ${p.edges.length - edges.length}개`, rates && `페르소나의 없는 행동 비율 ${rates}개`].filter(Boolean);
  const said = [
    lost.length && `파일에서 고칠 수 없는 항목을 뺐습니다: ${lost.join(', ')}`,
    renamed && `노드 id가 겹친 ${renamed}개는 뒤에 -2, -3…을 붙였습니다 (연결선은 첫 노드에만 남음)`,
    // readProject가 범위 밖 선택 숫자 칸을 빼고 연 내용 (한 줄씩)
    ...notes,
  ].filter(Boolean);
  return { project: lost.length ? { ...p, edges, personas } : p, positions, ...(said.length && { dropped: said.join(' · ') }) };
}

/** 필요한 값만 구독한다. 노드를 끄는 동안 위치(positions)만 바뀌면 이것을 쓰는 패널은 다시 그리지 않는다 */
export const usePick = <K extends keyof State>(...keys: K[]) =>
  useStore(useShallow((s: State) => Object.fromEntries(keys.map((k) => [k, s[k]])) as Pick<State, K>));
