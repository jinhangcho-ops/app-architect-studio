// 네트워크·보안 칸 (노드·연결선 패널)과 점검 결과 목록 (노드 패널·전체 결과)
import type { Analysis } from '../../engine/analyze';
import type { ProjectEdge, ProjectNode } from '../../engine/schema';
import { EDGE_NET_NAMES, EDGE_TLS_NAMES, EXPOSURE_NAMES, LEVEL_MARK, relevant, SECRET_NAMES, SECURITY_FIELD_NAMES, TENANT_NAMES, edgeNet, type SecurityHit } from '../../engine/security';
import { Row, Section } from './fields';
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
  const { edit } = usePick('edit');
  const s = n.security ?? {};
  const set = (key: keyof NodeSec, v: unknown) => edit((p) => updateNode(p, n.id, { security: patched<NodeSec>(n.security, key, v) }));
  const fields = relevant(n);
  const hits = analysis?.security.filter((h) => h.node === n.id) ?? [];
  const bool = (key: 'tls' | 'at_rest' | 'waf' | 'rate_limit' | 'audit_log') => (
    <Pick key={key} label={SECURITY_FIELD_NAMES[key]} hint={HINTS[key]} value={fromBool(s[key])} names={ONOFF} onChange={(v) => set(key, toBool(v))} />
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
  const guessed = !e.security?.crosses && edgeNet(project, e);
  const hits = analysis?.security.filter((h) => h.edge?.[0] === e.from && h.edge[1] === e.to) ?? [];
  return (
    <Section title="네트워크·보안">
      <Pick label="암호화" value={e.security?.tls} names={EDGE_TLS_NAMES} onChange={(v) => set('tls', v)} hint="이 연결로 오가는 데이터를 암호화하는지. 서비스끼리 서로를 확인하려면 mTLS" />
      <Pick label="지나는 망" value={e.security?.crosses} names={EDGE_NET_NAMES} onChange={(v) => set('crosses', v)}
        hint={guessed ? `비우면 "${EDGE_NET_NAMES[guessed]}"으로 짐작해요 (화면·외부 서비스·다른 클라우드와 잇는 선은 인터넷)` : '같은 서버·내부망·인터넷 중 어디를 지나는지'} />
      <SecurityList hits={hits} />
    </Section>
  );
}
