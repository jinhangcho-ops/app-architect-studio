import { useEffect, useMemo, useRef, useState } from 'react';
import { parseProject } from '../../engine/data';
import { LAYERS, LAYER_NAMES, type Layer } from '../../engine/model';
import { Canvas } from './Canvas';
import { catalog, examples } from './data';
import { mergeCodeAnalysis } from './codeImport';
import { addNode, findPlans, pasteNode, run } from './edit';
import { clearAutosave, readAutosave, scheduleAutosave } from './autosave';
import { searchProject, type Hit } from './search';
import type { OptimizeResult } from '../../engine/optimize';
import { Report } from './Report';
import { NodeInside, TableSidePanel } from './NodeInside';
import { EdgePanel, NodePanel } from './NodePanel';
import { OptimizePanel } from './OptimizePanel';
import { View3D } from './View3D';
import { ProjectPanel } from './ProjectPanel';
import { ResultsPanel } from './ResultsPanel';
import { exportProject, useStore } from './store';

// 사용자 PC의 날짜 (toISOString은 UTC라 한국에서는 오전 9시 전에 어제 날짜가 된다). sv-SE 형식이 YYYY-MM-DD
const today = new Date().toLocaleDateString('sv-SE');

export function App() {
  const { project, positions, selected, load, edit, relayout, select, focus, setFocus, undo, redo, past, future, clipboard, set, move } = useStore();
  // 위치를 끌어도 다시 계산하지 않도록 프로젝트가 바뀔 때만 분석한다
  const result = useMemo(() => run(project, today), [project]);
  const [tab, setTab] = useState<'selected' | 'results' | 'optimize'>('results');
  const fileRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [report, setReport] = useState<{ plans?: OptimizeResult }>();
  const [find, setFind] = useState<{ q: string; at: number }>();
  // 앱을 열 때 남아 있던 임시 저장. 복구할지 정하기 전에는 임시 저장을 덮어쓰지 않는다
  const [recovery, setRecovery] = useState(() => readAutosave());
  useEffect(() => { if (!recovery) scheduleAutosave(project, positions); }, [project, positions, recovery]);

  const hits = find ? searchProject(project, catalog.byId, find.q) : [];
  const go = (h: Hit) => {
    setTab('selected');
    if (h.kind === 'node') { setFocus(undefined); select({ kind: 'node', id: h.node }); set({ flyTo: h.node }); }
    else { setFocus(h.node); select({ kind: 'table', node: h.node, table: h.table }); }
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

  const save = () => {
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
      if (k === 's') { e.preventDefault(); save(); return; }
      if (k === 'f') { e.preventDefault(); setFind({ q: find?.q ?? '', at: 0 }); return; }
      if (k === 'o') { e.preventDefault(); fileRef.current?.click(); return; }
      if (typing) return;
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

  const open = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const pos = Object.fromEntries((data.nodes ?? []).filter((n: { pos?: unknown }) => n.pos).map((n: { id: string; pos: { x: number; y: number } }) => [n.id, n.pos]));
      load(parseProject(data, catalog.items, file.name), pos);
    } catch (e) {
      alert((e as Error).message);
    }
  };

  return (
    <>
    <div className="app">
      <header className="toolbar">
        <strong className="brand">App Architect Studio</strong>
        <select aria-label="노드 추가" value="" onChange={(e) => e.target.value && add(e.target.value as Layer)}>
          <option value="">+ 노드 추가</option>
          {LAYERS.map((l) => <option key={l} value={l}>{LAYER_NAMES[l]}</option>)}
        </select>
        <button onClick={undo} disabled={!past.length} title="되돌리기 (Ctrl+Z)" aria-label="되돌리기">↶</button>
        <button onClick={redo} disabled={!future.length} title="다시 하기 (Ctrl+Y, Ctrl+Shift+Z)" aria-label="다시 하기">↷</button>
        <button onClick={relayout} disabled={view === '3d'}>자동 배치</button>
        <button onClick={() => setView(view === '2d' ? '3d' : '2d')}>{view === '2d' ? '3D 보기' : '2D 보기'}</button>
        <span className="spacer" />
        <select aria-label="예시 불러오기" value="" onChange={(e) => {
          const ex = examples.find((x) => x.name === e.target.value);
          if (ex) load(parseProject(ex.data, catalog.items, ex.name));
        }}>
          <option value="">예시 불러오기</option>
          {examples.map((e) => <option key={e.name} value={e.name}>{e.name}</option>)}
        </select>
        <button onClick={() => fileRef.current?.click()}>열기</button>
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files?.[0] && open(e.target.files[0])} />
        <button onClick={() => codeRef.current?.click()} title="tools/analyze_py.py가 만든 JSON">코드 분석 불러오기</button>
        <input ref={codeRef} type="file" accept="application/json" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          if (!f) return;
          try {
            const data = JSON.parse(await f.text());
            edit((p) => mergeCodeAnalysis(p, data));
          } catch (err) {
            alert((err as Error).message);
          }
          e.target.value = '';
        }} />
        <button onClick={save}>저장</button>
        {/* 최선 조합(7번째 절)은 설계서를 열 때 한 번 찾는다 */}
        <button className="primary" onClick={() => setReport({ plans: findPlans(project, today).result })}>설계서 PDF</button>
      </header>
      <aside className="left"><ProjectPanel /></aside>
      <main className="center">
        {focus
          ? <NodeInside nodeId={focus} analysis={result.analysis} onSelect={() => setTab('selected')} />
          : view === '2d'
          ? <Canvas analysis={result.analysis} onSelect={() => setTab('selected')} />
          : <View3D analysis={result.analysis} onSelect={() => setTab('selected')} />}
        {result.error && <pre className="error-banner">{result.error}</pre>}
        {recovery && (
          <div className="recovery">
            저장하지 않고 닫힌 작업이 있습니다: <b>{recovery.project.name}</b> ({new Date(recovery.savedAt).toLocaleString('ko-KR')})
            <button className="primary" onClick={() => { load(recovery.project, recovery.positions); setRecovery(undefined); }}>복구</button>
            <button onClick={() => { clearAutosave(); setRecovery(undefined); }}>버리기</button>
          </div>
        )}
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
      <aside className="right">
        <nav className="tabs">
          <button className={tab === 'selected' ? 'on' : ''} onClick={() => setTab('selected')}>선택한 것</button>
          <button className={tab === 'results' ? 'on' : ''} onClick={() => setTab('results')}>전체 결과</button>
          <button className={tab === 'optimize' ? 'on' : ''} onClick={() => setTab('optimize')}>최선 조합</button>
        </nav>
        {tab === 'results' && <ResultsPanel analysis={result.analysis} />}
        {tab === 'optimize' && <OptimizePanel today={today} />}
        {tab === 'selected' && selected?.kind === 'node' && <NodePanel id={selected.id} analysis={result.analysis} />}
        {tab === 'selected' && selected?.kind === 'edge' && <EdgePanel from={selected.from} to={selected.to} />}
        {tab === 'selected' && selected?.kind === 'table' && <TableSidePanel nodeId={selected.node} table={selected.table} analysis={result.analysis} />}
        {tab === 'selected' && !selected && <p className="muted">캔버스에서 노드나 연결선을 고르세요.</p>}
      </aside>
    </div>
    {/* 인쇄할 때 .app은 숨기고 설계서만 남기므로 .app 밖에 둔다 */}
    {report && <Report project={project} analysis={result.analysis} positions={positions} plans={report.plans} today={today} onClose={() => setReport(undefined)} />}
    </>
  );
}
