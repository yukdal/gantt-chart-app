// 엑셀 내보내기/가져오기 (9단계) — xlsx-js-style 로컬 번들(public/vendor) 사용
// - 순수 함수(행 구성·서식·zip 재포장·가져오기 파싱/검증)는 상단에 두고
//   Node 테스트에서 require 할 수 있게 파일 끝에서 module.exports 한다 (crud.js 패턴).
// - 브라우저 UI(드롭다운·파일 선택·미리보기 모달)는 하단 typeof document 블록에 둔다.
// - 참고: xlsx-js-style(CE 포크)은 틀 고정(freeze pane)을 직접 쓰지 못하므로,
//   생성된 xlsx(zip)를 풀어 sheet1.xml 에 <pane> 을 주입한 뒤
//   무압축(STORED) zip 으로 다시 포장한다. (zipStoreEntries/injectFreezePane 참고)

// ─────────────────────────────────────────────────────────────
// 컬럼 정의·라벨 매핑 (내보내기·가져오기 공통)
// ─────────────────────────────────────────────────────────────

// 내보내기 컬럼 (정확히 이 순서·이름 — 가져오기 헤더 검증에도 사용)
var EXCEL_COLUMNS = [
  '프로젝트명', '구분', '태스크명', '상위태스크', '담당자',
  '시작일', '종료일', '진행률', '상태', '우선순위', '마일스톤', '메모',
];

// 값 → 화면/엑셀 표기
var EXCEL_STATUS_LABELS = {
  plan: 'Plan (계획)',
  setup: 'Set up (준비)',
  ongoing: 'Ongoing (진행)',
  complete: 'Complete (완료)',
  delayed: 'Delayed (지연)',
};
var EXCEL_CATEGORY_LABELS = { personal: '개인', work: '업무' };
var EXCEL_PRIORITY_LABELS = { high: '높음', medium: '보통', low: '낮음' };

// ─────────────────────────────────────────────────────────────
// 내보내기: 행 구성 (화면 좌측 목록과 동일한 프로젝트 → 계층 순서)
// ─────────────────────────────────────────────────────────────

/**
 * 프로젝트 → 계층(DFS) 순서로 태스크를 평탄화한다. (gantt.js buildRows 와 동일 규칙:
 * 같은 부모 아래에서는 order 오름차순, 동률이면 이름순. 부모가 없는 고아는 마지막에 최상위로)
 * @returns {Array<{project:object, task:object, parentName:string}>}
 */
function orderTasksForExport(projects, tasks) {
  var result = [];
  projects.forEach(function (project) {
    var own = tasks.filter(function (t) { return t.projectId === project.id; });
    var byId = {};
    own.forEach(function (t) { byId[t.id] = t; });

    // parentId -> 자식 목록 (최상위 키는 '')
    var byParent = {};
    own.forEach(function (t) {
      var key = t.parentId || '';
      (byParent[key] = byParent[key] || []).push(t);
    });
    Object.keys(byParent).forEach(function (k) {
      byParent[k].sort(function (a, b) {
        var ao = a.order == null ? 0 : a.order;
        var bo = b.order == null ? 0 : b.order;
        if (ao !== bo) return ao - bo;
        return String(a.name).localeCompare(String(b.name));
      });
    });

    var visited = {};
    (function walk(parentKey) {
      (byParent[parentKey] || []).forEach(function (t) {
        if (visited[t.id]) return; // 순환 방어
        visited[t.id] = true;
        result.push({
          project: project,
          task: t,
          parentName: (t.parentId && byId[t.parentId]) ? byId[t.parentId].name : '',
        });
        walk(t.id);
      });
    })('');
    // 부모가 누락된 태스크는 최상위로 뒤에 추가 (gantt.js 와 동일)
    own.forEach(function (t) {
      if (!visited[t.id]) {
        visited[t.id] = true;
        result.push({ project: project, task: t, parentName: '' });
      }
    });
  });
  return result;
}

/**
 * 내보내기용 2차원 배열(aoa)을 만든다. [0] 은 헤더, 이후는 데이터 행.
 * 빈 값도 '' 로 채워 모든 셀이 생성되게 한다 (테두리 서식 적용 목적).
 */
function buildExportAoa(projects, tasks) {
  var aoa = [EXCEL_COLUMNS.slice()];
  orderTasksForExport(projects, tasks).forEach(function (row) {
    var t = row.task;
    aoa.push([
      row.project.name,
      EXCEL_CATEGORY_LABELS[row.project.category] || row.project.category,
      t.name,
      row.parentName,
      t.assignee || '',
      t.startDate,
      t.endDate,
      typeof t.progress === 'number' ? t.progress : 0, // 숫자 셀로 내보냄
      EXCEL_STATUS_LABELS[t.status] || t.status,
      EXCEL_PRIORITY_LABELS[t.priority] || t.priority,
      t.milestone ? 'O' : '',
      t.memo || '',
    ]);
  });
  return aoa;
}

// 셀 값의 표시 폭 (한글 등 비ASCII 문자는 2배 폭으로 계산)
function excelDisplayWidth(value) {
  var s = String(value == null ? '' : value);
  var w = 0;
  for (var i = 0; i < s.length; i++) {
    w += s.charCodeAt(i) > 127 ? 2 : 1;
  }
  return w;
}

// 열 너비 자동 계산: 각 열 최대 표시 폭 + 여유 2, 최소 8 · 최대 40
function computeColWidths(aoa) {
  var widths = [];
  aoa.forEach(function (row) {
    row.forEach(function (cell, c) {
      var w = excelDisplayWidth(cell);
      if (widths[c] == null || w > widths[c]) widths[c] = w;
    });
  });
  return widths.map(function (w) {
    return Math.max(8, Math.min(40, w + 2));
  });
}

// ─────────────────────────────────────────────────────────────
// zip 재포장 유틸 (틀 고정 주입용) — 무압축(STORED) zip 작성기
// ─────────────────────────────────────────────────────────────

// CRC32 테이블 (zip 항목 체크섬 계산에 필요)
var CRC32_TABLE = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32Bytes(bytes) {
  var c = -1;
  for (var i = 0; i < bytes.length; i++) c = (c >>> 8) ^ CRC32_TABLE[(c ^ bytes[i]) & 0xFF];
  return (c ^ -1) >>> 0;
}

/**
 * [{name, bytes}] 목록을 무압축 zip(Uint8Array)으로 만든다.
 * xlsx 는 zip 컨테이너이므로 이 결과가 그대로 유효한 .xlsx 파일이 된다.
 */
function zipStoreEntries(entries) {
  var enc = new TextEncoder();
  var chunks = [];
  var offset = 0;
  var central = [];
  function push(a) { chunks.push(a); offset += a.length; }
  function u16(n) { return [n & 0xFF, (n >> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >> 24) & 0xFF]; }

  entries.forEach(function (e) {
    var nameB = enc.encode(e.name);
    var data = e.bytes;
    var crc = crc32Bytes(data);
    var localOffset = offset;
    // 로컬 파일 헤더 (0x04034b50), general purpose flag bit11 = UTF-8 이름
    push(new Uint8Array([].concat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0)
    )));
    push(nameB);
    push(data);
    // 중앙 디렉터리 항목 (0x02014b50)
    central.push(new Uint8Array([].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(data.length), u32(data.length), u16(nameB.length),
      u16(0), u16(0), u16(0), u16(0), u32(0), u32(localOffset),
      Array.prototype.slice.call(nameB)
    )));
  });

  var cdStart = offset;
  central.forEach(push);
  var cdSize = offset - cdStart;
  // 중앙 디렉터리 끝 레코드 (0x06054b50)
  push(new Uint8Array([].concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(cdSize), u32(cdStart), u16(0)
  )));

  var total = 0;
  chunks.forEach(function (c) { total += c.length; });
  var out = new Uint8Array(total);
  var p = 0;
  chunks.forEach(function (c) { out.set(c, p); p += c.length; });
  return out;
}

/**
 * 워크시트 XML 의 첫 sheetView 에 틀 고정(1행 고정 <pane>)을 주입한다.
 * xlsx-js-style CE 포크가 freeze 를 직접 쓰지 못해 XML 후처리로 해결한다.
 */
function injectFreezePane(xml) {
  var pane = '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
             '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>';
  if (/<sheetView\b[^>]*\/>/.test(xml)) {
    // 자기닫힘 <sheetView .../> → 여는/닫는 태그로 바꾸고 pane 삽입
    return xml.replace(/<sheetView\b([^>]*)\/>/, '<sheetView$1>' + pane + '</sheetView>');
  }
  return xml.replace(/(<sheetView\b[^>]*>)/, '$1' + pane);
}

// ─────────────────────────────────────────────────────────────
// 내보내기: xlsx 바이트 생성 (서식 + 틀 고정)
// ─────────────────────────────────────────────────────────────

/**
 * 프로젝트/태스크 데이터를 보고용 서식이 적용된 .xlsx 바이트(Uint8Array)로 만든다.
 * @param {object[]} projects
 * @param {object[]} tasks
 * @param {object} X XLSX 라이브러리 (브라우저: window.XLSX, 테스트: require 결과)
 */
function buildXlsxBytes(projects, tasks, X) {
  var aoa = buildExportAoa(projects, tasks);
  var ws = X.utils.aoa_to_sheet(aoa);

  // 얇은 테두리 (전 셀 공통)
  var thin = { style: 'thin', color: { rgb: 'B7BFC9' } };
  var allBorders = { top: thin, bottom: thin, left: thin, right: thin };
  // 헤더: 굵게 + 연한 파랑 배경(#DCE6F1) + 테두리 + 가운데 정렬
  var headerStyle = {
    font: { bold: true },
    fill: { patternType: 'solid', fgColor: { rgb: 'DCE6F1' } },
    border: allBorders,
    alignment: { horizontal: 'center', vertical: 'center' },
  };
  var bodyStyle = { border: allBorders };

  // 모든 셀에 서식 적용 (aoa 는 빈 값도 '' 로 채워 셀이 항상 존재)
  for (var r = 0; r < aoa.length; r++) {
    for (var c = 0; c < EXCEL_COLUMNS.length; c++) {
      var addr = X.utils.encode_cell({ r: r, c: c });
      if (!ws[addr]) ws[addr] = { t: 's', v: '' }; // 방어적 셀 생성
      ws[addr].s = r === 0 ? headerStyle : bodyStyle;
    }
  }

  ws['!cols'] = computeColWidths(aoa).map(function (w) { return { wch: w }; });

  var wb = X.utils.book_new();
  X.utils.book_append_sheet(wb, ws, '간트차트');

  // 1) 일단 무압축 xlsx 로 쓰고
  var written = X.write(wb, { type: 'array', bookType: 'xlsx', cellStyles: true, compression: false });
  // 2) 내부 파일 목록을 얻어 시트 XML 에 틀 고정을 주입한 뒤
  var rd = X.read(written, { type: 'array', bookFiles: true });
  var enc = new TextEncoder();
  var dec = new TextDecoder('utf-8');
  var entries = [];
  Object.keys(rd.files).forEach(function (name) {
    // SheetJS 내부 표식 항목(''/'\x01Sh33tJ5')과 디렉터리 항목은 제외
    if (!name || name.charCodeAt(0) === 1 || name.slice(-1) === '/') return;
    var content = rd.files[name].content;
    var bytes = typeof content === 'string' ? enc.encode(content) : new Uint8Array(content);
    if (/xl\/worksheets\/sheet1\.xml$/.test(name)) {
      bytes = enc.encode(injectFreezePane(dec.decode(bytes)));
    }
    entries.push({ name: name, bytes: bytes });
  });
  // 3) 무압축 zip 으로 다시 포장 → 최종 .xlsx 바이트
  return zipStoreEntries(entries);
}

// 내보내기 파일명: 간트차트_YYYY-MM-DD.xlsx
// namePart(선택, 이미 정리된 프로젝트명)를 주면 간트차트_프로젝트명_YYYY-MM-DD.xlsx
function exportFileName(d, namePart) {
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  var mid = namePart ? namePart + '_' : '';
  return '간트차트_' + mid + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + '.xlsx';
}

// ─────────────────────────────────────────────────────────────
// 가져오기: 셀 값 정규화 (관대한 파싱)
// ─────────────────────────────────────────────────────────────

// 비교용 정규화: 문자열화 → 트림 → 소문자 → 연속 공백 1개로
function normKey(v) {
  return String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
}

// 구분: "개인"/"업무"/"personal"/"work" 허용
function normalizeCategoryCell(v) {
  var k = normKey(v);
  if (k === '개인' || k === 'personal') return 'personal';
  if (k === '업무' || k === 'work') return 'work';
  return null; // 인식 실패
}

// 상태 별칭 표: "Plan (계획)"/"plan"/"계획" 등 모두 허용
var STATUS_ALIASES = (function () {
  var m = {};
  [['plan', ['plan', '계획', 'plan (계획)']],
   ['setup', ['setup', 'set up', '준비', 'set up (준비)', 'setup (준비)']],
   ['ongoing', ['ongoing', '진행', 'ongoing (진행)']],
   ['complete', ['complete', '완료', 'complete (완료)']],
   ['delayed', ['delayed', '지연', 'delayed (지연)']],
  ].forEach(function (pair) {
    pair[1].forEach(function (alias) { m[alias] = pair[0]; });
  });
  return m;
})();

// 상태 정규화 (빈 값은 기본값 plan, 인식 실패는 null)
function normalizeStatusCell(v) {
  var k = normKey(v);
  if (k === '') return 'plan';
  return STATUS_ALIASES[k] || null;
}

// 우선순위: "높음"/"보통"/"낮음"/"high"/... 허용, 빈 값은 medium
function normalizePriorityCell(v) {
  var k = normKey(v);
  if (k === '') return 'medium';
  if (k === '높음' || k === 'high') return 'high';
  if (k === '보통' || k === '중간' || k === 'medium') return 'medium';
  if (k === '낮음' || k === 'low') return 'low';
  return null;
}

// 마일스톤: "O"/"o"/"TRUE"/"예"/1 등을 true 로, 그 외는 false (관대)
function normalizeMilestoneCell(v) {
  if (v === true || v === 1) return true;
  var k = normKey(v);
  return ['o', 'true', '예', 'y', 'yes', '1', 'ㅇ'].indexOf(k) !== -1;
}

// 엑셀 날짜 일련번호(1899-12-30 기준 일수) → 'YYYY-MM-DD'
function excelSerialToYmd(serial) {
  var ms = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  var d = new Date(ms);
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
}

// 실제 존재하는 날짜인지 검사 ('2026-02-30' 같은 값 거부)
function isRealYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  var p = s.split('-');
  var d = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  return d.getFullYear() === Number(p[0]) &&
         d.getMonth() === Number(p[1]) - 1 &&
         d.getDate() === Number(p[2]);
}

/**
 * 날짜 셀 정규화. 문자열 'YYYY-MM-DD', 엑셀 date 셀(일련번호 숫자), Date 객체 허용.
 * @returns {{value:string}|{error:string}|{empty:true}}
 */
function normalizeDateCell(v) {
  if (v == null || v === '') return { empty: true };
  if (v instanceof Date) {
    var p2a = function (n) { return (n < 10 ? '0' : '') + n; };
    return { value: v.getFullYear() + '-' + p2a(v.getMonth() + 1) + '-' + p2a(v.getDate()) };
  }
  if (typeof v === 'number' && isFinite(v)) {
    // 엑셀 일련번호로 간주 (1900년 이후 ~ 9999-12-31 = 2958465)
    if (v < 1 || v > 2958465) return { error: "'" + v + "'은(는) 날짜로 해석할 수 없는 숫자입니다" };
    return { value: excelSerialToYmd(v) };
  }
  var s = String(v).trim();
  if (isRealYmd(s)) return { value: s };
  return { error: "'" + s + "'은(는) YYYY-MM-DD 형식이 아닙니다" };
}

// 진행률: 50, '50', '50%', 0.5(엑셀 % 서식 셀) 허용 → 0~100 정수
function normalizeProgressCell(v) {
  if (v == null || v === '') return { value: 0 };
  var n;
  if (typeof v === 'number') {
    // 엑셀 % 서식 셀은 0.5 처럼 소수로 저장됨 → 0<v<1 이면 백분율로 환산
    n = (v > 0 && v < 1) ? v * 100 : v;
  } else {
    var s = String(v).trim();
    if (/%$/.test(s)) s = s.slice(0, -1).trim(); // '50%' → '50'
    if (s === '') return { value: 0 };
    n = Number(s);
  }
  if (!isFinite(n)) return { error: "'" + v + "'은(는) 진행률로 해석할 수 없습니다" };
  n = Math.round(n);
  if (n < 0 || n > 100) return { error: "'" + v + "'은(는) 0~100 범위를 벗어났습니다" };
  return { value: n };
}

// ─────────────────────────────────────────────────────────────
// 가져오기: aoa 파싱 → 행 객체 + 행별 오류
// ─────────────────────────────────────────────────────────────

// 셀이 모두 빈 값인 행인지
function isEmptyRow(row) {
  if (!row) return true;
  for (var i = 0; i < row.length; i++) {
    if (String(row[i] == null ? '' : row[i]).trim() !== '') return false;
  }
  return true;
}

/**
 * sheet_to_json({header:1, raw:true}) 결과(aoa)를 행 객체 목록으로 파싱한다.
 * @returns {{headerError:string|null, rows:Array, dataRowCount:number}}
 *   rows[i]: { excelRow, projectName, category, name, parentName, assignee,
 *              startDate, endDate, progress, status, priority, milestone, memo,
 *              raw:[...], errors:[문자열] }
 */
function parseImportAoa(aoa) {
  if (!Array.isArray(aoa) || aoa.length === 0 || isEmptyRow(aoa[0])) {
    return {
      headerError: '1행: 헤더 행이 없습니다. 첫 행에 컬럼명(' + EXCEL_COLUMNS.join(', ') + ')이 필요합니다.',
      rows: [], dataRowCount: 0,
    };
  }
  // 헤더 검증 (이름·순서 정확히 일치해야 함)
  for (var c = 0; c < EXCEL_COLUMNS.length; c++) {
    var h = String(aoa[0][c] == null ? '' : aoa[0][c]).trim();
    if (h !== EXCEL_COLUMNS[c]) {
      return {
        headerError: '1행 헤더: ' + (c + 1) + '번째 컬럼이 "' + EXCEL_COLUMNS[c] +
          '"이어야 하는데 "' + h + '"입니다. (필요한 컬럼 순서: ' + EXCEL_COLUMNS.join(', ') + ')',
        rows: [], dataRowCount: 0,
      };
    }
  }

  var rows = [];
  var dataRowCount = 0;
  for (var i = 1; i < aoa.length; i++) {
    var raw = aoa[i] || [];
    if (isEmptyRow(raw)) continue; // 빈 행 무시
    dataRowCount++;
    var excelRow = i + 1; // 엑셀 행 번호 (1행 = 헤더)
    var errors = [];
    var cell = function (idx) { return raw[idx] == null ? '' : raw[idx]; };
    var cellStr = function (idx) { return String(cell(idx)).trim(); };

    var projectName = cellStr(0);
    if (!projectName) errors.push(excelRow + '행 프로젝트명: 값이 비어 있습니다');

    var category = normalizeCategoryCell(cell(1));
    if (category === null) {
      errors.push(excelRow + '행 구분: \'' + cellStr(1) + '\'은(는) 개인/업무 중 하나가 아닙니다');
    }

    var name = cellStr(2);
    if (!name) errors.push(excelRow + '행 태스크명: 값이 비어 있습니다');

    var parentName = cellStr(3);
    var assignee = cellStr(4);

    var sd = normalizeDateCell(cell(5));
    if (sd.empty) errors.push(excelRow + '행 시작일: 값이 비어 있습니다');
    else if (sd.error) errors.push(excelRow + '행 시작일: ' + sd.error);

    var ed = normalizeDateCell(cell(6));
    if (ed.empty) errors.push(excelRow + '행 종료일: 값이 비어 있습니다');
    else if (ed.error) errors.push(excelRow + '행 종료일: ' + ed.error);

    if (sd.value && ed.value && ed.value < sd.value) {
      errors.push(excelRow + '행 종료일: 종료일(' + ed.value + ')이 시작일(' + sd.value + ')보다 빠릅니다');
    }

    var pg = normalizeProgressCell(cell(7));
    if (pg.error) errors.push(excelRow + '행 진행률: ' + pg.error);

    var status = normalizeStatusCell(cell(8));
    if (status === null) {
      errors.push(excelRow + '행 상태: \'' + cellStr(8) + '\'은(는) 유효한 상태가 아닙니다 (Plan/Set up/Ongoing/Complete/Delayed)');
    }

    var priority = normalizePriorityCell(cell(9));
    if (priority === null) {
      errors.push(excelRow + '행 우선순위: \'' + cellStr(9) + '\'은(는) 높음/보통/낮음 중 하나가 아닙니다');
    }

    var milestone = normalizeMilestoneCell(cell(10));
    var memo = cellStr(11);

    rows.push({
      excelRow: excelRow,
      projectName: projectName,
      category: category,
      name: name,
      parentName: parentName,
      assignee: assignee,
      startDate: sd.value || '',
      endDate: ed.value || '',
      progress: pg.value != null ? pg.value : 0,
      status: status,
      priority: priority,
      milestone: milestone,
      memo: memo,
      raw: raw.slice(0, EXCEL_COLUMNS.length),
      errors: errors,
    });
  }
  return { headerError: null, rows: rows, dataRowCount: dataRowCount };
}

// ─────────────────────────────────────────────────────────────
// 가져오기: 반영 계획 수립 (프로젝트 병합 + 상위태스크 해석 + 부모 우선 순서)
// ─────────────────────────────────────────────────────────────

/**
 * 파싱된 행들로 반영 계획을 만든다.
 * - 프로젝트: 이름+구분이 기존과 일치하면 그 프로젝트에 병합, 없으면 새로 생성
 * - 상위태스크: 같은 파일 내 태스크명(같은 프로젝트) 우선, 없으면 기존 태스크명에서 찾기
 * - 순서: 부모가 먼저 생성되도록 위상 정렬. 해석 불가/순환/오류 부모는 행 오류로 추가
 * @returns {{projectPlans:Array, orderedRows:Array}}
 *   projectPlans[i]: { key, name, category, existingId|null }
 *   orderedRows: 반영 순서의 유효 행 (각 행에 projectKey, parentRef 부여)
 */
function planImport(rows, existingProjects, existingTasks) {
  var validRows = rows.filter(function (r) { return r.errors.length === 0; });

  // 1) 프로젝트 계획 (이름+구분 기준, 파일 등장 순서 유지)
  var projectPlans = [];
  var planByKey = {};
  validRows.forEach(function (r) {
    var key = r.projectName + ' ' + r.category; // 이름에 공백이 있어도 안전한 구분자
    r.projectKey = key;
    if (!planByKey[key]) {
      var existing = existingProjects.find(function (p) {
        return p.name === r.projectName && p.category === r.category;
      });
      var plan = { key: key, name: r.projectName, category: r.category, existingId: existing ? existing.id : null };
      planByKey[key] = plan;
      projectPlans.push(plan);
    }
  });

  // 1.5) 중복 판정 — 반영 대상 프로젝트 안에 "태스크명 + 상위태스크명"이 모두
  //      같은 기존 태스크가 있으면 중복(제외). 같은 파일 안에서 같은 조합이
  //      두 번 나오면 두 번째부터 중복. (중복은 오류가 아니라 조용히 건너뜀)
  var existingById = {};
  existingTasks.forEach(function (t) { existingById[t.id] = t; });
  // 기존 태스크의 부모 이름 ('' = 최상위 또는 부모 유실)
  function existingParentNameOf(t) {
    return (t.parentId && existingById[t.parentId]) ? existingById[t.parentId].name : '';
  }
  var seenCombo = {}; // "프로젝트키\0태스크명\0상위태스크명" → 첫 등장 행
  validRows.forEach(function (r) {
    r.duplicate = false;
    r.duplicateOf = null; // 중복 대상 기존 태스크 (자식 행의 부모 연결에 사용)
    var plan = planByKey[r.projectKey];
    if (plan && plan.existingId) {
      var match = existingTasks.find(function (t) {
        return t.projectId === plan.existingId && t.name === r.name &&
               existingParentNameOf(t) === r.parentName;
      });
      if (match) { r.duplicate = true; r.duplicateOf = match; }
    }
    var combo = r.projectKey + ' ' + r.name + ' ' + r.parentName;
    if (seenCombo[combo]) {
      // 파일 내부 중복: 두 번째부터 제외 (첫 행이 기존 중복이면 그 대상을 물려받음)
      r.duplicate = true;
      if (!r.duplicateOf) r.duplicateOf = seenCombo[combo].duplicateOf;
    } else {
      seenCombo[combo] = r;
    }
  });

  // 2) 상위태스크 해석 준비: 프로젝트 키별 "파일 내 태스크명 → 첫 등장 행" 맵
  var fileRowByName = {};
  validRows.forEach(function (r) {
    var m = (fileRowByName[r.projectKey] = fileRowByName[r.projectKey] || {});
    if (!m[r.name]) m[r.name] = r;
  });

  // 기존 태스크에서 이름으로 찾기 (기존 프로젝트에 병합될 때만 의미 있음)
  function findExistingTask(plan, name) {
    if (!plan || !plan.existingId) return null;
    return existingTasks.find(function (t) {
      return t.projectId === plan.existingId && t.name === name;
    }) || null;
  }

  // 각 행의 부모 참조 결정 (파일 내 행 우선 → 기존 태스크 → 실패)
  validRows.forEach(function (r) {
    if (!r.parentName) { r.parentRef = null; return; }
    var fileRow = (fileRowByName[r.projectKey] || {})[r.parentName];
    if (fileRow && fileRow !== r) {
      if (fileRow.duplicate) {
        // 부모가 중복으로 제외된 행 → 그 중복 대상(기존의 동일 태스크)에 연결
        if (fileRow.duplicateOf) {
          r.parentRef = { type: 'existing', taskId: fileRow.duplicateOf.id };
        } else {
          r.parentRef = { type: 'missing' }; // 이론상 도달 불가 (첫 등장 행은 파일 내 중복이 아님)
        }
        return;
      }
      r.parentRef = { type: 'row', row: fileRow };
      return;
    }
    var existing = findExistingTask(planByKey[r.projectKey], r.parentName);
    if (existing) {
      r.parentRef = { type: 'existing', taskId: existing.id };
      return;
    }
    r.parentRef = { type: 'missing' };
  });

  // 3) 부모 우선 위상 정렬 (파일 순서 안정 유지) — 중복 행은 반영 대상에서 제외
  var duplicateRows = validRows.filter(function (r) { return r.duplicate; });
  var orderedRows = [];
  var placed = new Set();
  var remaining = validRows.filter(function (r) { return !r.duplicate; });
  var progressed = true;
  while (remaining.length > 0 && progressed) {
    progressed = false;
    var next = [];
    remaining.forEach(function (r) {
      var ready = false;
      if (!r.parentRef) ready = true;                                         // 최상위
      else if (r.parentRef.type === 'existing') ready = true;                 // 기존 태스크가 부모
      else if (r.parentRef.type === 'row') ready = placed.has(r.parentRef.row); // 파일 내 부모가 이미 배치됨
      // type 'missing' 은 ready 가 될 수 없음 → 아래에서 오류 처리
      if (ready) {
        orderedRows.push(r);
        placed.add(r);
        progressed = true;
      } else {
        next.push(r);
      }
    });
    remaining = next;
  }

  // 4) 끝내 배치되지 못한 행 → 사유별 오류 부여
  remaining.forEach(function (r) {
    if (r.parentRef && r.parentRef.type === 'missing') {
      // 같은 파일에 이름이 같은 "오류 행"이 있으면 더 구체적으로 안내한다
      var errParent = rows.find(function (o) {
        return o !== r && o.errors.length > 0 &&
               o.projectName === r.projectName && o.category === r.category &&
               o.name === r.parentName;
      });
      if (errParent) {
        r.errors.push(r.excelRow + '행 상위태스크: 상위태스크 \'' + r.parentName + '\'(' + errParent.excelRow + '행)에 오류가 있어 반영할 수 없습니다');
      } else {
        r.errors.push(r.excelRow + '행 상위태스크: \'' + r.parentName + '\'을(를) 같은 파일 또는 기존 태스크에서 찾을 수 없습니다');
      }
    } else if (r.parentRef && r.parentRef.type === 'row' && r.parentRef.row.errors.length > 0) {
      r.errors.push(r.excelRow + '행 상위태스크: 상위태스크 \'' + r.parentName + '\'(' + r.parentRef.row.excelRow + '행)에 오류가 있어 반영할 수 없습니다');
    } else {
      r.errors.push(r.excelRow + '행 상위태스크: \'' + r.parentName + '\' 관계가 순환하거나 해석할 수 없습니다');
    }
  });

  // 프로젝트 계획은 최종 유효 행이 하나라도 있는 것만 남긴다
  var finalPlans = projectPlans.filter(function (plan) {
    return orderedRows.some(function (r) { return r.projectKey === plan.key; });
  });

  return { projectPlans: finalPlans, orderedRows: orderedRows, duplicateRows: duplicateRows };
}

// rows 전체의 오류 개수 합
function countImportErrors(rows) {
  var n = 0;
  rows.forEach(function (r) { n += r.errors.length; });
  return n;
}

/**
 * 가져오기 전체 검증 파이프라인: aoa → 파싱 → 계획 수립 → 연쇄 오류 안정화 반복.
 * (부모 행 오류로 자식이 새로 무효화되면 그 자식을 제외하고 다시 계획한다)
 * @returns {{headerError, rows, dataRowCount, errors:[{excelRow,message}],
 *            plan:{projectPlans, orderedRows},
 *            summary:{newProjects, mergeProjects, tasks}}}
 */
function validateImport(aoa, existingProjects, existingTasks) {
  var parsed = parseImportAoa(aoa);
  if (parsed.headerError) {
    return {
      headerError: parsed.headerError, rows: [], dataRowCount: 0,
      errors: [{ excelRow: 1, message: parsed.headerError }],
      plan: { projectPlans: [], orderedRows: [], duplicateRows: [] },
      summary: { newProjects: 0, mergeProjects: 0, tasks: 0, duplicates: 0 },
    };
  }

  // planImport 는 부모 문제로 새 오류를 행에 추가할 수 있다 → 오류 수가 변하지
  // 않을 때까지 반복 (행 수 이상 반복될 수 없어 항상 종료)
  var plan = planImport(parsed.rows, existingProjects, existingTasks);
  var prev = -1;
  var cur = countImportErrors(parsed.rows);
  while (cur !== prev) {
    prev = cur;
    plan = planImport(parsed.rows, existingProjects, existingTasks);
    cur = countImportErrors(parsed.rows);
  }

  // 평탄한 오류 목록 (행 순서대로)
  var errors = [];
  parsed.rows.forEach(function (r) {
    r.errors.forEach(function (msg) { errors.push({ excelRow: r.excelRow, message: msg }); });
  });

  var newProjects = plan.projectPlans.filter(function (p) { return !p.existingId; }).length;
  return {
    headerError: null,
    rows: parsed.rows,
    dataRowCount: parsed.dataRowCount,
    errors: errors,
    plan: plan,
    summary: {
      newProjects: newProjects,
      mergeProjects: plan.projectPlans.length - newProjects,
      tasks: plan.orderedRows.length,
      duplicates: plan.duplicateRows.length, // 중복으로 제외된 행 수
    },
  };
}

// Node(테스트) 환경에서 순수 함수 검증할 수 있도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    EXCEL_COLUMNS: EXCEL_COLUMNS,
    EXCEL_STATUS_LABELS: EXCEL_STATUS_LABELS,
    EXCEL_CATEGORY_LABELS: EXCEL_CATEGORY_LABELS,
    EXCEL_PRIORITY_LABELS: EXCEL_PRIORITY_LABELS,
    orderTasksForExport: orderTasksForExport,
    buildExportAoa: buildExportAoa,
    excelDisplayWidth: excelDisplayWidth,
    computeColWidths: computeColWidths,
    crc32Bytes: crc32Bytes,
    zipStoreEntries: zipStoreEntries,
    injectFreezePane: injectFreezePane,
    buildXlsxBytes: buildXlsxBytes,
    exportFileName: exportFileName,
    normalizeCategoryCell: normalizeCategoryCell,
    normalizeStatusCell: normalizeStatusCell,
    normalizePriorityCell: normalizePriorityCell,
    normalizeMilestoneCell: normalizeMilestoneCell,
    normalizeDateCell: normalizeDateCell,
    normalizeProgressCell: normalizeProgressCell,
    excelSerialToYmd: excelSerialToYmd,
    parseImportAoa: parseImportAoa,
    planImport: planImport,
    validateImport: validateImport,
  };
}

// ─────────────────────────────────────────────────────────────
// 브라우저 UI (드롭다운 · 내보내기 실행 · 가져오기 미리보기/반영)
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    // HTML 이스케이프 (crud.js 와 동일 규칙)
    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    // ── 토스트 (drag.js 의 toast-host/스타일 재사용, 성공은 초록 변형) ──
    function showToastMsg(message, isError) {
      var host = $('toast-host');
      if (!host) {
        host = document.createElement('div');
        host.id = 'toast-host';
        host.className = 'toast-host';
        document.body.appendChild(host);
      }
      var el = document.createElement('div');
      el.className = 'toast ' + (isError ? 'toast--error' : 'toast--success');
      el.setAttribute('role', 'alert');
      el.textContent = message;
      host.appendChild(el);
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { el.classList.add('is-shown'); });
      });
      setTimeout(function () {
        el.classList.remove('is-shown');
        setTimeout(function () { el.remove(); }, 250);
      }, 3000);
    }

    // 현재 데이터 스냅샷 (gantt.js 가 노출)
    function state() {
      return (window.GanttApp && window.GanttApp.getState())
        ? window.GanttApp.getState()
        : { projects: [], tasks: [] };
    }

    // ── 서버 POST 헬퍼 (실패 시 한국어 메시지로 throw) ──
    async function apiPost(url, body) {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      var data = null;
      try { data = await res.json(); } catch (e) { /* 본문 없음 */ }
      if (!res.ok) {
        throw new Error((data && data.error) ? data.error : ('요청 실패 (HTTP ' + res.status + ')'));
      }
      return data;
    }

    // ─────────────────────────────────────────────────────
    // 내보내기: (범위 반영) 워크북 생성 → Blob 다운로드
    // scope: window.ExportScope.choose 결과 {mode:'all'|'project', projectId, projectName}
    // ─────────────────────────────────────────────────────
    function doExport(scope) {
      var s = state();
      if (s.projects.length === 0) {
        showToastMsg('내보낼 프로젝트가 없습니다.', true);
        return;
      }
      // 범위 적용: 프로젝트별이면 해당 프로젝트+소속 태스크만 (scope.js 공유 함수)
      var projects = s.projects;
      var tasks = s.tasks;
      var namePart = '';
      if (scope && scope.mode === 'project') {
        var filtered = filterByProject(s.projects, s.tasks, scope.projectId);
        projects = filtered.projects;
        tasks = filtered.tasks;
        namePart = sanitizeFileNamePart(scope.projectName);
      }
      try {
        var bytes = buildXlsxBytes(projects, tasks, window.XLSX);
        var blob = new Blob([bytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = exportFileName(new Date(), namePart);
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
        showToastMsg('엑셀 파일을 내보냈습니다.', false);
      } catch (ex) {
        showToastMsg('내보내기 실패: ' + ex.message, true);
      }
    }

    // ─────────────────────────────────────────────────────
    // 가져오기: 파일 선택 → 파싱/검증 → 미리보기 모달
    // ─────────────────────────────────────────────────────
    var pendingImport = null; // 검증 결과 (모달이 열려 있는 동안 유지)
    var importTrap = null;    // Tab 트랩 (12단계) — 모달이 열려 있는 동안만 유지

    async function importFromFile(file) {
      try {
        var buf = await file.arrayBuffer();
        var wb = window.XLSX.read(new Uint8Array(buf), { type: 'array' });
        var sheetName = wb.SheetNames[0];
        if (!sheetName) throw new Error('시트를 찾을 수 없습니다.');
        var aoa = window.XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
          header: 1, raw: true, defval: '',
        });
        var s = state();
        pendingImport = validateImport(aoa, s.projects, s.tasks);
        openImportModal(pendingImport);
      } catch (ex) {
        showToastMsg('가져오기 실패: ' + ex.message, true);
      }
    }

    // 미리보기 모달 렌더링
    function openImportModal(result) {
      var backdrop = $('import-backdrop');

      // 요약: 추가될 프로젝트/태스크 수 + 오류 수
      var sm = result.summary;
      var summaryHtml =
        '새 프로젝트 <strong>' + sm.newProjects + '개</strong> · ' +
        '기존 프로젝트에 병합 <strong>' + sm.mergeProjects + '개</strong> · ' +
        '추가될 태스크 <strong>' + sm.tasks + '개</strong>';
      if (sm.duplicates > 0) {
        summaryHtml += ' · <span class="import-summary__dup">중복 제외 ' + sm.duplicates + '건</span>';
      }
      if (result.errors.length > 0) {
        summaryHtml += ' · <span class="import-summary__err">오류 ' + result.errors.length + '건</span>';
      }
      $('import-summary').innerHTML = summaryHtml;

      // 오류 목록
      var errBox = $('import-errors');
      if (result.errors.length > 0) {
        errBox.hidden = false;
        errBox.innerHTML = '<div class="import-errors__title">오류 목록</div><ul>' +
          result.errors.map(function (e) { return '<li>' + esc(e.message) + '</li>'; }).join('') +
          '</ul>';
      } else {
        errBox.hidden = true;
        errBox.innerHTML = '';
      }

      // 행 미리보기 테이블 (파일 순서, 처음 20행 + "…외 N행")
      var MAX_PREVIEW = 20;
      var rows = result.rows;
      var thead = '<tr><th>행</th>' + EXCEL_COLUMNS.map(function (c) {
        return '<th>' + esc(c) + '</th>';
      }).join('') + '</tr>';
      var bodyHtml = rows.slice(0, MAX_PREVIEW).map(function (r) {
        // 오류(빨강)가 중복(회색)보다 우선 표시
        var isDup = r.errors.length === 0 && r.duplicate;
        var cls = r.errors.length > 0 ? ' class="is-error"' : (isDup ? ' class="is-duplicate"' : '');
        var cells = [
          r.projectName, EXCEL_CATEGORY_LABELS[r.category] || '', r.name, r.parentName,
          r.assignee, r.startDate, r.endDate, r.progress,
          EXCEL_STATUS_LABELS[r.status] || '', EXCEL_PRIORITY_LABELS[r.priority] || '',
          r.milestone ? 'O' : '', r.memo,
        ];
        // 정규화에 실패한 셀은 원본 값을 그대로 보여준다 (무엇이 문제인지 보이도록)
        if (r.category === null) cells[1] = String(r.raw[1] == null ? '' : r.raw[1]);
        if (r.status === null) cells[8] = String(r.raw[8] == null ? '' : r.raw[8]);
        if (r.priority === null) cells[9] = String(r.raw[9] == null ? '' : r.raw[9]);
        if (!r.startDate) cells[5] = String(r.raw[5] == null ? '' : r.raw[5]);
        if (!r.endDate) cells[6] = String(r.raw[6] == null ? '' : r.raw[6]);
        var tds = cells.map(function (v) { return '<td>' + esc(v) + '</td>'; });
        // 중복 행: 태스크명 셀에 "중복(제외)" 배지 표기
        if (isDup) {
          tds[2] = '<td>' + esc(cells[2]) + ' <span class="dup-badge">중복(제외)</span></td>';
        }
        return '<tr' + cls + '><td>' + r.excelRow + '</td>' + tds.join('') + '</tr>';
      }).join('');
      var moreHtml = rows.length > MAX_PREVIEW
        ? '<tr><td colspan="' + (EXCEL_COLUMNS.length + 1) + '" class="import-table__more">…외 ' +
          (rows.length - MAX_PREVIEW) + '행</td></tr>'
        : '';
      $('import-table').innerHTML = '<thead>' + thead + '</thead><tbody>' + bodyHtml + moreHtml + '</tbody>';

      // 반영 버튼 상태: 오류가 있으면 비활성 + "오류 행 제외" 체크로만 활성화
      var applyBtn = $('import-apply');
      var excludeWrap = $('import-exclude-wrap');
      var excludeCb = $('import-exclude');
      excludeCb.checked = false;
      if (result.headerError || sm.tasks === 0) {
        // 반영할 수 있는 행이 하나도 없음
        excludeWrap.hidden = true;
        applyBtn.disabled = true;
      } else if (result.errors.length > 0) {
        excludeWrap.hidden = false;
        applyBtn.disabled = true; // "오류 행 제외" 체크 시에만 활성화
      } else {
        excludeWrap.hidden = true;
        applyBtn.disabled = false;
      }

      backdrop.hidden = false;
      // Tab 트랩 활성화 (12단계)
      if (window.FocusTrap) importTrap = window.FocusTrap.activate(backdrop);
    }

    function closeImportModal() {
      if (importTrap) { importTrap.deactivate(); importTrap = null; }
      $('import-backdrop').hidden = true;
      pendingImport = null;
    }

    // ─────────────────────────────────────────────────────
    // 가져오기: 반영 (프로젝트 생성 → 태스크 부모 우선 순차 POST)
    // ─────────────────────────────────────────────────────
    async function applyImport(result) {
      var plan = result.plan;
      var projectIds = {};          // projectKey -> (기존 또는 새로 생성된) 프로젝트 id
      var createdTaskIds = new Map(); // 행 객체 -> 생성된 태스크 id
      var projectCount = 0;
      var taskCount = 0;

      // 1) 프로젝트: 기존 병합이면 그 id 사용, 아니면 새로 생성
      for (var i = 0; i < plan.projectPlans.length; i++) {
        var p = plan.projectPlans[i];
        if (p.existingId) {
          projectIds[p.key] = p.existingId;
        } else {
          var created = await apiPost('/api/projects', { name: p.name, category: p.category });
          projectIds[p.key] = created.id;
          projectCount++;
        }
      }

      // 2) 태스크: 위상 정렬된 순서(부모 먼저)로 순차 생성
      for (var j = 0; j < plan.orderedRows.length; j++) {
        var r = plan.orderedRows[j];
        var parentId = null;
        if (r.parentRef && r.parentRef.type === 'row') parentId = createdTaskIds.get(r.parentRef.row) || null;
        else if (r.parentRef && r.parentRef.type === 'existing') parentId = r.parentRef.taskId;
        var task;
        try {
          task = await apiPost('/api/tasks', {
            projectId: projectIds[r.projectKey],
            name: r.name,
            parentId: parentId,
            assignee: r.assignee,
            startDate: r.startDate,
            endDate: r.endDate,
            progress: r.progress,
            status: r.status,
            priority: r.priority,
            milestone: r.milestone,
            dependencies: [],
            memo: r.memo,
          });
        } catch (ex) {
          // 중간 실패: 어디까지 반영됐는지 알려주고 중단
          throw new Error(r.excelRow + '행(' + r.name + ') 반영 중 오류: ' + ex.message +
            ' — 프로젝트 ' + projectCount + '개, 태스크 ' + taskCount + '개는 이미 반영되었습니다.');
        }
        createdTaskIds.set(r, task.id);
        taskCount++;
      }

      return { projectCount: projectCount, taskCount: taskCount };
    }

    // ─────────────────────────────────────────────────────
    // 이벤트 바인딩
    // ─────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
      var btn = $('btn-excel');
      var menu = $('excel-menu');
      var fileInput = $('excel-file-input');

      // "엑셀 ▾" 드롭다운 열기/닫기 ("표시 ▾" 와 동일 동작)
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var willOpen = menu.hidden;
        menu.hidden = !willOpen;
        btn.setAttribute('aria-expanded', String(willOpen));
      });
      document.addEventListener('click', function (e) {
        if (menu.hidden) return;
        if (e.target === btn || menu.contains(e.target)) return;
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
      });

      // 내보내기 — 범위 선택 모달(scope.js)을 거쳐 실행
      $('btn-excel-export').addEventListener('click', function () {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        // 프로젝트가 없으면 모달을 띄우지 않고 기존 안내 토스트 유지
        if (state().projects.length === 0) {
          showToastMsg('내보낼 프로젝트가 없습니다.', true);
          return;
        }
        window.ExportScope.choose({ title: '엑셀 내보내기 범위' }).then(function (scope) {
          if (!scope) return; // 취소
          doExport(scope);
        });
      });

      // 가져오기 → 파일 선택 대화상자
      $('btn-excel-import').addEventListener('click', function () {
        menu.hidden = true;
        btn.setAttribute('aria-expanded', 'false');
        fileInput.click();
      });

      // 파일 선택 완료 → 파싱/검증 → 미리보기
      fileInput.addEventListener('change', function () {
        var f = fileInput.files && fileInput.files[0];
        fileInput.value = ''; // 같은 파일을 다시 선택해도 change 가 발생하도록 초기화
        if (f) importFromFile(f);
      });

      // 미리보기 모달: 취소/배경 클릭으로 닫기
      $('import-cancel').addEventListener('click', closeImportModal);
      $('import-backdrop').addEventListener('click', function (e) {
        if (e.target === $('import-backdrop')) closeImportModal();
      });

      // "오류 행을 제외하고 반영" 체크 → 반영 버튼 활성/비활성
      $('import-exclude').addEventListener('change', function () {
        if (!pendingImport) return;
        if (pendingImport.errors.length > 0 && pendingImport.summary.tasks > 0) {
          $('import-apply').disabled = !$('import-exclude').checked;
        }
      });

      // 반영 실행
      $('import-apply').addEventListener('click', async function () {
        if (!pendingImport) return;
        var result = pendingImport;
        var applyBtn = $('import-apply');
        applyBtn.disabled = true;
        applyBtn.textContent = '반영 중…';
        try {
          var done = await applyImport(result);
          closeImportModal();
          var doneMsg = '가져오기 완료: 프로젝트 ' + done.projectCount + '개, 태스크 추가 ' +
            done.taskCount + '건';
          if (result.summary.duplicates > 0) {
            doneMsg += ', 중복 제외 ' + result.summary.duplicates + '건';
          }
          showToastMsg(doneMsg + '.', false);
        } catch (ex) {
          closeImportModal();
          showToastMsg(ex.message, true);
        } finally {
          applyBtn.textContent = '반영';
          if (window.GanttApp) await window.GanttApp.reload(); // 성공/실패 모두 재로딩
        }
      });

      // Esc 로 미리보기 모달 닫기 (열려 있을 때만)
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && !$('import-backdrop').hidden) closeImportModal();
      });
    });
  })();
}
