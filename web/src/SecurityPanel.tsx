// 네트워크·보안 칸 (노드·연결선 패널)과 점검 결과 목록 (노드 패널·전체 결과)
import type { Analysis } from '../../engine/analyze';
import type { ProjectEdge, ProjectNode } from '../../engine/schema';
import { EDGE_NET_NAMES, EDGE_TLS_NAMES, EXPOSURE_NAMES, LEVEL_MARK, relevant, SECRET_NAMES, SECURITY_FIELD_NAMES, TENANT_NAMES, edgeNet, type SecurityHit } from '../../engine/security';
import { Fragment } from 'react';
import { NumField, Row, Section } from './fields';
import { Select } from './Select';
import { usePick } from './store';
import { updateEdge, updateNode } from './edit';

type NodeSec = NonNullable<ProjectNode['security']>;
type EdgeSec = NonNullable<ProjectEdge['security']>;
/** 칸 하나를 바꾼 보안 값. 비우면 그 칸을 지우고, 다 비면 security 자체를 지운다 (미정) */
function patched<T extends object>(cur: T | undefined, key: keyof T, v: unknown): T | undefined {
  const next = { ...cur } as Record<string, unknown>;
  if (v === undefined) delete next[key as string]; else next[key as string] = v;
  return Object.keys(next).length ? (next as T) : undefined;
}

const UNSET = '미정';
function Pick<K extends string>({ label, value, names, onChange, hint }: { label: string; value?: K; names: Record<K, string>; onChange: (v: K | undefined) => void; hint?: string }) {
  return (
    <Row label={label} hint={hint}>
      <Select aria-label={label} value={value ?? ''} onChange={(e) => onChange((e.target.value || undefined) as K | undefined)}>
        <option value="">{UNSET}</option>
        {(Object.keys(names) as K[]).map((k) => <option key={k} value={k}>{names[k]}</option>)}
      </Select>
    </Row>
  );
}
const ONOFF = { on: '켬', off: '끔' } as const;
const toBool = (v?: 'on' | 'off') => (v === undefined ? undefined : v === 'on');
const fromBool = (b?: boolean) => (b === undefined ? undefined : b ? 'on' : 'off');

/** 점검 결과 줄들 */
export function SecurityList({ hits, empty }: { hits: SecurityHit[]; empty?: string }) {
  if (!hits.length) return empty ? <p className="muted">{empty}</p> : null;
  return <>{hits.map((h, i) => (
    <div key={i} className={`judge v-${h.level === 'info' ? 'ok' : h.level}`}>
      <b>{LEVEL_MARK[h.level]} {h.target}</b>
      <div>{h.why}</div>
      <div className="muted">→ {h.instead}</div>
    </div>
  ))}</>;
}

const HINTS: Partial<Record<keyof NodeSec, string>> = {
  exposure: '인터넷에서 바로 닿는지, 내부망에서만인지, 같은 서버·사설 구역 안에서만인지. 캔버스의 구역 틀과 같은 값이에요',
  tls: '이 노드가 받는 연결을 TLS(HTTPS·DB SSL)로 받는지',
  at_rest: 'DB·디스크·백업을 암호화해 저장하는지 (관리형 DB는 대개 기본값)',
  secrets: 'DB 비밀번호·API 키를 어디에 두는지. 화면(앱)에 두면 누구나 볼 수 있어요',
  waf: '알려진 공격 요청을 거르는 웹 방화벽 (CDN·클라우드 WAF)',
  rate_limit: '사용자·IP별 요청 수 제한',
  audit_log: '누가 언제 무엇을 열람·변경했는지 남기는 로그',
  tenant_isolation: '여러 고객(매장·회사) 데이터가 한 테이블에 있을 때 서로 못 보게 하는 방법',
};

export function NodeSecuritySection({ node: n, analysis }: { node: ProjectNode; analysis?: Analysis }) {
  const { project, edit } = usePick('project', 'edit');
  const s = n.security ?? {};
  const set = (key: keyof NodeSec, v: unknown) => edit((p) => updateNode(p, n.id, { security: patched<NodeSec>(n.security, key, v) }));
  const fields = relevant(project, n);
  const hits = analysis?.security.filter((h) => h.node === n.id) ?? [];
  // 엔진과 같게: 한도 값이 있으면 속도 제한 켬. 끔·미정으로 바꾸면 한도도 지움
  const rateOn = s.rate_limit === true || s.rate_limit_rpm !== undefined;
  const setRate = (on: boolean | undefined, rpm?: number) => edit((p) => updateNode(p, n.id, { security: patched<NodeSec>(patched<NodeSec>(n.security, 'rate_limit', on), 'rate_limit_rpm', rpm) }));
  // 감사 로그를 끔·미정으로 바꾸면 보관 기간도 지움
  const setAudit = (on: boolean | undefined) => edit((p) => updateNode(p, n.id, { security: patched<NodeSec>(patched<NodeSec>(n.security, 'audit_log', on), 'audit_retention_months', undefined) }));
  const bool = (key: 'tls' | 'at_rest' | 'waf' | 'rate_limit' | 'audit_log') => (
    <Fragment key={key}>
      <Pick label={SECURITY_FIELD_NAMES[key]} hint={HINTS[key]} value={fromBool(key === 'rate_limit' && rateOn ? true : s[key])} names={ONOFF} onChange={(v) => (key === 'rate_limit' ? setRate(toBool(v)) : key === 'audit_log' && v !== 'on' ? setAudit(toBool(v)) : set(key, toBool(v)))} />
      {key === 'rate_limit' && rateOn && (
        <NumField label="클라이언트당 분당 요청 한도" value={s.rate_limit_rpm} step={1} hint="사용자·IP 하나가 1분에 보낼 수 있는 요청 수. 트래픽과 대조해 너무 낮거나 느슨하면 아래에 알립니다 (단위 /분)"
          onChange={(v) => (v && v > 0 ? setRate(true, v) : setRate(true))} />
      )}
      {key === 'audit_log' && s.audit_log === true && (
        <NumField label="감사 로그 보관 기간(개월)" value={s.audit_retention_months} step={1} hint="접속기록을 몇 달 보관하는지. 개인정보 안전성 확보조치 기준은 1년, 5만 명 이상·고유식별정보·민감정보는 2년"
          onChange={(v) => set('audit_retention_months', v && v > 0 ? Math.round(v) : undefined)} />
      )}
    </Fragment>
  );
  return (
    <Section title="네트워크·보안" desc={fields.length ? '비어 있는 칸은 "미정"으로 판정에서 확인 필요로 알려요.' : '이 노드는 우리가 정할 보안 칸이 없어요 (외부 서비스는 그 회사가 관리).'}>
      {fields.includes('exposure') && <Pick label={SECURITY_FIELD_NAMES.exposure} hint={HINTS.exposure} value={s.exposure} names={EXPOSURE_NAMES} onChange={(v) => set('exposure', v)} />}
      {(['tls', 'at_rest'] as const).filter((k) => fields.includes(k)).map(bool)}
      {fields.includes('secrets') && <Pick label={SECURITY_FIELD_NAMES.secrets} hint={HINTS.secrets} value={s.secrets} names={SECRET_NAMES} onChange={(v) => set('secrets', v)} />}
      {(['waf', 'rate_limit', 'audit_log'] as const).filter((k) => fields.includes(k)).map(bool)}
      {fields.includes('tenant_isolation') && <Pick label={SECURITY_FIELD_NAMES.tenant_isolation} hint={HINTS.tenant_isolation} value={s.tenant_isolation} names={TENANT_NAMES} onChange={(v) => set('tenant_isolation', v)} />}
      <SecurityList hits={hits} />
    </Section>
  );
}

export function EdgeSecuritySection({ edge: e, analysis }: { edge: ProjectEdge; analysis?: Analysis }) {
  const { project, edit } = usePick('project', 'edit');
  const set = (key: keyof EdgeSec, v: unknown) => edit((p) => updateEdge(p, e.from, e.to, { security: patched<EdgeSec>(e.security, key, v) }));
  // 비우면 undefined (JSON 저장에서 빠지고 점검은 !== undefined로 본다)
  const setCall = (key: 'timeout_ms' | 'retries' | 'breaker', v: unknown) => edit((p) => updateEdge(p, e.from, e.to, { [key]: v }));
  const guessed = !e.security?.crosses && edgeNet(project, e);
  const hits = analysis?.security.filter((h) => h.edge?.[0] === e.from && h.edge[1] === e.to) ?? [];
  return (
    <Section title="네트워크·보안">
      <Pick label="암호화" value={e.security?.tls} names={EDGE_TLS_NAMES} onChange={(v) => set('tls', v)} hint="이 연결로 오가는 데이터를 암호화하는지. 서비스끼리 서로를 확인하려면 mTLS" />
      <Pick label="지나는 망" value={e.security?.crosses} names={EDGE_NET_NAMES} onChange={(v) => set('crosses', v)}
        hint={guessed ? `비우면 "${EDGE_NET_NAMES[guessed]}"으로 짐작해요 (화면·외부 서비스·다른 클라우드와 잇는 선은 인터넷)` : '같은 서버·내부망·인터넷 중 어디를 지나는지'} />
      {e.sync && <>
        <NumField label="타임아웃(ms)" value={e.timeout_ms} step={1} hint="받는 쪽이 이보다 오래 걸리면 끊어요. 받는 노드 p99의 1.5~2배가 보통" onChange={(v) => setCall('timeout_ms', v !== undefined && v > 0 ? v : undefined)} />
        <NumField label="재시도 횟수" value={e.retries} step={1} hint="첫 시도 뒤 다시 보내는 횟수. 1회·지수 백오프 권장" onChange={(v) => setCall('retries', v !== undefined && v >= 0 ? Math.round(v) : undefined)} />
        <Pick label="서킷 브레이커" value={fromBool(e.breaker)} names={ONOFF} onChange={(v) => setCall('breaker', toBool(v))} hint="연속으로 실패하면 잠시 호출을 끊어 받는 쪽이 살아나게 하는 장치" />
      </>}
      <SecurityList hits={hits} />
    </Section>
  );
}
