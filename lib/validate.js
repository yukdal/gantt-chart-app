// 서버 측 검증 모듈
// - 모든 검증 함수는 문제가 없으면 null 을, 문제가 있으면 한국어 오류 메시지(문자열)를 반환한다.
// - 상위 라우터는 반환된 메시지로 400 응답을 만든다.

// 허용된 열거값 집합
const CATEGORIES = ['personal', 'work'];                                  // 프로젝트 분류
// 태스크 상태 5종 (5단계 개편): plan(계획) / setup(준비) / ongoing(진행) / complete(완료) / delayed(지연)
const STATUSES = ['plan', 'setup', 'ongoing', 'complete', 'delayed'];
const PRIORITIES = ['high', 'medium', 'low'];                            // 태스크 우선순위

// 구(舊) 상태값 → 신(新) 상태값 마이그레이션 매핑
// (기존 데이터의 todo/doing/done/hold 를 서버 로딩 시점에 자동 변환하는 데 사용)
const STATUS_MIGRATION = {
  todo: 'plan',
  doing: 'ongoing',
  done: 'complete',
  hold: 'delayed',
};

/**
 * 문자열이 정확히 YYYY-MM-DD 형식이며 실제로 존재하는 날짜인지 검사한다.
 * 예: 2026-02-30 은 2월에 30일이 없으므로 거부.
 * @param {*} str 검사 대상
 * @returns {boolean} 유효하면 true
 */
function isValidDate(str) {
  // 타입과 형식(정확히 4-2-2 자리) 검사
  if (typeof str !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(str)) return false;
  // 각 부분을 숫자로 분해
  const [y, m, d] = str.split('-').map(Number);
  // UTC 로 날짜 생성 후 되돌려보아 자동 보정(overflow)이 일어났는지 확인
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * 공백만 있지 않은 실제 문자열인지 검사한다.
 * @param {*} v 검사 대상
 * @returns {boolean} 비어있지 않은 문자열이면 true
 */
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * 부모 체인에 순환이 생기는지 검사한다.
 * taskId 의 부모를 newParentId 로 바꿨을 때, 부모를 따라 위로 올라가다
 * 자기 자신(taskId)에 도달하면 순환이다.
 * @param {object[]} tasks 전체 태스크 목록
 * @param {string} taskId 대상 태스크 id
 * @param {string|null} newParentId 새 부모 id (null 이면 최상위)
 * @returns {boolean} 순환이 생기면 true
 */
function createsParentCycle(tasks, taskId, newParentId) {
  if (!newParentId) return false;              // 최상위로 만들면 순환 불가
  if (newParentId === taskId) return true;     // 자기 자신을 부모로
  // id → parentId 매핑 (대상 태스크는 새 값으로 덮어씀)
  const parentOf = {};
  for (const t of tasks) parentOf[t.id] = t.parentId || null;
  parentOf[taskId] = newParentId;
  // 부모 체인을 따라 올라가며 taskId 재방문 여부 확인
  let cur = newParentId;
  const seen = new Set();
  while (cur) {
    if (cur === taskId) return true;   // 자신에게 되돌아옴 → 순환
    if (seen.has(cur)) break;          // 기존 그래프의 순환 방어 (무한루프 방지)
    seen.add(cur);
    cur = parentOf[cur] || null;
  }
  return false;
}

/**
 * 의존(dependencies) 그래프에 순환이 생기는지 DFS 로 검사한다.
 * taskId 의 의존 목록을 newDeps 로 바꿨을 때, 의존을 따라가다
 * 다시 taskId 로 돌아오면 순환이다. (자기 자신 의존, A→B→A 등 모두 검출)
 * @param {object[]} tasks 전체 태스크 목록
 * @param {string} taskId 대상 태스크 id
 * @param {string[]} newDeps 새 의존 목록
 * @returns {boolean} 순환이 생기면 true
 */
function createsDependencyCycle(tasks, taskId, newDeps) {
  // id → dependencies 매핑 (대상 태스크는 새 값으로 덮어씀)
  const depsOf = {};
  for (const t of tasks) depsOf[t.id] = Array.isArray(t.dependencies) ? t.dependencies : [];
  depsOf[taskId] = newDeps;
  // taskId 에서 출발해 의존을 따라가며 taskId 로 되돌아오는지 확인
  const visited = new Set();
  function dfs(node) {
    for (const dep of depsOf[node] || []) {
      if (dep === taskId) return true;         // 시작점으로 복귀 → 순환
      if (!visited.has(dep)) {
        visited.add(dep);
        if (dfs(dep)) return true;
      }
    }
    return false;
  }
  return dfs(taskId);
}

// 외부로 공개
module.exports = {
  CATEGORIES,
  STATUSES,
  STATUS_MIGRATION,
  PRIORITIES,
  isValidDate,
  isNonEmptyString,
  createsParentCycle,
  createsDependencyCycle,
};
