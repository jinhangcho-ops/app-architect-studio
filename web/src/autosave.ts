// 임시 저장: 고칠 때마다(잠깐 쉬었다가) 브라우저 저장소에 프로젝트와 노드 위치를 써 둔다.
// 창이 강제로 닫혀도 다시 열면 "이전 작업 복구"로 되살린다. 저장 버튼(Ctrl+S)의 JSON 파일과는 따로다.
import { parseProject } from '../../engine/data';
import type { Project } from '../../engine/schema';
import { catalog } from './data';
import type { XY } from './layout';
import { exportProject } from './store';

const KEY = 'app-architect-studio.autosave.v1';
const WAIT_MS = 800;

export type Autosave = { savedAt: string; project: Project; positions: Record<string, XY> };

let timer: ReturnType<typeof setTimeout> | undefined;

/** 마지막 편집 뒤 WAIT_MS만큼 조용하면 저장한다 (한 글자마다 쓰지 않게) */
export function scheduleAutosave(p: Project, positions: Record<string, XY>, storage: Storage | undefined = globalThis.localStorage) {
  clearTimeout(timer);
  timer = setTimeout(() => writeAutosave(p, positions, storage), WAIT_MS);
}

export function writeAutosave(p: Project, positions: Record<string, XY>, storage: Storage | undefined = globalThis.localStorage): boolean {
  try {
    storage?.setItem(KEY, JSON.stringify({ savedAt: new Date().toISOString(), project: exportProject(p, positions) }));
    return true;
  } catch {
    // 저장 공간이 없거나(사생활 보호 모드·용량 초과) 막혀 있으면 임시 저장만 건너뛴다. 작업은 계속된다
    return false;
  }
}

/** 남아 있는 임시 저장. 깨졌거나 지금 카탈로그로 검증되지 않으면 없는 것으로 본다 */
export function readAutosave(storage: Storage | undefined = globalThis.localStorage): Autosave | undefined {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) return undefined;
    const data = JSON.parse(raw) as { savedAt: string; project: { nodes?: { id: string; pos?: XY }[] } };
    const positions = Object.fromEntries((data.project.nodes ?? []).filter((n) => n.pos).map((n) => [n.id, n.pos!]));
    return { savedAt: data.savedAt, project: parseProject(data.project, catalog.items, '임시 저장'), positions };
  } catch {
    return undefined;
  }
}

export function clearAutosave(storage: Storage | undefined = globalThis.localStorage) {
  try { storage?.removeItem(KEY); } catch { /* 지울 수 없으면 다음 저장이 덮어쓴다 */ }
}
