// 데이터 저장소 모듈
// - projects.json 한 파일에 { projects: [...], tasks: [...] } 구조로 보관
// - 모든 쓰기는 원자적(임시 파일 → rename)으로 수행하여 중단 시에도 원본이 깨지지 않도록 보장
// - DATA_DIR 은 환경변수로 덮어쓸 수 있으며, 기본값은 프로젝트 폴더의 dev-data

const path = require('path'); // 경로 처리 유틸
const fs = require('fs');     // 파일 시스템 (동기 API 사용)
const V = require('./validate'); // 상태 마이그레이션 매핑(STATUS_MIGRATION) 참조

// 데이터 디렉터리 경로 계산
// __dirname 은 lib 폴더이므로 한 단계 위로 올라가 프로젝트 루트의 dev-data 를 가리킨다.
// (상대경로 './dev-data' 는 실행 위치에 따라 달라지므로 금지)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'dev-data');
// 실제 데이터 파일 경로
const DATA_FILE = path.join(DATA_DIR, 'projects.json');

/**
 * JSON 파일을 원자적으로 기록한다.
 * 임시 파일(.tmp)에 먼저 쓴 뒤 rename 하여, 쓰기 도중 중단돼도
 * 원본이 깨지지 않도록 보장한다.
 * @param {string} filePath 최종 파일 경로
 * @param {object} data 저장할 객체
 */
function writeJsonAtomic(filePath, data) {
  const tmpPath = filePath + '.tmp';                         // 임시 파일 경로
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));  // 임시 파일에 먼저 기록
  fs.renameSync(tmpPath, filePath);                          // 원자적 교체
}

/**
 * DATA_DIR 을 준비한다.
 * - 폴더가 없으면 생성
 * - projects.json 이 없으면 빈 구조로 원자적 초기화
 */
function initDataDir() {
  // 데이터 디렉터리 없으면 생성 (recursive: 상위 경로까지 함께 생성)
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log(`[초기화] 데이터 디렉터리를 생성했습니다: ${DATA_DIR}`);
  }
  // projects.json 없으면 빈 구조로 초기화
  if (!fs.existsSync(DATA_FILE)) {
    writeJsonAtomic(DATA_FILE, { projects: [], tasks: [] });
    console.log(`[초기화] projects.json 을 빈 구조로 생성했습니다: ${DATA_FILE}`);
  }
}

/**
 * 전체 데이터를 읽어 { projects, tasks } 형태로 반환한다.
 * 파일이 손상되었거나 배열이 아니면 안전하게 빈 배열로 보정한다.
 * @returns {{projects: object[], tasks: object[]}}
 */
function readData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8'); // 파일 내용을 문자열로 읽기
  const data = JSON.parse(raw);                   // JSON 파싱
  // 방어적 보정: 키가 없거나 배열이 아니면 빈 배열로
  if (!Array.isArray(data.projects)) data.projects = [];
  if (!Array.isArray(data.tasks)) data.tasks = [];
  return data;
}

/**
 * 전체 데이터를 원자적으로 저장한다.
 * @param {{projects: object[], tasks: object[]}} data 저장할 전체 데이터
 */
function writeData(data) {
  writeJsonAtomic(DATA_FILE, data);
}

/**
 * 태스크 상태값을 구(舊) 5종 이전 값에서 신(新) 값으로 마이그레이션한다.
 * (todo→plan, doing→ongoing, done→complete, hold→delayed)
 * - 서버 시작 시 1회 호출한다.
 * - 변환이 하나라도 발생하면 파일을 다시 원자적으로 저장하고 한국어 로그를 남긴다.
 * - 이미 신 값이거나 알 수 없는 값은 건드리지 않는다.
 * @returns {number} 변환된 태스크 수
 */
function migrateStatuses() {
  const data = readData();
  const map = V.STATUS_MIGRATION;       // { todo:'plan', ... }
  let changed = 0;                      // 변환된 태스크 수
  const counts = {};                    // 어떤 값이 몇 개 바뀌었는지 집계

  for (const t of data.tasks) {
    const oldValue = t.status;
    if (Object.prototype.hasOwnProperty.call(map, oldValue)) {
      t.status = map[oldValue];         // 신 값으로 교체
      counts[oldValue] = (counts[oldValue] || 0) + 1;
      changed += 1;
    }
  }

  if (changed > 0) {
    writeData(data);                    // 변환분을 파일에 반영 (원자적)
    // 변환 내역을 사람이 읽기 쉬운 형태로 구성
    const detail = Object.keys(counts)
      .map((k) => `${k}→${map[k]} ${counts[k]}건`)
      .join(', ');
    console.log(`[마이그레이션] 옛 상태값을 새 상태값으로 변환했습니다: ${detail} (총 ${changed}건)`);
  } else {
    console.log('[마이그레이션] 변환할 옛 상태값이 없습니다. (건너뜀)');
  }
  return changed;
}

// 외부로 공개
module.exports = {
  DATA_DIR,
  DATA_FILE,
  writeJsonAtomic,
  initDataDir,
  readData,
  writeData,
  migrateStatuses,
};
