import { Persona, REGIONS, Scale, PATTERN_IDS, type PriceRow, type Project } from '../../engine/schema';
import { prices } from './data';
import { PATTERNS } from '../../engine/traffic';
import { STANDARD_OFFSET } from '../../engine/timezones';
import { NumField, Row, Section, TextField } from './fields';
import { useStore } from './store';

const MODES: [Project['deploy']['mode'], string][] = [
  ['web', '웹 (브라우저 + 서버)'], ['mobile', '모바일 앱'], ['local_exe', '로컬 데스크톱(exe)'], ['hybrid', '하이브리드 (로컬 + 동기화)'], ['server', '서버 전용'],
];

export function ProjectPanel() {
  const { project: p, edit } = useStore();
  const set = (patch: Partial<Project>) => edit((x) => ({ ...x, ...patch }));
  const setScale = (patch: Partial<NonNullable<Project['scale']>>) => p.scale && set({ scale: { ...p.scale, ...patch } });
  const setPersona = (i: number, patch: Partial<Project['personas'][number]>) =>
    set({ personas: p.personas.map((x, k) => (k === i ? { ...x, ...patch } : x)) });
  const shareSum = p.personas.reduce((s, x) => s + x.share, 0);

  return (
    <div className="panel">
      <Section title="프로젝트">
        <TextField label="이름" value={p.name} onChange={(v) => set({ name: v })} />
      </Section>

      <Section title="구동 방식">
        <Row label="방식">
          <select value={p.deploy.mode} onChange={(e) => set({ deploy: { ...p.deploy, mode: e.target.value as Project['deploy']['mode'] } })}>
            {MODES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Row>
        <Row label="오프라인 필요"><input type="checkbox" checked={p.deploy.offline_required} onChange={(e) => set({ deploy: { ...p.deploy, offline_required: e.target.checked } })} /></Row>
        <Row label="사용 범위">
          <select value={p.deploy.scope} onChange={(e) => set({ deploy: { ...p.deploy, scope: e.target.value as Project['deploy']['scope'] } })}>
            <option value="single">혼자</option><option value="team">팀·사내</option><option value="public">공개 서비스</option>
          </select>
        </Row>
      </Section>

      <Section title="규모">
        {!p.scale && <button onClick={() => set({ scale: Scale.parse({ users: 100000 }) })}>규모 입력하기</button>}
        {p.scale && <>
          <NumField label="활성 사용자" value={p.scale.users} step={1000} onChange={(v) => v && setScale({ users: v })} />
          <NumField label="이벤트 배수" value={p.scale.event_multiplier} onChange={(v) => setScale({ event_multiplier: v ?? 1 })} />
          <NumField label="창 안 비율" value={p.scale.window_share} step={0.05} hint="깨어 있는 시간대에 들어오는 접속 비율" onChange={(v) => setScale({ window_share: v ?? 0.8 })} />
          <Row label="기준 나라">
            <select value={p.scale.report_country} onChange={(e) => setScale({ report_country: e.target.value })}>
              {Object.keys(STANDARD_OFFSET).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Row>
          <NumField label="시드" value={p.scale.seed} step={1} onChange={(v) => setScale({ seed: v ?? 1 })} />
          <NumField label="목표 사용률" value={p.target_utilization} step={0.05} onChange={(v) => v && set({ target_utilization: v })} />
        </>}
      </Section>

      <Section title={`페르소나 (비율 합 ${(shareSum * 100).toFixed(0)}%)`}>
        {p.personas.map((ps, i) => (
          <div key={i} className="persona">
            <input value={ps.name} onChange={(e) => setPersona(i, { name: e.target.value })} aria-label="이름" />
            <select value={ps.pattern} onChange={(e) => setPersona(i, { pattern: e.target.value as typeof ps.pattern })} aria-label="패턴">
              {PATTERN_IDS.map((id) => <option key={id} value={id}>{PATTERNS[id].label}</option>)}
            </select>
            <input type="number" step={0.05} value={ps.share} onChange={(e) => setPersona(i, { share: Number(e.target.value) })} aria-label="비율" />
            <select value={ps.country} onChange={(e) => setPersona(i, { country: e.target.value })} aria-label="나라">
              {Object.keys(STANDARD_OFFSET).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <button onClick={() => set({ personas: p.personas.filter((_, k) => k !== i) })} aria-label="삭제">×</button>
          </div>
        ))}
        <button onClick={() => set({ personas: [...p.personas, Persona.parse({ name: '새 페르소나', pattern: 'regular', share: 0 })] })}>페르소나 추가</button>
        {p.personas.length > 0 && Math.abs(shareSum - 1) > 1e-6 && <p className="warn">비율 합이 100%여야 계산합니다.</p>}
      </Section>

      <Section title="비용 기준">
        <Row label="기본 리전">
          <select value={p.cost.region ?? ''} onChange={(e) => set({ cost: { ...p.cost, region: (e.target.value || undefined) as typeof p.cost.region } })}>
            <option value="">(없음)</option>
            {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Row>
        {([['저장 (GB·월)', 'storage', 'gb_month'], ['인터넷 송신 (GB)', 'egress', 'gb'], ['리전 간 전송 (GB)', 'transfer', 'gb_interregion']] as const).map(([label, key, unit]) => (
          <Row key={key} label={label}>
            <select value={p.cost[key] ?? ''} onChange={(e) => set({ cost: { ...p.cost, [key]: e.target.value || undefined } })}>
              <option value="">(계산 안 함)</option>
              {productsOf(unit).map((x) => <option key={x} value={x}>{x}</option>)}
            </select>
          </Row>
        ))}
        <p className="muted">노드 비용은 주 항목의 과금 방식(대수×시간·사용량·월 정액)과 노드 리전으로 가격표에서 찾습니다.</p>
      </Section>

      <Section title="성장">
        {!p.growth && <button onClick={() => set({ growth: { monthly_rate: 0.1, months: 24, lead_months: 3 } })}>성장률 입력하기</button>}
        {p.growth && <>
          <NumField label="월 성장률" value={p.growth.monthly_rate} step={0.01} onChange={(v) => set({ growth: { ...p.growth!, monthly_rate: v ?? 0 } })} />
          <NumField label="준비 기간(월)" value={p.growth.lead_months} step={1} onChange={(v) => set({ growth: { ...p.growth!, lead_months: v ?? 0 } })} />
          <button onClick={() => set({ growth: undefined })}>성장률 지우기</button>
        </>}
      </Section>
    </div>
  );
}

/** 가격표에서 이 단위로 파는 상품 키 목록 */
const productsOf = (unit: PriceRow['unit']) => [...new Set(prices.filter((r) => r.unit === unit).map((r) => r.product ?? r.id))];
