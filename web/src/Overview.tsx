// 한눈에 보기: 위쪽 지표 줄과, 캔버스 아래 "활성 사용자가 늘면 어디가 먼저 막힐까요?" 그래프
import type { Analysis } from '../../engine/analyze';
import type { Metric } from '../../engine/model';
import type { Project } from '../../engine/schema';
import { healthOf, type Health } from './Canvas';
import { fmt, howMetric } from './format';

const Kpi = ({ label, m, value, unit }: { label: string; m?: Metric; value?: string; unit?: string }) => (
  <div className="kpi" data-tip={m ? howMetric(m) : undefined}>
    <span>{label}</span>
    <b>{value ?? (m ? (m.unit === '비율' ? fmt(m.value * 100) : fmt(m.value)) : '—')}<small>{unit ?? (m ? (m.unit === '비율' ? '%' : m.unit) : '')}</small></b>
  </div>
);

export function KpiStrip({ analysis: a }: { analysis?: Analysis }) {
  const t = a?.traffic;
  const storage = a?.storage?.tablesGb ?? t?.storageGbWithOverhead;
  if (!t) {
    return (
      <section className="kpis">
        <Kpi label="서버 트래픽" value="—" unit="로컬 실행이거나 규모·페르소나가 없음" />
        {a?.localMemory && <Kpi label="로컬 메모리" m={a.localMemory.mb} />}
      </section>
    );
  }
  return (
    <section className="kpis">
      <Kpi label="DAU" m={t.dau} />
      <Kpi label="창 안 접속" m={t.inWindowShare} />
      <Kpi label="피크 RPS" m={t.peakRps} />
      <Kpi label="이벤트 피크 RPS" m={t.peakRpsEvent} />
      <Kpi label={a?.storage?.tablesGb ? '저장(테이블 합계)' : '저장(여유분 포함)'} m={storage} />
      <Kpi label="하루 송신" m={t.egressGbPerDay} />
    </section>
  );
}

const COLOR: Record<Health, string> = { bad: '#ff5a5a', warn: '#f5b301', ok: '#2ec4a6', none: '#6a7486' };
const W = 1100, H = 300, L = 70, R = 20, T = 30, B = 40;

/** 사용자 수에 따라 노드가 한계까지 얼마나 쓰는지. 한계가 있으면 사용자 ÷ 한계(100%에서 막힘), 없으면 지금 사용률에 비례 */
export function LimitChart({ project: p, analysis: a }: { project: Project; analysis?: Analysis }) {
  const users = p.scale?.users;
  if (!a?.traffic || !users) return null;
  const lines = p.nodes.flatMap((n) => {
    const h = healthOf(a, users, n.id);
    const lim = a.nodes[n.id]?.limitUsers?.value;
    const slope = lim ? 1 / lim : h.meter !== undefined ? h.meter / users : undefined;
    return slope ? [{ id: n.id, name: n.name, lim, slope, color: COLOR[h.health] }] : [];
  });
  if (!lines.length) return null;
  const limits = lines.flatMap((l) => (l.lim ? [l.lim] : []));
  const xMax = Math.max(users * 2, (Math.max(0, ...limits) || users * 5) * 1.15);
  const yMax = 1.15;
  const x = (u: number) => L + ((W - L - R) * u) / xMax;
  const y = (v: number) => H - B - ((H - B - T) * v) / yMax;
  const ticks = [0, 1, 2, 3, 4, 5, 6].map((i) => (xMax * i) / 6);
  const short = (u: number) => (u >= 1e6 ? `${fmt(u / 1e6)}M` : `${Math.round(u / 1000)}k`);
  const target = p.target_utilization;
  return (
    <section className="limit-chart">
      <h3>활성 사용자가 늘면 어디가 먼저 막힐까요?<small>가로: 활성 사용자 · 세로: 한계까지 쓴 비율</small></h3>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="활성 사용자에 따른 노드별 한계 비율">
        {[0, 0.5, 1].map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end">{v * 100}%</text></g>)}
        {ticks.map((u) => <text key={u} x={x(u)} y={H - B + 20} textAnchor="middle">{short(u)}</text>)}
        <line x1={L} x2={W - R} y1={y(1)} y2={y(1)} stroke="#ff5a5a" strokeDasharray="6 5" />
        <text x={L + 18} y={y(1) - 8} style={{ fill: "#ff5a5a" }}>한계 100%</text>
        <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} stroke="#2ec4a6" strokeDasharray="2 5" />
        <text x={L + 18} y={y(target) - 8} style={{ fill: "#2ec4a6" }}>목표 사용률 {target}</text>
        <line x1={x(users)} x2={x(users)} y1={T - 10} y2={H - B} stroke="#5f6a7a" strokeDasharray="3 4" />
        <text x={x(users) + 6} y={T - 14} className="now">지금 {fmt(users)}명</text>
        {lines.map((l) => {
          const end = Math.min(xMax, yMax / l.slope);
          return <line key={l.id} x1={x(0)} y1={y(0)} x2={x(end)} y2={y(end * l.slope)} stroke={l.color} strokeWidth={l.lim ? 2.5 : 2} />;
        })}
        {lines.filter((l) => l.lim && l.lim <= xMax).map((l) => (
          <g key={l.id}>
            <circle cx={x(l.lim!)} cy={y(1)} r={6} fill={l.color} />
            <text x={x(l.lim!)} y={y(1) + 22} textAnchor="middle" style={{ fill: l.color }}>{l.name} · {fmt(l.lim!)}명</text>
          </g>
        ))}
      </svg>
    </section>
  );
}
