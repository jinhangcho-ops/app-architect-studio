// 화면 블록의 와이어프레임 (UI/UX 설계): 왼편에서 영역·컨트롤을 끌어 화면 틀에 놓고, 끌어서 옮기고, 오른쪽 아래 모서리로 크기를 바꾼다.
// 두 번 누르면 글을 고치고, Delete나 왼편으로 끌어 내면 지운다. 화면은 여러 장 둘 수 있다.
// 컨트롤에 API 호출(메서드·경로·받는 블록·접속당 횟수)을 붙이면 연결선이 생기고, 화면에서 나가는 부하가 호출 비율대로 나뉜다.
import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { Analysis } from '../../engine/analyze';
import { routedCalls } from '../../engine/api';
import { LAYER_NAMES } from '../../engine/model';
import { HTTP_METHODS, WIRE_COLORS, WIRE_DEVICES, type Screen, type WireItem } from '../../engine/schema';
import { addScreen, addWire, bindApi, dropRemove, mapScreens, patchAt, screensOf, updateWire } from './edit';
import { NumInput } from './fields';
import { fmt } from './format';
import { htmlToScreen } from './htmlImport';
import { paginate, renderHtml } from './htmlRender';
import { markDrag, overPalette, readDrag, WIRE_NAMES } from './Palette';
import { Select } from './Select';
import { usePick } from './store';
import { COLORS, DEVICE_NAMES, DEVICES, deviceOf, drawOrder, fitItem, lineEnds, NO_LABEL, savePngs, screenFrame, SHAPES, toDevice, type Frame } from './wireDraw';

const GRID = 8;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** 놓을 때 기본 크기 (데스크톱 틀 기준, 좁은 틀에서는 틀 너비로 줄인다) */
const SIZE: Record<WireItem['kind'], [number, number]> = {
  header: [1280, 64], nav: [1280, 44], sidebar: [240, 600], main: [800, 520], form: [400, 320], table: [640, 280], list: [360, 320], card: [280, 180],
  modal: [480, 320], footer: [1280, 56], text: [240, 28], image: [240, 160], button: [120, 40], input: [280, 40], select: [200, 40], tabs: [400, 40],
  rect: [200, 120], ellipse: [120, 120], line: [200, 16], arrow: [200, 16], icon: [32, 32], avatar: [48, 48], checkbox: [160, 28], radio: [160, 28], toggle: [160, 28],
};

/** 도형은 SVG로 그린다 (좌표는 상자 안 px, 틀 배율은 바깥 상자가 맞춘다) */
function ShapeSvg({ it }: { it: WireItem }) {
  const { w, h, kind } = it;
  const col = it.color ? COLORS[it.color] : undefined;
  const stroke = col?.stroke ?? '#6b7584', fill = col?.fill ?? '#ffffff';
  const s = Math.min(16, h - 4);
  let body;
  if (kind === 'ellipse') body = <ellipse cx={w / 2} cy={h / 2} rx={w / 2 - 1} ry={h / 2 - 1} fill={fill} stroke={stroke} strokeWidth={1.5} />;
  else if (kind === 'line' || kind === 'arrow') {
    const { x1, y1, x2, y2 } = lineEnds({ x: 0, y: 0, w, h });
    const a = Math.atan2(y2 - y1, x2 - x1), r = 10;
    body = <>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={stroke} strokeWidth={2} />
      {kind === 'arrow' && <polygon fill={stroke} points={`${x2},${y2} ${x2 - r * Math.cos(a - 0.45)},${y2 - r * Math.sin(a - 0.45)} ${x2 - r * Math.cos(a + 0.45)},${y2 - r * Math.sin(a + 0.45)}`} />}
    </>;
  } else if (kind === 'icon') {
    const cx = w / 2, cy = h / 2, rr = Math.min(w, h) / 2 - 2;
    const pts = Array.from({ length: 10 }, (_, i) => { const q = i % 2 ? rr * 0.45 : rr, ang = -Math.PI / 2 + (i * Math.PI) / 5; return `${cx + q * Math.cos(ang)},${cy + q * Math.sin(ang)}`; }).join(' ');
    body = <polygon points={pts} fill={col?.fill ?? '#e3e7ee'} stroke={stroke} strokeWidth={1.5} />;
  } else if (kind === 'avatar') body = <circle cx={w / 2} cy={h / 2} r={Math.min(w, h) / 2 - 1} fill={col?.fill ?? '#e3e7ee'} stroke={stroke} strokeWidth={1.5} />;
  else if (kind === 'checkbox') body = <rect x={2} y={h / 2 - s / 2} width={s} height={s} fill="#fff" stroke={stroke} strokeWidth={1.5} />;
  else if (kind === 'radio') body = <circle cx={2 + s / 2} cy={h / 2} r={s / 2} fill="#fff" stroke={stroke} strokeWidth={1.5} />;
  else body = <><rect x={2} y={h / 2 - s / 2} width={s * 2} height={s} rx={s / 2} fill={col?.stroke ?? '#2b5fd9'} /><circle cx={2 + s * 1.5} cy={h / 2} r={s / 2 - 2} fill="#fff" /></>;
  return <svg className="wshape" viewBox={`0 0 ${w} ${h}`} aria-hidden>{body}</svg>;
}

type Live = { id: string; mode: 'move' | 'size'; sx: number; sy: number; o: WireItem; now: WireItem };


/** 탭 아이콘: 기기 모양 (데스크톱·태블릿·모바일) */
function DeviceIcon({ d }: { d: NonNullable<Screen['device']> }) {
  return (
    <svg className="wtab-ico" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth={1.4}>
      {d === 'desktop' && <><rect x="1.5" y="2.5" width="13" height="8.5" rx="1.2" /><path d="M6 14h4M8 11v3" /></>}
      {d === 'tablet' && <><rect x="3" y="1.5" width="10" height="13" rx="1.5" /><path d="M7 12.5h2" /></>}
      {d === 'tablet_land' && <><rect x="1.5" y="3" width="13" height="10" rx="1.5" /><path d="M12.5 7v2" /></>}
      {d === 'mobile' && <><rect x="4.5" y="1.5" width="7" height="13" rx="1.5" /><path d="M7.2 12.5h1.6" /></>}
    </svg>
  );
}

type Sel = { s: number; id: string };

/** 화면 틀 한 장: 상자 놓기·옮기기·크기 바꾸기·글 고치기. 나란히 보기에서는 두 장이 각각 이것을 쓴다 */
function FrameView({ nodeId, s, screen, frame, k, left, top, caption, active, sel, setSel, editing, setEditing, nameOf, onActivate }: {
  nodeId: string; s: number; screen: Screen; frame: Frame; k: number; left: number; top: number; caption?: string; active: boolean;
  sel?: Sel; setSel: (x?: Sel) => void; editing?: string; setEditing: (x?: string) => void; nameOf: (id?: string) => string; onActivate: () => void;
}) {
  const { edit } = usePick('edit');
  const [live, setLive] = useState<Live>();
  const key = (id: string) => `${s}:${id}`;
  const isSel = (id: string) => sel?.s === s && sel.id === id;
  const remove = (id: string) => { edit((x) => dropRemove(x, nodeId, { kind: 'remove', what: 'wire', screen: s, id })); setSel(undefined); };
  const down = (e: RPointerEvent, it: WireItem, mode: Live['mode']) => {
    if (e.button !== 0 || editing === key(it.id)) return;
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel({ s, id: it.id });
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
    if (now.x !== o.x || now.y !== o.y || now.w !== o.w || now.h !== o.h) edit((x) => updateWire(x, nodeId, s, id, { x: now.x, y: now.y, w: now.w, h: now.h }));
  };
  /** 터치·창 전환으로 끌기가 취소되면 옮기지 않고 끝낸다 */
  const cancel = () => { setLive(undefined); markDrag(); };

  // 큰 상자(영역)를 먼저 그려 작은 상자(컨트롤)가 위에 오게 한다
  const items = drawOrder(screen.items.map((it) => (live?.id === it.id ? live.now : fitItem(it, frame))));
  return <>
    {caption && <button className={`wcap ${active ? 'on' : ''}`} style={{ left, top: top - 22, maxWidth: frame.w * k }} onClick={onActivate} title="이 화면을 기준으로 (기기·PNG·복사)">{caption}</button>}
    <div className={`wframe ${active ? 'active' : ''}`} style={{ left, top, width: frame.w * k, height: frame.h * k, fontSize: 12 * k }}
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
        edit((pp) => addWire(pp, nodeId, s, { kind: d.ui, label: WIRE_NAMES[d.ui], x, y, w, h }));
      }}>
      {!items.length && <p className="wempty muted">왼편에서 헤더·버튼 같은 상자를 끌어 여기에 놓으세요</p>}
      {items.map((it) => (
        <div key={it.id} className={`wi wi-${it.kind} ${isSel(it.id) ? 'sel' : ''} ${it.api ? 'has-api' : ''} ${it.color ? `c-${it.color}` : ''}`}
          style={{ left: it.x * k, top: it.y * k, width: it.w * k, height: it.h * k, ...(it.color && !SHAPES.has(it.kind) && { background: COLORS[it.color].fill, borderColor: COLORS[it.color].stroke }) }}
          onPointerDown={(e) => down(e, it, 'move')} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel}
          onDoubleClick={() => setEditing(key(it.id))} title={`${WIRE_NAMES[it.kind]} · ${it.w}×${it.h}`}>
          {editing === key(it.id)
            ? <input autoFocus defaultValue={it.label} aria-label="상자 글" onPointerDown={(e) => e.stopPropagation()}
              onBlur={(e) => { edit((x) => updateWire(x, nodeId, s, it.id, { label: e.target.value })); setEditing(undefined); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(undefined); }} />
            : !NO_LABEL.has(it.kind) && <span className="wl" style={it.color && it.color !== 'dark' ? { color: COLORS[it.color].stroke } : undefined}>{it.kind === 'avatar' ? it.label.slice(0, 1) : it.label}</span>}
          {SHAPES.has(it.kind) && <ShapeSvg it={it} />}
          {it.api && <span className={`wapi ${it.api.to ? '' : 'none'}`}>{it.api.method}{it.api.to ? ` → ${nameOf(it.api.to)}` : ' (받는 블록 없음)'}</span>}
          {isSel(it.id) && <i className="wsize" aria-label="크기 바꾸기" onPointerDown={(e) => down(e, it, 'size')} onPointerMove={move} onPointerUp={up} onPointerCancel={cancel} />}
        </div>
      ))}
    </div>
  </>;
}

const GAP = 24, CAP = 22;

export function WireframeInside({ nodeId, analysis }: { nodeId: string; analysis?: Analysis }) {
  const { project: p, edit } = usePick('project', 'edit');
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const screens = screensOf(n);
  const [cur, setCur] = useState(0);
  const si = Math.min(cur, screens.length - 1);
  const screen = screens[si];
  // 나란히 볼 다른 화면 (없거나 지워졌으면 한 장만)
  const [pairWant, setPair] = useState<number>();
  const pair = pairWant !== undefined && pairWant !== si && pairWant < screens.length ? pairWant : undefined;
  const shown = pair === undefined ? [si] : [si, pair].sort((a, b) => a - b);
  const [sel, setSel] = useState<Sel>();
  const [editing, setEditing] = useState<string>();
  const device = deviceOf(screen, p.deploy.mode);
  const frame = DEVICES[device];
  const frames = shown.map((i) => screenFrame(screens[i], p.deploy.mode));
  const setDevice = (d: NonNullable<Screen['device']>) => edit((x) => mapScreens(x, nodeId, (ss) => patchAt(ss, si, { device: d })));
  const fileRef = useRef<HTMLInputElement>(null);
  const ps = sel && sel.s < screens.length ? sel.s : si;
  const picked = sel ? screens[ps]?.items.find((x) => x.id === sel.id) : undefined;
  const targets = p.nodes.filter((x) => x.id !== nodeId && x.layer !== 'ui');
  const nameOf = (id?: string) => p.nodes.find((x) => x.id === id)?.name ?? '—';
  // 호출은 있는데 연결선이 없는 대상, 연결선은 있는데 호출이 없는 대상 (호출이 하나라도 있으면 그 블록으로 부하가 안 간다)
  const routed = routedCalls(p, n);
  const allCalls = screens.flatMap((s) => s.items.filter((i) => i.api?.to).map((i) => ({ s: s.name, i })));
  const unrouted = allCalls.filter(({ i }) => !routed.some((c) => c.item === i.id && c.to === i.api!.to));
  const idle = routed.length ? p.edges.filter((e) => e.from === nodeId && !routed.some((c) => c.to === e.to)).map((e) => nameOf(e.to)) : [];
  const loads = analysis?.api.filter((c) => c.node === nodeId) ?? [];

  // 틀(한 장 또는 두 장)을 칸에 맞춰 줄인다. 두 장이면 같은 배율로 나란히, 위에 화면 이름
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ k: 1, lefts: [0], top: 0 });
  const dims = frames.map((f) => `${f.w}x${f.h}`).join(',');
  useEffect(() => {
    const el = wrap.current!;
    const update = () => {
      const cap = frames.length > 1 ? CAP : 0;
      const sumW = frames.reduce((a, f) => a + f.w, 0), maxH = Math.max(...frames.map((f) => f.h));
      const k = Math.min(1, (el.clientWidth - 32 - GAP * (frames.length - 1)) / sumW, (el.clientHeight - 32 - cap) / maxH);
      let x = (el.clientWidth - sumW * k - GAP * (frames.length - 1)) / 2;
      const lefts = frames.map((f) => { const l = x; x += f.w * k + GAP; return l; });
      setFit({ k, lefts, top: (el.clientHeight - maxH * k - cap) / 2 + cap });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
    // 틀 크기(dims)가 바뀔 때만 다시 잰다
  }, [dims]);

  return (
    <div className="wire">
      <div className="wtabbar" role="tablist" aria-label="화면">
        {screens.map((s, i) => (
          <div key={i} role="tab" aria-selected={i === si} className={`wtab ${i === si ? 'on' : ''} ${i === pair ? 'pair' : ''}`} onClick={() => setCur(i)}
            title={`${s.name} · ${screenFrame(s, p.deploy.mode).name}${i === pair ? ' · 나란히 보는 중' : ''} (두 번 누르면 이름 고치기)`}>
            <DeviceIcon d={deviceOf(s, p.deploy.mode)} />
            {editing === `screen:${i}`
              ? <input autoFocus defaultValue={s.name} aria-label="화면 이름" onClick={(e) => e.stopPropagation()} onBlur={(e) => { const v = e.target.value.trim(); if (v && !screens.some((y, j) => j !== i && y.name === v)) edit((x) => mapScreens(x, nodeId, (ss) => patchAt(ss, i, { name: v }))); setEditing(undefined); }}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(undefined); }} />
              : <span className="name" onDoubleClick={() => setEditing(`screen:${i}`)}>{s.name}</span>}
            {screens.length > 1 && <button className="x" aria-label={`${s.name} 지우기`} onClick={(e) => { e.stopPropagation(); edit((x) => mapScreens(x, nodeId, (ss) => ss.filter((_, j) => j !== i))); setCur(0); setPair(undefined); setSel(undefined); }}>×</button>}
          </div>
        ))}
        <button className="wtab-add" aria-label="화면 더하기" title="화면 더하기 (지금 기기)" onClick={() => { edit((x) => addScreen(x, nodeId, device)); setCur(screens.length); }}>+</button>
      </div>
      <div className="inside-bar">
        <Select aria-label="기기" value={device} onChange={(e) => setDevice(e.target.value as typeof device)}>
          {WIRE_DEVICES.map((d) => <option key={d} value={d}>{DEVICES[d].name}</option>)}
        </Select>
        <Select aria-label="다른 기기로 복사" value="" onChange={(e) => {
          const d = e.target.value as typeof device;
          if (!d) return;
          edit((x) => addScreen(x, nodeId, d, toDevice(screen, frame, DEVICES[d], d, `${screen.name} (${DEVICE_NAMES[d]})`)));
          // 복사한 화면을 원래 화면 옆에 나란히 보여 준다
          setPair(si);
          setCur(screens.length);
        }}>
          <option value="">다른 기기로 복사</option>
          {WIRE_DEVICES.filter((d) => d !== device).map((d) => <option key={d} value={d}>{DEVICE_NAMES[d]}용으로 복사</option>)}
        </Select>
        {screens.length > 1 && <Select aria-label="나란히 보기" value={pair === undefined ? '' : String(pair)} onChange={(e) => setPair(e.target.value === '' ? undefined : Number(e.target.value))}>
          <option value="">한 장만 보기</option>
          {screens.map((s, i) => (i === si ? null : <option key={i} value={String(i)}>나란히: {s.name} ({DEVICE_NAMES[deviceOf(s, p.deploy.mode)]})</option>))}
        </Select>}
        <button onClick={() => fileRef.current?.click()} title="HTML 파일을 지금 기기 너비로 그려 요소마다 상자로 가져옵니다. CSS 파일을 함께 고르면 그 모양대로 배치합니다">HTML 가져오기</button>
        <input ref={fileRef} type="file" accept=".html,.htm,.css" multiple hidden onChange={async (e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = '';
          const html = files.find((x) => /\.html?$/i.test(x.name));
          if (!html) return;
          const css = Object.fromEntries(await Promise.all(files.filter((x) => /\.css$/i.test(x.name)).map(async (x) => [x.name, await x.text()] as const)));
          const text = await html.text();
          const base = html.name.replace(/\.html?$/i, '');
          // 실제로 그려 자리를 읽고, 그릴 수 없으면 영역 규칙으로 배치한다. 둘 다 틀보다 길면 여러 장으로 (틀 밖 요소와 그 API를 버리지 않게)
          const entries = await renderHtml(text, frame, css);
          const fallback = entries ? undefined : htmlToScreen(text, frame, base);
          const pages = paginate(entries ?? fallback!.items, frame, fallback?.name ?? base);
          // 빈 화면 한 장뿐이면 그 자리를 바꾸고, 아니면 지금 기기로 이어 붙인다 (이름은 겹치지 않게)
          const replace = screens.length === 1 && !screen.items.length;
          edit((x) => pages.reduce((acc, sc) => addScreen(acc, nodeId, device, sc), replace ? mapScreens(x, nodeId, () => []) : x));
          setPair(undefined);
          setCur(replace ? 0 : screens.length);
        }} />
        <button onClick={() => savePngs([{ screen, name: `${n.name}-${screen.name}` }], p.deploy.mode)}>PNG 저장</button>
        {screens.length > 1 && <button onClick={() => savePngs(screens.map((s) => ({ screen: s, name: `${n.name}-${s.name}` })), p.deploy.mode)}>모든 화면 PNG</button>}
      </div>
      <div className="wwrap" ref={wrap} tabIndex={0}
        onKeyDown={(e) => { if (picked && !editing && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); edit((x) => dropRemove(x, nodeId, { kind: 'remove', what: 'wire', screen: ps, id: picked.id })); setSel(undefined); } }}
        onPointerDown={() => setSel(undefined)}>
        {shown.map((s, j) => (
          <FrameView key={s} nodeId={nodeId} s={s} screen={screens[s]} frame={frames[j]} k={fit.k} left={fit.lefts[j] ?? 0} top={fit.top}
            caption={shown.length > 1 ? `${screens[s].name} · ${frames[j].name}` : undefined} active={shown.length > 1 && s === si}
            sel={sel} setSel={setSel} editing={editing} setEditing={setEditing} nameOf={nameOf}
            onActivate={() => { if (s !== si) { setPair(si); setCur(s); } }} />
        ))}
      </div>
      <div className="winspect">
        {picked ? <>
          <b>{WIRE_NAMES[picked.kind]}</b>
          {shown.length > 1 && <span className="muted">{screens[ps].name}</span>}
          <label>표시 글 <input value={picked.label} onChange={(e) => edit((x) => updateWire(x, nodeId, ps, picked.id, { label: e.target.value }))} /></label>
          <span className="wcolors" role="group" aria-label="색">
            <button className={!picked.color ? 'on' : ''} title="기본 색" onClick={() => edit((x) => updateWire(x, nodeId, ps, picked.id, { color: undefined }))}>기본</button>
            {WIRE_COLORS.map((c) => <button key={c} className={picked.color === c ? 'on' : ''} title={COLORS[c].name} aria-label={COLORS[c].name} style={{ background: COLORS[c].fill, borderColor: COLORS[c].stroke }}
              onClick={() => edit((x) => updateWire(x, nodeId, ps, picked.id, { color: c }))} />)}
          </span>
          {picked.api ? <>
            <Select aria-label="메서드" value={picked.api.method} onChange={(e) => edit((x) => bindApi(x, nodeId, ps, picked.id, { ...picked.api!, method: e.target.value as typeof HTTP_METHODS[number] }))}>
              {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
            </Select>
            <input aria-label="경로" placeholder="/api/orders" value={picked.api.path} onChange={(e) => edit((x) => bindApi(x, nodeId, ps, picked.id, { ...picked.api!, path: e.target.value }))} />
            <Select aria-label="받는 블록" value={picked.api.to ?? ''} onChange={(e) => edit((x) => bindApi(x, nodeId, ps, picked.id, { ...picked.api!, to: e.target.value || undefined }))}>
              <option value="">받는 블록 고르기</option>
              {targets.map((t) => <option key={t.id} value={t.id}>{t.name} ({LAYER_NAMES[t.layer]})</option>)}
            </Select>
            <label title="접속 1회에 이 호출을 부르는 평균 횟수. 화면의 요청을 호출끼리 이 비율로 나눕니다">접속당 <NumInput min={0} step={0.1} value={picked.api.per_session} onChange={(e) => edit((x) => bindApi(x, nodeId, ps, picked.id, { ...picked.api!, per_session: Math.max(0, Number(e.target.value) || 0) }))} />회</label>
            <button onClick={() => edit((x) => bindApi(x, nodeId, ps, picked.id, undefined))}>API 빼기</button>
          </> : <button onClick={() => edit((x) => bindApi(x, nodeId, ps, picked.id, { method: picked.kind === 'form' || picked.kind === 'button' ? 'POST' : 'GET', path: '', per_session: 1 }))}>+ API 호출 붙이기</button>}
        </> : <>
          <b>API 호출</b>
          {loads.length ? loads.map((c) => (
            <span key={c.screen + c.item} className="wcall" title={c.rps.formula}>{c.screen} · {c.label} <code>{c.method} {c.path || '/'}</code> → {nameOf(c.to)} <b>{fmt(c.rps.value)}</b> / 이벤트 {fmt(c.rpsEvent.value)} RPS</span>
          )) : <span className="muted">상자를 고르고 "API 호출 붙이기"를 누르면, 그 호출이 받는 블록으로 연결선이 생기고 부하가 호출 비율대로 나뉘어요.</span>}
        </>}
        {unrouted.length > 0 && <span className="warn">연결선이 지워져 계산에서 빠진 호출: {unrouted.map(({ s, i }) => `${s}·${i.label}`).join(', ')}</span>}
        {idle.length > 0 && <span className="warn">호출이 없어 이 화면에서 부하를 받지 않는 연결: {idle.join(', ')}</span>}
      </div>
      <p className="inside-hint muted">끌어서 옮기고 오른쪽 아래 모서리로 크기를 바꿔요 · 두 번 누르면 글 고치기 · Delete나 왼편으로 끌어 내면 지워요 · 나란히 볼 때 화면 이름을 누르면 그 화면이 기준이 돼요</p>
    </div>
  );
}
