import { useMemo, useRef, useState } from 'react';
import { parseProject } from '../../engine/data';
import { LAYERS, LAYER_NAMES, type Layer } from '../../engine/model';
import { Canvas } from './Canvas';
import { catalog, examples } from './data';
import { addNode, run } from './edit';
import { EdgePanel, NodePanel } from './NodePanel';
import { OptimizePanel } from './OptimizePanel';
import { ProjectPanel } from './ProjectPanel';
import { ResultsPanel } from './ResultsPanel';
import { exportProject, useStore } from './store';

const today = new Date().toISOString().slice(0, 10);

export function App() {
  const { project, positions, selected, load, edit, relayout, select } = useStore();
  // 위치를 끌어도 다시 계산하지 않도록 프로젝트가 바뀔 때만 분석한다
  const result = useMemo(() => run(project, today), [project]);
  const [tab, setTab] = useState<'selected' | 'results' | 'optimize'>('results');
  const fileRef = useRef<HTMLInputElement>(null);

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
    <div className="app">
      <header className="toolbar">
        <strong className="brand">App Architect Studio</strong>
        <select aria-label="노드 추가" value="" onChange={(e) => e.target.value && add(e.target.value as Layer)}>
          <option value="">+ 노드 추가</option>
          {LAYERS.map((l) => <option key={l} value={l}>{LAYER_NAMES[l]}</option>)}
        </select>
        <button onClick={relayout}>자동 배치</button>
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
        <button onClick={save}>저장</button>
      </header>
      <aside className="left"><ProjectPanel /></aside>
      <main className="center">
        <Canvas analysis={result.analysis} onSelect={() => setTab('selected')} />
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
        {tab === 'selected' && !selected && <p className="muted">캔버스에서 노드나 연결선을 고르세요.</p>}
      </aside>
    </div>
  );
}
