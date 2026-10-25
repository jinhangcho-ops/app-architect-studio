// 봉우리(정규분포) 여러 개의 합을 끌어서 정하는 그래프. 하루 피크 시각(0~24시, 자정을 넘어 이어짐)과 페르소나 분포(0~1, 칸마다 비율)가 같이 쓴다.
// 봉우리를 좌우로 끌면 가운데, 위아래로 끌면 폭, 양옆 점은 폭. 끄는 동안은 그림만 바꾸고 놓을 때 한 번 저장한다(끌 때마다 다시 계산하지 않게).
import { useRef, useState, type ReactNode } from 'react';
import { Row } from './fields';

export type Bump = { mu: number; sg: number; w: number };

const VX0 = 20, VX1 = 700, BASE = 200, H = 140, MAXPK = 4;
const SQ2PI = Math.sqrt(2 * Math.PI);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function PeakEditor({ peaks, onChange, domain, wrap, sgMin, sgMax, ticks, band, bins, binValues, peakName, width, children }: {
  peaks: Bump[];
  onChange: (peaks: Bump[]) => void;
  /** 가로축 끝값 (하루 24, 페르소나 1) */
  domain: number;
  /** 끝을 넘으면 처음으로 이어짐 (하루: 23시 다음 0시) */
  wrap?: boolean;
  sgMin: number;
  sgMax: number;
  ticks?: { at: number; label: string }[];
  /** 칠해 둘 구간 (하루: 깨어 있는 창). 끝이 시작보다 작으면 자정을 넘는다 */
  band?: [number, number];
  /** 칸 나누기 (페르소나): 이름과 색 */
  bins?: { label: string; color: string }[];
  /** 칸마다 아래에 적을 값 (끄는 중이면 dragging = true) */
  binValues?: (peaks: Bump[], dragging: boolean) => string[];
  peakName: (k: Bump) => string;
  width: (sg: number) => string;
  /** 고른 봉우리 아래에 붙일 칸 */
  children?: (k: Bump, setMu: (mu: number) => void) => ReactNode;
}) {
  const svg = useRef<SVGSVGElement>(null);
  const [draft, setDraft] = useState<Bump[]>();
  const [sel, setSel] = useState(0);
  const ps = draft ?? peaks;
  const at = Math.min(sel, ps.length - 1);
  const k = ps[at];
  const sx = (VX1 - VX0) / domain;
  const total = ps.reduce((s, p) => s + p.w, 0) || 1;
  const one = (u: number, p: Bump) => {
    const z = (d: number) => Math.exp(-0.5 * (d / p.sg) ** 2) / (p.sg * SQ2PI);
    return wrap ? z(u - p.mu) + z(u - p.mu - domain) + z(u - p.mu + domain) : z(u - p.mu);
  };
  const pdf = (u: number, list = ps) => { const t = list.reduce((s, p) => s + p.w, 0) || 1; return list.reduce((s, p) => s + (p.w / t) * one(u, p), 0); };
  // 높이 배율: 저장된 모양(끄기 전)의 가장 높은 곳이 칸의 85%가 되게. 끄는 동안은 바뀌지 않아 위아래 끌기가 폭으로 일정하게 바뀐다
  const K = (H * 0.85) / Math.max(1e-9, ...Array.from({ length: 241 }, (_, i) => pdf((i / 240) * domain, peaks)));
  const ux = (u: number) => VX0 + u * sx;
  const uy = (u: number) => Math.max(BASE - H - 18, BASE - K * pdf(u));
  const samples = (a: number, b: number) => {
    const m = Math.max(2, Math.ceil(((b - a) / domain) * 140));
    return Array.from({ length: m + 1 }, (_, i) => a + ((b - a) * i) / m);
  };
  const line = (us: number[]) => us.map((u, i) => `${i ? 'L' : 'M'}${ux(u).toFixed(1)},${uy(u).toFixed(1)}`).join(' ');

  const toSvg = (e: React.PointerEvent) => {
    const pt = svg.current!.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    return pt.matrixTransform(svg.current!.getScreenCTM()!.inverse());
  };
  const patch = (list: Bump[], i: number, q: Partial<Bump>) => list.map((p, j) => (j === i ? { ...p, ...q } : p));
  /** 끌기: 놓을 때 저장 */
  const drag = (i: number, move: (p: { x: number; y: number }, list: Bump[]) => Partial<Bump>) => ({
    onPointerDown: (e: React.PointerEvent) => { e.preventDefault(); (e.target as Element).setPointerCapture(e.pointerId); setSel(i); setDraft(ps); },
    onPointerMove: (e: React.PointerEvent) => { if (draft) setDraft(patch(draft, i, move(toSvg(e), draft))); },
    // 누르기만 하고 움직이지 않았으면(봉우리 고르기) 저장하지 않는다
    onPointerUp: () => { if (draft && draft !== peaks) onChange(draft); setDraft(undefined); },
    onPointerCancel: () => setDraft(undefined),
  });
  const movePeak = (i: number) => (p: { x: number; y: number }, list: Bump[]) => {
    const mu = clamp((p.x - VX0) / sx, 0, domain);
    const w = list[i].w / list.reduce((s, q) => s + q.w, 0);
    // 이 봉우리 자신의 높이 → 폭 (높을수록 좁다)
    const own = (BASE - p.y) / K - (pdf(mu, list) - w * one(mu, list[i]));
    return own / w > 0.02 ? { mu, sg: clamp(1 / ((own / w) * SQ2PI), sgMin, sgMax) } : { mu };
  };
  const key = (i: number) => (e: React.KeyboardEvent) => {
    const p = ps[i], stepMu = domain / 48, stepSg = (sgMax - sgMin) / 20;
    const q = e.key === 'ArrowLeft' ? { mu: clamp(p.mu - stepMu, 0, domain) } : e.key === 'ArrowRight' ? { mu: clamp(p.mu + stepMu, 0, domain) }
      : e.key === 'ArrowUp' ? { sg: clamp(p.sg - stepSg, sgMin, sgMax) } : e.key === 'ArrowDown' ? { sg: clamp(p.sg + stepSg, sgMin, sgMax) } : undefined;
    if (!q) return;
    e.preventDefault(); setSel(i); onChange(patch(ps, i, q));
  };
  /** 비어 있는 곳(밀도가 가장 낮은 곳)에 새 봉우리 */
  const add = () => {
    const spots = samples(domain / 14, domain - domain / 14);
    const mu = spots.reduce((b, u) => (pdf(u) < pdf(b) ? u : b), spots[0]);
    onChange([...ps.map((p) => ({ ...p, w: p.w * 0.7 })), { mu, sg: (sgMin + sgMax) / 3, w: total * 0.3 }]);
    setSel(ps.length);
  };
  const remove = () => { onChange(ps.filter((_, j) => j !== at)); setSel(0); };
  const setWeight = (pct: number) => {
    const s = clamp(pct / 100, 0.05, 0.95), others = total - k.w;
    onChange(ps.map((p, j) => (j === at ? { ...p, w: s } : { ...p, w: (p.w / others) * (1 - s) })));
  };

  const n = bins?.length ?? 0;
  const values = bins && binValues ? binValues(ps, !!draft) : [];
  const binOf = (mu: number) => clamp(Math.floor((mu / domain) * n), 0, n - 1);
  const bandRects = band && (band[1] > band[0] ? [[band[0], band[1]]] : [[band[0], domain], [0, band[1]]]);
  const bottom = bins ? BASE + 52 : BASE + 26;

  return (
    <div className="peak-editor">
      <div className="pkbar">
        {ps.map((p, i) => (
          <button key={i} className="chip" aria-pressed={i === at} onClick={() => setSel(i)}>
            <span className="n">{i + 1}</span><b>{peakName(p)}</b>{ps.length > 1 && <span className="t">비중 {Math.round((p.w / total) * 100)}%</span>}
          </button>
        ))}
        <button className="add" onClick={add} disabled={ps.length >= MAXPK} title={ps.length >= MAXPK ? '피크는 4개까지 둘 수 있어요' : undefined}>+ 피크 추가</button>
      </div>
      <svg ref={svg} className="pk-svg" viewBox={`0 ${BASE - H - 30} 720 ${bottom - (BASE - H - 30)}`} role="group" aria-label="봉우리 그래프">
        {bandRects?.map(([a, b]) => <rect key={a} className="pk-band" x={ux(a)} y={BASE - H - 22} width={ux(b) - ux(a)} height={H + 22} />)}
        {bins?.map((b, i) => {
          const a0 = (i / n) * domain, a1 = ((i + 1) / n) * domain;
          return <path key={i} d={`M${ux(a0)},${BASE} ${line(samples(a0, a1)).replace('M', 'L')} L${ux(a1)},${BASE} Z`} fill={b.color} opacity={i === binOf(k.mu) ? 0.62 : 0.3} />;
        })}
        {!bins && <path d={`${line(samples(0, domain))} L${ux(domain)},${BASE} L${ux(0)},${BASE} Z`} className="pk-area" />}
        <line x1={VX0} x2={VX1} y1={BASE} y2={BASE} className="pk-axis" />
        <path d={line(samples(0, domain))} className="pk-curve" />
        {ticks?.map((t) => <text key={t.at} x={ux(t.at)} y={BASE + 18} textAnchor="middle">{t.label}</text>)}
        {bins?.map((b, i) => (
          <g key={i}>
            <text x={ux(((i + 0.5) / n) * domain)} y={BASE + 20} textAnchor="middle" className={i === binOf(k.mu) ? 'on' : ''}>{b.label}</text>
            <text x={ux(((i + 0.5) / n) * domain)} y={BASE + 42} textAnchor="middle" className="pct" style={{ fill: b.color }}>{values[i]}</text>
          </g>
        ))}
        <line x1={ux(k.mu)} x2={ux(k.mu)} y1={uy(k.mu)} y2={BASE} className="pk-stem" />
        {([-1, 1] as const).map((d) => {
          const u = clamp(k.mu + d * k.sg, 0, domain);
          return <circle key={d} className="hd side" cx={ux(u)} cy={uy(u)} r={7} tabIndex={0} role="slider" aria-label={`폭 (${d < 0 ? '왼쪽' : '오른쪽'})`} aria-valuetext={width(k.sg)}
            {...drag(at, (p) => ({ sg: clamp(Math.abs((p.x - VX0) / sx - k.mu), sgMin, sgMax) }))} />;
        })}
        {ps.map((p, i) => (
          <g key={i}>
            <circle className={`hd${i === at ? ' on' : ''}`} cx={ux(p.mu)} cy={uy(p.mu)} r={i === at ? 10 : 8} tabIndex={0} role="slider"
              aria-label={`피크 ${i + 1}: 좌우는 가운데, 위아래는 폭`} aria-valuetext={`${peakName(p)}, 폭 ${width(p.sg)}`}
              onKeyDown={key(i)} onFocus={() => setSel(i)} {...drag(i, movePeak(i))} />
            {ps.length > 1 && <text x={ux(p.mu)} y={uy(p.mu) - 16} textAnchor="middle" className="pk-n">{i + 1}</text>}
          </g>
        ))}
      </svg>
      <div className="pk-fields">
        {children?.(k, (mu) => onChange(patch(ps, at, { mu })))}
        <Row label="폭" hint="좁을수록 한곳에 몰려요">
          <span className="sl"><input type="range" min={sgMin} max={sgMax} step={(sgMax - sgMin) / 40} value={k.sg} onChange={(e) => onChange(patch(ps, at, { sg: Number(e.target.value) }))} /><output>{width(k.sg)}</output></span>
        </Row>
        <Row label="피크 비중" hint="봉우리가 여럿일 때 이 피크가 차지하는 몫이에요">
          <span className="sl"><input type="range" min={5} max={95} step={5} disabled={ps.length < 2} value={ps.length < 2 ? 95 : Math.round((k.w / total) * 100)} onChange={(e) => setWeight(Number(e.target.value))} /><output>{Math.round((k.w / total) * 100)}%</output></span>
        </Row>
        <div className="inline"><button onClick={remove} disabled={ps.length < 2}>이 피크 삭제</button></div>
      </div>
    </div>
  );
}
