// 화면 블록의 와이어프레임 (UI/UX 설계): 왼편에서 영역·컨트롤을 끌어 화면 틀에 놓고, 끌어서 옮기고, 오른쪽 아래 모서리로 크기를 바꾼다.
// 두 번 누르면 글을 고치고, Delete나 왼편으로 끌어 내면 지운다. 화면은 여러 장 둘 수 있다. 계산에는 쓰지 않는다.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { WireItem } from '../../engine/schema';
import { addScreen, addWire, dropRemove, mapScreens, updateWire } from './edit';
import { overPalette, readDrag, WIRE_NAMES } from './Palette';
import { useStore } from './store';

const GRID = 8;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** 놓을 때 기본 크기 (데스크톱 틀 기준, 좁은 틀에서는 틀 너비로 줄인다) */
const SIZE: Record<WireItem['kind'], [number, number]> = {
  header: [1280, 64], nav: [1280, 44], sidebar: [240, 600], main: [800, 520], form: [400, 320], table: [640, 280], list: [360, 320], card: [280, 180],
  modal: [480, 320], footer: [1280, 56], text: [240, 28], image: [240, 160], button: [120, 40], input: [280, 40], select: [200, 40], tabs: [400, 40],
};

type Live = { id: string; mode: 'move' | 'size'; sx: number; sy: number; o: WireItem; now: WireItem };

export function WireframeInside({ nodeId }: { nodeId: string }) {
  const { project: p, edit } = useStore();
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const screens = n.wireframe?.screens ?? [{ name: '화면 1', items: [] }];
  const [cur, setCur] = useState(0);
  const si = Math.min(cur, screens.length - 1);
  const screen = screens[si];
  const [sel, setSel] = useState<string>();
  const [live, setLive] = useState<Live>();
  const [editing, setEditing] = useState<string>();
  const frame = p.deploy.mode === 'mobile' ? { w: 390, h: 844, name: '모바일 390×844' } : { w: 1280, h: 800, name: '데스크톱 1280×800' };

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
    if (live.mode === 'move' && overPalette(e)) return remove(id);
    if (now.x !== o.x || now.y !== o.y || now.w !== o.w || now.h !== o.h) edit((x) => updateWire(x, nodeId, si, id, { x: now.x, y: now.y, w: now.w, h: now.h }));
  };

  // 큰 상자(영역)를 먼저 그려 작은 상자(컨트롤)가 위에 오게 한다
  const items = [...screen.items].map((it) => (live?.id === it.id ? live.now : it)).sort((a, b) => b.w * b.h - a.w * a.h);

  return (
    <div className="wire">
      <div className="inside-bar">
        {screens.map((s, i) => (
          <span key={i} className={`wscreen ${i === si ? 'on' : ''}`} onClick={() => setCur(i)}>
            {editing === `screen:${i}`
              ? <input autoFocus defaultValue={s.name} aria-label="화면 이름" onBlur={(e) => { const v = e.target.value.trim(); if (v) edit((x) => mapScreens(x, nodeId, (ss) => ss.map((y, j) => (j === i ? { ...y, name: v } : y)))); setEditing(undefined); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(undefined); }} />
              : <span onDoubleClick={() => setEditing(`screen:${i}`)} title="두 번 누르면 이름을 고쳐요">{s.name}</span>}
            {screens.length > 1 && <button aria-label={`${s.name} 지우기`} onClick={(e) => { e.stopPropagation(); edit((x) => mapScreens(x, nodeId, (ss) => ss.filter((_, j) => j !== i))); setCur(0); }}>×</button>}
          </span>
        ))}
        <button onClick={() => { edit((x) => addScreen(x, nodeId)); setCur(screens.length); }}>+ 화면</button>
        <span className="spacer" />
        <span className="muted">{frame.name} · {screen.items.length}개</span>
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
              onPointerDown={(e) => down(e, it, 'move')} onPointerMove={move} onPointerUp={up}
              onDoubleClick={() => setEditing(it.id)} title={`${WIRE_NAMES[it.kind]} · ${it.w}×${it.h}`}>
              {editing === it.id
                ? <input autoFocus defaultValue={it.label} aria-label="상자 글" onPointerDown={(e) => e.stopPropagation()}
                  onBlur={(e) => { edit((x) => updateWire(x, nodeId, si, it.id, { label: e.target.value })); setEditing(undefined); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(undefined); }} />
                : <span className="wl">{it.label}</span>}
              {sel === it.id && <i className="wsize" aria-label="크기 바꾸기" onPointerDown={(e) => down(e, it, 'size')} onPointerMove={move} onPointerUp={up} />}
            </div>
          ))}
        </div>
      </div>
      <p className="inside-hint muted">끌어서 옮기고 오른쪽 아래 모서리로 크기를 바꿔요 · 두 번 누르면 글 고치기 · Delete나 왼편으로 끌어 내면 지워요 · 화면 이름은 두 번 눌러 고쳐요</p>
    </div>
  );
}
