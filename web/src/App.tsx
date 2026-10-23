import { useEffect, useMemo, useRef, useState } from 'react';
import { parseProject } from '../../engine/data';
import { LAYERS, LAYER_NAMES, type Layer } from '../../engine/model';
import { Canvas } from './Canvas';
import { catalog, examples } from './data';
import { mergeCodeAnalysis } from './codeImport';
import { addNode, findPlans, run } from './edit';
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
  const { project, positions, selected, load, edit, relayout, select, focus, setFocus, undo, redo, past, future } = useStore();
  // 위치를 끌어도 다시 계산하지 않도록 프로젝트가 바뀔 때만 분석한다
  const result = useMemo(() => run(project, today), [project]);
  const [tab, setTab] = useState<'selected' | 'results' | 'optimize'>('results');
  const fileRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const [view, setView] = useState<'2d' | '3d'>('2d');
  const [report, setReport] = useState<{ plans?: OptimizeResult }>();

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
  // e.code(자판 위치)를 써서 한글 입력 상태에서도 같은 키로 동작한다
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && !!e.target.closest('input, textarea, select, [contenteditable="true"]');
      if (e.key === 'Escape') {
        if (report) setReport(undefined);
        else if (!typing) (focus ? setFocus(undefined) : select(null));
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.code === 'KeyS') { e.preventDefault(); save(); return; }
      if (e.code === 'KeyO') { e.preventDefault(); fileRef.current?.click(); return; }
      if (typing) return;
      if (e.code === 'KeyZ' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (e.code === 'KeyY' || (e.code === 'KeyZ' && e.shiftKey)) { e.preventDefault(); redo(); }
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
