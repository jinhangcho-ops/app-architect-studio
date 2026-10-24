// 한눈에 보기: 위쪽 지표 줄과, 캔버스 아래 "활성 사용자가 늘면 어디가 먼저 막힐까요?" 그래프 (엔진 식으로 다시 계산한 사용률·p99 곡선)
import { useState } from 'react';
import { perInstance, type Analysis } from '../../engine/analyze';
import { instancesNeeded } from '../../engine/capacity';
import { nodeP99 } from '../../engine/latency';
import type { Metric } from '../../engine/model';
import type { CatalogItem, Project } from '../../engine/schema';
import { healthOf, type Health } from './Canvas';
import { catalog } from './data';
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

export type ChartKind = 'util' | 'p99';
export type Series = { id: string; name: string; color: string; lim?: number; pts: [number, number][] };

/** 사용자 수(xs)마다 엔진과 같은 식으로 다시 계산한 노드별 값 (이벤트 피크 기준).
 *  util = 부하 ÷ (필요 대수 × 대당 처리량): 대수가 늘 때마다 꺾여 내려가고, 최대 대수에 닿으면 가파르게 오른다.
 *  p99 = 대기열(M/M/c) p99 ms: 포화에 가까울수록 휘어 오르고, 포화(ρ ≥ 1)부터는 끝이 없어 선을 멈춘다.
 *  부하는 사용자 수에 비례한다 (성장 타임라인·비용과 같은 가정). 대당 처리량을 모르는 노드는 그릴 수 없어 뺀다 */
export function limitSeries(p: Project, a: Analysis, byId: Map<string, CatalogItem>, xs: number[], kind: ChartKind): Series[] {
  const users = p.scale?.users;
  if (!users) return [];
  return p.nodes.flatMap((n) => {
    const load = a.nodes[n.id]?.load;
    const per = perInstance(n, byId);
    if (!load || !per.rps || (kind === 'p99' && !n.perf)) return [];
    const pts = xs.map((u): [number, number] => {
      const rps = (load.rps.event * u) / users;
      const N = instancesNeeded(rps, per.rps!.value, p.target_utilization, n.min_instances, per.max);
      if (kind === 'util') return [u, N ? rps / (N * per.rps!.value) : 0];
      return [u, nodeP99(rps, n.perf!.service_ms, N * n.perf!.workers, n.perf!.service_p99_ms).value];
    });
    return [{ id: n.id, name: n.name, color: COLOR[healthOf(a, users, n.id).health], lim: a.nodes[n.id]?.limitUsers?.value, pts }];
  });
}

const SAMPLES = 240;

/** 활성 사용자에 따라 노드마다 엔진이 계산한 서버 사용률·p99를 그린다 (탭으로 바꿔 본다) */
export function LimitChart({ project: p, analysis: a }: { project: Project; analysis?: Analysis }) {
  const [kind, setKind] = useState<ChartKind>('util');
  const users = p.scale?.users;
  if (!a?.traffic || !users) return null;
  const limits = p.nodes.flatMap((n) => (a.nodes[n.id]?.limitUsers ? [a.nodes[n.id].limitUsers!.value] : []));
  const xMax = Math.max(users * 2, (Math.max(0, ...limits) || users * 5) * 1.15);
  const xs = Array.from({ length: SAMPLES + 1 }, (_, i) => (xMax * i) / SAMPLES);
  const lines = limitSeries(p, a, catalog.byId, xs, kind);
  const target = p.target_utilization;
  const p99Goal = p.optimize.max_p99_ms;
  // p99 세로축: 목표의 1.3배와 지금 값의 4배 중 큰 쪽 (포화 근처에서 치솟는 부분은 잘라 보인다)
  const nowP99 = Math.max(0, ...lines.map((l) => l.pts.find(([u]) => u >= users)?.[1] ?? 0).filter(Number.isFinite));
  const yMax = kind === 'util' ? 1.15 : Math.max(p99Goal ? p99Goal * 1.3 : 0, nowP99 * 4, 10);
  const x = (u: number) => L + ((W - L - R) * u) / xMax;
  const y = (v: number) => H - B - ((H - B - T) * Math.min(v, yMax * 1.05)) / yMax;
  const ticks = [0, 1, 2, 3, 4, 5, 6].map((i) => (xMax * i) / 6);
  const short = (u: number) => (u >= 1e6 ? `${fmt(u / 1e6)}M` : `${Math.round(u / 1000)}k`);
  const path = (pts: [number, number][]) => {
    // 포화(끝없는 p99)부터는 선을 그리지 않는다
    const end = pts.findIndex(([, v]) => !Number.isFinite(v));
    return (end < 0 ? pts : pts.slice(0, end)).map(([u, v], i) => `${i ? 'L' : 'M'}${x(u).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  };
  const yTicks = kind === 'util' ? [0, 0.5, 1] : [0, yMax / 2, yMax];
  return (
    <section className="limit-chart">
      <h3>
        활성 사용자가 늘면 어디가 먼저 막힐까요?
        <span className="chart-tabs" role="tablist">
          <button role="tab" aria-selected={kind === 'util'} className={kind === 'util' ? 'on' : ''} onClick={() => setKind('util')}>서버 사용률</button>
          <button role="tab" aria-selected={kind === 'p99'} className={kind === 'p99' ? 'on' : ''} onClick={() => setKind('p99')}>응답 지연 p99</button>
        </span>
        <small>{kind === 'util' ? '세로: 이벤트 피크 대당 사용률 · 서버가 늘면 꺾여 내려감 · 점 = 판정이 "안 됨"이 되는 사용자 수' : '세로: 이벤트 피크 p99 · 포화에 가까울수록 휘어 오름 · 점 = 포화가 시작되는 사용자 수'}</small>
      </h3>
      {!lines.length ? <p className="muted">{kind === 'p99' ? '처리 시간(평균 처리 ms·동시 처리 수)을 넣은 노드가 없어 p99를 그릴 수 없어요.' : '대당 처리량을 아는 노드가 없어 사용률을 그릴 수 없어요.'}</p> : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={kind === 'util' ? '활성 사용자에 따른 노드별 서버 사용률' : '활성 사용자에 따른 노드별 p99'}>
          {yTicks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end">{kind === 'util' ? `${v * 100}%` : `${fmt(v)}ms`}</text></g>)}
          {ticks.map((u) => <text key={u} x={x(u)} y={H - B + 20} textAnchor="middle">{short(u)}</text>)}
          {kind === 'util' && <>
            <line x1={L} x2={W - R} y1={y(1)} y2={y(1)} stroke="#ff5a5a" strokeDasharray="6 5" />
            <text x={L + 18} y={y(1) - 8} style={{ fill: '#ff5a5a' }}>한계 100%</text>
            <line x1={L} x2={W - R} y1={y(target)} y2={y(target)} stroke="#2ec4a6" strokeDasharray="2 5" />
            <text x={L + 18} y={y(target) - 8} style={{ fill: '#2ec4a6' }}>목표 사용률 {target}</text>
          </>}
          {kind === 'p99' && p99Goal && <>
            <line x1={L} x2={W - R} y1={y(p99Goal)} y2={y(p99Goal)} stroke="#ff5a5a" strokeDasharray="6 5" />
            <text x={L + 18} y={y(p99Goal) - 8} style={{ fill: '#ff5a5a' }}>p99 목표 {fmt(p99Goal)}ms</text>
          </>}
          <line x1={x(users)} x2={x(users)} y1={T - 10} y2={H - B} stroke="#5f6a7a" strokeDasharray="3 4" />
          <text x={x(users) + 6} y={T - 14} className="now">지금 {fmt(users)}명</text>
          {lines.map((l) => <path key={l.id} d={path(l.pts)} fill="none" stroke={l.color} strokeWidth={2.2} strokeLinejoin="round" />)}
          {lines.map((l) => {
            // 표시: 사용률 = 카탈로그 한계 사용자(판정이 '안 됨'이 되는 곳), p99 = 포화가 시작되는 곳
            const at = kind === 'util' ? l.lim : l.pts.find(([, v]) => !Number.isFinite(v))?.[0];
            if (at === undefined || at > xMax) return null;
            const v = kind === 'util' ? Math.min(1, l.pts.find(([u]) => u >= at)?.[1] ?? 1) : yMax;
            return (
              <g key={l.id}>
                <circle cx={x(at)} cy={y(v)} r={5} fill={l.color} />
                <text x={x(at)} y={y(v) + (kind === 'util' ? 20 : 16)} textAnchor="middle" style={{ fill: l.color }}>{l.name} · {fmt(at)}명{kind === 'p99' ? ' 포화' : ''}</text>
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}
