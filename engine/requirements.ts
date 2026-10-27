// requirements.txt → 패키지별 버전. FastAPI 뼈대가 그 버전에서 돌아가는 문법을 고르는 데 쓴다.
// 읽을 수 없는 줄·설치 옵션 줄은 건너뛰고 "N번째 줄: 이유"로 알려 준다. 판단은 허용되는 가장 낮은 버전으로 한다 (그 버전에서도 돌아야 하므로).

export type Requirement = {
  /** PEP 503 정규화 이름 (PyJWT → pyjwt, typing_extensions → typing-extensions) */
  name: string;
  extras: string[];
  /** 버전 조건 원문 (==2.14.1, >=0.100,<1 …). 없으면 '' */
  spec: string;
  /** 조건이 허용하는 가장 낮은 버전. 하한이 없으면(<1, 조건 없음, URL 설치) undefined */
  min?: string;
  /** 환경 표시 (; python_version < "3.9" 뒤) */
  marker?: string;
  line: number;
};
export type RequirementsResult = { reqs: Requirement[]; skipped: string[] };

export const normName = (n: string) => n.trim().toLowerCase().replace(/[-_.]+/g, '-');

/** 버전 비교: 앞의 숫자 부분(1.2.3)만 본다. 2.0.0a1 같은 사전 배포는 2.0.0으로 친다 */
export function cmpVersion(a: string, b: string): number {
  const nums = (v: string) => (v.match(/^\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number);
  const x = nums(a), y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

const NAME = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(?:\[([^\]]*)\])?\s*(.*)$/;
const CLAUSE = /^(===|==|~=|>=|<=|!=|>|<)\s*([0-9][0-9A-Za-z.*+!_-]*)$/;

/** 버전 조건 → 허용되는 가장 낮은 버전 (조건이 여럿이면 하한 중 가장 높은 것). 읽지 못하면 null */
function lowest(spec: string): string | undefined | null {
  if (!spec) return undefined;
  let min: string | undefined;
  for (const raw of spec.split(',')) {
    const m = CLAUSE.exec(raw.trim());
    if (!m) return null;
    const [, op, v] = m;
    // ==2.* 는 2.0부터, >0.99는 0.99 바로 위지만 문법이 바뀌는 경계는 0.100 같은 배포 번호라 0.99로 봐도 같은 규칙을 고른다
    if (op === '<' || op === '<=' || op === '!=') continue;
    const base = v.replace(/(\.\*)+$/, '').replace(/\.?\*.*$/, '') || '0';
    if (!min || cmpVersion(base, min) > 0) min = base;
  }
  return min;
}

export function parseRequirements(text: string): RequirementsResult {
  const reqs: Requirement[] = [], skipped: string[] = [];
  // 줄 끝 \ 는 다음 줄과 이어진다
  const lines = text.replace(/^\uFEFF/, '').replace(/\\\r?\n/g, ' ').split(/\r?\n/);
  lines.forEach((full, i) => {
    const line = i + 1;
    // 줄 처음이나 공백 뒤 #부터는 주석 (URL의 #egg= 는 주석이 아님)
    const s = full.replace(/(^|\s)#.*$/, '').trim();
    if (!s) return;
    if (s.startsWith('-')) { skipped.push(`${line}번째 줄: 설치 옵션(${s.split(/\s/)[0]})은 버전 판단에 쓰지 않습니다`); return; }
    if (/^(\.{0,2}[\\/]|[a-z+]+:\/\/|git\+)/i.test(s)) { skipped.push(`${line}번째 줄: 이름 없이 경로·주소로 설치하는 줄이라 버전을 모릅니다`); return; }
    // 줄 뒤 옵션(--hash=sha256:… 등)은 버전과 상관없어 뗀다
    const [body, marker] = s.replace(/\s+--[\w-]+(=\S+)?/g, '').split(/;(.*)/s).map((x) => x?.trim());
    const m = NAME.exec(body);
    if (!m) { skipped.push(`${line}번째 줄: 패키지 이름을 읽지 못했습니다 (${s})`); return; }
    const [, name, extras = '', rest] = m;
    // name @ https://… 는 주소로 설치 → 이름은 알지만 버전은 모름
    const spec = rest.startsWith('@') ? '' : rest.replace(/^\((.*)\)$/, '$1').replace(/\s+/g, '');
    const min = lowest(spec);
    if (min === null) { skipped.push(`${line}번째 줄: 버전 조건을 읽지 못했습니다 (${rest})`); return; }
    reqs.push({ name: normName(name), extras: extras.split(',').map((x) => x.trim()).filter(Boolean), spec, ...(min && { min }), ...(marker && { marker }), line });
  });
  return { reqs, skipped };
}

/** 환경 표시가 python_version 비교 하나(python_version < "3.12")면 그 Python에서 맞는지. 그 밖의 표시는 모름(undefined) */
export function markerHolds(marker: string, python: string): boolean | undefined {
  const m = /^python_version\s*(<=|>=|==|!=|<|>)\s*["']([\d.]+)["']$/.exec(marker.trim());
  if (!m) return undefined;
  // python_version은 주.부 버전(3.12)만 본다
  const d = cmpVersion(python.split('.').slice(0, 2).join('.'), m[2]);
  return { '<': d < 0, '<=': d <= 0, '>': d > 0, '>=': d >= 0, '==': d === 0, '!=': d !== 0 }[m[1]];
}

const highest = (vs: (string | undefined)[]) => vs.filter((v): v is string => !!v).reduce<string | undefined>((a, b) => (!a || cmpVersion(b, a) > 0 ? b : a), undefined);

/** 환경마다 pip가 적용하는 조건들. 환경 표시 없는 줄은 어디서나 함께(그리고) 적용되고, 환경 표시 줄은 그 환경에서 그 위에 더해진다.
 *  그래서 [표시 없는 줄만(표시가 맞지 않는 환경), 표시 줄마다 표시 없는 줄 + 그 줄] — 판단은 이 중 어느 환경에서도 맞아야 한다 */
function specsOf(r: RequirementsResult, name: string): { spec: string; min?: string }[] {
  const lines = r.reqs.filter((x) => x.name === normName(name));
  const plain = lines.filter((x) => !x.marker);
  const join = (xs: Requirement[]) => ({ spec: xs.map((x) => x.spec).filter(Boolean).join(','), min: highest(xs.map((x) => x.min)) });
  return [...(plain.length ? [join(plain)] : []), ...lines.filter((x) => x.marker).map((m) => join([...plain, m]))];
}

/** 패키지의 모든 조건이 bound보다 낮은 버전만 허용하는지 (pydantic<2, fastapi<=0.99). 하한 없이 상한만 적으면 pip가 그 아래 버전을 깔므로 */
export function allBelow(r: RequirementsResult, name: string, bound: string): boolean {
  const lines = specsOf(r, name);
  return lines.length > 0 && lines.every((x) => x.spec.split(',').some((c) => {
    const m = CLAUSE.exec(c.trim());
    return !!m && ((m[1] === '<' && cmpVersion(m[2], bound) <= 0) || (m[1] === '<=' && cmpVersion(m[2], bound) < 0));
  }));
}

/** 패키지의 판단 버전. 같은 이름이 여러 줄이면(환경 표시별 등) 하한 중 가장 낮은 것 — 어느 환경에서도 돌아야 하므로 */
export function versionOf(r: RequirementsResult, name: string): string | undefined {
  const mins = specsOf(r, name).map((x) => x.min);
  if (!mins.length || mins.some((v) => v === undefined)) return undefined;
  return (mins as string[]).reduce((a, b) => (cmpVersion(a, b) <= 0 ? a : b));
}
