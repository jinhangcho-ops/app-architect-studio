// 화면 블록의 와이어프레임 (UI/UX 설계): 왼편에서 영역·컨트롤을 끌어 화면 틀에 놓고, 끌어서 옮기고, 오른쪽 아래 모서리로 크기를 바꾼다.
// 두 번 누르면 글을 고치고, Delete나 왼편으로 끌어 내면 지운다. 화면은 여러 장 둘 수 있다.
// 컨트롤에 API 호출(메서드·경로·받는 블록·접속당 횟수)을 붙이면 연결선이 생기고, 화면에서 나가는 부하가 호출 비율대로 나뉜다.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Analysis } from '../../engine/analyze';
import { routedCalls } from '../../engine/api';
import { LAYER_NAMES } from '../../engine/model';
import type { WireItem } from '../../engine/schema';
import { addScreen, addWire, bindApi, dropRemove, mapScreens, updateWire } from './edit';
import { fmt } from './format';
import { htmlToScreen } from './htmlImport';
import { markDrag, overPalette, readDrag, WIRE_NAMES } from './Palette';
import { Select } from './Select';
import { useStore } from './store';
import { downloadPng, drawOrder, fitItem, frameOf } from './wireDraw';

const GRID = 8;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** 놓을 때 기본 크기 (데스크톱 틀 기준, 좁은 틀에서는 틀 너비로 줄인다) */
const SIZE: Record<WireItem['kind'], [number, number]> = {
  header: [1280, 64], nav: [1280, 44], sidebar: [240, 600], main: [800, 520], form: [400, 320], table: [640, 280], list: [360, 320], card: [280, 180],
  modal: [480, 320], footer: [1280, 56], text: [240, 28], image: [240, 160], button: [120, 40], input: [280, 40], select: [200, 40], tabs: [400, 40],
};

type Live = { id: string; mode: 'move' | 'size'; sx: number; sy: number; o: WireItem; now: WireItem };

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function WireframeInside({ nodeId, analysis }: { nodeId: string; analysis?: Analysis }) {
  const { project: p, edit } = useStore();
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const screens = n.wireframe?.screens ?? [{ name: '화면 1', items: [] }];
  const [cur, setCur] = useState(0);
  const si = Math.min(cur, screens.length - 1);
  const screen = screens[si];
  const [sel, setSel] = useState<string>();
  const [live, setLive] = useState<Live>();
  const [editing, setEditing] = useState<string>();
  const frame = frameOf(p.deploy.mode);
  const fileRef = useRef<HTMLInputElement>(null);
  const picked = screen.items.find((x) => x.id === sel);
  const targets = p.nodes.filter((x) => x.id !== nodeId && x.layer !== 'ui');
  const nameOf = (id?: string) => p.nodes.find((x) => x.id === id)?.name ?? '—';
  // 호출은 있는데 연결선이 없는 대상, 연결선은 있는데 호출이 없는 대상 (호출이 하나라도 있으면 그 블록으로 부하가 안 간다)
  const routed = routedCalls(p, n);
  const allCalls = screens.flatMap((s) => s.items.filter((i) => i.api?.to).map((i) => ({ s: s.name, i })));
  const unrouted = allCalls.filter(({ i }) => !routed.some((c) => c.item === i.id && c.to === i.api!.to));
  const idle = routed.length ? p.edges.filter((e) => e.from === nodeId && !routed.some((c) => c.to === e.to)).map((e) => nameOf(e.to)) : [];
  const loads = analysis?.api.filter((c) => c.node === nodeId) ?? [];

  // 화면 틀을 칸에 맞춰 줄인다
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ k: 1, left: 0, top: 0 });
  const k = fit.k;
  useEffect(() => {
    const el = wrap.current!;
    const update = () => {
      const kk = Math.min(1, (el.clientWidth - 32) / frame.w, (el.clientHeight - 32) / frame.h);
      setFit({ k: kk, left: (el.clientWidth - frame.w * kk) / 2, top: (el.clientHeight - frame.h * kk) / 2 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [frame.w, frame.h]);

  const remove = (id: string) => { edit((x) => dropRemove(x, nodeId, { kind: 'remove', what: 'wire', screen: si, id })); setSel(undefined); };
  const down = (e: RPointerEvent, it: WireItem, mode: Live['mode']) => {
    if (e.button !== 0 || editing === it.id) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel(it.id);
    if (mode === 'move') markDrag('remove');
    setLive({ id: it.id, mode, sx: e.clientX, sy: e.clientY, o: it, now: it });
  };
  const move = (e: RPointerEvent) => {
    if (!live) return;
    const dx = (e.clientX - live.sx) / k, dy = (e.clientY - live.sy) / k, o = live.o;
    const now = live.mode === 'move'
      ? { ...o, x: snap(Math.max(0, Math.min(frame.w - o.w, o.x + dx))), y: snap(Math.max(0, Math.min(frame.h - o.h, o.y + dy))) }
      : { ...o, w: Math.max(GRID * 3, snap(Math.min(frame.w - o.x, o.w + dx))), h: Math.max(GRID * 2, snap(Math.min(frame.h - o.y, o.h + dy))) };
    setLive({ ...live, now });
  };
  const up = (e: RPointerEvent) => {
    if (!live) return;
    const { id, now, o } = live;
    setLive(undefined);
    markDrag();
    if (live.mode === 'move' && overPalette(e)) return remove(id);
    if (now.x !== o.x || now.y !== o.y || now.w !== o.w || now.h !== o.h) edit((x) => updateWire(x, nodeId, si, id, { x: now.x, y: now.y, w: now.w, h: now.h }));
  };

  /** 터치·창 전환으로 끌기가 취소되면 옮기지 않고 끝낸다 */
  const cancel = () => { setLive(undefined); markDrag(); };

  // 큰 상자(영역)를 먼저 그려 작은 상자(컨트롤)가 위에 오게 한다
  const items = drawOrder(screen.items.map((it) => (live?.id === it.id ? live.now : fitItem(it, frame))));

  return (
    <div className="wire">
      <div className="inside-bar">
        {screens.map((s, i) => (
          <span key={i} className={`wscreen ${i === si ? 'on' : ''}`} onClick={() => setCur(i)}>
            {editing === `screen:${i}`
              ? <input autoFocus defaultValue={s.name} aria-label="화면 이름" onBlur={(e) => { const v = e.target.value.trim(); if (v && !screens.some((y, j) => j !== i && y.name === v)) edit((x) => mapScreens(x, nodeId, (ss) => ss.map((y, j) => (j === i ? { ...y, name: v } : y)))); setEditing(undefined); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(undefined); }} />
              : <span onDoubleClick={() => setEditing(`screen:${i}`)} title="두 번 누르면 이름을 고쳐요">{s.name}</span>}
            {screens.length > 1 && <button aria-label={`${s.name} 지우기`} onClick={(e) => { e.stopPropagation(); edit((x) => mapScreens(x, nodeId, (ss) => ss.filter((_, j) => j !== i))); setCur(0); }}>×</button>}
          </span>
        ))}
        <button onClick={() => { edit((x) => addScreen(x, nodeId)); setCur(screens.length); }}>+ 화면</button>
        <span className="spacer" />
        <span className="muted">{frame.name} · {screen.items.length}개</span>
        <button onClick={() => fileRef.current?.click()} title="HTML 파일의 헤더·폼·버튼 등을 새 화면으로 가져옵니다">HTML 가져오기</button>
        <input ref={fileRef} type="file" accept=".html,.htm" hidden onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          const sc = htmlToScreen(await f.text(), frame, f.name.replace(/\.html?$/i, ''));
          // 화면 이름은 겹치지 않게 (호출 목록·설계서 표가 이름으로 줄을 가른다)
          for (let k = 2, base = sc.name; screens.some((y) => y.name === sc.name); k++) sc.name = `${base} ${k}`;
          edit((x) => mapScreens(x, nodeId, (ss) => [...ss.filter((y) => y.items.length || ss.length > 1), sc]));
          setCur(screen.items.length || screens.length > 1 ? screens.length : 0);
        }} />
        <button onClick={() => downloadPng(screen, frame, `${n.name}-${screen.name}`)}>PNG 저장</button>
        {screens.length > 1 && <button onClick={() => screens.forEach((s) => downloadPng(s, frame, `${n.name}-${s.name}`))}>모든 화면 PNG</button>}
      </div>
      <div className="wwrap" ref={wrap} tabIndex={0}
        onKeyDown={(e) => { if (sel && !editing && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); remove(sel); } }}
        onPointerDown={() => setSel(undefined)}>
        <div className="wframe" style={{ left: fit.left, top: fit.top, width: frame.w * k, height: frame.h * k }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const d = readDrag(e);
            if (d?.kind !== 'ui') return;
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            const [w0, h0] = SIZE[d.ui];
            const w = Math.min(w0, frame.w), h = Math.min(h0, frame.h);
            const x = snap(Math.max(0, Math.min(frame.w - w, (e.clientX - r.left) / k - w / 2)));
            const y = snap(Math.max(0, Math.min(frame.h - h, (e.clientY - r.top) / k - h / 2)));
            edit((pp) => addWire(pp, nodeId, si, { kind: d.ui, label: WIRE_NAMES[d.ui], x, y, w, h }));
          }}>
          {!items.length && <p className="wempty muted">왼편에서 헤더·버튼 같은 상자를 끌어 여기에 놓으세요</p>}
          {items.map((it) => (
            <div key={it.id} className={`wi wi-${it.kind} ${sel === it.id ? 'sel' : ''}`} style={{ left: it.x * k, top: it.y * k, width: it.w * k, height: it.h * k }}
              onPointerDown={(e) => down(e, it, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
              onDoubleClick={() => setEditing(it.id)} title={`${WIRE_NAMES[it.kind]} · ${it.w}×${it.h}`}>
              {editing === it.id
                ? <input autoFocus defaultValue={it.label} aria-label="상자 글" onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => { edit((x) => updateWire(x, nodeId, si, it.id, { label: e.target.value })); setEditing(undefined); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(undefined); }} />
                : <span className="wl">{it.label}</span>}
              {it.api && <span className={`wapi ${it.api.to ? '' : 'none'}`}>{it.api.method}{it.api.to ? ` → ${nameOf(it.api.to)}` : ' (받는 블록 없음)'}</span>}
              {sel === it.id && <i className="wsize" aria-label="크기 바꾸기" onPointerDown={(e) => down(e, it, 'size')} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} />}
            </div>
          ))}
        </div>
      </div>
      <div className="winspect">
        {picked ? <>
          <b>{WIRE_NAMES[picked.kind]}</b>
          <label>글 <input value={picked.label} onChange={(e) => edit((x) => updateWire(x, nodeId, si, picked.id, { label: e.target.value }))} /></label>
          {picked.api ? <>
            <Select aria-label="메서드" value={picked.api.method} onChange={(e) => edit((x) => bindApi(x, nodeId, si, picked.id, { ...picked.api!, method: e.target.value as typeof METHODS[number] }))}>
              {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
            <input aria-label="경로" placeholder="/api/orders" value={picked.api.path} onChange={(e) => edit((x) => bindApi(x, nodeId, si, picked.id, { ...picked.api!, path: e.target.value }))} />
            <Select aria-label="받는 블록" value={picked.api.to ?? ''} onChange={(e) => edit((x) => bindApi(x, nodeId, si, picked.id, { ...picked.api!, to: e.target.value || undefined }))}>
              <option value="">받는 블록 고르기</option>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({LAYER_NAMES[t.layer]})</option>)}
            </Select>
            <label title="접속 1회에 이 호출을 부르는 평균 횟수. 화면의 요청을 호출끼리 이 비율로 나눕니다">접속당 <input type="number" min={0} step={0.1} value={picked.api.per_session} onChange={(e) => edit((x) => bindApi(x, nodeId, si, picked.id, { ...picked.api!, per_session: Math.max(0, Number(e.target.value) || 0) }))} />회</label>
            <button onClick={() => edit((x) => bindApi(x, nodeId, si, picked.id, undefined))}>API 빼기</button>
          </> : <button onClick={() => edit((x) => bindApi(x, nodeId, si, picked.id, { method: picked.kind === 'form' || picked.kind === 'button' ? 'POST' : 'GET', path: '', per_session: 1 }))}>+ API 호출 붙이기</button>}
        </> : <>
          <b>API 호출</b>
          {loads.length ? loads.map((c) => (
            <span key={c.screen + c.item} className="wcall" title={c.rps.formula}>{c.screen} · {c.label} <code>{c.method} {c.path || '/'}</code> → {nameOf(c.to)} <b>{fmt(c.rps.value)}</b> / 이벤트 {fmt(c.rpsEvent.value)} RPS</span>
          )) : <span className="muted">상자를 고르고 "API 호출 붙이기"를 누르면, 그 호출이 받는 블록으로 연결선이 생기고 부하가 호출 비율대로 나뉘어요.</span>}
        </>}
        {unrouted.length > 0 && <span className="warn">연결선이 지워져 계산에서 빠진 호출: {unrouted.map(({ s, i }) => `${s}·${i.label}`).join(', ')}</span>}
        {idle.length > 0 && <span className="warn">호출이 없어 이 화면에서 부하를 받지 않는 연결: {idle.join(', ')}</span>}
      </div>
      <p className="inside-hint muted">끌어서 옮기고 오른쪽 아래 모서리로 크기를 바꿔요 · 두 번 누르면 글 고치기 · Delete나 왼편으로 끌어 내면 지워요 · 화면 이름은 두 번 눌러 고쳐요</p>
    </div>
  );
}
