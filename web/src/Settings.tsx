// 설정 화면: 왼쪽 목차(바뀐 항목 수) · 가운데 칸들 · 아래 줄(바뀐 수, 되돌리기, 설계도로).
// "바뀐 항목"은 마지막으로 불러온 프로젝트(예시·파일·복구)와 비교한다.
import { useRef, useState } from 'react';
import { ProjectPanel } from './ProjectPanel';
import { changedCounts, resetSettings, SETTINGS } from './settingsDiff';
import { usePick } from './store';

export function Settings({ onBack }: { onBack: () => void }) {
  const { project, baseline, edit } = usePick('project', 'baseline', 'edit');
  const counts = changedCounts(project, baseline);
  const total = Object.values(counts).reduce((s, x) => s + x, 0);
  const body = useRef<HTMLDivElement>(null);
  const [cur, setCur] = useState(SETTINGS[0].id);
  // 지금 보는 칸: 위 끝을 지난 마지막 칸 (맨 아래까지 내렸으면 마지막 칸)
  const onScroll = () => {
    const b = body.current!;
    const secs = SETTINGS.map((s) => document.getElementById(s.id)).filter((x): x is HTMLElement => !!x);
    let at = secs[0]?.id ?? SETTINGS[0].id;
    for (const s of secs) if (s.offsetTop - b.scrollTop - 40 <= 0) at = s.id;
    if (b.scrollTop + b.clientHeight >= b.scrollHeight - 4) at = secs.at(-1)?.id ?? at;
    setCur(at);
  };
  return (
    <div className="settings">
      <nav className="snav" aria-label="설정 항목">
        <h2>설정</h2>
        {SETTINGS.map((s) => (
          <a key={s.id} href={`#${s.id}`} aria-current={cur === s.id}
            onClick={(e) => { e.preventDefault(); document.getElementById(s.id)?.scrollIntoView({ block: 'start' }); }}>
            {s.title}{counts[s.id] > 0 && <span className="badge">{counts[s.id]}</span>}
          </a>
        ))}
        <p className="note">불러온 뒤 바꾼 항목은 노란 숫자로 알려 줘요.</p>
      </nav>
      <div className="sbody" ref={body} onScroll={onScroll}><ProjectPanel /></div>
      <div className="sfoot">
        <span className="info">{total ? <>불러온 값에서 바뀐 항목 <b>{total}개</b></> : '불러온 값에서 바뀐 항목이 없어요.'}</span>
        <span className="spacer" />
        <button className="btn" disabled={!total} onClick={() => edit((p) => resetSettings(p, baseline))} title="설정 화면의 값만 되돌려요 (노드·연결선은 그대로). Ctrl+Z로 다시 돌릴 수 있어요">불러온 값으로 되돌리기</button>
        <button className="btn primary" onClick={onBack}>설계도로 돌아가기</button>
      </div>
    </div>
  );
}
