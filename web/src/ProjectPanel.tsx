import { Select } from './Select';
import { Fragment, useState } from 'react';
import { Persona, REGIONS, Scale, PATTERN_IDS, SERVICE_KINDS, type Exchange, type PriceRow, type Project } from '../../engine/schema';
import { RECOMMEND, SERVICE_NAMES } from './exchange';
import { DayPeakSection, PersonaMixEditor } from './PeakSections';
import { prices } from './data';
import { PATTERNS } from '../../engine/traffic';
import { enabled, MODE_NAMES, SCOPE_NAMES } from '../../engine/deploy';
import { STANDARD_OFFSET } from '../../engine/timezones';
import { NumField, NumInput, Row, Section, TextField } from './fields';
import { addAction, patchAt, removeAction, removePersona, setActionRate, updateAction, updatePersona } from './edit';
import { usePick } from './store';
import { desktop, setUpdateCheck, updateCheckOn } from './desktop';

export function ProjectPanel() {
  const { project: p, edit } = usePick('project', 'edit');
  const [editPersonas, setEditPersonas] = useState(false);
  const set = (patch: Partial<Project>) => edit((x) => ({ ...x, ...patch }));
  const setScale = (patch: Partial<NonNullable<Project['scale']>>) => p.scale && set({ scale: { ...p.scale, ...patch } });
  const setPersona = (i: number, patch: Partial<Project['personas'][number]>) => edit((x) => updatePersona(x, i, patch));
  const shareSum = p.personas.reduce((s, x) => s + x.share, 0);

  return (
    <div className="panel">
      <Section id="s-proj" title="프로젝트" desc="설계서에 표시되는 이름이에요.">
        <TextField label="이름" value={p.name} onChange={(v) => set({ name: v })} />
      </Section>

      <Section id="s-mode" title="구동 방식" desc="서비스가 어디서, 누구에게 쓰이는지 골라 주세요.">
        <Row label="방식">
          <Select value={p.deploy.mode} onChange={(e) => set({ deploy: { ...p.deploy, mode: e.target.value as Project['deploy']['mode'] } })}>
            {Object.entries(MODE_NAMES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Row>
        <Row label="오프라인 필요"><input type="checkbox" checked={p.deploy.offline_required} onChange={(e) => set({ deploy: { ...p.deploy, offline_required: e.target.checked } })} /></Row>
        <Row label="사용 범위">
          <Select value={p.deploy.scope} onChange={(e) => set({ deploy: { ...p.deploy, scope: e.target.value as Project['deploy']['scope'] } })}>
            {Object.entries(SCOPE_NAMES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </Select>
        </Row>
        {enabled(p.deploy, 'localMemory') && <LocalMemory />}
      </Section>

      <Section id="s-scale" title="규모" desc="사용자가 늘 때 어디가 먼저 막힐지 계산하는 데 쓰는 값이에요.">
        {!p.scale && <button onClick={() => set({ scale: Scale.parse({ users: 100000 }) })}>규모 입력하기</button>}
        {p.scale && <>
          <NumField label="활성 사용자" hint="한 달 안에 쓰는 사람 수" value={p.scale.users} step={1000} onChange={(v) => v && setScale({ users: v })} />
          <NumField label="이벤트 배수" hint="이벤트 때 평소의 몇 배가 몰리는지" value={p.scale.event_multiplier} onChange={(v) => setScale({ event_multiplier: v ?? 1 })} />
          <NumField label="창 안 비율" value={p.scale.window_share} step={0.05} hint="깨어 있는 시간대에 들어오는 접속 비율" onChange={(v) => setScale({ window_share: v ?? 0.8 })} />
          <Row label="기준 나라">
            <Select value={p.scale.report_country} onChange={(e) => setScale({ report_country: e.target.value })}>
              {Object.keys(STANDARD_OFFSET).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
          </Row>
          <NumField label="보관 기간(일)" hint="데이터를 지우지 않고 두는 기간. 테이블마다 따로 정하지 않으면 이 값으로 저장량을 계산해요" value={p.scale.retention_days} step={30} onChange={(v) => setScale({ retention_days: v ?? 365 })} />
          <NumField label="시드" hint="같은 값이면 같은 결과가 나와요" value={p.scale.seed} step={1} onChange={(v) => setScale({ seed: v ?? 1 })} />
          <NumField label="목표 사용률" hint="이 선을 넘으면 착수 시점으로 봐요" value={p.target_utilization} step={0.05} onChange={(v) => v && set({ target_utilization: v })} />
          <Row label="큐 적체 계산 단위" hint="대수가 고정된 큐 소비자의 적체를 몇 분 칸 평균 도착으로 계산할지. 짧을수록 몇 분짜리 몰림이 적체에 보여요 (자동 확장 소비자는 늘 1분)">
            <Select value={String(p.scale.queue_step_min)} onChange={(e) => setScale({ queue_step_min: Number(e.target.value) as 1 | 5 | 15 | 60 })}>
              {[1, 5, 15, 60].map((m) => <option key={m} value={String(m)}>{m}분</option>)}
            </Select>
          </Row>
        </>}
      </Section>

      <DayPeakSection />

      <Section id="s-pers" title={`페르소나 (비율 합 ${(shareSum * 100).toFixed(0)}%)`} desc="활동 정도에 따른 사용자 분포예요. 목록 위에서부터 활발한 순으로 보고, 봉우리를 끌어서 비율을 정해요.">
        <PersonaMixEditor />
        {/* 평소에는 비율 막대로 보고, "편집"을 누르면 입력 칸으로 바뀐다 */}
        {!editPersonas && p.personas.map((ps, i) => {
          const top = Math.max(...p.personas.map((x) => x.share), 1e-9);
          return (
            <div key={i} className="persona-bar" data-tip={`${PATTERNS[ps.pattern].label} · ${ps.country}`}>
              <span>{ps.name}</span>
              <div className="track"><i style={{ width: `${(ps.share / top) * 100}%` }} /></div>
              <em>{Math.round(ps.share * 100)}%</em>
            </div>
          );
        })}
        {editPersonas && p.personas.map((ps, i) => (
          <Fragment key={i}>
          <div className="persona">
            <input value={ps.name} onChange={(e) => setPersona(i, { name: e.target.value })} aria-label="이름" />
            <Select value={ps.pattern} onChange={(e) => setPersona(i, { pattern: e.target.value as typeof ps.pattern })} aria-label="패턴">
              {PATTERN_IDS.map((id) => <option key={id} value={id}>{PATTERNS[id].label}</option>)}
            </Select>
            <NumInput step={0.05} value={ps.share} onChange={(e) => setPersona(i, { share: Number(e.target.value) })} aria-label="비율" />
            <Select value={ps.country} onChange={(e) => setPersona(i, { country: e.target.value })} aria-label="나라">
              {Object.keys(STANDARD_OFFSET).map((c) => <option key={c} value={c}>{c}</option>)}
            </Select>
            <button onClick={() => edit((x) => removePersona(x, i))} aria-label="삭제">×</button>
          </div>
          {/* 비우면 패턴의 기본값을 쓴다 */}
          <NumField label={`${ps.name} 접속 횟수(하루)`} value={ps.sessions_per_day} step={0.5} hint={`비우면 패턴 기본 ${PATTERNS[ps.pattern].sessions_per_day}회`} onChange={(v) => setPersona(i, { sessions_per_day: v })} />
          <NumField label={`${ps.name} 접속 시간(분)`} value={ps.session_minutes} step={1} hint={`접속 한 번에 머무는 시간. 비우면 패턴 기본 ${PATTERNS[ps.pattern].session_minutes}분`} onChange={(v) => setPersona(i, { session_minutes: v })} />
          </Fragment>
        ))}
        <div className="inline">
          <button onClick={() => setEditPersonas(!editPersonas)}>{editPersonas ? '편집 끝' : '편집'}</button>
          {editPersonas && <button onClick={() => set({ personas: [...p.personas, Persona.parse({ name: '새 페르소나', pattern: 'regular', share: 0 })] })}>페르소나 추가</button>}
        </div>
        {p.personas.length > 0 && Math.abs(shareSum - 1) > 1e-6 && <p className="warn">비율 합이 100%여야 계산합니다.</p>}
      </Section>

      <ActionsSection />

      <Section id="s-ex" title="데이터 주고받기 (로드밸런서)" desc="앱이 얼마마다 다시 받고, 모아서 보내는지에 따라 요청 수가 달라져요.">
        {(() => {
          const ex = p.exchange ?? { receive: 'polling' as const, send: 'realtime' as const, batch_s: 60 };
          const setEx = (patch: Partial<Exchange>) => set({ exchange: { ...ex, ...patch } });
          const rec = ex.service ? RECOMMEND[ex.service] : undefined;
          return <>
            <Row label="서비스 성격">
              <Select value={ex.service ?? ''} onChange={(e) => setEx({ service: (e.target.value || undefined) as Exchange['service'] })}>
                <option value="">고르면 추천값을 보여 줘요</option>
                {SERVICE_KINDS.map((k) => <option key={k} value={k}>{SERVICE_NAMES[k]}</option>)}
              </Select>
            </Row>
            {rec && <div className="recommend">
              <b>추천: {rec.ex.receive === 'streaming' ? '스트리밍' : '폴링'}{rec.ex.refresh_s ? ` ${rec.ex.refresh_s}초마다` : ' (화면 옮길 때만)'} · {rec.ex.send === 'batch' ? `${rec.ex.batch_s}초마다 모아 보내기` : '바로 보내기'}</b>
              <p className="muted">{rec.why} (예시값)</p>
              <button onClick={() => setEx(rec.ex)}>추천값 적용</button>
            </div>}
            <Row label="받기">
              <Select value={ex.receive} onChange={(e) => setEx({ receive: e.target.value as Exchange['receive'] })}>
                <option value="polling">폴링 (앱이 다시 요청)</option>
                <option value="streaming">스트리밍 (연결 유지, 서버가 밀어줌)</option>
              </Select>
            </Row>
            <NumField label="최신화 주기(초)" value={ex.refresh_s} step={1} hint="비우면 화면을 옮길 때만 받아요. 짧을수록 접속 중 요청이 늘어요" onChange={(v) => setEx({ refresh_s: v && v > 0 ? v : undefined })} />
            <Row label="보내기">
              <Select value={ex.send} onChange={(e) => setEx({ send: e.target.value as Exchange['send'] })}>
                <option value="realtime">행동마다 바로</option>
                <option value="batch">모았다가 한꺼번에</option>
              </Select>
            </Row>
            {ex.send === 'batch' && <NumField label="모아 보내는 주기(초)" value={ex.batch_s} step={5} onChange={(v) => setEx({ batch_s: v && v > 0 ? v : 60 })} />}
            <p className="muted">접속 1회의 요청 = 접속당 읽기 + 접속 시간 ÷ 최신화 주기 + 쓰기 요청(모아 보내면 접속 시간 ÷ 주기). 스트리밍은 접속마다 연결 1개를 열어 둡니다.</p>
          </>;
        })()}
      </Section>

      <Section id="s-growth" title="성장" desc="몇 개월째에 한계에 닿는지, 언제 준비를 시작해야 하는지 계산해요.">
        {!p.growth && <button onClick={() => set({ growth: { monthly_rate: 0.1, months: 24, lead_months: 3 } })}>성장률 입력하기</button>}
        {p.growth && <>
          {!p.growth.inflow && <NumField label="월 성장률" value={p.growth.monthly_rate} step={0.01} onChange={(v) => set({ growth: { ...p.growth!, monthly_rate: v ?? 0 } })} />}
          <NumField label="보는 기간(월)" value={p.growth.months} step={6} hint="월별 비용·유입 곡선을 몇 개월까지 보일지" onChange={(v) => set({ growth: { ...p.growth!, months: v ?? 24 } })} />
          <NumField label="준비 기간(월)" value={p.growth.lead_months} step={1} onChange={(v) => set({ growth: { ...p.growth!, lead_months: v ?? 0 } })} />
          {!p.growth.inflow && p.scale && p.personas.length > 0 && <button onClick={() => set({ growth: { ...p.growth!, inflow: {
            market: p.scale!.users * 10, external: 0.01, word_of_mouth: 0.3, up: 0.05, down: 0.03, leave: 0.1,
            // 새 사용자는 보통 가볍게 써 보며 시작한다: '가끔' 패턴, 없으면 가장 덜 활발한 페르소나
            entry: (p.personas.find((x) => x.pattern === 'occasional') ?? [...p.personas].sort((a, b) => PATTERN_IDS.indexOf(b.pattern) - PATTERN_IDS.indexOf(a.pattern))[0]).name,
          } } })}>유입 경로·페르소나 단계로 계산하기</button>}
          {p.growth.inflow && (() => {
            const f = p.growth!.inflow!;
            const setF = (patch: Partial<typeof f>) => set({ growth: { ...p.growth!, inflow: { ...f, ...patch } } });
            return <>
              <NumField label="시장 크기(명)" value={f.market} step={10000} hint="이 서비스를 쓸 수 있는 전체 사람 수" onChange={(v) => setF({ market: v ?? f.market })} />
              <NumField label="바깥 유입(월)" value={f.external} step={0.005} hint="광고·검색 등으로 아직 안 쓴 사람 중 매달 들어오는 비율 (Bass p, 흔히 0.01~0.03)" onChange={(v) => setF({ external: v ?? 0 })} />
              <NumField label="입소문(월)" value={f.word_of_mouth} step={0.05} hint="써 본 사람이 데려오는 힘 (Bass q, 흔히 0.3~0.5). 써 본 사람이 많을수록 커져 S자 곡선이 됩니다" onChange={(v) => setF({ word_of_mouth: v ?? 0 })} />
              <Row label="들어오는 페르소나">
                <Select value={f.entry} onChange={(e) => setF({ entry: e.target.value })}>
                  {p.personas.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
                </Select>
              </Row>
              <NumField label="더 활발해짐(월)" value={f.up} step={0.01} hint="매달 한 단계 더 활발한 페르소나로 옮기는 비율" onChange={(v) => setF({ up: v ?? 0 })} />
              <NumField label="덜 쓰게 됨(월)" value={f.down} step={0.01} hint="매달 한 단계 덜 활발한 페르소나로 옮기는 비율" onChange={(v) => setF({ down: v ?? 0 })} />
              <NumField label="떠남(월)" value={f.leave} step={0.01} hint="가장 덜 활발한 페르소나에서 매달 떠나는 비율" onChange={(v) => setF({ leave: v ?? 0 })} />
              <p className="muted">한계 시점·월 비용은 페르소나별 1인당 요청을 반영한 사용자 수로 계산합니다. 아래 그래프의 "사용자 유입"·"페르소나 단계" 탭에서 봅니다.</p>
              <button onClick={() => { const { inflow: _, ...rest } = p.growth!; set({ growth: rest }); }}>월 성장률로 돌아가기</button>
            </>;
          })()}
          <button onClick={() => set({ growth: undefined })}>성장률 지우기</button>
        </>}
      </Section>

      <Section id="s-cost" title="비용 기준" desc="가격표에서 어떤 상품으로 저장·송신 비용을 셀지 골라요.">
        <Row label="기본 리전">
          <Select value={p.cost.region ?? ''} onChange={(e) => set({ cost: { ...p.cost, region: (e.target.value || undefined) as typeof p.cost.region } })}>
            <option value="">(없음)</option>
            {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </Select>
        </Row>
        {([['저장 (GB·월)', 'storage', 'gb_month'], ['인터넷 송신 (GB)', 'egress', 'gb'], ['리전 간 전송 (GB)', 'transfer', 'gb_interregion']] as const).map(([label, key, unit]) => (
          <Row key={key} label={label}>
            <Select value={p.cost[key] ?? ''} onChange={(e) => set({ cost: { ...p.cost, [key]: e.target.value || undefined } })}>
              <option value="">(계산 안 함)</option>
              {productsOf(unit).map((x) => <option key={x} value={x}>{x}</option>)}
            </Select>
          </Row>
        ))}
        <p className="muted">노드 비용은 주 항목의 과금 방식(대수×시간·사용량·월 정액)과 노드 리전으로 가격표에서 찾습니다.</p>
      </Section>

      <Section id="s-rec" title="장애 목표" desc="어떤 장애까지 견뎌야 하는지, 얼마 안에 되살리고 데이터를 얼마나 잃어도 되는지 정해요. 정하면 노드 판정에 넣어요.">
        <Row label="견딜 장애" hint="존 = 같은 리전 안의 데이터센터 하나, 리전 = 지역 전체">
          <Select value={p.recovery?.survive ?? ''} onChange={(e) => set({ recovery: e.target.value ? { ...p.recovery, survive: e.target.value as 'none' | 'zone' | 'region' } : undefined })}>
            <option value="">(목표 없음 — 결과만 보기)</option>
            <option value="none">백업만 (존 장애도 멈춰도 됨)</option>
            <option value="zone">존 하나 장애</option>
            <option value="region">리전 하나 장애</option>
          </Select>
        </Row>
        {p.recovery && <>
          <NumField label="목표 RTO(분)" value={p.recovery.rto_min} step={5} hint="장애가 나서 다시 동작하기까지 허용하는 시간. 넘기는 시간·백업에서 되살리는 시간과 비교해요" onChange={(v) => set({ recovery: { ...p.recovery!, rto_min: v && v > 0 ? v : undefined } })} />
          <NumField label="목표 RPO(분)" value={p.recovery.rpo_min} step={5} hint="장애 때 잃어도 되는 데이터의 시간. 백업 주기·시점 복구·리전 복제 지연과 비교해요" onChange={(v) => set({ recovery: { ...p.recovery!, rpo_min: v === undefined || v < 0 ? undefined : v } })} />
        </>}
      </Section>

      <AppSection />
    </div>
  );
}

/** 이 PC의 앱 설정 (프로젝트 파일에 들어가지 않음) */
function AppSection() {
  const [on, setOn] = useState(updateCheckOn);
  return (
    <Section id="s-app" title="앱" desc="이 PC의 앱 설정이에요. 프로젝트 파일에는 들어가지 않아요.">
      <Row label="앱을 열 때 새 버전 확인" hint="앱을 열 때 GitHub에 최신 릴리스 주소와 (새 버전이면) 릴리스 노트만 물어요. 프로젝트·데이터 값은 보내지 않아요">
        <input type="checkbox" checked={on} disabled={!desktop} onChange={(e) => { setUpdateCheck(e.target.checked); setOn(e.target.checked); }} />
      </Row>
      {!desktop && <p className="muted">설치형 데스크톱 앱에서만 확인해요.</p>}
    </Section>
  );
}

/** 가격표에서 이 단위로 파는 상품 키 목록 */
const productsOf = (unit: PriceRow['unit']) => [...new Set(prices.filter((r) => r.unit === unit).map((r) => r.product ?? r.id))];

/** 행동: 한 번 일어나면 어느 테이블에 몇 행을 쓰는지, 접속당 빈도. 아래 표는 페르소나별 빈도(비우면 기본값) */
export function ActionsSection() {
  const { project: p, edit } = usePick('project', 'edit');
  const targets = p.nodes.flatMap((n) => n.tables.map((t) => ({ key: `${n.id}.${t.name}`, node: n.id, table: t.name, label: `${n.name}.${t.name}` })));
  if (!targets.length && !p.actions.length) {
    return <Section id="s-act" title="행동"><p className="muted">DB·캐시·분석 노드에 테이블을 넣으면 행동(주문, 리뷰 …)으로 테이블에 쓰는 양을 정할 수 있습니다.</p></Section>;
  }
  return (
    <Section id="s-act" title={`행동 (${p.actions.length})`} desc="사용자가 서비스에서 하는 일과 그때 쓰는 테이블이에요.">
      {p.actions.map((a) => {
        const upd = (patch: Parameters<typeof updateAction>[2]) => edit((x) => updateAction(x, a.name, patch));
        const setWrite = (i: number, patch: Partial<(typeof a.writes)[number]>) => upd({ writes: patchAt(a.writes, i, patch) });
        // 이 행동이 아직 안 쓰는 첫 테이블
        const free = targets.find((t) => !a.writes.some((w) => w.node === t.node && w.table === t.table));
        return (
          <div key={a.name} className="action">
            <div className="inline">
              <input aria-label="행동 이름" defaultValue={a.name} onBlur={(e) => e.target.value && e.target.value !== a.name && upd({ name: e.target.value })} />
              <label className="muted">접속당 <NumInput step={0.01} value={a.per_session} onChange={(e) => upd({ per_session: Number(e.target.value) || 0 })} />회</label>
              <button aria-label="행동 삭제" onClick={() => edit((x) => removeAction(x, a.name))}>×</button>
            </div>
            {a.writes.map((w, i) => (
              <div key={i} className="inline write">
                <span className="muted">→</span>
                <Select aria-label="쓰는 테이블" value={`${w.node}.${w.table}`} onChange={(e) => {
                  const t = targets.find((x) => x.key === e.target.value)!;
                  setWrite(i, { node: t.node, table: t.table });
                }}>
                  {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                </Select>
                <NumInput aria-label="행 수" value={w.rows} onChange={(e) => setWrite(i, { rows: Number(e.target.value) || 1 })} />행
                {a.writes.length > 1 && <button aria-label="쓰기 삭제" onClick={() => upd({ writes: a.writes.filter((_, k) => k !== i) })}>×</button>}
              </div>
            ))}
            {free && <button onClick={() => upd({ writes: [...a.writes, { node: free.node, table: free.table, rows: 1 }] })}>테이블 추가</button>}
          </div>
        );
      })}
      {targets.length > 0 && <button onClick={() => edit(addAction)}>행동 추가</button>}

      {p.actions.length > 0 && p.personas.length > 0 && <>
        <p className="muted">페르소나별 접속당 빈도 — 비우면 위의 기본값</p>
        <div className="plans"><table className="grid">
          <thead><tr><th>페르소나</th>{p.actions.map((a) => <th key={a.name}>{a.name}</th>)}</tr></thead>
          <tbody>{p.personas.map((ps, i) => (
            <tr key={i}>
              <td>{ps.name}</td>
              {p.actions.map((a) => (
                <td key={a.name}><NumInput step={0.01} placeholder={String(a.per_session)} value={ps.action_rates[a.name] ?? ''}
                  onChange={(e) => edit((x) => setActionRate(x, i, a.name, e.target.value === '' ? undefined : Number(e.target.value)))} /></td>
              ))}
            </tr>
          ))}</tbody>
        </table></div>
      </>}
    </Section>
  );
}

/** 로컬 실행 메모리 입력: 런타임 + 시작할 때 올리는 라이브러리 합 + 필요할 때 올리는 것 중 가장 큰 하나 + 캐시 */
function LocalMemory() {
  const { project: p, edit } = usePick('project', 'edit');
  const mem = p.deploy.memory ?? { runtime_mb: 0, eager_mb: [], lazy_mb: [] };
  const setMem = (patch: Partial<typeof mem>) => edit((x) => ({ ...x, deploy: { ...x.deploy, memory: { ...mem, ...patch } } }));
  const nums = (s: string) => s.split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v >= 0 && s.trim() !== '');
  return <>
    <NumField label="기기 메모리(GB)" value={p.deploy.device_spec?.memGb} onChange={(v) => edit((x) => ({ ...x, deploy: { ...x.deploy, device_spec: { ...x.deploy.device_spec, memGb: v } } }))} />
    <NumField label="런타임(MB)" value={p.deploy.memory?.runtime_mb} hint="Electron·JVM·Python 등 실행 환경 자체" onChange={(v) => setMem({ runtime_mb: v ?? 0 })} />
    <Row label="상시 로드(MB)" hint="시작할 때 올리는 라이브러리, 쉼표로 구분">
      {/* 다른 프로젝트를 열면 값이 바뀌므로 key로 칸을 새로 그린다 */}
      <input key={mem.eager_mb.join()} defaultValue={mem.eager_mb.join(', ')} onBlur={(e) => setMem({ eager_mb: nums(e.target.value) })} />
    </Row>
    <Row label="지연 로드(MB)" hint="필요할 때 올리는 라이브러리, 쉼표로 구분 (가장 큰 하나만 더함)">
      <input key={mem.lazy_mb.join()} defaultValue={mem.lazy_mb.join(', ')} onBlur={(e) => setMem({ lazy_mb: nums(e.target.value) })} />
    </Row>
    <NumField label="데이터 캐시(MB)" value={p.deploy.memory?.cache_mb} onChange={(v) => setMem({ cache_mb: v })} />
  </>;
}
