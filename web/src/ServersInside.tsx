// 세부 구성 (서버 구성): 들어오는 곳 → 분배 방식 → 서버 N대(대마다 사용률) → 나가는 곳.
// 아래에서 최소 대수(−/+)와 방식(같은 종류의 다른 항목)을 바꾸면 엔진이 대수·사용률·비용·판정을 다시 계산한다.
import { useEffect, useRef, useState } from 'react';
import { perInstance, type Analysis } from '../../engine/analyze';
import { LAYER_NAMES, type Layer } from '../../engine/model';
import type { CatalogItem, Project } from '../../engine/schema';
import { catalog } from './data';
import { updateNode } from './edit';
import { fmt } from './format';
import { Select } from './Select';
import { useStore } from './store';

/** 레이어마다 "서버"를 부르는 말 */
const UNIT: Record<Layer, { name: string; unit: string; route: string }> = {
  ui: { name: '화면', unit: '개', route: '접속' },
  gateway: { name: '게이트웨이 서버', unit: '대', route: '분산 방식' },
  backend: { name: '서버', unit: '대', route: '요청 분배' },
  cache: { name: '캐시 노드', unit: '개', route: '키 분배' },
  queue: { name: '브로커', unit: '대', route: '파티션 분배' },
  batch: { name: '워커', unit: '대', route: '가져오기' },
  db: { name: 'DB 서버', unit: '대', route: '쓰기 경로' },
  external: { name: '연결', unit: '개', route: '호출' },
  analytics: { name: '노드', unit: '개', route: '처리 방식' },
};

export type ServerLayout = {
  name: string; unit: string; route: string;
  /** 이벤트 피크에 떠 있는 대수 (계산값) 또는 이중화 대수 */
  count: number;
  /** 대마다 이벤트 피크 사용률 (대당 처리량을 모르면 없음) */
  util?: number;
  /** −/+로 바꾸는 값: 처리량을 알면 최소 대수, 모르면 이중화 대수 */
  knob: 'min_instances' | 'replicas';
  knobValue: number;
  max: number;
  limitUsers?: number;
  inbound: string[];
  outbound: string[];
  /** 같은 종류로 바꿀 수 있는 주 항목 */
  methods: CatalogItem[];
};

export function serverLayout(p: Project, a: Analysis | undefined, byId: Map<string, CatalogItem>, id: string): ServerLayout {
  const n = p.nodes.find((x) => x.id === id)!;
  const na = a?.nodes[id];
  const per = perInstance(n, byId);
  const kind = n.primary ? byId.get(n.primary)?.kind : undefined;
  const name = (nid: string) => p.nodes.find((x) => x.id === nid)?.name ?? nid;
  const u = UNIT[n.layer];
  const knob = per.rps ? 'min_instances' : 'replicas';
  return {
    ...u,
    count: na?.instances?.event.value ?? n.replicas,
    util: na?.utilization?.event.value,
    knob,
    knobValue: knob === 'min_instances' ? n.min_instances : n.replicas,
    max: Number.isFinite(per.max) ? per.max : 50,
    limitUsers: na?.limitUsers?.value,
    inbound: p.edges.filter((e) => e.to === id).map((e) => name(e.from)),
    outbound: p.edges.filter((e) => e.from === id).map((e) => name(e.to)),
    methods: catalog.items.filter((i) => i.role === '주' && i.attaches_to.includes(n.layer) && (!kind || i.kind === kind)),
  };
}

const SHOW = 8;
const W = 840, H = 380;

export function ServersInside({ nodeId, analysis }: { nodeId: string; analysis?: Analysis }) {
  const { project: p, edit } = useStore();
  const n = p.nodes.find((x) => x.id === nodeId)!;
  const s = serverLayout(p, analysis, catalog.byId, nodeId);
  const target = p.target_utilization;
  const over = s.util !== undefined && s.util > target;
  const col = s.util === undefined ? '#5f6c7e' : s.util > target ? '#ff5a5a' : s.util > target * 0.7 ? '#f5b301' : '#2ec4a6';

  // 무대(840×380)를 칸에 맞춰 줄인다 (키우지는 않음)
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState('');
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const k = Math.min(1, (el.clientWidth - 8) / W, (el.clientHeight - 8) / H);
      setFit(`translate(${Math.max(0, (el.clientWidth - W * k) / 2)}px, ${Math.max(4, (el.clientHeight - H * k) / 2)}px) scale(${k})`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const shown = Math.min(s.count, SHOW);
  const more = s.count - shown + (s.count > SHOW ? 1 : 0);
  const boxes = s.count > SHOW ? SHOW - 1 : shown;
  const rows = boxes + (s.count > SHOW ? 1 : 0);
  const bh = rows > 6 ? 36 : 48, gap = 8, tot = rows * bh + (rows - 1) * gap, y0 = (H - tot) / 2, mid = H / 2;
  const setKnob = (v: number) => edit((x) => updateNode(x, nodeId, { [s.knob]: Math.max(s.knob === 'replicas' ? 1 : 0, Math.min(s.max, v)) }));
  const item = n.primary ? catalog.byId.get(n.primary) : undefined;

  return (
    <div className="servers">
      <div className="dwrap" ref={wrap}>
        <div className="dstage" style={{ transform: fit }}>
          <svg viewBox={`0 0 ${W} ${H}`} aria-hidden>
            <defs><marker id="da" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto"><path d="M0,0L10,5L0,10z" fill="#6a7a94" /></marker></defs>
            <line x1="168" y1={mid} x2="204" y2={mid} stroke="#53627b" strokeWidth="3" markerEnd="url(#da)" />
            {Array.from({ length: rows }, (_, i) => {
              const cy = y0 + i * (bh + gap) + bh / 2;
              return (
                <g key={i}>
                  <path d={`M358 ${mid} C 392 ${mid}, 388 ${cy}, 418 ${cy}`} stroke="#53627b" strokeWidth="2" fill="none" markerEnd="url(#da)" />
                  <path d={`M592 ${cy} C 626 ${cy}, 622 ${mid}, 656 ${mid}`} stroke="#53627b" strokeWidth="2" fill="none" markerEnd="url(#da)" />
                </g>
              );
            })}
          </svg>
          <div className="dbox" style={{ left: 16, top: mid - 36, width: 150, height: 72 }}><small>들어오는 곳</small><b>{s.inbound.join(' · ') || '—'}</b></div>
          <div className="dbox router" style={{ left: 206, top: mid - 36, width: 150, height: 72 }}><small>{s.route}</small><b>{item?.name ?? '항목 없음'}</b></div>
          {Array.from({ length: boxes }, (_, i) => (
            <div key={i} className="dinst" style={{ left: 420, top: y0 + i * (bh + gap), width: 170, height: bh, borderLeftColor: col }}>
              <b>{s.name} {i + 1}</b>
              {s.util !== undefined && <div className="meter"><div className="track"><i style={{ width: `${Math.min(100, s.util * 100)}%`, background: col }} /></div>{Math.round(s.util * 100)}%</div>}
            </div>
          ))}
          {s.count > SHOW && <div className="dinst more" style={{ left: 420, top: y0 + boxes * (bh + gap), width: 170, height: bh }}><b>+{more}{s.unit} 더</b></div>}
          <div className="dbox" style={{ left: 658, top: mid - 36, width: 166, height: 72 }}><small>나가는 곳</small><b>{s.outbound.join(' · ') || '—'}</b></div>
        </div>
      </div>

      <div className="dctl">
        <div className="ctl">
          <span>{s.knob === 'min_instances' ? `최소 ${s.name} 수` : `이중화 ${s.name} 수`}</span>
          <div className="step">
            <button aria-label="줄이기" disabled={s.knobValue <= (s.knob === 'replicas' ? 1 : 0)} onClick={() => setKnob(s.knobValue - 1)}>−</button>
            <output>{s.knobValue}{s.unit}</output>
            <button aria-label="늘리기" disabled={s.knobValue >= s.max} onClick={() => setKnob(s.knobValue + 1)}>+</button>
          </div>
        </div>
        {s.methods.length > 1 && (
          <div className="ctl">
            <span>{s.route}</span>
            <Select value={n.primary ?? ''} onChange={(e) => edit((x) => updateNode(x, nodeId, { primary: e.target.value }))} aria-label={s.route}>
              {s.methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </Select>
          </div>
        )}
        <div className="res">
          <div><span>떠 있는 {s.name} (이벤트 피크)</span><b>{s.count}{s.unit}</b></div>
          <div><span>사용률 (이벤트 피크)</span><b className={s.util === undefined ? '' : over ? 'over' : 'okc'}>{s.util === undefined ? '—' : `${Math.round(s.util * 100)}%`}</b></div>
          <div><span>한계 사용자</span><b>{s.limitUsers ? `약 ${fmt(s.limitUsers)}명` : '—'}</b></div>
          <div><span>목표 사용률 {target}</span><b className={s.util === undefined ? '' : over ? 'over' : 'okc'}>{s.util === undefined ? '대당 처리량 모름' : over ? '넘었어요' : '안쪽이에요'}</b></div>
        </div>
      </div>
      {s.max < 50 && s.knobValue >= s.max && <p className="dnote">이 방식은 최대 {s.max}{s.unit}까지예요. 더 늘리려면 방식을 바꾸세요.</p>}
      {!analysis?.nodes[nodeId]?.load && <p className="dnote">{LAYER_NAMES[n.layer]} 노드로 들어오는 요청이 없어 사용률을 계산하지 않아요.</p>}
    </div>
  );
}
