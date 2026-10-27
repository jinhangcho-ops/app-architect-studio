// 저장 기록 창: 직접 저장(최대 20개)과 자동 저장(최대 10개) 시점을 보고 복구한다. 자동 저장 간격도 여기서 정한다.
// 데스크톱 앱에서 프로젝트 파일을 열었으면 그 폴더의 .saves/.autosave 기록을 먼저 보여 준다.
import { useEffect, useState } from 'react';
import { autosaveMinutes, MAX_AUTO, MAX_MANUAL, readAutosaves, readFolderSnapshots, readManualSaves, setAutosaveMinutes, snapshotLabel, type Snapshot } from './autosave';
import { baseName } from './desktop';
import { NumInput } from './fields';

export function SaveHistory({ filePath, onRestore, onClose }: { filePath?: string; onRestore: (s: Snapshot, sameFile?: boolean) => void; onClose: () => void }) {
  // 창을 열 때 한 번 읽는다 (저장은 다른 곳에서 일어나므로 열 때마다 새로 읽힌다)
  const [manual] = useState(() => readManualSaves());
  const [auto] = useState(() => readAutosaves());
  const [folder, setFolder] = useState<{ manual: Snapshot[]; auto: Snapshot[]; error?: string }>();
  const [minutes, setMinutes] = useState(() => autosaveMinutes());
  useEffect(() => {
    if (!filePath) return;
    Promise.all([readFolderSnapshots(filePath, 'manual'), readFolderSnapshots(filePath, 'auto')])
      .then(([m, a]) => setFolder({ manual: m, auto: a }))
      .catch((e: Error) => setFolder({ manual: [], auto: [], error: e.message }));
  }, [filePath]);

  const List = ({ title, items, max, sameFile }: { title: string; items: Snapshot[]; max: number; sameFile?: boolean }) => (
    <section>
      <h4>{title} <span className="muted">({items.length}/{max})</span></h4>
      {!items.length && <p className="muted">아직 없습니다.</p>}
      {items.map((s) => (
        <div key={s.savedAt} className="history-row">
          <span>{snapshotLabel(s)}</span>
          <button onClick={() => onRestore(s, sameFile && !s.legacy)}>복구</button>
        </div>
      ))}
    </section>
  );
  return (
    <div className="history" role="dialog" aria-label="저장 기록">
      <div className="history-head">
        <b>저장 기록</b>
        <span className="spacer" />
        <button onClick={onClose} aria-label="닫기">×</button>
      </div>
      <label className="row">
        <span>자동 저장 간격(분)</span>
        <NumInput min={1} step={1} value={minutes}
          onChange={(e) => { const m = Number(e.target.value); if (m >= 1) { setMinutes(m); setAutosaveMinutes(m); } }} />
      </label>
      <p className="muted">자동 저장은 고칠 때마다 최신 시점을 덮어쓰고, 간격이 지나면 새 시점을 만듭니다. 복구해도 지금 상태는 Ctrl+Z로 되돌릴 수 있습니다.</p>
      {filePath && <>
        <p><b>{baseName(filePath)}</b> 폴더의 기록</p>
        {folder?.error && <p className="warn">폴더 기록을 읽지 못했습니다: {folder.error}</p>}
        {!folder && <p className="muted">읽는 중…</p>}
        {folder && <>
          <List title="직접 저장 (.saves)" items={folder.manual} max={MAX_MANUAL} sameFile />
          <List title="자동 저장 (.autosave)" items={folder.auto} max={MAX_AUTO} sameFile />
        </>}
        <p className="muted">아래는 이 PC의 앱 안 기록입니다 (파일로 저장하기 전의 작업도 남습니다).</p>
      </>}
      <List title="직접 저장 (Ctrl+S)" items={manual} max={MAX_MANUAL} />
      <List title="자동 저장" items={auto} max={MAX_AUTO} />
    </div>
  );
}
