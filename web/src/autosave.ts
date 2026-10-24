// 저장 기록: 브라우저 저장소에 프로젝트와 노드 위치를 시점으로 남긴다. 강제로 닫혀도 다시 열면 복구할 수 있다.
//  - 자동 저장: 고칠 때마다(잠깐 쉬었다가) 최신 시점을 덮어쓰고, 간격(기본 10분, 사용자 지정)이 지나면 새 시점을 만든다. 10개
//  - 직접 저장: Ctrl+S·저장 버튼을 누를 때마다 새 시점. 20개
// JSON 파일 내보내기(Ctrl+Shift+S)와는 따로다.
import type { Project } from '../../engine/schema';
import type { XY } from './layout';
import { desktop, stamp, stampTime } from './desktop';
import { exportProject, importProject } from './store';

const AUTO_KEY = 'app-architect-studio.autosave.v1';
const MANUAL_KEY = 'app-architect-studio.saves.v1';
const SETTINGS_KEY = 'app-architect-studio.save-settings.v1';
const WAIT_MS = 800;
export const MAX_AUTO = 10;
export const MAX_MANUAL = 20;
export const DEFAULT_MINUTES = 10;

export type Snapshot = { createdAt: string; savedAt: string; project: Project; positions: Record<string, XY> };
type Raw = { createdAt?: string; savedAt: string; project: { name?: string; nodes?: { id: string; pos?: XY }[] } };
type Store = Storage | undefined;
const local = (): Store => globalThis.localStorage;

/** 저장된 시점들, 최신이 앞 (처음 만든 형식인 한 칸짜리도 읽는다) */
function rawList(storage: Store, key: string): Raw[] {
  const raw = storage?.getItem(key);
  if (!raw) return [];
  const data = JSON.parse(raw) as Raw | Raw[];
  return Array.isArray(data) ? data : [data];
}

/** 저장 기록 한 칸 → 시점. 깨졌거나 지금 카탈로그로 검증되지 않으면 undefined (그 시점만 뺀다) */
function toSnapshot(r: Raw): Snapshot | undefined {
  try {
    return { createdAt: r.createdAt ?? r.savedAt, savedAt: r.savedAt, ...importProject(r.project, '저장 기록') };
  } catch {
    return undefined;
  }
}

function readList(storage: Store, key: string): Snapshot[] {
  let list: Raw[];
  try { list = rawList(storage, key); } catch { return []; }
  return list.map(toSnapshot).filter((s): s is Snapshot => !!s);
}

/** 프로젝트 폴더의 시점 파일(.saves/.autosave) → 시점. 파일 내용은 내보내기 JSON, 이름은 저장 시각 */
export function snapshotFromFile(name: string, text: string): Snapshot | undefined {
  try {
    const savedAt = stampTime(name).toISOString();
    return toSnapshot({ createdAt: savedAt, savedAt, project: JSON.parse(text) });
  } catch {
    return undefined;
  }
}

/** 맨 앞에 넣거나(replace면 맨 앞을 바꿔) max개까지 남긴다.
 *  저장소가 꽉 차면(브라우저마다 5MB쯤) 가장 오래된 시점부터 하나씩 버리고 다시 쓴다.
 *  돌려주는 값: 공간이 모자라 버린 예전 시점 수. 이번 것 하나도 못 쓰면 false (작업은 계속된다) */
function put(storage: Store, key: string, entry: Raw, replace: boolean, max: number): number | false {
  if (!storage) return false;
  let list: Raw[] = [];
  try { list = rawList(storage, key); } catch { /* 깨진 기록은 버리고 새로 시작한다 */ }
  const all = [entry, ...(replace ? list.slice(1) : list)].slice(0, max);
  for (let n = all.length; n >= 1; n--) {
    try {
      storage.setItem(key, JSON.stringify(all.slice(0, n)));
      return all.length - n;
    } catch { /* 꽉 참: 하나 덜 남기고 다시 */ }
  }
  return false;
}

// ── 설정: 자동 저장 간격 ──
export function autosaveMinutes(storage: Store = local()): number {
  try {
    const m = Number(JSON.parse(storage?.getItem(SETTINGS_KEY) ?? '{}').minutes);
    return m >= 1 ? m : DEFAULT_MINUTES;
  } catch {
    return DEFAULT_MINUTES;
  }
}
export function setAutosaveMinutes(minutes: number, storage: Store = local()) {
  try { storage?.setItem(SETTINGS_KEY, JSON.stringify({ minutes: Math.max(1, Math.round(minutes)) })); } catch { /* 저장소가 막혀 있으면 기본값을 쓴다 */ }
}

// ── 자동 저장 ──
let timer: ReturnType<typeof setTimeout> | undefined;
let forceNew = false;

/** 다음 자동 저장은 최신 시점을 덮어쓰지 않고 새 시점으로 (예전 시점을 복구했거나 복구 안내를 닫았을 때 최신 시점을 지키려고) */
export function startNewSnapshot() { forceNew = true; }

/** 마지막 편집 뒤 WAIT_MS만큼 조용하면 저장한다 (한 글자마다 쓰지 않게). 못 쓰면 onFail (복구 시점이 없다고 알리게) */
export function scheduleAutosave(p: Project, positions: Record<string, XY>, onFail?: () => void, storage: Store = local()) {
  clearTimeout(timer);
  timer = setTimeout(() => { if (!writeAutosave(p, positions, storage)) onFail?.(); }, WAIT_MS);
}

export function writeAutosave(p: Project, positions: Record<string, XY>, storage: Store = local(), now = new Date()): boolean {
  let latest: Raw | undefined;
  try { latest = rawList(storage, AUTO_KEY)[0]; } catch { /* 깨진 기록 */ }
  const every = autosaveMinutes(storage) * 60_000;
  const same = !forceNew && !!latest && latest.project.name === p.name && now.getTime() - Date.parse(latest.createdAt ?? latest.savedAt) < every;
  const ok = put(storage, AUTO_KEY, { createdAt: same ? latest!.createdAt ?? latest!.savedAt : now.toISOString(), savedAt: now.toISOString(), project: exportProject(p, positions) }, same, MAX_AUTO) !== false;
  if (ok) forceNew = false;
  return ok;
}

export const readAutosaves = (storage: Store = local()) => readList(storage, AUTO_KEY);

// ── 직접 저장 (Ctrl+S) ──
/** 공간이 모자라 버린 예전 시점 수(보통 0), 못 쓰면 false. 버렸으면 화면이 알린다 (일부러 남긴 시점이라) */
export function writeManualSave(p: Project, positions: Record<string, XY>, storage: Store = local(), now = new Date()): number | false {
  return put(storage, MANUAL_KEY, { createdAt: now.toISOString(), savedAt: now.toISOString(), project: exportProject(p, positions) }, false, MAX_MANUAL);
}
export const readManualSaves = (storage: Store = local()) => readList(storage, MANUAL_KEY);

/** 목록에 보일 한 줄: 저장 시각 · 프로젝트 이름 · 노드 수 */
export const snapshotLabel = (s: Snapshot) =>
  `${new Date(s.savedAt).toLocaleString('ko-KR')} · ${s.project.name.length > 24 ? `${s.project.name.slice(0, 23)}…` : s.project.name} · 노드 ${s.project.nodes.length}개`;

// ── 데스크톱 앱: 프로젝트 파일이 있으면 같은 폴더의 .autosave/에도 자동 저장 (브라우저 저장소 기록과 같은 규칙) ──
let folderTimer: ReturnType<typeof setTimeout> | undefined;
let folderLatest: { file: string; name: string; created: number } | undefined;

export function scheduleFolderAutosave(file: string, p: Project, positions: Record<string, XY>, onFail?: () => void) {
  const api = desktop;
  if (!api) return;
  clearTimeout(folderTimer);
  folderTimer = setTimeout(() => {
    const now = new Date();
    const same = folderLatest?.file === file && now.getTime() - folderLatest.created < autosaveMinutes() * 60_000;
    const name = same ? folderLatest!.name : stamp(now);
    if (!same) folderLatest = { file, name, created: now.getTime() };
    // 폴더에 못 쓰면(권한·디스크) 브라우저 저장소 기록만 남으므로 알린다
    api.writeSnapshot(file, 'auto', name, JSON.stringify(exportProject(p, positions), null, 2), MAX_AUTO).catch(() => onFail?.());
  }, WAIT_MS);
}

/** 직접 저장: 프로젝트 파일을 덮어쓰고(처음이면 저장 창) .saves/에 시점 파일을 남긴다. 저장한 경로, 취소면 null */
export async function saveToFolder(file: string | undefined, p: Project, positions: Record<string, XY>): Promise<string | null> {
  const api = desktop!;
  const text = JSON.stringify(exportProject(p, positions), null, 2);
  const saved = await api.saveFile(file, text, `${p.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.aas.json`);
  if (saved) await api.writeSnapshot(saved, 'manual', stamp(), text, MAX_MANUAL);
  return saved;
}

export async function readFolderSnapshots(file: string, kind: 'manual' | 'auto'): Promise<Snapshot[]> {
  const list = await desktop!.listSnapshots(file, kind);
  return list.map((x) => snapshotFromFile(x.name, x.text)).filter((s): s is Snapshot => !!s);
}
