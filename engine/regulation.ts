// 15절 규정 검사: 개인정보를 다루는 노드에 "법령명 제N조 확인 필요"만 붙인다. 조문 내용은 해석하지 않는다.
import { test, type Vars } from './expr';
import { REGION_COUNTRY, type LawRow, type Project, type ProjectNode } from './schema';

export type LawHit = { nodeId: string; law: string; article: string; reason: string; verified: boolean; source: string; asOf: string };

/** 노드 하나의 트리거 변수. subject_KR처럼 나라마다 참거짓 변수를 만든다 */
export function privacyVars(n: ProjectNode, countries: string[]): Vars | undefined {
  const pv = n.privacy;
  if (!pv?.personal) return undefined;
  const store = n.region === undefined ? 'unknown' : n.region === 'local' ? 'local' : REGION_COUNTRY[n.region];
  return {
    personal: pv.personal,
    sensitive: pv.sensitive,
    unique_id: pv.unique_id,
    sends_external: pv.sends_external,
    store_country: store,
    ...Object.fromEntries(countries.map((c) => [`subject_${c}`, pv.subjects.includes(c)])),
  };
}

const NAMES: Record<string, string> = { KR: '한국', JP: '일본', local: '사용자 기기', unknown: '미정' };
const fill = (s: string, v: Vars) => s.replace(/\{(\w+)\}/g, (m, k: string) => (k in v ? NAMES[String(v[k])] ?? String(v[k]) : m));

export function checkRegulation(p: Project, laws: LawRow[]): LawHit[] {
  // 법령 표가 쓰는 subject_XX 변수를 빠짐없이 만들어 '없는 변수' 오류를 막는다
  const countries = [...new Set([...laws.flatMap((l) => [...l.trigger.matchAll(/subject_([A-Z]{2})/g)].map((m) => m[1])), ...p.nodes.flatMap((n) => n.privacy?.subjects ?? [])])];
  const hits: LawHit[] = [];
  for (const n of p.nodes) {
    const v = privacyVars(n, countries);
    if (!v) continue;
    for (const l of laws) {
      if (test(l.trigger, v)) hits.push({ nodeId: n.id, law: l.law, article: l.article, reason: fill(l.reason, v), verified: l.verified, source: l.source, asOf: l.as_of });
    }
  }
  return hits;
}
