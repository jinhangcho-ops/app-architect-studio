// 한눈에 보기: 위쪽 지표 줄과, 캔버스 아래 "활성 사용자가 늘면 어디가 먼저 막힐까요?" 그래프 (엔진 식으로 다시 계산한 사용률·p99 곡선)
import { useMemo, useState } from 'react';
import { perInstance, primaryShape, sizeAt, type Analysis } from '../../engine/analyze';
import { dayLabel } from '../../engine/industry';
import { dayCurve } from '../../engine/traffic';
import type { Metric } from '../../engine/model';
import type { CatalogItem, Project } from '../../engine/schema';
import { healthOf, type Health } from './Canvas';
import { catalog } from './data';
import { trafficKey } from './edit';
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

export type ChartKind = 'traffic' | 'util' | 'inflow' | 'stages' | 'p99';
export type Series = { id: string; name: string; color: string; lim?: number; pts: [number, number][] };

const STEP_MIN = 5;
/** 5분 칸 값 → (시각, 값) 점. 칸 가운데에 둔다 */
const dayPts = (vals: number[]): [number, number][] => vals.map((v, j) => [((j + 0.5) * STEP_MIN) / 60, v]);

/** 하루 시간대별 노드 사용률 (5분 칸): 평소 피크에 맞춘 대수를 그대로 두고, 페르소나 기대 트래픽이 시간마다 만드는 부하로 나눈다.
 *  노드 부하는 화면에서 연결선을 따라 같은 비율로 퍼지므로 노드 몫 = 노드 평소 피크 ÷ 전체 평소 피크 (비용 계산과 같은 가정) */
export function dayUtilization(p: Project, a: Analysis, total: number[]): Series[] {
  const t = a.traffic;
  if (!t || !t.peakRps.value || !p.scale) return [];
  return p.nodes.flatMap((n) => {
    const na = a.nodes[n.id], util = na?.utilization?.normal.value, N = na?.instances?.normal.value;
    if (!na?.load || util === undefined || !N) return [];
    // 엔진의 피크 사용률을 트래픽 곡선 비율로 줄인다 (주 서버 DB·대기 서버처럼 대수로 나누면 틀리는 노드도 맞게)
    return [{ id: n.id, name: `${n.name} (${N}대)`, color: COLOR[healthOf(a, p.scale!.users, n.id).health], pts: dayPts(total.map((r) => (util * r) / t.peakRps.value)) }];
  });
}

/** 사용자 수(xs)마다 엔진과 같은 식으로 다시 계산한 노드별 이벤트 피크 p99(ms, M/M/c).
 *  포화에 가까울수록 휘어 오르고, 포화(ρ ≥ 1)부터는 끝이 없어 선을 멈춘다. 대수는 그 사용자 수에 필요한 만큼 (오토스케일) */
export function p99Series(p: Project, a: Analysis, byId: Map<string, CatalogItem>, xs: number[]): Series[] {
  const users = p.scale?.users;
  if (!users) return [];
  return p.nodes.flatMap((n) => {
    const load = a.nodes[n.id]?.load;
    const per = perInstance(n, byId);
    if (!load || !per.rps || !n.perf) return [];
    const pts = xs.map((u): [number, number] => {
      const rps = (load.rps.event * u) / users;
      return [u, sizeAt(n, per.rps!.value, per.max, rps, p.target_utilization, primaryShape(n, byId, load)).p99!.value];
    });
    return [{ id: n.id, name: n.name, color: COLOR[healthOf(a, users, n.id).health], lim: a.nodes[n.id]?.limitUsers?.value, pts }];
  });
}

const SAMPLES = 240;
const PERSONA_COLORS = ['#2ec4a6', '#5b8def', '#f5b301', '#c77dff', '#ff8a5b', '#7bd389', '#ff5a8a', '#8fa3bf'];
const CHANNEL_COLORS = { external: '#5b8def', wom: '#2ec4a6' };
const HOURS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

/** 캔버스 아래 그래프 (탭): 페르소나별 하루 트래픽 · 하루 서버 사용률 · 사용자 유입(경로별) · 페르소나 단계 · 사용자 증가 시 p99 */
export function LimitChart({ project: p, analysis: a }: { project: Project; analysis?: Analysis }) {
  const [kind, setKind] = useState<ChartKind>('traffic');
  // 5분 칸 기대 트래픽: 페르소나·데이터 주고받기가 바뀔 때만 다시 계산 (1분 해상도 합성이라 그릴 때마다 하지 않는다)
  const curve = useMemo(() => dayCurve(p, STEP_MIN), trafficKey(p));
  const users = p.scale?.users;
  const t = a?.traffic;
  if (!a || !t || !users || !curve) return null;
  const adoption = a.growth?.adoption;
  const tz = p.scale?.report_country ?? '';

  // 가로축: 하루 탭은 0~24시, 유입·단계 탭은 달, p99 탭은 활성 사용자
  const limits = p.nodes.flatMap((n) => (a.nodes[n.id]?.limitUsers ? [a.nodes[n.id].limitUsers!.value] : []));
  const uMax = Math.max(users * 2, (Math.max(0, ...limits) || users * 5) * 1.15);
  const months = adoption ? adoption.length - 1 : 0;
  const xMax = kind === 'p99' ? uMax : kind === 'inflow' || kind === 'stages' ? Math.max(1, months) : 24;
  const x = (v: number) => L + ((W - L - R) * v) / xMax;

  // 쌓는 그래프: 아래 것부터 누적, 큰 누적부터 칠해 띠가 보이게
  const stack = (layers: number[][]) => layers.map((_, k) => layers[0].map((__, j) => layers.slice(0, k + 1).reduce((s, l) => s + l[j], 0)));
  const personaStack = kind === 'traffic' ? stack(curve.personas.map((c) => c.rps)) : [];
  const util = kind === 'util' ? dayUtilization(p, a, curve.total) : [];
  const inflowStack = kind === 'inflow' && adoption ? stack([adoption.map((m) => m.external), adoption.map((m) => m.wordOfMouth)]) : [];
  const stageStack = kind === 'stages' && adoption ? stack(p.personas.map((_, i) => adoption.map((m) => m.byPersona[i]))) : [];
  const p99 = kind === 'p99' ? p99Series(p, a, catalog.byId, Array.from({ length: SAMPLES + 1 }, (_, i) => (uMax * i) / SAMPLES)) : [];
  const p99Goal = p.optimize.max_p99_ms;
  const nowP99 = Math.max(0, ...p99.map((l) => l.pts.find(([u]) => u >= users)?.[1] ?? 0).filter(Number.isFinite));
  const top = (layers: number[][]) => Math.max(0, ...(layers.at(-1) ?? [0]));
  const yMax = (kind === 'traffic' ? top(personaStack) * 1.15
    : kind === 'util' ? Math.max(1.05, ...util.flatMap((l) => l.pts.map(([, v]) => v * 1.1)))
    : kind === 'inflow' ? top(inflowStack) * 1.15
    : kind === 'stages' ? Math.max(top(stageStack), ...(adoption ?? []).map((m) => m.equivalent)) * 1.1
    : Math.max(p99Goal ? p99Goal * 1.3 : 0, nowP99 * 4, 10)) || 1;
  const y = (v: number) => H - B - ((H - B - T) * Math.min(v, yMax * 1.05)) / yMax;
  const yTicks = [0, yMax / 2, yMax].map((v) => (kind === 'util' ? Math.round(v * 20) / 20 : v));
  const yLabel = (v: number) => (kind === 'util' ? `${Math.round(v * 100)}%` : kind === 'traffic' ? `${fmt(Math.round(v))} RPS` : kind === 'p99' ? `${fmt(v)}ms` : `${fmt(v)}명`);
  const short = (u: number) => (u >= 1e6 ? `${fmt(u / 1e6)}M` : `${Math.round(u / 1000)}k`);
  const line = (pts: [number, number][]) => {
    const end = pts.findIndex(([, v]) => !Number.isFinite(v));
    return (end < 0 ? pts : pts.slice(0, end)).map(([u, v], i) => `${i ? 'L' : 'M'}${x(u).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  };
  const area = (pts: [number, number][]) => `${line(pts)} L${x(pts.at(-1)![0])},${y(0)} L${x(pts[0][0])},${y(0)} Z`;
  const monthPts = (vals: number[]): [number, number][] => vals.map((v, mo) => [mo, v]);
  const areas = (layers: number[][], toPts: (v: number[]) => [number, number][], color: (k: number) => string) =>
    [...layers].reverse().map((cum, j) => { const k = layers.length - 1 - j; return <path key={k} d={area(toPts(cum))} fill={color(k)} fillOpacity={0.55} stroke={color(k)} strokeWidth={1.2} />; });

  const empty = kind === 'util' ? !util.length : kind === 'p99' ? !p99.length : kind === 'inflow' || kind === 'stages' ? !adoption : !curve.personas.length;
  const TABS: [ChartKind, string][] = [['traffic', '하루 트래픽 (페르소나별)'], ['util', '하루 서버 사용률'], ['inflow', '사용자 유입'], ['stages', '페르소나 단계'], ['p99', '사용자 증가 시 p99']];
  const ex = p.exchange;
  const exText = ex ? `${ex.receive === 'streaming' ? '스트리밍' : '폴링'}${ex.refresh_s ? ` ${ex.refresh_s}초` : ''} · ${ex.send === 'batch' ? `${ex.batch_s}초 모아 보내기` : '바로 보내기'}` : '주고받기 설정 없음';
  const SUB: Record<ChartKind, string> = {
    traffic: `가로: ${tz} 기준 시각 · 세로: 평소 요청 기댓값(5분 평균) · ${p.scale && dayLabel(p.scale) ? `하루 피크 「${dayLabel(p.scale)}」` : '페르소나 접속 시간대'}·접속 시간·${exText}로 계산`,
    util: '가로: 기준 시각 · 세로: 평소 피크에 맞춘 대수로 받을 때의 대당 사용률 (5분 평균)',
    inflow: '가로: 달 · 세로: 그달 새로 들어온 사람 · 바깥 유입(광고·검색)과 입소문(Bass 확산)',
    stages: '가로: 달 · 세로: 페르소나별 활성 사용자 (쌓음) · 점선 = 1인당 요청을 반영한 환산 사용자(부하·한계 시점 기준)',
    p99: '가로: 활성 사용자 · 세로: 이벤트 피크 p99 · 포화에 가까울수록 휘어 오름 · 점 = 포화가 시작되는 사용자 수',
  };
  const EMPTY: Record<ChartKind, string> = {
    traffic: '요청을 만드는 페르소나가 없어요.', util: '대당 처리량을 아는 노드가 없어 사용률을 그릴 수 없어요.',
    inflow: '왼쪽 "성장"에서 "유입 경로·페르소나 단계로 계산하기"를 누르면 그려요.', stages: '왼쪽 "성장"에서 "유입 경로·페르소나 단계로 계산하기"를 누르면 그려요.',
    p99: '처리 시간(평균 처리 ms·동시 처리 수)을 넣은 노드가 없어 p99를 그릴 수 없어요.',
  };
  const xTicks = kind === 'p99' ? [0, 1, 2, 3, 4, 5, 6].map((i) => (uMax * i) / 6)
    : kind === 'inflow' || kind === 'stages' ? Array.from({ length: 7 }, (_, i) => Math.round((months * i) / 6))
    : HOURS;
  const xLabel = (v: number) => (kind === 'p99' ? short(v) : kind === 'inflow' || kind === 'stages' ? `${v}개월` : `${v}시`);

  return (
    <section className="limit-chart">
      <h3>
        트래픽과 한계
        <span className="chart-tabs" role="tablist">
          {TABS.map(([k, label]) => <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)}>{label}</button>)}
        </span>
        <small>{SUB[kind]}</small>
      </h3>
      {empty ? <p className="muted">{EMPTY[kind]}</p> : <>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={TABS.find(([k]) => k === kind)![1]}>
          {yTicks.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} className="grid" /><text x={L - 8} y={y(v) + 4} textAnchor="end">{yLabel(v)}</text></g>)}
          {[...new Set(xTicks)].map((v) => <text key={v} x={x(v)} y={H - B + 20} textAnchor="middle">{xLabel(v)}</text>)}
          {kind === 'traffic' && areas(personaStack, dayPts, (k) => PERSONA_COLORS[k % PERSONA_COLORS.length])}
          {kind === 'util' && <>
            <line x1={L} x2={W - R} y1={y(1)} y2={y(1)} stroke="#ff5a5a" strokeDasharray="6 5" />
            <text x={L + 18} y={y(1) - 8} style={{ fill: '#ff5a5a' }}>한계 100%</text>
            <line x1={L} x2={W - R} y1={y(p.target_utilization)} y2={y(p.target_utilization)} stroke="#2ec4a6" strokeDasharray="2 5" />
            <text x={L + 18} y={y(p.target_utilization) - 8} style={{ fill: '#2ec4a6' }}>목표 사용률 {p.target_utilization}</text>
            {util.map((l) => <path key={l.id} d={line(l.pts)} fill="none" stroke={l.color} strokeWidth={2.2} strokeLinejoin="round" />)}
          </>}
          {kind === 'inflow' && areas(inflowStack, monthPts, (k) => (k ? CHANNEL_COLORS.wom : CHANNEL_COLORS.external))}
          {kind === 'stages' && adoption && <>
            {areas(stageStack, monthPts, (k) => PERSONA_COLORS[k % PERSONA_COLORS.length])}
            <path d={line(monthPts(adoption.map((m) => m.equivalent)))} fill="none" stroke="#e9edf3" strokeWidth={1.8} strokeDasharray="5 4" />
          </>}
          {kind === 'p99' && <>
            {p99Goal && <><line x1={L} x2={W - R} y1={y(p99Goal)} y2={y(p99Goal)} stroke="#ff5a5a" strokeDasharray="6 5" /><text x={L + 18} y={y(p99Goal) - 8} style={{ fill: '#ff5a5a' }}>p99 목표 {fmt(p99Goal)}ms</text></>}
            <line x1={x(users)} x2={x(users)} y1={T - 10} y2={H - B} stroke="#5f6a7a" strokeDasharray="3 4" />
            <text x={x(users) + 6} y={T - 14} className="now">지금 {fmt(users)}명</text>
            {p99.map((l) => <path key={l.id} d={line(l.pts)} fill="none" stroke={l.color} strokeWidth={2.2} strokeLinejoin="round" />)}
            {p99.map((l) => {
              const at = l.pts.find(([, v]) => !Number.isFinite(v))?.[0];
              return at === undefined ? null : <g key={l.id}><circle cx={x(at)} cy={y(yMax)} r={5} fill={l.color} /><text x={x(at)} y={y(yMax) + 16} textAnchor="middle" style={{ fill: l.color }}>{l.name} · {fmt(at)}명 포화</text></g>;
            })}
          </>}
        </svg>
        <div className="chart-legend">
          {kind === 'traffic' && curve.personas.map((c, k) => <span key={k}><i style={{ background: PERSONA_COLORS[k % PERSONA_COLORS.length] }} />{c.name} · 피크 {fmt(Math.max(...c.rps))} RPS</span>)}
          {kind === 'util' && util.map((l) => <span key={l.id}><i style={{ background: l.color }} />{l.name} · 최고 {Math.round(Math.max(...l.pts.map(([, v]) => v)) * 100)}%</span>)}
          {kind === 'inflow' && adoption && <>
            <span><i style={{ background: CHANNEL_COLORS.external }} />바깥 유입 · {months}개월 합 {fmt(adoption.reduce((s, m) => s + m.external, 0))}명</span>
            <span><i style={{ background: CHANNEL_COLORS.wom }} />입소문 · {months}개월 합 {fmt(adoption.reduce((s, m) => s + m.wordOfMouth, 0))}명</span>
            <span>떠난 사람 {fmt(adoption.at(-1)!.left)}명</span>
          </>}
          {kind === 'stages' && adoption && <>
            {p.personas.map((ps, k) => <span key={k}><i style={{ background: PERSONA_COLORS[k % PERSONA_COLORS.length] }} />{ps.name} {fmt(adoption.at(-1)!.byPersona[k])}명</span>)}
            <span>활성 {fmt(adoption.at(-1)!.active)}명 · 환산 {fmt(adoption.at(-1)!.equivalent)}명 ({months}개월째)</span>
          </>}
        </div>
      </>}
    </section>
  );
}
