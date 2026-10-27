import { Component, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { parseProject } from '../../engine/data';
import { interfaceFiles } from '../../engine/interfaces';
import { schemaFiles } from '../../engine/ddl';
import { LAYERS, LAYER_NAMES, type Layer } from '../../engine/model';
import { Canvas, Legend } from './Canvas';
import { catalog, examples } from './data';
import { mergeCodeAnalysis } from './codeImport';
import { addNode, findPlans, pasteNode, run } from './edit';
import { flushAutosave, readAutosaves, saveToFolder, scheduleAutosave, scheduleFolderAutosave, snapshotLabel, startNewSnapshot, writeAutosave, writeManualSave, type Snapshot } from './autosave';
import { baseName, checkForUpdate, desktop, type UpdateInfo } from './desktop';
import { UpdatePrompt } from './UpdatePrompt';
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
import { Settings } from './Settings';
import { Menu } from './Menu';
import { changedCounts } from './settingsDiff';
import { ResultsPanel } from './ResultsPanel';
import { exportProject, importProject, useStore } from './store';

// 사용자 PC의 날짜 (toISOString은 UTC라 한국에서는 오전 9시 전에 어제 날짜가 된다). sv-SE 형식이 YYYY-MM-DD
const today = new Date().toLocaleDateString('sv-SE');

type Hidden = { right: boolean; bottom: boolean };
const PANELS_KEY = 'aas.panels';
const TIP_KEY = 'aas.tip-closed';
const readHidden = (): Hidden => {
  try { return { right: false, bottom: false, ...JSON.parse(localStorage.getItem(PANELS_KEY) ?? '{}') }; } catch { return { right: false, bottom: false }; }
};
/** 패널 단추 아이콘: 창 모양에서 그 쪽 칸을 칠한다 */
const PanelIcon = ({ side }: { side: 'right' | 'bottom' }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.3">
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
    {side === 'right' && <rect x="10" y="2.5" width="4.5" height="11" fill="currentColor" stroke="none" opacity="0.7" />}
    {side === 'bottom' && <rect x="1.5" y="9.5" width="13" height="4" fill="currentColor" stroke="none" opacity="0.7" />}
  </svg>
);

/** 한 패널이 그리다 터져도(손으로 고친 파일 등) 앱 전체가 흰 화면이 되지 않게 그 자리만 바꿔 보인다. 저장·자동 저장은 App에 있어 계속된다 */
class Guard extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="muted" role="alert" style={{ padding: 16 }}>
        <p>이 화면을 그리지 못했습니다: {this.state.error.message}</p>
        <button className="btn" onClick={() => this.setState({ error: undefined })}>다시 시도</button>
      </div>
    );
  }
}

export function App() {
  const { project, baseline, positions, selected, load, edit, relayout, select, focus, focusTab, setFocus, undo, redo, past, future, clipboard, set, move, rejected } = useStore();
  // 위치를 끌어도 다시 계산하지 않도록 프로젝트가 바뀔 때만 분석한다.
  // 계산은 입력 뒤로 미룬다(사용자가 많으면 한 번에 0.5초 넘게 걸려 칸에 글자를 칠 때마다 멈추므로). 그동안은 바로 전 결과를 보인다
  const computed = useDeferredValue(project);
  const result = useMemo(() => run(computed, today), [computed]);
  const [tab, setTab] = useState<'selected' | 'results' | 'optimize'>('results');
  const fileRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  // 위쪽 화면 전환: 설계도 / 설정
  const [screen, setScreen] = useState<'design' | 'settings'>('design');
  const changed = Object.values(changedCounts(project, baseline)).reduce((s, x) => s + x, 0);
  // 처음 보는 사람을 위한 안내 카드 (닫으면 이 기기에서는 다시 안 나온다)
  const [tip, setTip] = useState(() => { try { return localStorage.getItem(TIP_KEY) !== '1'; } catch { return true; } });
  const closeTip = () => { setTip(false); try { localStorage.setItem(TIP_KEY, '1'); } catch { /* 저장소를 못 쓰면 이번 창에서만 */ } };
  // 접은 패널 (왼쪽 설정·아래 그래프·오른쪽 결과). 다음에 열 때도 그대로 (이 기기에만 저장)
  const [hide, setHide] = useState<Hidden>(readHidden);
  const toggle = (patch: Partial<Hidden>) => setHide((h) => { const next = { ...h, ...patch }; try { localStorage.setItem(PANELS_KEY, JSON.stringify(next)); } catch { /* 저장소를 못 쓰면 이번 창에서만 */ } return next; });
  const onlyDiagram = hide.right && hide.bottom;
  const [report, setReport] = useState<{ plans?: OptimizeResult }>();
  const [find, setFind] = useState<{ q: string; at: number }>();
  // 앱을 열 때 남아 있던 임시 저장. 이번 작업은 새 시점으로 남겨(안내를 닫지 않아도 자동 저장은 계속) 그 시점을 덮어쓰지 않는다
  const [recovery, setRecovery] = useState<Snapshot | undefined>(() => readAutosaves()[0]);
  useEffect(() => { if (recovery) startNewSnapshot(); }, []);
  // 복구 안내 중 손대지 않은 시작 프로젝트는 저장하지 않는다 (켤 때마다 빈 시점이 쌓여 복구할 시점을 밀어냄)
  const startProject = useRef(project);
  const [history, setHistory] = useState(false);
  const [notice, setNotice] = useState<string>();
  // 새 버전 알림 (데스크톱 앱에서 켤 때 한 번 확인)
  // 새 버전 알림 (설치 앱에서, 설정에서 켜 두었을 때 열 때 한 번)
  const [update, setUpdate] = useState<UpdateInfo>();
  useEffect(() => { void checkForUpdate().then((u) => u && setUpdate(u)); }, []);
  // 데스크톱 앱에서 지금 열려 있는 프로젝트 파일 (Ctrl+S가 이 파일을 덮어쓰고, 같은 폴더에 시점 파일을 남긴다)
  const [filePath, setFilePath] = useState<string>();
  useEffect(() => { document.title = filePath ? `${baseName(filePath)} - App Architect Studio` : 'App Architect Studio'; }, [filePath]);
  const restore = (snap: Snapshot, sameFile = false) => {
    // 같은 파일의 이전 시점이면 경로가 그대로 맞으므로 되돌리기 경계로 치지 않는다
    load(snap.project, snap.positions, !sameFile);
    if (!sameFile) setFilePath(undefined);
    startNewSnapshot();
    setRecovery(undefined);
    setHistory(false);
  };
  // 앞 알림의 타이머가 뒤에 뜬 긴 알림(자동 저장 실패 경고 등)을 일찍 지우지 않게 하나만 둔다
  const noticeTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const say = (msg: string, ms = 2500) => { clearTimeout(noticeTimer.current); setNotice(msg); noticeTimer.current = setTimeout(() => setNotice(undefined), ms); };
  const openError = (e: Error) => (e instanceof SyntaxError ? `JSON 파일을 읽지 못했습니다: ${e.message}` : e.message);
  // 적용하지 않은 편집 알림: 6초 보이되, 그 전에 편집이 성공하면 store가 지워 바로 사라진다
  useEffect(() => {
    if (!rejected) return;
    const t = setTimeout(() => set({ rejected: undefined }), 6000);
    return () => clearTimeout(t);
  }, [rejected]);
  // 다른 파일을 열기 전으로 되돌리면 Ctrl+S·폴더 자동 저장이 엉뚱한 파일에 쓰지 않게 열린 파일을 잊는다
  const leaveFile = (crossed: boolean) => {
    if (!crossed || !filePath) return;
    setFilePath(undefined);
    say('다른 파일을 열기 전으로 돌아갔어요. 다음 저장은 파일 이름을 다시 묻습니다', 5000);
  };
  const back = () => leaveFile(undo());
  const forward = () => leaveFile(redo());
  /** 파일·예시를 불러온다. 이름이 같은 다른 프로젝트가 자동 저장 최신 시점을 덮지 않게 새 시점으로 */
  const loadNew: typeof load = (p, pos) => { load(p, pos); startNewSnapshot(); };
  /** 데스크톱 앱 저장: path가 없으면 "다른 이름으로 저장" 창. 저장한 파일로 이어서 작업한다 */
  const saveDesktop = (path: string | undefined, extra = '') => saveToFolder(path, project, positions)
    .then((r) => {
      if (!r) return;
      setFilePath(r.path);
      if (r.snapshot) say(`저장했습니다: ${baseName(r.path)}${extra}`);
      else say(`저장했습니다: ${baseName(r.path)} · 저장 기록 시점은 남기지 못했습니다 (.saves 폴더에 쓸 수 없음)`, 8000);
    })
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
    const fail = (where: string) => () => {
      if (warnedSave.current) return;
      warnedSave.current = true;
      say(`${where} 자동 저장을 하지 못했어요. 강제로 닫히면 복구할 수 없으니 "저장"(Ctrl+S)이나 "파일로 내보내기"로 저장하세요`, 10000);
    };
    if (recovery && project === startProject.current) return;
    scheduleAutosave(project, positions, fail('브라우저 저장소에'));
    if (filePath) scheduleFolderAutosave(filePath, project, positions, fail('프로젝트 폴더에'));
  }, [project, positions, filePath, recovery]);
  // 창을 닫을 때 기다리던 자동 저장을 바로 한다 (마지막 편집 뒤 0.8초 안에 닫아도 복구 시점에 남게)
  useEffect(() => { addEventListener('pagehide', flushAutosave); return () => removeEventListener('pagehide', flushAutosave); }, []);

  const hits = find ? searchProject(project, catalog.byId, find.q) : [];
  const go = (h: Hit) => {
    setTab('selected');
    if (h.kind === 'node') { setFocus(undefined); select({ kind: 'node', id: h.node }); set({ flyTo: h.node }); }
    else { setFocus(h.node, 'tables'); select({ kind: 'table', node: h.node, table: h.table }); }
  };
  const paste = () => {
    if (!clipboard) return;
    // 세부 구성 중이면 캔버스로 나와 붙인 노드가 보이게 (가운데·오른쪽이 다른 노드를 보이지 않게)
    if (focus) setFocus(undefined);
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

  /** 명세 파일들(인터페이스, 스키마·데이터 사전). 데스크톱 앱은 폴더를 골라 한 번에, 브라우저는 파일마다 내려받기 */
  const exportTexts = async (files: { name: string; text: string }[], empty: string) => {
    if (!files.length) return say(empty, 4000);
    if (desktop) {
      return void desktop.saveTexts(files)
        .then((out) => { if (out) say(`명세 파일 ${out.length}개를 저장했습니다`); })
        .catch((err: Error) => say(`저장하지 못했습니다: ${err.message}`, 8000));
    }
    for (const f of files) {
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([f.text], { type: 'text/plain' })), download: f.name });
      a.click();
      URL.revokeObjectURL(a.href);
    }
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
      // 와이어프레임 탭에서는 노드 복사·붙여넣기를 하지 않는다 (상자를 복사하려다 노드가 복제되지 않게)
      if (focus && focusTab === 'wireframe' && (k === 'c' || k === 'v')) return;
      // 카드를 누르면 세부 구성으로 들어가 선택이 비므로, 세부 구성 중이면 그 노드를 복사한다
      const copyId = selected?.kind === 'node' ? selected.id : focus;
      // 페이지 글자를 드래그해 골라 둔 경우에는 브라우저의 복사를 그대로 둔다
      if (k === 'c' && copyId && !window.getSelection()?.toString()) {
        set({ clipboard: project.nodes.find((n) => n.id === copyId) });
        return;
      }
      if (k === 'v' && clipboard) { e.preventDefault(); paste(); return; }
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); back(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); forward(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // 데스크톱 앱은 열기 창에서 고른 파일 경로를 기억해 Ctrl+S가 그 파일에 저장한다
  const openProject = () => {
    if (!desktop) return fileRef.current?.click();
    desktop.openFile().then((r) => {
      if (!r) return;
      const { project, positions, dropped } = importProject(JSON.parse(r.text), baseName(r.path));
      loadNew(project, positions);
      setFilePath(r.path);
      if (dropped) say(dropped, 8000);
    }).catch((err: Error) => say(openError(err), 8000));
  };

  const open = async (file: File) => {
    try {
      const { project, positions, dropped } = importProject(JSON.parse(await file.text()), file.name);
      loadNew(project, positions);
      if (dropped) say(dropped, 8000);
    } catch (e) {
      say(openError(e as Error), 8000);
    }
  };

  // 노드를 끄는 동안 App은 위치 때문에 다시 그려지지만, 위치와 무관한 패널(KPI·왼쪽·그래프·오른쪽)은 그대로 둔다
  const analysis = result.analysis;
  const kpi = useMemo(() => <KpiStrip analysis={analysis} />, [analysis]);
  const left = useMemo(() => focus && <Palette nodeId={focus} analysis={analysis} />, [focus, analysis]);
  // 분석과 짝을 맞춰 그리는 곳(그래프·범례·설계서)은 계산에 쓴 프로젝트를 넘긴다 (새 노드가 아직 분석에 없을 수 있어서)
  const chart = useMemo(() => <LimitChart project={computed} analysis={analysis} />, [computed, analysis]);
  const right = useMemo(() => <>
    {tab === 'results' && <ResultsPanel analysis={analysis} />}
    {tab === 'optimize' && <OptimizePanel today={today} />}
    {tab === 'selected' && selected?.kind === 'node' && <NodePanel id={selected.id} analysis={analysis} />}
    {tab === 'selected' && selected?.kind === 'edge' && <EdgePanel from={selected.from} to={selected.to} analysis={analysis} />}
    {tab === 'selected' && selected?.kind === 'table' && <TableSidePanel nodeId={selected.node} table={selected.table} analysis={analysis} />}
    {tab === 'selected' && !selected && <p className="muted">캔버스에서 노드나 연결선을 고르세요.</p>}
  </>, [tab, selected, analysis]);

  return (
    <>
    <div className="app">
      <header className="bar">
        <div className="brand"><i />App Architect Studio</div>
        <div className="seg" role="tablist" aria-label="화면">
          <button role="tab" aria-selected={screen === 'design'} onClick={() => setScreen('design')}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><rect x="1.5" y="2" width="5" height="4" rx="1" /><rect x="9.5" y="2" width="5" height="4" rx="1" /><rect x="5.5" y="10" width="5" height="4" rx="1" /><path d="M4 6v2h8V6M8 8v2" /></svg>설계도</button>
          <button role="tab" aria-selected={screen === 'settings'} onClick={() => setScreen('settings')}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><path d="M2 4.5h7M12 4.5h2M2 11.5h2M7 11.5h7" /><circle cx="10.5" cy="4.5" r="1.6" /><circle cx="5.5" cy="11.5" r="1.6" /></svg>설정
            {changed > 0 && <span className="badge" title="불러온 뒤 바꾼 설정 항목 수">{changed}</span>}</button>
        </div>
        <span className="spacer" />
        <Menu label="파일" right>{(close) => <>
          <div className="menu-head">예시 불러오기</div>
          {examples.map((e) => (
            <button key={e.name} role="menuitem" onClick={() => { close(); loadNew(parseProject(e.data, catalog.items, e.name)); setFilePath(undefined); }}>{e.name}</button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => { close(); openProject(); }}>열기<small>Ctrl+O</small></button>
          <button role="menuitem" title="tools/analyze_py.py가 만든 JSON" onClick={() => { close(); codeRef.current?.click(); }}>코드 분석 불러오기</button>
          <hr />
          <button role="menuitem" onClick={() => { close(); exportFile(); }}>파일로 내보내기<small>Ctrl+Shift+S</small></button>
          <button role="menuitem" title="연결선의 인터페이스 명세 → OpenAPI(REST)·AsyncAPI(메시지)·proto(gRPC)·파일·전문 레이아웃(CSV), 받는 쪽이 FastAPI면 엔드포인트 뼈대(.py)" onClick={() => { close(); void exportTexts(interfaceFiles(project), '연결선에 인터페이스 명세가 없습니다. 연결선을 고르고 "인터페이스 명세"에서 추가하세요'); }}>인터페이스 명세 내보내기</button>
          <button role="menuitem" title="DB 노드의 테이블 명세 → 노드별 schema-….sql(CREATE TABLE·INDEX, 주석)과 data-dictionary.csv" onClick={() => { close(); void exportTexts(schemaFiles(project, catalog.byId), 'DB 노드에 테이블 명세가 없습니다. DB 노드를 고르고 "테이블 명세"에서 추가하세요'); }}>스키마(DDL)·데이터 사전 내보내기</button>
          <button role="menuitem" onClick={() => { close(); setHistory(!history); }}>저장 기록</button>
        </>}</Menu>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) open(f); }} />
        <input ref={codeRef} type="file" accept="application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const data = JSON.parse(await f.text());
            let skipped = 0;
            edit((p) => { const r = mergeCodeAnalysis(p, data); skipped = r.skipped; return r.project; });
            if (skipped) say(`순환 import라 부하를 계산할 수 없는 연결선 ${skipped}개는 넣지 않았습니다`, 8000);
          } catch (err) {
            say((err as Error).message, 8000);
          }
          e.target.value = '';
        }} />
        <button className="btn" onClick={save} title="저장 기록에 시점을 남깁니다 (Ctrl+S)">저장</button>
        {/* 최선 조합(7번째 절)은 설계서를 열 때 한 번 찾는다 */}
        <button className="btn primary" onClick={() => setReport({ plans: findPlans(project, today).result })}>설계서 PDF</button>
      </header>
      {kpi}
      <div className="views">
      {screen === 'settings' && <Guard><Settings onBack={() => setScreen('design')} /></Guard>}
      <div className={`design ${focus ? 'with-left' : ''} ${hide.right ? 'hide-right' : ''}`} hidden={screen !== 'design'}>
      {focus && <aside className="left"><Guard key={focus}>{left}</Guard></aside>}
      <main className="center">
        <div className="ctb">
          <Menu label="노드 추가" icon={<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M8 3v10M3 8h10" /></svg>}>{(close) => <>
            {LAYERS.map((l) => <button key={l} role="menuitem" onClick={() => { close(); add(l); }}><i className={`dot l-${l}`} />{LAYER_NAMES[l]}</button>)}
          </>}</Menu>
          <i className="sep" />
          <button className="btn icon" onClick={back} disabled={!past.length} title="되돌리기 (Ctrl+Z)" aria-label="되돌리기"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M6 3.5L3 6.5l3 3M3.5 6.5H10a3.5 3.5 0 010 7H7" /></svg></button>
          <button className="btn icon" onClick={forward} disabled={!future.length} title="다시 하기 (Ctrl+Y, Ctrl+Shift+Z)" aria-label="다시 하기"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden><path d="M10 3.5l3 3-3 3M12.5 6.5H6a3.5 3.5 0 000 7h3" /></svg></button>
          <i className="sep" />
          <button className="btn" onClick={relayout} disabled={view === '3d' || !!focus} title="카드를 보기 좋게 다시 늘어놓아요">자동 배치</button>
          <button className="btn" aria-pressed={view === '3d'} onClick={() => setView(view === '2d' ? '3d' : '2d')} disabled={!!focus} title="입체로 보기">3D 보기</button>
          <span className="spacer" />
          {!focus && <Legend project={computed} analysis={analysis} />}
          <span className="panel-toggles" role="group" aria-label="패널 보이기">
            <button aria-pressed={!hide.bottom} title="아래 그래프" aria-label="아래 그래프" onClick={() => toggle({ bottom: !hide.bottom })}><PanelIcon side="bottom" /></button>
            <button aria-pressed={!hide.right} title="오른쪽 결과 패널" aria-label="오른쪽 결과 패널" onClick={() => toggle({ right: !hide.right })}><PanelIcon side="right" /></button>
          </span>
          <button className={`btn ${onlyDiagram ? 'on' : ''}`} onClick={() => toggle(onlyDiagram ? { right: false, bottom: false } : { right: true, bottom: true })}>{onlyDiagram ? '패널 다시 보기' : '다이어그램만'}</button>
        </div>
        <div className="stage">
          <Guard key={`${focus}:${view}`}>{focus
            ? <NodeInside key={focus} nodeId={focus} analysis={result.analysis} onSelect={() => setTab('selected')} />
            : view === '2d'
            ? <Canvas analysis={result.analysis} onSelect={() => setTab('selected')} layout={`${hide.right}${hide.bottom}${screen}`} />
            : <View3D analysis={result.analysis} onSelect={() => setTab('selected')} />}</Guard>
          {!focus && view === '2d' && tip && (
            <div className="tip" role="note">
              <button className="x" aria-label="안내 닫기" onClick={closeTip}>×</button>
              <b>이렇게 읽어요</b>
              <ul>
                <li><i className="h-bad" /><span>빨간 카드가 사용자가 늘 때 가장 먼저 막히는 곳이에요.</span></li>
                <li><i className="wire" /><span>선이 굵을수록 요청이 많이 지나가요.</span></li>
                <li><i className="h-warn" /><span>입력값(사용자 수, 페르소나, 하루 피크 등)은 위쪽 <b>설정</b>에서 바꿔요.</span></li>
              </ul>
            </div>
          )}
        </div>
        {!focus && !hide.bottom && <Guard>{chart}</Guard>}
      </main>
      {!hide.right && (
      <aside className="right">
        <nav className="tabs">
          <button className={tab === 'selected' ? 'on' : ''} onClick={() => setTab('selected')}>선택한 것</button>
          <button className={tab === 'results' ? 'on' : ''} onClick={() => setTab('results')}>전체 결과</button>
          <button className={tab === 'optimize' ? 'on' : ''} onClick={() => setTab('optimize')}>최선 조합</button>
        </nav>
        <Guard key={`${tab}:${JSON.stringify(selected)}`}>{right}</Guard>
      </aside>
      )}
      </div>
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
      {(rejected ?? notice) && <div className="notice" role="status">{rejected ?? notice}</div>}
      {/* 업데이트 전에 지금 작업을 자동 저장에 남긴다. 못 남기면 업데이트하지 않는다 */}
      {update && <UpdatePrompt info={update} prepare={() => (writeAutosave(project, positions) ? undefined : '지금 작업을 자동 저장에 남기지 못해 업데이트하지 않았어요. 먼저 파일로 저장해 주세요')} />}
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
              <button key={i} className={i === (find.at - 1 + hits.length) % hits.length ? 'on' : ''} onClick={() => go(h)}>
                <b>{h.label}</b> <span className="muted">{h.detail}</span>
              </button>
            ))}
          </div>}
        </div>
      )}
      </div>
    </div>
    <Tooltip />
    {/* 인쇄할 때 .app은 숨기고 설계서만 남기므로 .app 밖에 둔다 */}
    {report && <Report project={computed} analysis={result.analysis} positions={positions} plans={report.plans} today={today} onClose={() => setReport(undefined)} />}
    </>
  );
}
