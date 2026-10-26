// 새 버전 알림: 위쪽에 "새 버전 vX가 있어요 [업데이트]", 누르면 바뀐 것(릴리스 노트)과 [지금 업데이트]·[나중에] 창.
// 릴리스 노트는 글자로만 넣는다 (React가 textContent로 넣는다. HTML로 해석하지 않음)
import { useState } from 'react';
import { desktop, type UpdateInfo } from './desktop';

/** 버전 뒤 조사: 끝 숫자를 읽는 소리에 받침이 없으면(2 이, 4 사, 5 오, 9 구) "가", 있으면(0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔) "이" */
export const subjectParticle = (version: string) => {
  const last = version.trim().slice(-1);
  return /\d/.test(last) ? ('2459'.includes(last) ? '가' : '이') : '이(가)';
};

/** 노트의 ## · ### 머리를 "■ "로 바꿔 보이게 (나머지 줄은 그대로) */
export const notesText = (notes: string) => notes.replace(/^#{2,3} +/gm, '■ ');

/** prepare: 업데이트 전에 지금 작업을 남긴다. 못 남겼으면 이유(그러면 업데이트하지 않음) */
export function UpdatePrompt({ info, prepare }: { info: UpdateInfo; prepare: () => string | undefined }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ busy?: boolean; error?: string }>({});
  const run = async () => {
    const why = prepare();
    if (why) return setState({ error: why });
    setState({ busy: true });
    const r = await desktop!.installUpdate().catch((e: Error) => ({ ok: false, reason: e.message }));
    // 성공하면 설치가 시작되고 앱이 닫혔다가 설치 뒤 다시 열린다
    setState(r.ok ? { busy: true } : { error: r.reason });
  };
  return <>
    <div className="update" role="status">
      <span>새 버전 <b>v{info.version}</b>{subjectParticle(info.version)} 있어요</span>
      <button className="primary" onClick={() => setOpen(true)}>업데이트</button>
    </div>
    {open && (
      <div className="overlay">
        <div className="history update-dialog" role="dialog" aria-modal="true" aria-label="업데이트">
          <div className="history-head"><b>v{info.current} → v{info.version}에서 바뀐 것</b></div>
          {info.notes
            ? <div className="release-notes">{notesText(info.notes)}</div>
            : <p className="muted">릴리스 노트를 받지 못했어요. GitHub Releases에서 볼 수 있어요.</p>}
          {state.error && <p className="warn">{state.error}</p>}
          {state.busy && !state.error && <p className="muted">설치 파일을 받아 확인하고 있어요. 설치가 시작되면 앱이 닫혔다가 다시 열려요.</p>}
          <div className="inline">
            <button className="primary" disabled={state.busy} onClick={() => void run()}>{state.busy ? '업데이트 중…' : '지금 업데이트'}</button>
            <button disabled={state.busy} onClick={() => { setOpen(false); setState({}); }}>나중에</button>
          </div>
        </div>
      </div>
    )}
  </>;
}
