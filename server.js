// 간트 차트 웹앱 — 2단계: 데이터 API
// - 반드시 127.0.0.1 에만 바인딩 (0.0.0.0 금지)
// - 프로젝트/태스크 CRUD, 서버 측 검증, 순환(부모/의존) 검사, 원자적 쓰기
// - 데이터/검증 로직은 lib/store.js, lib/validate.js 로 분리

const express = require('express');       // 웹 서버 프레임워크
const path = require('path');             // 경로 처리 유틸
const { randomUUID } = require('crypto'); // Node 내장 UUID 생성기 (외부 패키지 금지)

// 분리한 모듈들
const store = require('./lib/store');       // 데이터 읽기/쓰기(원자적) + 초기화
const V = require('./lib/validate');        // 검증 헬퍼 모음

// 환경변수 설정 (없으면 기본값)
const PORT = process.env.PORT || 3000;                // 포트 (기본 3000)
const HOST = process.env.HOST || '127.0.0.1';         // 바인딩 주소 (기본 로컬 전용)

// 서버 시작 시각 (uptime 계산용)
const START_TIME = Date.now();

// 데이터 디렉터리 준비 (서버 기동 전에 수행)
store.initDataDir();

// 상태값 마이그레이션 (구 todo/doing/done/hold → 신 plan/ongoing/complete/delayed)
// store 로딩 직후 1회 수행하여 기존 데이터를 자동 변환·저장한다.
store.migrateStatuses();

// Express 앱 생성
const app = express();

// JSON 요청 본문 파싱 미들웨어
app.use(express.json());

// 정적 파일 서빙 (public 폴더 — 프론트엔드)
// 개발 중 브라우저가 옛 JS/CSS를 캐시해 최신 기능이 안 보이는 문제를 막기 위해
// 프로덕션이 아닐 때는 캐시를 완전히 끈다 (no-store).
const staticOptions =
  process.env.NODE_ENV === 'production'
    ? {}
    : {
        etag: false,
        lastModified: false,
        setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
      };
app.use(express.static(path.join(__dirname, 'public'), staticOptions));

// ─────────────────────────────────────────────────────────────
// 공용 헬퍼
// ─────────────────────────────────────────────────────────────

// 현재 시각 ISO 문자열
function nowIso() {
  return new Date().toISOString();
}

/**
 * parentId 값의 유효성을 검사한다. (null 은 허용 = 최상위)
 * @returns {string|null} 문제가 있으면 오류 메시지, 없으면 null
 */
function parentIdError(data, projectId, parentId, selfId) {
  if (parentId === null) return null;                       // 최상위 허용
  if (typeof parentId !== 'string') return 'parentId 는 문자열 또는 null 이어야 합니다.';
  if (selfId !== null && parentId === selfId) return '태스크는 자기 자신을 부모로 지정할 수 없습니다.';
  const parent = data.tasks.find((t) => t.id === parentId); // 부모 태스크 조회
  if (!parent) return '존재하지 않는 부모 태스크입니다.';
  if (parent.projectId !== projectId) return '부모 태스크는 같은 프로젝트에 속해야 합니다.';
  return null;
}

/**
 * dependencies 배열의 유효성을 검사한다.
 * @returns {string|null} 문제가 있으면 오류 메시지, 없으면 null
 */
function dependenciesError(data, projectId, deps, selfId) {
  if (!Array.isArray(deps)) return 'dependencies 는 배열이어야 합니다.';
  for (const depId of deps) {
    if (typeof depId !== 'string') return 'dependencies 항목은 문자열 id 여야 합니다.';
    if (selfId !== null && depId === selfId) return '태스크는 자기 자신에 의존할 수 없습니다.';
    const dep = data.tasks.find((t) => t.id === depId);     // 선행 태스크 조회
    if (!dep) return `존재하지 않는 의존 태스크입니다: ${depId}`;
    if (dep.projectId !== projectId) return '의존 태스크는 같은 프로젝트에 속해야 합니다.';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// 헬스체크
// ─────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - START_TIME) / 1000), // 가동 시간(초)
    dataDir: store.DATA_DIR,                               // 현재 데이터 경로
  });
});

// ─────────────────────────────────────────────────────────────
// 프로젝트 API
// ─────────────────────────────────────────────────────────────

// 전체 데이터 반환 ({ projects, tasks })
app.get('/api/projects', (req, res) => {
  res.json(store.readData());
});

// 프로젝트 생성
app.post('/api/projects', (req, res) => {
  const b = req.body || {};
  // name: 필수, 공백만 불가
  if (!V.isNonEmptyString(b.name)) {
    return res.status(400).json({ error: 'name 은 필수이며 공백만일 수 없습니다.' });
  }
  // category: 필수, 허용값만
  if (!V.CATEGORIES.includes(b.category)) {
    return res.status(400).json({ error: "category 는 'personal' 또는 'work' 여야 합니다." });
  }
  const data = store.readData();
  const now = nowIso();
  const project = {
    id: randomUUID(),
    name: b.name.trim(),
    category: b.category,
    createdAt: now,
    updatedAt: now,
  };
  data.projects.push(project);
  store.writeData(data);
  res.status(201).json(project);
});

// 프로젝트 수정 (부분 수정 허용)
app.put('/api/projects/:id', (req, res) => {
  const data = store.readData();
  const project = data.projects.find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '해당 프로젝트를 찾을 수 없습니다.' });

  const b = req.body || {};
  const updates = {};
  // name 이 왔으면 검증
  if (b.name !== undefined) {
    if (!V.isNonEmptyString(b.name)) {
      return res.status(400).json({ error: 'name 은 공백만일 수 없습니다.' });
    }
    updates.name = b.name.trim();
  }
  // category 가 왔으면 검증
  if (b.category !== undefined) {
    if (!V.CATEGORIES.includes(b.category)) {
      return res.status(400).json({ error: "category 는 'personal' 또는 'work' 여야 합니다." });
    }
    updates.category = b.category;
  }
  Object.assign(project, updates, { updatedAt: nowIso() });
  store.writeData(data);
  res.json(project);
});

// 프로젝트 삭제 (소속 태스크 전부 함께 삭제 — cascade)
app.delete('/api/projects/:id', (req, res) => {
  const data = store.readData();
  const exists = data.projects.some((p) => p.id === req.params.id);
  if (!exists) return res.status(404).json({ error: '해당 프로젝트를 찾을 수 없습니다.' });

  // 삭제될 태스크 id 목록 확보 (보고용)
  const removedTasks = data.tasks
    .filter((t) => t.projectId === req.params.id)
    .map((t) => t.id);

  // 프로젝트와 소속 태스크 제거
  data.projects = data.projects.filter((p) => p.id !== req.params.id);
  data.tasks = data.tasks.filter((t) => t.projectId !== req.params.id);

  store.writeData(data);
  res.json({ deletedProject: req.params.id, deletedTasks: removedTasks });
});

// ─────────────────────────────────────────────────────────────
// 태스크 API
// ─────────────────────────────────────────────────────────────

// 태스크 생성
app.post('/api/tasks', (req, res) => {
  const b = req.body || {};
  const data = store.readData();

  // projectId: 필수, 존재하는 프로젝트
  if (!V.isNonEmptyString(b.projectId)) {
    return res.status(400).json({ error: 'projectId 는 필수입니다.' });
  }
  if (!data.projects.some((p) => p.id === b.projectId)) {
    return res.status(400).json({ error: '존재하지 않는 프로젝트입니다.' });
  }
  const projectId = b.projectId;

  // name: 필수
  if (!V.isNonEmptyString(b.name)) {
    return res.status(400).json({ error: 'name 은 필수이며 공백만일 수 없습니다.' });
  }
  // 날짜: 형식 + 실제 존재하는 날짜
  if (!V.isValidDate(b.startDate)) {
    return res.status(400).json({ error: 'startDate 는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.' });
  }
  if (!V.isValidDate(b.endDate)) {
    return res.status(400).json({ error: 'endDate 는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.' });
  }
  // endDate >= startDate (YYYY-MM-DD 는 문자열 비교로 대소 판별 가능)
  if (b.endDate < b.startDate) {
    return res.status(400).json({ error: 'endDate 는 startDate 이후(같음 포함)여야 합니다.' });
  }

  // parentId (기본 null) — 같은 프로젝트 소속이어야 함
  const parentId = b.parentId === undefined ? null : b.parentId;
  const pErr = parentIdError(data, projectId, parentId, null);
  if (pErr) return res.status(400).json({ error: pErr });

  // progress (기본 0) — 0~100 정수
  let progress = 0;
  if (b.progress !== undefined) {
    if (!Number.isInteger(b.progress) || b.progress < 0 || b.progress > 100) {
      return res.status(400).json({ error: 'progress 는 0~100 사이의 정수여야 합니다.' });
    }
    progress = b.progress;
  }
  // status (기본 plan)
  let status = 'plan';
  if (b.status !== undefined) {
    if (!V.STATUSES.includes(b.status)) {
      return res.status(400).json({ error: "status 는 'plan','setup','ongoing','complete','delayed' 중 하나여야 합니다." });
    }
    status = b.status;
  }
  // priority (기본 medium)
  let priority = 'medium';
  if (b.priority !== undefined) {
    if (!V.PRIORITIES.includes(b.priority)) {
      return res.status(400).json({ error: "priority 는 'high','medium','low' 중 하나여야 합니다." });
    }
    priority = b.priority;
  }
  // milestone (기본 false)
  let milestone = false;
  if (b.milestone !== undefined) {
    if (typeof b.milestone !== 'boolean') {
      return res.status(400).json({ error: 'milestone 는 boolean 이어야 합니다.' });
    }
    milestone = b.milestone;
  }
  // assignee (기본 '')
  let assignee = '';
  if (b.assignee !== undefined) {
    if (typeof b.assignee !== 'string') {
      return res.status(400).json({ error: 'assignee 는 문자열이어야 합니다.' });
    }
    assignee = b.assignee;
  }
  // memo (기본 '')
  let memo = '';
  if (b.memo !== undefined) {
    if (typeof b.memo !== 'string') {
      return res.status(400).json({ error: 'memo 는 문자열이어야 합니다.' });
    }
    memo = b.memo;
  }
  // dependencies (기본 []) — 같은 프로젝트 내 존재해야 함
  let dependencies = [];
  if (b.dependencies !== undefined) {
    const dErr = dependenciesError(data, projectId, b.dependencies, null);
    if (dErr) return res.status(400).json({ error: dErr });
    dependencies = b.dependencies;
  }

  // order: 같은 계층(같은 projectId + 같은 parentId) 형제 수를 기본 순번으로 부여
  const order = data.tasks.filter(
    (t) => t.projectId === projectId && (t.parentId || null) === parentId
  ).length;

  const now = nowIso();
  const task = {
    id: randomUUID(),
    projectId,
    name: b.name.trim(),
    parentId,
    assignee,
    startDate: b.startDate,
    endDate: b.endDate,
    progress,
    status,
    priority,
    milestone,
    memo,
    dependencies,
    order,
    createdAt: now,
    updatedAt: now,
  };
  data.tasks.push(task);
  store.writeData(data);
  res.status(201).json(task);
});

// 태스크 수정 (부분 수정 허용, projectId 변경 금지)
app.put('/api/tasks/:id', (req, res) => {
  const data = store.readData();
  const task = data.tasks.find((t) => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: '해당 태스크를 찾을 수 없습니다.' });

  const b = req.body || {};
  // projectId 변경 금지
  if (b.projectId !== undefined && b.projectId !== task.projectId) {
    return res.status(400).json({ error: '태스크의 projectId 는 변경할 수 없습니다.' });
  }
  const projectId = task.projectId;
  const updates = {};

  // name
  if (b.name !== undefined) {
    if (!V.isNonEmptyString(b.name)) {
      return res.status(400).json({ error: 'name 은 공백만일 수 없습니다.' });
    }
    updates.name = b.name.trim();
  }
  // 날짜 (온 것만 검증)
  if (b.startDate !== undefined) {
    if (!V.isValidDate(b.startDate)) {
      return res.status(400).json({ error: 'startDate 는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.' });
    }
    updates.startDate = b.startDate;
  }
  if (b.endDate !== undefined) {
    if (!V.isValidDate(b.endDate)) {
      return res.status(400).json({ error: 'endDate 는 YYYY-MM-DD 형식의 실제 날짜여야 합니다.' });
    }
    updates.endDate = b.endDate;
  }
  // 병합된 최종 날짜로 순서 검사 (한쪽만 바꿔도 검증되도록)
  const effStart = updates.startDate !== undefined ? updates.startDate : task.startDate;
  const effEnd = updates.endDate !== undefined ? updates.endDate : task.endDate;
  if (effEnd < effStart) {
    return res.status(400).json({ error: 'endDate 는 startDate 이후(같음 포함)여야 합니다.' });
  }
  // progress
  if (b.progress !== undefined) {
    if (!Number.isInteger(b.progress) || b.progress < 0 || b.progress > 100) {
      return res.status(400).json({ error: 'progress 는 0~100 사이의 정수여야 합니다.' });
    }
    updates.progress = b.progress;
  }
  // status
  if (b.status !== undefined) {
    if (!V.STATUSES.includes(b.status)) {
      return res.status(400).json({ error: "status 는 'plan','setup','ongoing','complete','delayed' 중 하나여야 합니다." });
    }
    updates.status = b.status;
  }
  // priority
  if (b.priority !== undefined) {
    if (!V.PRIORITIES.includes(b.priority)) {
      return res.status(400).json({ error: "priority 는 'high','medium','low' 중 하나여야 합니다." });
    }
    updates.priority = b.priority;
  }
  // milestone
  if (b.milestone !== undefined) {
    if (typeof b.milestone !== 'boolean') {
      return res.status(400).json({ error: 'milestone 는 boolean 이어야 합니다.' });
    }
    updates.milestone = b.milestone;
  }
  // assignee
  if (b.assignee !== undefined) {
    if (typeof b.assignee !== 'string') {
      return res.status(400).json({ error: 'assignee 는 문자열이어야 합니다.' });
    }
    updates.assignee = b.assignee;
  }
  // memo
  if (b.memo !== undefined) {
    if (typeof b.memo !== 'string') {
      return res.status(400).json({ error: 'memo 는 문자열이어야 합니다.' });
    }
    updates.memo = b.memo;
  }
  // parentId — 같은 프로젝트 소속 + 부모 체인 순환 거부
  if (b.parentId !== undefined) {
    const pErr = parentIdError(data, projectId, b.parentId, task.id);
    if (pErr) return res.status(400).json({ error: pErr });
    if (V.createsParentCycle(data.tasks, task.id, b.parentId)) {
      return res.status(400).json({ error: '부모 태스크 설정이 순환을 만듭니다.' });
    }
    updates.parentId = b.parentId;
  }
  // dependencies — 같은 프로젝트 소속 + 순환 의존 거부(기존 그래프와 합쳐 검사)
  if (b.dependencies !== undefined) {
    const dErr = dependenciesError(data, projectId, b.dependencies, task.id);
    if (dErr) return res.status(400).json({ error: dErr });
    if (V.createsDependencyCycle(data.tasks, task.id, b.dependencies)) {
      return res.status(400).json({ error: '의존 관계가 순환을 만듭니다.' });
    }
    updates.dependencies = b.dependencies;
  }
  // order — 같은 계층 내 표시 순서 (6단계 3/3: 드래그 순서 변경용, 유한한 숫자만)
  if (b.order !== undefined) {
    if (typeof b.order !== 'number' || !Number.isFinite(b.order)) {
      return res.status(400).json({ error: 'order 는 유한한 숫자여야 합니다.' });
    }
    updates.order = b.order;
  }

  Object.assign(task, updates, { updatedAt: nowIso() });
  store.writeData(data);
  res.json(task);
});

// 태스크 삭제 (하위 태스크 재귀 삭제 + 다른 태스크의 dependencies 에서 제거)
app.delete('/api/tasks/:id', (req, res) => {
  const data = store.readData();
  const target = data.tasks.find((t) => t.id === req.params.id);
  if (!target) return res.status(404).json({ error: '해당 태스크를 찾을 수 없습니다.' });

  // 삭제 대상 집합: 자신 + 모든 하위(재귀)
  const toDelete = new Set();
  (function collect(id) {
    toDelete.add(id);
    for (const t of data.tasks) {
      if ((t.parentId || null) === id) collect(t.id);
    }
  })(target.id);

  // 대상 제거
  data.tasks = data.tasks.filter((t) => !toDelete.has(t.id));

  // 남은 태스크들의 dependencies 에서 삭제된 id 제거
  const now = nowIso();
  for (const t of data.tasks) {
    if (Array.isArray(t.dependencies) && t.dependencies.some((d) => toDelete.has(d))) {
      t.dependencies = t.dependencies.filter((d) => !toDelete.has(d));
      t.updatedAt = now;
    }
  }

  store.writeData(data);
  res.json({ deletedTasks: [...toDelete] });
});

// ─────────────────────────────────────────────────────────────
// 내보내기
// ─────────────────────────────────────────────────────────────

// 전체 JSON 파일 다운로드 (파일명에 날짜 포함)
app.get('/api/export/json', (req, res) => {
  const data = store.readData();
  const today = nowIso().slice(0, 10); // YYYY-MM-DD
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="gantt-export-${today}.json"`);
  res.send(JSON.stringify(data, null, 2));
});

// ─────────────────────────────────────────────────────────────
// 오류 처리
// ─────────────────────────────────────────────────────────────

// JSON 파싱 실패 등 미들웨어 오류를 한국어 메시지로 변환
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '요청 본문이 올바른 JSON 형식이 아닙니다.' });
  }
  console.error('[서버 오류]', err);
  res.status(500).json({ error: '서버 내부 오류가 발생했습니다.' });
});

// 서버 기동 — 반드시 HOST(127.0.0.1)에만 바인딩
app.listen(PORT, HOST, () => {
  console.log(`간트 차트 서버가 실행 중입니다 → http://${HOST}:${PORT}`);
  console.log(`데이터 디렉터리: ${store.DATA_DIR}`);
});
