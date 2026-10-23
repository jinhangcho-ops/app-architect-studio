// 블록 안으로 들어가 보기 (DB·캐시·분석 노드): 테이블 블록(컬럼·키·인덱스·크기)과, 행동 → 테이블 쓰기 화살표.
// 행동에서 테이블로 선을 그으면 쓰기가 생기고, 선을 지우면 쓰기가 빠진다. 테이블을 누르면 오른쪽에서 바로 고친다.
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from '@xyflow/react';
import { useState } from 'react';
import type { Analysis } from '../../engine/analyze';
import { LAYER_NAMES } from '../../engine/model';
import { DEFAULT_STORAGE, selectedFeatures, storageProfileOf, TABLE_LAYERS, type ProjectNode } from '../../engine/schema';
import { catalog } from './data';
import { overPalette } from './Palette';
import type { TableAnalysis } from '../../engine/tables';
import { valueBytes } from '../../engine/tables';
import { addAction, addTable, addWrite, dropItem, dropRemove, removeWrite, setFeature } from './edit';
import { fmt, fmtMetric, howMetric } from './format';
import { TableLab } from './ResultsPanel';
import { useStore } from './store';
import { TableEditor } from './TablesPanel';
import { InsideBar, PART_LAYERS, PartsInside, READABLE } from './PartsInside';
import { isOurDrag, readDrag, startDrag } from './Palette';
import { isLocal, ServersInside } from './ServersInside';
import { type DetailTab } from './store';
import { WireframeInside } from './WireframeInside';

type Table = ProjectNode['tables'][number];
type TableData = { t: Table; size?: TableAnalysis };
type ActionData = { name: string; perSession: number };

const STORAGE_NAMES = { integer: '정수', real: '실수', text: '문자열', blob: '바이너리' } as const;

function TableBlock({ data, selected }: NodeProps<Node<TableData>>) {
  const { t, size } = data;
  const indexed = new Set(t.indexes.flatMap((ix) => ix.columns));
  return (
    <div className={`tblock ${selected ? 'sel' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="tblock-head">
        <b>{t.name}</b>
        {size && <span title={`${howMetric(size.storedGb)}`}>{fmt(size.storedGb.value)} GB</span>}
      </div>
      {size && <div className="tblock-sub">하루 {fmt(size.newRowsPerDay.value)}행 · 행 {fmt(size.rowBytes.value)}B + 인덱스 {fmt(size.indexBytesPerRow.value)}B{t.partition ? ` · ${t.partition.column} 기준 ${({ day: '일', week: '주', month: '월' } as const)[t.partition.interval]} 파티션` : ''}</div>}
      <table>
        <tbody>{t.columns.map((c) => (
          <tr key={c.name}>
            <td className="tblock-key">{t.primary_key.includes(c.name) ? '🔑' : indexed.has(c.name) ? '◆' : ''}</td>
            <td>{c.name}{c.nullable ? '?' : ''}</td>
            <td className="muted">{c.type} · {STORAGE_NAMES[c.storage ?? DEFAULT_STORAGE[c.type]]}</td>
            <td className="muted num">{fmt(valueBytes(c))}B</td>
          </tr>
        ))}</tbody>
      </table>
      {t.indexes.length > 0 && <div className="tblock-sub">{t.indexes.map((ix) => `${ix.unique ? '고유 ' : ''}${ix.name}(${ix.columns.join(', ')})`).join(' · ')}</div>}
    </div>
  );
}

function ActionBlock({ data }: NodeProps<Node<ActionData>>) {
  return (
    <div className="ablock">
      <b>{data.name}</b>
      <div className="muted">접속당 {data.perSession}회</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { table: TableBlock, action: ActionBlock };

/** 모든 블록은 세부 구성(서버 구성)을 연다 */
export const canEnter = (layer?: string) => !!layer;

/** 카드를 누르면 열리는 세부 구성: 서버(로컬이면 기기) 구성 + 테이블 구성(DB·캐시·분석) · 부품 구성(백엔드·게이트웨이·워커) · 와이어프레임(화면) */
export function NodeInside({ nodeId, analysis, onSelect }: { nodeId: string; analysis?: Analysis; onSelect: () => void }) {
  const { project: p, setFocus, focusTab: tab, set, edit } = useStore();
  const n = p.nodes.find((x) => x.id === nodeId);
  if (!n) return <p className="muted inside-empty">블록이 없습니다. <button onClick={() => setFocus(undefined)}>← 전체 구조</button></p>;
  const tabs: [DetailTab, string][] = [['servers', isLocal(p, n) ? '기기 구성' : '서버 구성']];
  if ((TABLE_LAYERS as readonly string[]).includes(n.layer)) tabs.push(['tables', '테이블 구성']);
  if ((PART_LAYERS as readonly string[]).includes(n.layer)) tabs.push(['parts', '부품 구성']);
  if (n.layer === 'ui') tabs.push(['wireframe', '와이어프레임']);
  const shown = tabs.some(([k]) => k === tab) ? tab : 'servers';
  return (
    <div className="detail" onContextMenu={(e) => { e.preventDefault(); setFocus(undefined); }}
      onDragOver={(e) => isOurDrag(e) && e.preventDefault()}
      onDrop={(e) => {
        // 왼편 목록에서 끌어 온 것 (와이어프레임 상자는 와이어프레임이 직접 받는다)
        const d = readDrag(e);
        if (!d) return;
        e.preventDefault();
        if (d.kind === 'item') edit((x) => dropItem(x, nodeId, d.id));
        else if (d.kind === 'table') edit((x) => addTable(x, nodeId));
        else if (d.kind === 'action') edit(addAction);
        else if (d.kind === 'feature') edit((x) => setFeature(x, nodeId, d.id, true));
      }}>
      <div className="dhead">
        <button className="back" onClick={() => setFocus(undefined)} title="Esc 또는 오른쪽 클릭으로도 돌아갑니다">← 전체 구조</button>
        <b>{n.name} · 세부 구성</b>
        <span className="muted">{LAYER_NAMES[n.layer]}</span>
        <span className="spacer" />
        {tabs.length > 1 && <div className="dtabs" role="tablist">{tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={shown === k} className={shown === k ? 'on' : ''} onClick={() => set({ focusTab: k })}>{label}</button>
        ))}</div>}
      </div>
      {shown === 'servers' && <ServersInside nodeId={nodeId} analysis={analysis} />}
      {shown === 'tables' && <TablesInside nodeId={nodeId} analysis={analysis} onSelect={onSelect} />}
      {shown === 'parts' && <PartsInside nodeId={nodeId} analysis={analysis} canEnter={canEnter} />}
      {shown === 'wireframe' && <WireframeInside nodeId={nodeId} />}
    </div>
  );
}

function TablesInside({ nodeId, analysis, onSelect }: { nodeId: string; analysis?: Analysis; onSelect: () => void }) {
  const { project: p, edit, select, selected } = useStore();
  // 안쪽 배치는 보는 동안만 기억한다 (저장 파일에는 바깥 노드 위치만 남긴다)
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const sp = storageProfileOf(n.primary ? catalog.byId.get(n.primary) : undefined, catalog.byId);

  const actions = p.actions.filter((a) => a.writes.some((w) => w.node === nodeId));
  const others = p.actions.filter((a) => !actions.includes(a));
  let y = 0;
  const tableNodes: Node<TableData>[] = n.tables.map((t) => {
    const at = { x: 380, y };
    y += 90 + t.columns.length * 22 + (t.indexes.length ? 24 : 0);
    return {
      id: `t:${t.name}`, type: 'table', position: moved[`t:${t.name}`] ?? at,
      selected: selected?.kind === 'table' && selected.node === nodeId && selected.table === t.name,
      data: { t, size: analysis?.tables.find((x) => x.nodeId === nodeId && x.table === t.name) },
    };
  });
  const actionNodes: Node<ActionData>[] = [...actions, ...others].map((a, i) => ({
    id: `a:${a.name}`, type: 'action', position: moved[`a:${a.name}`] ?? { x: 0, y: i * 100 }, data: { name: a.name, perSession: a.per_session },
  }));
  const edges: Edge[] = actions.flatMap((a) => a.writes.filter((w) => w.node === nodeId).map((w) => ({
    id: `${a.name}->${w.table}`, source: `a:${a.name}`, target: `t:${w.table}`,
    label: `${w.rows}행씩`, markerEnd: { type: MarkerType.ArrowClosed },
  })));

  return (
    <div className="inside">
      <InsideBar>
        {sp && <span className="fchips">저장 기능 {selectedFeatures(sp, n).map((f) => (
          <span key={f.id} className="fchip" draggable title="왼편 목록으로 끌어 놓으면 꺼져요" onDragStart={(e) => startDrag(e, { kind: 'remove', what: 'feature', id: f.id })}>{f.label}</span>
        ))}</span>}
        <span className="spacer" />
        <button onClick={() => edit((x) => addTable(x, nodeId))}>테이블 추가</button>
        <button onClick={() => edit(addAction)} disabled={!n.tables.length && !p.nodes.some((x) => x.tables.length)}>행동 추가</button>
      </InsideBar>
      {!n.tables.length && <p className="muted inside-empty">테이블이 없습니다. "테이블 추가"를 누르거나, 오른쪽 노드 패널에서 명세서를 붙여 넣으세요.</p>}
      <ReactFlow
        nodes={[...actionNodes, ...tableNodes]}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={READABLE}
        colorMode="dark"
        onNodesChange={(changes) => {
          for (const c of changes) if (c.type === 'position' && c.position) setMoved((m) => ({ ...m, [c.id]: c.position! }));
        }}
        onConnect={(c) => c.source?.startsWith('a:') && c.target?.startsWith('t:') && edit((x) => addWrite(x, c.source.slice(2), nodeId, c.target.slice(2)))}
        onEdgesDelete={(es) => edit((x) => es.reduce((acc, e) => removeWrite(acc, e.source.slice(2), nodeId, e.target.slice(2)), x))}
        // 테이블 블록을 왼편 목록으로 끌어 놓으면 테이블을 지운다 (Ctrl+Z로 되돌림)
        onNodeDragStop={(e, node) => node.id.startsWith('t:') && overPalette(e) && edit((x) => dropRemove(x, nodeId, { kind: 'remove', what: 'table', id: node.id.slice(2) }))}
        onNodeClick={(_, node) => {
          if (!node.id.startsWith('t:')) return select(null);
          select({ kind: 'table', node: nodeId, table: node.id.slice(2) });
          onSelect();
        }}
        onPaneClick={() => select(null)}
        deleteKeyCode={['Backspace', 'Delete']}
      >
        <Background />
        <Controls />
      </ReactFlow>
      <p className="inside-hint muted">왼편에서 테이블·행동·저장 기능을 끌어 놓아 더합니다 · 테이블 블록이나 저장 기능을 왼편으로 끌어 내면 빠집니다 · 행동 블록의 오른쪽 점에서 테이블로 선을 그으면 쓰기가 생깁니다 · 선을 고르고 Delete로 뺍니다 · 테이블을 누르면 오른쪽에서 고칩니다</p>
    </div>
  );
}

/** 오른쪽 패널: 고른 테이블의 크기와 편집, SQLite 실험 */
export function TableSidePanel({ nodeId, table, analysis }: { nodeId: string; table: string; analysis?: Analysis }) {
  const { project, select } = useStore();
  const n = project.nodes.find((x) => x.id === nodeId);
  const t = n?.tables.find((x) => x.name === table);
  if (!n || !t) return <p className="muted">테이블이 없습니다.</p>;
  const size = analysis?.tables.find((x) => x.nodeId === nodeId && x.table === table);
  return (
    <div className="panel">
      <section className="section">
        <h3>{n.name} › {t.name}</h3>
        {size && <table className="metrics"><tbody>
          {([['하루 새 행', size.newRowsPerDay], ['행 크기', size.rowBytes], ['인덱스/행', size.indexBytesPerRow], ['보관 기간 저장량', size.storedGb], ['파티션 하나', size.partitions?.gb]] as const)
            .map(([label, m]) => m && <tr key={label} title={howMetric(m)}><td>{label}</td><td>{fmtMetric(m)}</td></tr>)}
        </tbody></table>}
        {size && size.assumptions.length > 0 && <ul className="muted">{size.assumptions.map((s) => <li key={s}>{s}</li>)}</ul>}
        <p><TableLab nodeId={nodeId} table={table} /></p>
      </section>
      <TableEditor key={t.name} node={n} t={t} open onRename={(name) => select({ kind: 'table', node: nodeId, table: name })} />
    </div>
  );
}
