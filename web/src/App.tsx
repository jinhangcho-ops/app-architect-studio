import { Select } from './Select';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseProject } from '../../engine/data';
import { LAYERS, LAYER_NAMES, type Layer } from '../../engine/model';
import { Canvas } from './Canvas';
import { catalog, examples } from './data';
import { mergeCodeAnalysis } from './codeImport';
import { addNode, findPlans, pasteNode, run } from './edit';
import { readAutosaves, saveToFolder, scheduleAutosave, scheduleFolderAutosave, snapshotLabel, startNewSnapshot, writeManualSave, type Snapshot } from './autosave';
import { baseName, desktop } from './desktop';
import { SaveHistory } from './SaveHistory';
import { searchProject, type Hit } from './search';
import type { OptimizeResult } from '../../engine/optimize';
import { Report } from './Report';
import { Tooltip } from './Tooltip';
import { KpiStrip, LimitChart } from './Overview';
import { NodeInside, TableSidePanel } from './NodeInside';
import { Palette } from './Palette';
import { EdgePanel, NodePanel } from './NodePanel';
import { OptimizePanel } from './OptimizePanel';
import { View3D } from './View3D';
import { ProjectPanel } from './ProjectPanel';
import { ResultsPanel } from './ResultsPanel';
import { exportProject, importProject, useStore } from './store';

// 사용자 PC의 날짜 (toISOString은 UTC라 한국에서는 오전 9시 전에 어제 날짜가 된다). sv-SE 형식이 YYYY-MM-DD
const today = new Date().toLocaleDateString('sv-SE');

type Hidden = { left: boolean; right: boolean; bottom: boolean };
const PANELS_KEY = 'aas.panels';
const readHidden = (): Hidden => {
  try { return { left: false, right: false, bottom: false, ...JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}') }; } catch { return { left: false, right: false, bottom: false }; }
};
/** 패널 단추 아이콘: 창 모양에서 그 쪽 칸을 칠한다 */
const PanelIcon = ({ side }: { side: 'left' | 'right' | 'bottom' }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    {side === 'left' && <rect x="1.5" y="2.5" width="4.5" height="11" fill="currentColor" stroke="none" opacity="0.7" />}
    {side === 'right' && <rect x="10" y="2.5" width="4.5" height="11" fill="currentColor" stroke="none" opacity="0.7" />}
    {side === 'bottom' && <rect x="1.5" y="9.5" width="13" height="4" fill="currentColor" stroke="none" opacity="0.7" />}
  </svg>
);

export function App() {
  const { project, positions, selected, load, edit, relayout, select, focus, setFocus, undo, redo, past, future, clipboard, set, move } = useStore();
  // 위치를 끌어도 다시 계산하지 않도록 프로젝트가 바뀔 때만 분석한다
  const result = useMemo(() => run(project, today), [project]);
  const [tab, setTab] = useState<'selected' | 'results' | 'optimize'>('results');
  const fileRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  // 접은 패널 (왼쪽 설정·아래 그래프·오른쪽 결과). 다음에 열 때도 그대로 (이 기기에만 저장)
  const [hide, setHide] = useState<Hidden>(readHidden);
  const toggle = (patch: Partial<Hidden>) => setHide((h) => { const next = { ...h, ...patch }; try { localStorage.setItem(PANELS_KEY, JSON.stringify(next)); } catch { /* 저장소를 못 쓰면 이번 창에서만 */ } return next; });
  const onlyDiagram = hide.left && hide.right && hide.bottom;
  const [report, setReport] = useState<{ plans?: OptimizeResult }>();
  const [find, setFind] = useState<{ q: string; at: number }>();
  // 앱을 열 때 남아 있던 임시 저장. 복구할지 정하기 전에는 임시 저장을 덮어쓰지 않는다
  const [recovery, setRecovery] = useState<Snapshot | undefined>(() => readAutosaves()[0]);
  const [history, setHistory] = useState(false);
  const [notice, setNotice] = useState<string>();
  // 데스크톱 앱에서 지금 열려 있는 프로젝트 파일 (Ctrl+S가 이 파일을 덮어쓰고, 같은 폴더에 시점 파일을 남긴다)
  const [filePath, setFilePath] = useState<string>();
  useEffect(() => { document.title = filePath ? `${baseName(filePath)} - App Architect Studio` : 'App Architect Studio'; }, [filePath]);
  const restore = (snap: Snapshot, sameFile = false) => {
    load(snap.project, snap.positions);
    if (!sameFile) setFilePath(undefined);
    startNewSnapshot();
    setRecovery(undefined);
    setHistory(false);
  };
  const say = (msg: string, ms = 2500) => { setNotice(msg); setTimeout(() => setNotice(undefined), ms); };
  /** 데스크톱 앱 저장: path가 없으면 "다른 이름으로 저장" 창. 저장한 파일로 이어서 작업한다 */
  const saveDesktop = (path: string | undefined, extra = '') => saveToFolder(path, project, positions)
    .then((saved) => { if (saved) { setFilePath(saved); say(`저장했습니다: ${baseName(saved)}${extra}`); } })
    .catch((err: Error) => say(`저장하지 못했습니다: ${err.message}`, 8000));
  // 직접 저장(Ctrl+S). 데스크톱 앱: 프로젝트 파일 + 같은 폴더 .saves/ (최대 20개). 브라우저: 브라우저 저장소 (최대 20개)
  const save = () => {
    if (desktop) return void saveDesktop(filePath, ' · 시점은 .saves 폴더에');
    const dropped = writeManualSave(project, positions);
    const ok = dropped !== false;
    say(!ok ? '브라우저 저장소를 쓸 수 없어 저장하지 못했습니다. "파일로 내보내기"(Ctrl+Shift+S)를 쓰세요'
      : `저장했습니다 · ${new Date().toLocaleTimeString('ko-KR')}${dropped ? ` · 저장소 공간이 모자라 오래된 직접 저장 시점 ${dropped}개를 지웠어요` : ''}`, ok && !dropped ? 2500 : 8000);
  };
  // 자동 저장이 실패하면(저장소가 꽉 참·폴더에 못 씀) 한 번 알린다. 복구 시점이 없는데 있다고 믿지 않게
  const warnedSave = useRef(false);
  useEffect(() => {
    if (recovery) return;
    const fail = (where: string) => () => {
      if (warnedSave.current) return;
      warnedSave.current = true;
      say(`${where} 자동 저장을 하지 못했어요. 강제로 닫히면 복구할 수 없으니 "저장"(Ctrl+S)이나 "파일로 내보내기"로 저장하세요`, 10000);
    };
    scheduleAutosave(project, positions, fail('브라우저 저장소에'));
    if (filePath) scheduleFolderAutosave(filePath, project, positions, fail('프로젝트 폴더에'));
  }, [project, positions, recovery, filePath]);

  const hits = find ? searchProject(project, catalog.byId, find.q) : [];
  const go = (h: Hit) => {
    setTab('selected');
    if (h.kind === 'node') { setFocus(undefined); select({ kind: 'node', id: h.node }); set({ flyTo: h.node }); }
    else { setFocus(h.node, 'tables'); select({ kind: 'table', node: h.node, table: h.table }); }
  };
  const paste = () => {
    if (!clipboard) return;
    let id = '';
    edit((p) => { const r = pasteNode(p, clipboard); id = r.id; return r.project; });
    const from = positions[clipboard.id];
    if (from) move(id, { x: from.x + 40, y: from.y + 40 });
    select({ kind: 'node', id });
    setTab('selected');
  };

  const add = (layer: Layer) => {
    let id = '';
    edit((p) => {
      const r = addNode(p, layer);
      id = r.id;
      return r.project;
    });
    select({ kind: 'node', id });
    setTab('selected');
  };

  /** JSON 파일로 내보내기 (Ctrl+Shift+S) */
  const exportFile = () => {
    // 데스크톱 앱: "다른 이름으로 저장" (새 파일을 고르고 그 파일로 이어서 작업)
    if (desktop) return void saveDesktop(undefined);
    const blob = new Blob([JSON.stringify(exportProject(project, positions), null, 2)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${project.name || 'project'}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // 윈도우 단축키. 글자 칸에서 치는 중이면 Ctrl+Z·Y는 브라우저의 글자 되돌리기에 맡긴다.
  // e.code(자판 위치)를 써서 한글 입력 상태에서도 같은 키로 동작한다. e.code가 비어 오는 환경(자동화 도구 등)은 e.key로 본다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && !!e.target.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        if (report) setReport(undefined);
        else if (find) setFind(undefined);
        else if (!typing) (focus ? setFocus(undefined) : select(null));
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : e.key.toLowerCase();
      if (k === 's') { e.preventDefault(); if (e.shiftKey) exportFile(); else save(); return; }
      if (k === 'f') { e.preventDefault(); setFind({ q: find?.q ?? '', at: 0 }); return; }
      if (k === 'o') { e.preventDefault(); openProject(); return; }
      if (typing) return;
      // 세부 구성에서는 노드 복사·붙여넣기를 하지 않는다 (와이어프레임 상자를 복사하려다 노드가 복제되지 않게)
      if (focus && (k === 'c' || k === 'v')) return;
      // 페이지 글자를 드래그해 골라 둔 경우에는 브라우저의 복사를 그대로 둔다
      if (k === 'c' && selected?.kind === 'node' && !window.getSelection()?.toString()) {
        set({ clipboard: project.nodes.find((n) => n.id === selected.id) });
        return;
      }
      if (k === 'v' && clipboard) { e.preventDefault(); paste(); return; }
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 데스크톱 앱은 열기 창에서 고른 파일 경로를 기억해 Ctrl+S가 그 파일에 저장한다
  const openProject = () => {
    if (!desktop) return fileRef.current?.click();
    desktop.openFile().then((r) => {
      if (!r) return;
      const { project, positions } = importProject(JSON.parse(r.text), baseName(r.path));
      load(project, positions);
      setFilePath(r.path);
    }).catch((err: Error) => say(err.message, 8000));
  };

  const open = async (file: File) => {
    try {
      const { project, positions } = importProject(JSON.parse(await file.text()), file.name);
      load(project, positions);
    } catch (e) {
      say((e as Error).message, 8000);
    }
  };

  // 노드를 끄는 동안 App은 위치 때문에 다시 그려지지만, 위치와 무관한 패널(KPI·왼쪽·그래프·오른쪽)은 그대로 둔다
  const analysis = result.analysis;
  const kpi = useMemo(() => <KpiStrip analysis={analysis} />, [analysis]);
  const left = useMemo(() => (focus ? <Palette nodeId={focus} analysis={analysis} /> : <ProjectPanel />), [focus, analysis]);
  const chart = useMemo(() => <LimitChart project={project} analysis={analysis} />, [project, analysis]);
  const right = useMemo(() => <>
    {tab === 'results' && <ResultsPanel analysis={analysis} />}
    {tab === 'optimize' && <OptimizePanel today={today} />}
    {tab === 'selected' && selected?.kind === 'node' && <NodePanel id={selected.id} analysis={analysis} />}
    {tab === 'selected' && selected?.kind === 'edge' && <EdgePanel from={selected.from} to={selected.to} />}
    {tab === 'selected' && selected?.kind === 'table' && <TableSidePanel nodeId={selected.node} table={selected.table} analysis={analysis} />}
    {tab === 'selected' && !selected && <p className="muted">캔버스에서 노드나 연결선을 고르세요.</p>}
  </>, [tab, selected, analysis]);

  return (
    <>
    <div className={`app ${hide.left ? 'hide-left' : ''} ${hide.right ? 'hide-right' : ''}`}>
      <header className="toolbar">
        <strong className="brand">App Architect Studio</strong>
        <Select aria-label="노드 추가" value="" onChange={(e) => e.target.value && add(e.target.value as Layer)}>
          <option value="">+ 노드 추가</option>
          {LAYERS.map((l) => <option key={l} value={l}>{LAYER_NAMES[l]}</option>)}
        </Select>
        <i className="sep" />
        <button onClick={undo} disabled={!past.length} title="되돌리기 (Ctrl+Z)" aria-label="되돌리기">↶</button>
        <button onClick={redo} disabled={!future.length} title="다시 하기 (Ctrl+Y, Ctrl+Shift+Z)" aria-label="다시 하기">↷</button>
        <i className="sep" />
        <button onClick={relayout} disabled={view === '3d'}>자동 배치</button>
        <button onClick={() => setView(view === '2d' ? '3d' : '2d')}>{view === '2d' ? '3D 보기' : '2D 보기'}</button>
        <i className="sep" />
        <span className="panel-toggles" role="group" aria-label="패널 보이기">
          <button aria-pressed={!hide.left} title="왼쪽 설정 패널" aria-label="왼쪽 설정 패널" onClick={() => toggle({ left: !hide.left })}><PanelIcon side="left" /></button>
          <button aria-pressed={!hide.bottom} title="아래 그래프" aria-label="아래 그래프" onClick={() => toggle({ bottom: !hide.bottom })}><PanelIcon side="bottom" /></button>
          <button aria-pressed={!hide.right} title="오른쪽 결과 패널" aria-label="오른쪽 결과 패널" onClick={() => toggle({ right: !hide.right })}><PanelIcon side="right" /></button>
        </span>
        <button className={onlyDiagram ? 'on' : ''} onClick={() => toggle(onlyDiagram ? { left: false, right: false, bottom: false } : { left: true, right: true, bottom: true })}>{onlyDiagram ? '패널 다시 보기' : '다이어그램만'}</button>
        <span className="spacer" />
        <Select aria-label="예시 불러오기" value="" onChange={(e) => {
          const ex = examples.find((x) => x.name === e.target.value);
          if (ex) { load(parseProject(ex.data, catalog.items, ex.name)); setFilePath(undefined); }
        }}>
          <option value="">예시 불러오기</option>
          {examples.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
        </Select>
        <button onClick={openProject} title="Ctrl+O">열기</button>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
        <button onClick={() => codeRef.current?.click()} title="tools/analyze_py.py가 만든 JSON">코드 분석 불러오기</button>
        <input ref={codeRef} type="file" accept="application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const data = JSON.parse(await f.text());
            edit((p) => mergeCodeAnalysis(p, data));
          } catch (err) {
            say((err as Error).message, 8000);
          }
          e.target.value = '';
        }} />
        <i className="sep" />
        <button onClick={save} title="저장 기록에 시점을 남깁니다 (Ctrl+S)">저장</button>
        <button onClick={exportFile} title="JSON 파일로 내려받기 (Ctrl+Shift+S)">파일로 내보내기</button>
        <button onClick={() => setHistory(!history)} title="직접 저장·자동 저장 시점 보기와 복구">저장 기록</button>
        <i className="sep" />
        {/* 최선 조합(7번째 절)은 설계서를 열 때 한 번 찾는다 */}
        <button className="primary" onClick={() => setReport({ plans: findPlans(project, today).result })}>설계서 PDF</button>
      </header>
      {kpi}
      {!hide.left && <aside className="left">{left}</aside>}
      <main className="center">
        <div className="stage">
          {focus
            ? <NodeInside key={focus} nodeId={focus} analysis={result.analysis} onSelect={() => setTab('selected')} />
            : view === '2d'
            ? <Canvas analysis={result.analysis} onSelect={() => setTab('selected')} layout={`${hide.left}${hide.right}${hide.bottom}`} />
            : <View3D analysis={result.analysis} onSelect={() => setTab('selected')} />}
        </div>
        {!focus && !hide.bottom && chart}
        {result.error && <pre className="error-banner">{result.error}</pre>}
        {recovery && (
          <div className="recovery">
            <span>지난번 작업이 남아 있어요</span>
            <b title={snapshotLabel(recovery)}>{snapshotLabel(recovery)}</b>
            <button className="primary" onClick={() => restore(recovery)}>복구</button>
            <button onClick={() => setHistory(true)}>다른 시점…</button>
            <button onClick={() => { startNewSnapshot(); setRecovery(undefined); }}>닫기</button>
          </div>
        )}
        {history && <SaveHistory filePath={desktop ? filePath : undefined} onRestore={restore} onClose={() => setHistory(false)} />}
        {notice && <div className="notice" role="status">{notice}</div>}
        {find && (
          <div className="find" role="search">
            <input autoFocus value={find.q} placeholder="노드·항목·테이블·컬럼 찾기 (Enter 다음, Esc 닫기)" aria-label="찾기"
              onChange={(e) => setFind({ q: e.target.value, at: 0 })}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { e.stopPropagation(); setFind(undefined); }
                if (e.key === 'Enter' && hits.length) { go(hits[find.at % hits.length]); setFind({ ...find, at: find.at + 1 }); }
              }} />
            {find.q && <div className="find-results">
              {!hits.length && <div className="muted">찾은 것이 없습니다</div>}
              {hits.map((h, i) => (
                <button key={`${h.kind}:${h.label}`} className={i === (find.at - 1 + hits.length) % hits.length ? 'on' : ''} onClick={() => go(h)}>
                  <b>{h.label}</b> <span className="muted">{h.detail}</span>
                </button>
              ))}
            </div>}
          </div>
        )}
      </main>
      {!hide.right && (
      <aside className="right">
        <nav className="tabs">
          <button className={tab === 'selected' ? 'on' : ''} onClick={() => setTab('selected')}>선택한 것</button>
          <button className={tab === 'results' ? 'on' : ''} onClick={() => setTab('results')}>전체 결과</button>
          <button className={tab === 'optimize' ? 'on' : ''} onClick={() => setTab('optimize')}>최선 조합</button>
        </nav>
        {right}
      </aside>
      )}
    </div>
    <Tooltip />
    {/* 인쇄할 때 .app은 숨기고 설계서만 남기므로 .app 밖에 둔다 */}
    {report && <Report project={project} analysis={result.analysis} positions={positions} plans={report.plans} today={today} onClose={() => setReport(undefined)} />}
    </>
  );
}
