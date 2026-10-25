// 설계서 화면(7·17절): A4 인쇄용으로 그리고, 브라우저 인쇄 창의 "PDF로 저장"으로만 내보낸다.
// 목차: 요약 → 구동 방식 → 규모 가정 → 구조도 → 화면 설계·API → 노드별 판정 근거 → 확장 한계·지연·비용 → 최선 조합 → 가용성·성장 → 조문 → 미해결 → 적용한 설정 → 출처
import { useEffect, useRef, type ReactNode } from 'react';
import type { Analysis } from '../../engine/analyze';
import { MODE_NAMES, SCOPE_NAMES } from '../../engine/deploy';
import { regionLines } from '../../engine/failure';
import { lawLine } from '../../engine/regulation';
import { dayLabel } from '../../engine/industry';
import { LAYER_NAMES, VERDICT_NAMES } from '../../engine/model';
import type { OptimizeResult, Plan } from '../../engine/optimize';
import { itemIds, nodeStorageProfile, selectedFeatures, type Project, type Screen } from '../../engine/schema';
import { PATTERNS } from '../../engine/traffic';
import { catalog, laws, prices } from './data';
import { worstVerdict } from './edit';
import { fmt, fmtMetric, fmtShare } from './format';
import type { XY } from './layout';
import { costTimeline, milestoneText, nodeCard, openIssues, sourcesOf } from './reportData';
import { drawScreen, screenFrame } from './wireDraw';

const H = ({ n, children }: { n: number; children: ReactNode }) => <h2 className="r-h">{n}. {children}</h2>;
const KV = ({ rows }: { rows: [string, ReactNode][] }) => (
  <table className="r-kv"><tbody>{rows.map(([k, v]) => <tr key={k}><th>{k}</th><td>{v}</td></tr>)}</tbody></table>
);

export function Report({ project: p, analysis: a, positions, plans, today, onClose }: {
  project: Project; analysis?: Analysis; positions: Record<string, XY>; plans?: OptimizeResult; today: string; onClose: () => void;
}) {
  const name = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  const t = a?.traffic;
  const counts = a ? a.judgements.map((j) => worstVerdict(j)).reduce<Record<string, number>>((s, v) => (v ? { ...s, [v]: (s[v] ?? 0) + 1 } : s), {}) : {};
  // 계산에 쓴 가격 행: 비용 항목의 입력 이름에 가격 행 id가 들어 있다
  const usedPrices = a?.cost ? prices.filter((r) => Object.values(a.cost!.parts).some((m) => Object.keys(m.inputs).some((k) => k.includes(` ${r.id} `)))) : [];

  return (
    <div className="report-overlay">
      <div className="report-bar no-print">
        <b>설계서 미리보기</b>
        <span className="muted">인쇄 창에서 "PDF로 저장"을 고르세요 (A4)</span>
        <span className="spacer" />
        <button className="primary" onClick={() => window.print()}>PDF로 저장 (인쇄)</button>
        <button onClick={onClose}>닫기</button>
      </div>
      <article className="report">
        <header className="r-title">
          <h1>{p.name}</h1>
          <p className="muted">App Architect Studio 설계서 · {today} · 카탈로그 항목 {catalog.items.length}개 · 가격표 {prices.length}행</p>
        </header>
        {!a && <p className="warn">입력에 오류가 있어 계산 결과가 없습니다. 화면에서 오류를 고친 뒤 다시 여세요.</p>}

        {a && <>
          <section>
            <H n={1}>요약</H>
            <KV rows={[
              ['구동 방식', MODE_NAMES[p.deploy.mode]],
              ['활성 사용자', p.scale ? `${fmt(p.scale.users)}명` : '입력 없음'],
              ['이벤트 피크', t ? fmtMetric(t.peakRpsEvent) : '—'],
              ['월 비용', a.cost?.total ? `${fmtMetric(a.cost.total)}${a.cost.missing.length ? ' (계산 못 한 항목 있음)' : ''}` : '—'],
              ['첫 병목', a.bottleneck ? `${name(a.bottleneck.nodeId)} — ${a.bottleneck.limitUsers.value === 0 ? '지금 구조에서 이미 안 됨' : `활성 사용자 약 ${fmt(a.bottleneck.limitUsers.value)}명`}` : '—'],
              ['노드 판정', (['ok', 'conditional', 'fail', 'unknown'] as const).map((v) => `${VERDICT_NAMES[v]} ${counts[v] ?? 0}`).join(' · ')],
            ]} />
          </section>

          <section>
            <H n={2}>구동 방식</H>
            <KV rows={[
              ['방식', MODE_NAMES[p.deploy.mode]],
              ['사용 범위', SCOPE_NAMES[p.deploy.scope]],
              ['오프라인 필요', p.deploy.offline_required ? '예' : '아니오'],
              ...(a.localMemory ? [['로컬 메모리', `${fmtMetric(a.localMemory.mb)}${a.localMemory.share ? ` (기기 메모리의 ${fmtShare(a.localMemory.share.value)})` : ''}`] as [string, string]] : []),
            ]} />
          </section>

          <section>
            <H n={3}>규모 가정</H>
            {p.scale && <KV rows={[
              ['활성 사용자', `${fmt(p.scale.users)}명`], ['이벤트 배수', `${p.scale.event_multiplier}배`],
              ['창 안 비율', fmtShare(p.scale.window_share)], ['하루 피크 (업종)', dayLabel(p.scale) ?? '없음 (페르소나마다 깨어 있는 시간 가운데)'], ['보관 기간', `${p.scale.retention_days}일`], ['기준 나라', p.scale.report_country],
              ['데이터 주고받기', p.exchange
                ? `${p.exchange.receive === 'streaming' ? '스트리밍' : '폴링'}${p.exchange.refresh_s ? ` ${p.exchange.refresh_s}초마다 최신화` : ' (화면을 옮길 때만 받음)'} · ${p.exchange.send === 'batch' ? `${p.exchange.batch_s}초마다 모아 보내기` : '행동마다 바로 보내기'}`
                : '설정 없음 (접속당 읽기·쓰기만)'],
              ['성장', !p.growth ? '없음' : p.growth.inflow
                ? `유입 모형: 시장 ${fmt(p.growth.inflow.market)}명, 바깥 유입 ${p.growth.inflow.external}/월, 입소문 ${p.growth.inflow.word_of_mouth}, '${p.growth.inflow.entry}'로 들어옴, 단계 이동 ↑${p.growth.inflow.up} ↓${p.growth.inflow.down}, 떠남 ${p.growth.inflow.leave}`
                : `월 성장률 ${fmtShare(p.growth.monthly_rate)}`],
            ]} />}
            {t && <>
              <table className="r-grid">
                <thead><tr><th>페르소나</th><th>패턴</th><th>비율</th><th>인원</th><th>1인당 요청/일</th><th>요청 합계</th><th>쓰기 행 합계</th></tr></thead>
                <tbody>{t.personas.map((x, i) => (
                  <tr key={x.name}>
                    <td>{x.name}</td><td>{PATTERNS[p.personas[i].pattern].label}</td><td>{fmtShare(x.share)}</td><td>{fmt(x.people)}</td>
                    <td>{fmt(x.requests / x.people)}</td><td>{fmt(x.requests)}</td><td>{fmt(Object.values(x.rows).reduce((s, v) => s + v, 0))}</td>
                  </tr>
                ))}</tbody>
              </table>
              <KV rows={[
                ['DAU', fmtMetric(t.dau)], ['하루 요청', fmtMetric(t.dailyRequests)], ['피크 RPS', fmtMetric(t.peakRps)],
                ['이벤트 피크 RPS', fmtMetric(t.peakRpsEvent)], ['이벤트 쓰기', fmtMetric(t.peakWriteRpsEvent)], ['하루 송신', fmtMetric(t.egressGbPerDay)],
                ['저장량', a.storage?.tablesGb ? `테이블 합계 ${fmtMetric(a.storage.tablesGb)} (페르소나 추정 ${fmtMetric(a.storage.personaGb)})` : fmtMetric(t.storageGbWithOverhead)],
              ]} />
            </>}
            {p.actions.length > 0 && <p>행동: {p.actions.map((x) => `${x.name}(접속당 ${x.per_session}회 → ${x.writes.map((w) => `${w.node}.${w.table}${w.rows !== 1 ? ` ${w.rows}행` : ''}`).join(', ')})`).join(' · ')}</p>}
          </section>

          <section>
            <H n={4}>구조도</H>
            <Diagram project={p} analysis={a} positions={positions} />
          </section>

          <section>
            <H n={5}>화면 설계 · API 호출</H>
            <Screens project={p} analysis={a} />
          </section>

          <section>
            <H n={6}>노드별 선택과 판정 근거</H>
            {p.nodes.map((n) => {
              const c = nodeCard(p, a, catalog.byId, n.id);
              return (
                <div key={n.id} className={`r-card v-${c.verdict ?? 'none'}`}>
                  <div className="r-card-head"><b>{c.title}</b><span>{c.verdict ? VERDICT_NAMES[c.verdict] : '항목 없음'}</span></div>
                  <table><tbody>{c.rows.map((r) => (
                    <tr key={r.label}><th>{r.label}</th><td>{r.lines.length ? r.lines.map((l) => <div key={l}>{l}</div>) : <span className="muted">없음</span>}</td></tr>
                  ))}</tbody></table>
                </div>
              );
            })}
          </section>

          <section>
            <H n={7}>확장 한계 · 지연시간 · 월 비용</H>
            <ul>{p.nodes.filter((n) => a.nodes[n.id].limitUsers).map((n) => <li key={n.id}>{n.name}: 한계 사용자 약 {fmt(a.nodes[n.id].limitUsers!.value)}명</li>)}</ul>
            <ul>{a.paths.map((pa) => <li key={pa.nodes.join()}>{pa.nodes.map(name).join(' → ')}: p99 {fmtMetric(pa.p99)}</li>)}</ul>
            {a.cost && <>
              <table className="r-grid"><tbody>
                {Object.entries(a.cost.parts).map(([k, m]) => <tr key={k}><td>{p.nodes.some((n) => n.id === k) ? name(k) : k}</td><td>{fmtMetric(m)}</td></tr>)}
                <tr><th>합계</th><th>{fmtMetric(a.cost.total)}</th></tr>
              </tbody></table>
              {a.cost.missing.length > 0 && <p className="warn">계산하지 못한 항목: {a.cost.missing.join(' / ')}</p>}
              <p className="muted">가격 기준일: {[...new Set(usedPrices.map((r) => r.as_of))].join(', ') || '—'}{a.cost.stale.length ? ` · 오래된 가격: ${a.cost.stale.join(', ')}` : ''}</p>
            </>}
          </section>

          <section>
            <H n={8}>최선 조합과 선택 조건</H>
            <KV rows={[
              ['우선순위', p.optimize.priorities.join(' > ') || '없음 (모든 목표 같은 무게)'],
              ['꼭 지킬 조건', [p.optimize.budget_monthly !== undefined && `월 예산 ${fmt(p.optimize.budget_monthly)}`, p.optimize.min_limit_users !== undefined && `한계 사용자 ${fmt(p.optimize.min_limit_users)}명 이상`, p.optimize.max_p99_ms !== undefined && `p99 ${p.optimize.max_p99_ms}ms 이하`, p.optimize.min_availability !== undefined && `가용성 ${fmtShare(p.optimize.min_availability)} 이상`].filter(Boolean).join(' · ') || '없음'],
            ]} />
            {plans && <PlanTable p={p} plans={plans} />}
            {plans && !plans.best && <ul>{plans.relax.map((x) => <li key={x}>{x}</li>)}</ul>}
          </section>

          <section>
            <H n={9}>가용성 · 성장 타임라인</H>
            <ul>{a.paths.map((pa) => <li key={pa.nodes.join()}>{pa.nodes.map(name).join(' → ')}: 가용성 {fmtMetric(pa.availability)}, 월 중단 {fmtMetric(pa.downtime)}</li>)}</ul>
            {a.spof.length > 0 && <p>단일 장애점: {a.spof.map(name).join(', ')}</p>}
            {a.failure && a.failure.regions.length > 0 && <ul>{regionLines(a.failure, name).map((l) => <li key={l}>{l}</li>)}</ul>}
            {a.growth && <ul>
              {a.growth.milestones.map((ms) => <li key={ms.nodeId}>{name(ms.nodeId)}: {milestoneText(ms)}</li>)}
              {a.growth.tables.map((ms) => <li key={ms.nodeId}>{ms.nodeId}: {ms.month === undefined ? '서버 메모리에 닿지 않음' : `${ms.month}개월째 서버 메모리를 넘음, ${ms.startMonth}개월째 파티션 착수`}</li>)}
              {a.growth.monthlyCost.length > 0 && <li>월 비용: {costTimeline(a.growth.monthlyCost)}</li>}
            </ul>}
          </section>

          <section>
            <H n={10}>확인 필요 조문</H>
            {!a.regulation.length ? <p className="muted">개인정보 노드가 없거나 걸린 조문이 없습니다.</p> : <ul>
              {a.regulation.map((h) => <li key={h.nodeId + h.law + h.article}>{name(h.nodeId)} · {lawLine(h)}</li>)}
            </ul>}
            <p className="muted">법률 검토를 대신하지 않습니다. 조문 내용은 원문에서 확인하세요.</p>
          </section>

          <section>
            <H n={11}>미해결 ❌·⚠️ 목록</H>
            {(() => { const xs = openIssues(p, a, catalog.byId); return xs.length ? <ul>{xs.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="muted">없습니다.</p>; })()}
          </section>

          <section>
            <H n={12}>적용한 설정</H>
            <ul>{p.nodes.flatMap((n) => {
              const sp = nodeStorageProfile(n, catalog.byId);
              const feats = sp ? selectedFeatures(sp, n).map((f) => f.label) : [];
              const tips = itemIds(n).flatMap((id) => catalog.byId.get(id)?.settings ?? []).map((s) => `${s.name}(${s.goal})`);
              return feats.length || tips.length ? [<li key={n.id}>{n.name}: {[feats.length && `저장 기능 ${feats.join(', ')}${n.storage_features ? '' : ' (권장)'}`, tips.length && `권장 설정 ${tips.join(', ')}`].filter(Boolean).join(' · ')}</li>] : [];
            })}</ul>
          </section>

          <section>
            <H n={13}>카탈로그 출처</H>
            <ul className="r-src">
              {sourcesOf(p, catalog.byId).map((s) => <li key={s.item}>{s.item}: {s.urls.join(' · ')}</li>)}
              {usedPrices.map((r) => <li key={r.id}>가격 {r.id} ({r.as_of}): {r.source}</li>)}
              {[...new Set(a.regulation.map((h) => h.source))].map((s) => <li key={s}>법령: {s}</li>)}
            </ul>
            <p className="muted">법령 표 {laws.length}행 · 숫자에 붙은 공식과 기준값 출처(실측·사양 보정·업계 기준값)는 노드 카드의 계산 결과에 있습니다.</p>
          </section>
        </>}
      </article>
    </div>
  );
}

/** 구조도: 캔버스 배치를 그대로 축소해 그린다. 테두리 색 = 판정 */
function Diagram({ project: p, analysis: a, positions }: { project: Project; analysis: Analysis; positions: Record<string, XY> }) {
  const W = 170, H = 54;
  const pts = p.nodes.map((n) => positions[n.id] ?? { x: 0, y: 0 });
  const minX = Math.min(...pts.map((q) => q.x), 0), minY = Math.min(...pts.map((q) => q.y), 0);
  const maxX = Math.max(...pts.map((q) => q.x), 0) + W, maxY = Math.max(...pts.map((q) => q.y), 0) + H;
  const at = (id: string) => { const q = positions[id] ?? { x: 0, y: 0 }; return { x: q.x - minX, y: q.y - minY }; };
  return (
    <svg className="r-diagram" viewBox={`-10 -10 ${maxX - minX + 20} ${maxY - minY + 20}`} role="img" aria-label="구조도">
      <defs><marker id="r-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#555" /></marker></defs>
      {p.edges.map((e) => {
        const s = at(e.from), d = at(e.to);
        return <line key={`${e.from}-${e.to}`} x1={s.x + W} y1={s.y + H / 2} x2={d.x} y2={d.y + H / 2} stroke="#555" strokeDasharray={e.sync ? undefined : '5 4'} markerEnd="url(#r-arrow)" />;
      })}
      {p.nodes.map((n) => {
        const q = at(n.id);
        const v = worstVerdict(a.judgements.find((j) => j.nodeId === n.id)) ?? 'none';
        return (
          <g key={n.id}>
            <rect x={q.x} y={q.y} width={W} height={H} rx={6} className={`r-node v-${v}`} />
            <text x={q.x + 8} y={q.y + 18} className="r-node-layer">{LAYER_NAMES[n.layer]}</text>
            <text x={q.x + 8} y={q.y + 38} className="r-node-name">{n.name.length > 16 ? `${n.name.slice(0, 15)}…` : n.name}</text>
          </g>
        );
      })}
    </svg>
  );
}

function PlanTable({ p, plans }: { p: Project; plans: OptimizeResult }) {
  const cols: [string, Plan | undefined][] = [['지금', plans.current], ['최선', plans.best], ['최저 비용', plans.cheapest], ['최대 확장', plans.scalable]];
  const nodes = p.nodes.filter((n) => plans.current.assignment[n.id]);
  const item = (id?: string) => (id ? catalog.byId.get(id)?.name ?? id : '—');
  return (
    <table className="r-grid">
      <thead><tr><th />{cols.map(([l]) => <th key={l}>{l}</th>)}</tr></thead>
      <tbody>
        {nodes.map((n) => <tr key={n.id}><td>{n.name}</td>{cols.map(([l, x]) => <td key={l}>{item(x?.assignment[n.id])}</td>)}</tr>)}
        <tr><td>월 비용</td>{cols.map(([l, x]) => <td key={l}>{x?.metrics.cost === undefined ? '모름' : fmt(x.metrics.cost)}</td>)}</tr>
        <tr><td>한계 사용자</td>{cols.map(([l, x]) => <td key={l}>{x?.metrics.limitUsers === undefined ? '미확인' : `${fmt(x.metrics.limitUsers)}명`}</td>)}</tr>
        <tr><td>최대 p99</td>{cols.map(([l, x]) => <td key={l}>{x?.metrics.p99 === undefined ? '—' : `${fmt(x.metrics.p99)}ms`}</td>)}</tr>
        <tr><td>최소 가용성</td>{cols.map(([l, x]) => <td key={l}>{x?.metrics.availability === undefined ? '—' : fmtShare(x.metrics.availability)}</td>)}</tr>
      </tbody>
    </table>
  );
}

/** 와이어프레임 그림. 캔버스는 화면에 붙은 뒤에 그린다 (인쇄에도 그대로 나온다) */
function WireImage({ screen, frame }: { screen: Screen; frame: { w: number; h: number } }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current?.getContext('2d');
    if (c) drawScreen(c, screen, frame, 2);
  }, [screen, frame]);
  // 기기 너비 비율로 줄여 세로로 긴 모바일 화면이 한 쪽을 다 차지하지 않게 한다
  return <canvas ref={ref} className="r-wire" width={frame.w * 2} height={frame.h * 2} style={{ width: `${Math.min(100, frame.w / 12.8)}%` }} />;
}

function Screens({ project: p, analysis: a }: { project: Project; analysis: Analysis }) {
  const frameOfS = (s: Screen) => screenFrame(s, p.deploy.mode);
  const name = (id: string) => p.nodes.find((n) => n.id === id)?.name ?? id;
  const uis = p.nodes.filter((n) => n.layer === 'ui' && n.wireframe?.screens.some((s) => s.items.length));
  if (!uis.length) return <p className="muted">와이어프레임이 없습니다. 화면 블록의 세부 구성 › 와이어프레임에서 그릴 수 있습니다.</p>;
  return <>{uis.map((n) => {
    const calls = a.api.filter((c) => c.node === n.id);
    return (
      <div key={n.id}>
        <h3 className="r-sub">{n.name}</h3>
        {n.wireframe!.screens.filter((s) => s.items.length).map((s) => (
          <figure key={s.name} className="r-fig"><WireImage screen={s} frame={frameOfS(s)} /><figcaption>{n.name} · {s.name} ({frameOfS(s).name})</figcaption></figure>
        ))}
        {calls.length > 0 && <table className="r-grid"><thead><tr><th>화면 · 컨트롤</th><th>호출</th><th>받는 블록</th><th>접속당</th><th>피크 RPS</th><th>이벤트 피크 RPS</th></tr></thead><tbody>
          {calls.map((c) => <tr key={c.screen + c.item}><td>{c.screen} · {c.label}</td><td>{c.method} {c.path || '/'}</td><td>{name(c.to)}</td><td>{fmt(c.perSession)}회</td><td>{fmtMetric(c.rps)}</td><td>{fmtMetric(c.rpsEvent)}</td></tr>)}
        </tbody></table>}
      </div>
    );
  })}</>;
}
