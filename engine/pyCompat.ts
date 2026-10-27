// FastAPI 뼈대를 노드의 requirements.txt·Python 버전에 맞추는 규칙표.
// 버전 목록이 없으면 지금 기본(최신 방식)과 똑같이 만든다. 경계 버전의 근거는 각 줄 주석 (2026-10-27 확인).
import { cmpVersion, parseRequirements, versionOf } from './requirements';

/** 뼈대에서 버전에 따라 고르는 문법 */
export type PyProfile = {
  /** pydantic 주 버전 */
  pydantic: 1 | 2;
  /** pydantic 2.11+: populate_by_name 대신 validate_by_name·validate_by_alias */
  validateByName: boolean;
  /** fastapi 0.95+: 인자를 Annotated[T, Path(...)]로 (아니면 = Path(...) 기본값 꼴) */
  annotated: boolean;
  /** Python 3.9+: dict[str, Any]·list[Any] (아니면 typing의 Dict·List) */
  builtinGenerics: boolean;
  /** Python 3.9 미만: Annotated를 typing_extensions에서 */
  annotatedFromExtensions: boolean;
  /** 실행 안내: fastapi 0.112+ "fastapi[standard]" + fastapi dev, 0.111은 fastapi + fastapi dev, 그 전은 uvicorn */
  run: 'standard' | 'cli' | 'uvicorn';
  /** 뼈대 머리 주석에 적을 기준 (버전 목록이 없으면 빈 배열) */
  basis: string[];
  /** 조합 오류·확인 범위 밖 (명세 점검과 뼈대 머리 주석에 나온다) */
  warnings: string[];
};

/** 이 규칙표를 공식 변경 기록과 맞춰 본 마지막 버전. 이보다 새 버전은 최신 규칙을 쓰고 알린다 */
export const CHECKED = { fastapi: '0.162.0', pydantic: '2.12', python: '3.14' };

/** 버전 목록이 없을 때 = 지금까지 만들던 뼈대 */
const LATEST: PyProfile = { pydantic: 2, validateByName: false, annotated: true, builtinGenerics: true, annotatedFromExtensions: false, run: 'standard', basis: [], warnings: [] };

const atLeast = (v: string | undefined, min: string) => v === undefined || cmpVersion(v, min) >= 0;

export function pyProfile(node: { requirements?: string; python?: string }): PyProfile {
  if (!node.requirements?.trim() && !node.python) return LATEST;
  const r = parseRequirements(node.requirements ?? '');
  const fa = versionOf(r, 'fastapi'), pd = versionOf(r, 'pydantic'), py = node.python;
  const warnings: string[] = [];
  const listed = (name: string) => r.reqs.some((x) => x.name === name);
  if (node.requirements?.trim() && !listed('fastapi')) warnings.push('requirements.txt에 fastapi가 없습니다');

  // pydantic 주 버전: 적혀 있으면 그것, 없으면 fastapi 버전으로 짐작 (0.100 전 fastapi는 pydantic 1만 받음)
  const pydantic: 1 | 2 = pd !== undefined ? (cmpVersion(pd, '2') >= 0 ? 2 : 1) : fa !== undefined && cmpVersion(fa, '0.100') < 0 ? 1 : 2;
  // 함께 쓸 수 없는 조합 (fastapi 릴리스 노트: 0.100.0 pydantic 2 지원, 0.126.0 pydantic 1 지원 중단, 0.135.2 pydantic >=2.9, 0.125.0·0.129.0 Python 3.8·3.9 중단)
  if (fa && pd) {
    if (pydantic === 2 && cmpVersion(fa, '0.100') < 0) warnings.push(`fastapi ${fa}는 pydantic 2를 쓰지 못합니다 (0.100부터)`);
    if (pydantic === 1 && cmpVersion(fa, '0.126') >= 0) warnings.push(`fastapi ${fa}는 pydantic 1을 쓰지 못합니다 (0.126부터 2만)`);
    if (pydantic === 2 && cmpVersion(fa, '0.135.2') >= 0 && cmpVersion(pd, '2.9') < 0) warnings.push(`fastapi ${fa}는 pydantic 2.9 이상이 필요합니다 (지금 ${pd})`);
  }
  if (fa && py) {
    if (cmpVersion(fa, '0.129') >= 0 && cmpVersion(py, '3.10') < 0) warnings.push(`fastapi ${fa}는 Python 3.10 이상이 필요합니다 (지금 ${py})`);
    else if (cmpVersion(fa, '0.125') >= 0 && cmpVersion(py, '3.9') < 0) warnings.push(`fastapi ${fa}는 Python 3.9 이상이 필요합니다 (지금 ${py})`);
  }
  for (const [name, v] of [['fastapi', fa], ['pydantic', pd], ['python', py]] as const) {
    if (v && cmpVersion(v, CHECKED[name]) > 0) warnings.push(`${name} ${v}는 규칙표를 확인한 범위(${CHECKED[name]}) 밖이라 그 최신 규칙으로 만들었습니다`);
  }
  if (node.requirements?.trim() && listed('fastapi') && fa === undefined) warnings.push('fastapi 하한 버전이 없어 최신 규칙으로 만들었습니다');
  for (const s of r.skipped) warnings.push(`requirements.txt ${s}`);

  return {
    pydantic,
    // pydantic 문서: validate_by_name·validate_by_alias는 v2.11에 새로 생김, populate_by_name은 2.11+에서 권하지 않음
    validateByName: pydantic === 2 && pd !== undefined && cmpVersion(pd, '2.11') >= 0,
    // Annotated 인자: fastapi 0.95.0
    annotated: atLeast(fa, '0.95'),
    builtinGenerics: atLeast(py, '3.9'),
    annotatedFromExtensions: py !== undefined && cmpVersion(py, '3.9') < 0,
    // fastapi 0.112.0 "fastapi[standard]", 0.111.0 fastapi-cli(fastapi dev)
    run: atLeast(fa, '0.112') ? 'standard' : atLeast(fa, '0.111') ? 'cli' : 'uvicorn',
    basis: [...(fa ? [`fastapi ${fa}`] : []), ...(pd ? [`pydantic ${pd}`] : []), ...(py ? [`Python ${py}`] : [])],
    warnings,
  };
}
