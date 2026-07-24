// PPTX 네이티브 도형 렌더링 (13단계) — 캡처 이미지가 아니라 PptxGenJS 기본 요소
// (addShape / addText / 선)로 간트 차트를 슬라이드에 "다시 그린다".
// - 확대해도 선명하고, 파워포인트에서 개별 도형을 직접 편집할 수 있다.
// - 좌표 계산(날짜→인치 매핑)·분할 판정·눈금 단위 결정·표 페이지네이션은 전부
//   파일 상단의 "순수 함수"로 분리하고 파일 끝에서 module.exports 한다
//   (drag.js / scope.js / png.js / pptx.js 와 동일한 패턴 — Node 단위 테스트 대상).
// - 브라우저 전용 그리기 코드(window.PptxShapes)는 하단 typeof document 블록에 둔다.
//
// ※ buildShapeRows 는 gantt.js 의 buildRows 와 같은 규칙(프로젝트 그룹 헤더 + order/이름
//   정렬 DFS 계층 평탄화)을 순수 함수로 재구현한 것이다. gantt.js 의 원본은 IIFE 내부라
//   Node 에서 require 할 수 없기 때문이며, 규칙이 어긋나지 않도록 단위 테스트로 고정한다.
//   (pptx.js 가 png.js 헬퍼를 자체 구현한 것과 같은 이유)

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

// 상태 색 (bar = 기본색, dark = 진행률 채움·테두리·마일스톤용 어두운 톤) — 화면/범례와 동일
var SHAPE_STATUS_COLORS = {
  plan:     { bar: '9CA3AF', dark: '6B7280' },
  setup:    { bar: '8B5CF6', dark: '6D28D9' },
  ongoing:  { bar: '3B82F6', dark: '1D4ED8' },
  complete: { bar: '22C55E', dark: '15803D' },
  delayed:  { bar: 'EF4444', dark: 'B91C1C' },
};
// 범례 표시 순서 (index.html 범례 바와 동일)
var SHAPE_STATUS_ORDER = ['plan', 'setup', 'ongoing', 'complete', 'delayed'];

// 요일 라벨 (gantt.js WEEKDAY_KR 과 동일)
var SHAPE_WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토'];

// 우선순위 라벨 (표 슬라이드용)
var SHAPE_PRIORITY_LABELS = { high: '높음', medium: '보통', low: '낮음' };
// 우선순위 세로 띠 색 (화면 --prio-high / --prio-low-bar 라이트 값과 동일)
var SHAPE_PRIORITY_COLORS = { high: 'C2410C', low: 'D1D5DB' };

// 카테고리 라벨 (프로젝트 그룹 헤더 배지)
var SHAPE_CATEGORY_LABELS = { work: '업무', personal: '개인' };

// 눈금 한 칸의 "읽을 수 있는" 최소 폭(인치). 이 값보다 좁아지면 한 단계 굵은
// 단위(일→주→월)로 낮춘다. 라벨 글자 수 기준으로 잡은 값:
//   day  "12 수"   (3글자, 7pt)  → 0.16in
//   week "7/21 주" (6글자, 7pt)  → 0.28in
//   month "7월"    (2글자, 7pt)  → 0.30in  (월 라벨은 칸이 넓어야 축이 성기게 보이지 않는다)
var MIN_TICK_W_IN = { day: 0.16, week: 0.28, month: 0.30 };

// 눈금 단위별 "한 칸이 덮는 평균 일수" (분할 장수 추정용. 월은 365.25/12)
var TICK_DAYS = { day: 1, week: 7, month: 30.4375 };

// 격자선을 그릴 최대 눈금 수. 이보다 촘촘하면 세로 격자선을 생략해
// 도형 수 폭증과 시각적 노이즈를 막는다.
var MAX_GRID_LINES = 120;

// 슬라이드 기하 기본값 (인치, LAYOUT_WIDE 16:9 = 13.333 x 7.5)
var SHAPE_GEOM_DEFAULTS = {
  slideW: 13.333,     // 슬라이드 폭
  slideH: 7.5,        // 슬라이드 높이
  marginX: 0.3,       // 좌우 여백
  titleY: 0.12,       // 제목 y
  titleH: 0.34,       // 제목 높이
  axisY: 0.56,        // 날짜 축 헤더 시작 y
  axisRowH: 0.24,     // 축 헤더 한 줄 높이 (2줄이므로 총 0.48)
  leftColW: 2.9,      // 좌측 태스크명 열 폭
  legendH: 0.30,      // 하단 범례 높이
  legendGap: 0.10,    // 본문과 범례 사이 간격
  bottomPad: 0.10,    // 슬라이드 하단 여백
  prefRowH: 0.26,     // 선호 행 높이 (행이 적으면 이 값을 그대로 사용)
  minRowH: 0.19,      // 최소 가독 행 높이 — 이보다 얇아져야 할 만큼 행이 많으면 슬라이드 분할
};

// ─────────────────────────────────────────────────────────────
// 날짜 헬퍼 (Node 단독 require 가 가능하도록 자체 보유 — scope.js 와 동일 규칙)
// ─────────────────────────────────────────────────────────────

/** 'YYYY-MM-DD' → 로컬 자정 Date */
function shpYmdToDate(str) {
  var p = String(str).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

/** Date → 'YYYY-MM-DD' */
function shpDateToYmd(d) {
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
}

/** n일 뒤 Date */
function shpAddDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

/** 두 날짜 사이의 일수 차 (b - a). 자정 정규화 후 계산해 서머타임 영향 제거 */
function shpDiffDays(a, b) {
  var a0 = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  var b0 = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((b0 - a0) / 86400000);
}

/**
 * 자동 지연 경고 대상인지 판정한다 (gantt.js isOverdue 와 동일 규칙).
 * 완료가 아닌데 종료일이 기준일보다 이전이면 경고 대상.
 * @param {{status?:string, endDate?:string}} task
 * @param {Date} today 기준일 (자정 정규화된 Date)
 * @returns {boolean}
 */
function shpIsOverdue(task, today) {
  if (!task || !task.endDate) return false;
  if (task.status === 'complete') return false;
  return shpDiffDays(today, shpYmdToDate(task.endDate)) < 0;
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 1 — 행 목록 구성
// ─────────────────────────────────────────────────────────────

/**
 * 프로젝트 그룹 헤더 + 계층 평탄화된 태스크 행 목록을 만든다.
 * (gantt.js buildRows 와 동일 규칙: order 오름차순 → 이름순, DFS, 순환/미아 방어)
 * @param {Array<{id:*, name:string, category?:string}>} projects
 * @param {Array<object>} tasks
 * @returns {Array<{type:'group', project:object} | {type:'task', task:object, level:number}>}
 */
function buildShapeRows(projects, tasks) {
  var rows = [];
  (projects || []).forEach(function (project) {
    rows.push({ type: 'group', project: project });

    var own = (tasks || []).filter(function (t) { return t.projectId === project.id; });

    // parentId → 자식 목록 (최상위 키는 '')
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
    function walk(parentKey, level) {
      var children = byParent[parentKey] || [];
      children.forEach(function (t) {
        if (visited[t.id]) return;   // 순환 방어
        visited[t.id] = true;
        rows.push({ type: 'task', task: t, level: level });
        walk(t.id, level + 1);
      });
    }
    walk('', 0);
    // 부모가 같은 프로젝트에 없어 누락된 태스크는 최상위로 붙인다
    own.forEach(function (t) {
      if (!visited[t.id]) {
        visited[t.id] = true;
        rows.push({ type: 'task', task: t, level: 0 });
      }
    });
  });
  return rows;
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 2 — 슬라이드 기하 계산
// ─────────────────────────────────────────────────────────────

/**
 * 슬라이드 안에서 차트 각 영역이 차지할 좌표(인치)를 계산한다.
 * 위에서부터: 제목 → 날짜 축 2줄 → 본문(행) → 범례 순.
 * @param {object} [opts] SHAPE_GEOM_DEFAULTS 를 부분 덮어쓰기
 * @returns {{slideW,slideH,chartX,chartRight,leftColW,timelineX,timelineW,
 *            titleY,titleH,axisY,axisRowH,axisH,bodyY,bodyH,legendY,legendH,
 *            prefRowH,minRowH}}
 */
function shapeGeometry(opts) {
  var g = {};
  Object.keys(SHAPE_GEOM_DEFAULTS).forEach(function (k) { g[k] = SHAPE_GEOM_DEFAULTS[k]; });
  if (opts) Object.keys(opts).forEach(function (k) { if (opts[k] != null) g[k] = opts[k]; });

  var chartX = g.marginX;
  var chartRight = g.slideW - g.marginX;
  var timelineX = chartX + g.leftColW;
  var timelineW = chartRight - timelineX;
  var axisH = g.axisRowH * 2;                 // 축 헤더는 항상 2줄
  var bodyY = g.axisY + axisH;
  var legendY = g.slideH - g.bottomPad - g.legendH;
  var bodyH = legendY - g.legendGap - bodyY;

  return {
    slideW: g.slideW, slideH: g.slideH,
    chartX: chartX, chartRight: chartRight,
    leftColW: g.leftColW, timelineX: timelineX, timelineW: timelineW,
    titleY: g.titleY, titleH: g.titleH,
    axisY: g.axisY, axisRowH: g.axisRowH, axisH: axisH,
    bodyY: bodyY, bodyH: bodyH,
    legendY: legendY, legendH: g.legendH,
    prefRowH: g.prefRowH, minRowH: g.minRowH,
  };
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 3 — 행 분할 (세로 방향)
// ─────────────────────────────────────────────────────────────

/**
 * 행이 많아 한 슬라이드에 "읽을 수 있는 높이"로 담기지 않으면 행 기준으로 나눈다.
 * 판정 규칙:
 *   1) 한 슬라이드에 넣을 수 있는 최대 행 수 maxRows = floor(bodyH / minRowH)
 *   2) 필요한 슬라이드 수 slides = ceil(rowCount / maxRows)
 *   3) 슬라이드마다 행 수가 들쭉날쭉하지 않도록 rowsPerSlide = ceil(rowCount / slides) 로 균등 분배
 *   4) 실제 행 높이 rowH = min(prefRowH, bodyH / rowsPerSlide)
 *      (행이 적을 때 억지로 늘려 스카스카해 보이지 않도록 prefRowH 로 상한을 둔다)
 * @param {number} rowCount 전체 행 수 (그룹 헤더 포함)
 * @param {number} bodyH    본문 영역 높이(인치)
 * @param {number} prefRowH 선호 행 높이(인치)
 * @param {number} minRowH  최소 가독 행 높이(인치)
 * @returns {{slides:number, rowsPerSlide:number, rowH:number,
 *            slices:Array<{start:number,end:number}>}}
 */
function computeRowSlices(rowCount, bodyH, prefRowH, minRowH) {
  var n = (rowCount > 0) ? Math.floor(rowCount) : 0;
  var pref = prefRowH > 0 ? prefRowH : SHAPE_GEOM_DEFAULTS.prefRowH;
  var min = minRowH > 0 ? minRowH : SHAPE_GEOM_DEFAULTS.minRowH;
  var h = bodyH > 0 ? bodyH : min;

  if (n === 0) {
    return { slides: 1, rowsPerSlide: 0, rowH: pref, slices: [{ start: 0, end: 0 }] };
  }

  var maxRows = Math.floor(h / min);
  if (maxRows < 1) maxRows = 1;

  var slides = Math.ceil(n / maxRows);
  if (slides < 1) slides = 1;

  var rowsPerSlide = Math.ceil(n / slides);
  var rowH = Math.min(pref, h / rowsPerSlide);

  var slices = [];
  for (var s = 0; s < slides; s++) {
    var start = s * rowsPerSlide;
    var end = Math.min(n, start + rowsPerSlide);
    if (start >= end && s > 0) break;   // 균등 분배 결과 마지막 조각이 비면 버린다
    slices.push({ start: start, end: end });
  }
  return { slides: slices.length, rowsPerSlide: rowsPerSlide, rowH: rowH, slices: slices };
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 4 — 눈금 단위 결정 + 기간 분할 (가로 방향)
// ─────────────────────────────────────────────────────────────

/** 눈금 단위별 칸 개수 (totalDays 를 해당 단위로 나눈 올림값) */
function tickCountFor(unit, totalDays) {
  var d = totalDays > 0 ? totalDays : 1;
  if (unit === 'day') return d;
  if (unit === 'week') return Math.max(1, Math.ceil(d / 7));
  return Math.max(1, Math.ceil(d / TICK_DAYS.month));
}

/** 해당 단위로 그렸을 때 눈금 한 칸의 폭(인치) */
function tickWidthIn(unit, totalDays, timelineW) {
  return (timelineW > 0 ? timelineW : 0) / tickCountFor(unit, totalDays);
}

/**
 * 슬라이드 폭에 맞는 "읽을 수 있는" 날짜 눈금 단위를 정한다.
 *
 * 판단 로직:
 *  - 화면 보기(day/week/month)를 출발점으로 삼는다. 화면보다 더 촘촘하게는 절대 그리지
 *    않는다(사용자가 월 보기를 골랐는데 일 단위로 나오면 의도와 어긋나기 때문).
 *  - 출발점부터 day → week → month 순으로 내려가며, 눈금 한 칸 폭이 MIN_TICK_W_IN
 *    이상인 첫 단위를 고른다. 즉 "칸이 너무 촘촘하면 한 단계 굵은 단위로 낮춘다".
 *  - 월 단위로도 최소 폭을 못 채우면 더 낮출 단위가 없으므로 'month' 를 돌려주고,
 *    기간 분할(computeDateSlices)이 이어서 처리한다.
 * @param {string} screenScale 'day'|'week'|'month' (그 외 값은 'day' 로 취급)
 * @param {number} totalDays   이 슬라이드가 담을 총 일수
 * @param {number} timelineW   타임라인 영역 폭(인치)
 * @returns {'day'|'week'|'month'}
 */
function pickTickUnit(screenScale, totalDays, timelineW) {
  var order = ['day', 'week', 'month'];
  var idx = order.indexOf(screenScale);
  if (idx < 0) idx = 0;
  for (var i = idx; i < order.length; i++) {
    if (tickWidthIn(order[i], totalDays, timelineW) >= MIN_TICK_W_IN[order[i]]) {
      return order[i];
    }
  }
  return 'month';
}

/**
 * 전체 일수를 parts 조각으로 균등 분할한 [start, end) 일 인덱스 경계 배열.
 * 나머지는 앞 조각부터 하루씩 더 분배한다. (png.js splitDayRanges 와 동일 규칙)
 */
function splitDaySlices(totalDays, parts) {
  var n = totalDays > 0 ? Math.floor(totalDays) : 0;
  var p = parts > 0 ? Math.floor(parts) : 1;
  var out = [];
  var base = Math.floor(n / p);
  var rem = n % p;
  var start = 0;
  for (var i = 0; i < p; i++) {
    var size = base + (i < rem ? 1 : 0);
    out.push({ startDay: start, endDay: start + size });
    start += size;
  }
  return out;
}

/**
 * 기간(가로) 분할 계획. 월 눈금으로도 칸이 최소 폭에 못 미치면 기간을 여러 슬라이드로 나눈다.
 * @param {number} totalDays    전체 일수
 * @param {number} timelineW    타임라인 폭(인치)
 * @param {string} screenScale  화면 보기 단위
 * @param {boolean} allowSplit  기간 분할 허용 여부 (레이아웃 'split' 일 때만 true)
 * @returns {Array<{startDay:number, endDay:number}>} 최소 1개
 */
function computeDateSlices(totalDays, timelineW, screenScale, allowSplit) {
  var n = totalDays > 0 ? Math.floor(totalDays) : 1;
  var whole = [{ startDay: 0, endDay: n }];
  if (!allowSplit) return whole;

  // 가장 굵은 단위(월)로도 촘촘한가?
  if (tickWidthIn('month', n, timelineW) >= MIN_TICK_W_IN.month) return whole;

  // 한 슬라이드가 최소 폭을 지키며 담을 수 있는 최대 일수
  var maxTicks = Math.floor(timelineW / MIN_TICK_W_IN.month);
  if (maxTicks < 1) maxTicks = 1;
  var maxDays = Math.floor(maxTicks * TICK_DAYS.month);
  if (maxDays < 1) maxDays = 1;

  var parts = Math.ceil(n / maxDays);
  if (parts < 2) parts = 2;      // 분할하기로 했으면 최소 2장
  return splitDaySlices(n, parts);
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 5 — 날짜 → 좌표 매핑
// ─────────────────────────────────────────────────────────────

/**
 * 일 인덱스를 슬라이드 x 좌표(인치)로 매핑한다. 해당 날짜 칸의 "왼쪽 경계".
 * @param {number} dayIndex     범위 시작일로부터의 일 인덱스
 * @param {number} sliceStartDay 이 슬라이드가 담기 시작하는 일 인덱스
 * @param {number} timelineX    타임라인 좌측 x(인치)
 * @param {number} dayW         하루당 폭(인치)
 */
function dayToX(dayIndex, sliceStartDay, timelineX, dayW) {
  return timelineX + (dayIndex - sliceStartDay) * dayW;
}

/**
 * 태스크 바가 이 슬라이스에서 차지할 x/w(인치)를 구한다.
 * 바는 [startDay, endDay+1) 구간을 덮는다(종료일 포함). 슬라이스 밖은 잘라낸다.
 * @param {number} startDay 시작일 인덱스
 * @param {number} endDay   종료일 인덱스(포함)
 * @param {{startDay:number, endDay:number}} slice
 * @param {number} timelineX 타임라인 좌측 x(인치)
 * @param {number} dayW      하루당 폭(인치)
 * @param {number} [minW]    최소 폭(인치) — 기본 0.04
 * @returns {{x:number, w:number, clipLeft:boolean, clipRight:boolean}|null}
 *          이 슬라이스에 전혀 걸치지 않으면 null
 */
function barBox(startDay, endDay, slice, timelineX, dayW, minW) {
  var mw = (minW != null) ? minW : 0.04;
  var s = Math.max(startDay, slice.startDay);
  var e = Math.min(endDay + 1, slice.endDay);
  if (e <= s) return null;
  var x = timelineX + (s - slice.startDay) * dayW;
  var w = (e - s) * dayW;
  if (w < mw) w = mw;
  return {
    x: x, w: w,
    clipLeft: startDay < slice.startDay,
    clipRight: (endDay + 1) > slice.endDay,
  };
}

/**
 * 날짜 축 헤더(상단 그룹 / 하단 눈금) 셀 목록을 만든다.
 * - day:   상단 'YYYY년 M월' / 하단 '일' + 요일, 주말 플래그
 * - week:  상단 'YYYY년 M월' / 하단 'M/D' + '주'
 * - month: 상단 'YYYY년'     / 하단 'M월'
 * @param {string} rangeStartYmd 범위 시작일 'YYYY-MM-DD'
 * @param {number} sliceStartDay 슬라이스 시작 일 인덱스
 * @param {number} sliceEndDay   슬라이스 끝 일 인덱스(미포함)
 * @param {string} unit 'day'|'week'|'month'
 * @returns {{top:Array<{label,startDay,days}>, bottom:Array<{label,sub,startDay,days,weekend}>}}
 */
function buildAxisCells(rangeStartYmd, sliceStartDay, sliceEndDay, unit) {
  var top = [], bottom = [];
  var n = sliceEndDay - sliceStartDay;
  if (!(n > 0)) return { top: top, bottom: bottom };
  var base = shpAddDays(shpYmdToDate(rangeStartYmd), sliceStartDay);

  // 같은 라벨이 이어지면 하나로 합친다 (예: 같은 달의 여러 날)
  function pushTop(label, startDay, days) {
    var last = top[top.length - 1];
    if (last && last.label === label) last.days += days;
    else top.push({ label: label, startDay: startDay, days: days });
  }

  var i = 0;
  if (unit === 'day') {
    for (i = 0; i < n; i++) {
      var d = shpAddDays(base, i);
      pushTop(d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월', sliceStartDay + i, 1);
      bottom.push({
        label: String(d.getDate()), sub: SHAPE_WEEKDAY_KR[d.getDay()],
        startDay: sliceStartDay + i, days: 1,
        weekend: (d.getDay() === 0 || d.getDay() === 6),
      });
    }
  } else if (unit === 'week') {
    while (i < n) {
      var dw = shpAddDays(base, i);
      var daysW = Math.min(7, n - i);
      pushTop(dw.getFullYear() + '년 ' + (dw.getMonth() + 1) + '월', sliceStartDay + i, daysW);
      bottom.push({
        label: (dw.getMonth() + 1) + '/' + dw.getDate(), sub: '주',
        startDay: sliceStartDay + i, days: daysW, weekend: false,
      });
      i += 7;
    }
  } else {
    while (i < n) {
      var dm = shpAddDays(base, i);
      var dim = new Date(dm.getFullYear(), dm.getMonth() + 1, 0).getDate();  // 그 달의 일수
      var daysM = Math.min(dim - dm.getDate() + 1, n - i);                    // 달 남은 일수
      pushTop(dm.getFullYear() + '년', sliceStartDay + i, daysM);
      bottom.push({
        label: (dm.getMonth() + 1) + '월', sub: '',
        startDay: sliceStartDay + i, days: daysM, weekend: false,
      });
      i += daysM;
    }
  }
  return { top: top, bottom: bottom };
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 6 — 전체 슬라이드 계획
// ─────────────────────────────────────────────────────────────

/**
 * 도형 방식 차트 슬라이드 계획을 세운다. 행 분할(세로) × 기간 분할(가로)의 조합.
 * 슬라이드 순서는 "행 묶음 바깥 루프 → 기간 안쪽 루프" (같은 행들을 시간 순으로 훑는다).
 * @param {number} rowCount 전체 행 수
 * @param {number} totalDays 전체 일수
 * @param {string} screenScale 화면 보기 단위
 * @param {boolean} allowDateSplit 기간 분할 허용 여부
 * @param {object} [geom] shapeGeometry() 결과 (미지정 시 기본값 계산)
 * @returns {{geom:object, rowH:number, rowSlices:Array, dateSlices:Array,
 *            cells:Array<{rowSlice, dateSlice, unit:string, dayW:number,
 *                         index:number, total:number}>}}
 */
function planShapeSlides(rowCount, totalDays, screenScale, allowDateSplit, geom) {
  var g = geom || shapeGeometry();
  var rowPlan = computeRowSlices(rowCount, g.bodyH, g.prefRowH, g.minRowH);
  var dateSlices = computeDateSlices(totalDays, g.timelineW, screenScale, allowDateSplit);

  var cells = [];
  var total = rowPlan.slices.length * dateSlices.length;
  for (var r = 0; r < rowPlan.slices.length; r++) {
    for (var d = 0; d < dateSlices.length; d++) {
      var ds = dateSlices[d];
      var days = Math.max(1, ds.endDay - ds.startDay);
      cells.push({
        rowSlice: rowPlan.slices[r],
        dateSlice: ds,
        unit: pickTickUnit(screenScale, days, g.timelineW),
        dayW: g.timelineW / days,
        index: cells.length + 1,
        total: total,
      });
    }
  }
  return {
    geom: g, rowH: rowPlan.rowH,
    rowSlices: rowPlan.slices, dateSlices: dateSlices, cells: cells,
  };
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 7 — 태스크 목록 표
// ─────────────────────────────────────────────────────────────

/** 상태 코드 → 'Ongoing (진행)' 형태 라벨 (pptx.js statusLabelKo 와 동일 문자열) */
var SHAPE_STATUS_LABELS = {
  plan: 'Plan (계획)',
  setup: 'Set up (준비)',
  ongoing: 'Ongoing (진행)',
  complete: 'Complete (완료)',
  delayed: 'Delayed (지연)',
};

/** 태스크 목록 표 헤더 (컬럼 순서 고정) */
var TASK_TABLE_HEADER = ['태스크명', '담당자', '시작일', '종료일', '진행률', '상태', '우선순위'];

/**
 * 태스크 목록 표의 행 데이터를 만든다. 계층은 태스크명 앞의 전각 공백 들여쓰기로 표현하고,
 * 마일스톤은 '◆' 를 앞에 붙인다. 프로젝트 그룹 행은 태스크명 칸에만 '[업무] 이름' 을 넣는다.
 * @param {Array} rows buildShapeRows 결과
 * @returns {{header:string[], rows:Array<{cells:string[], isGroup:boolean, status:string}>}}
 */
function buildTaskTableRows(rows) {
  var out = [];
  (rows || []).forEach(function (row) {
    if (row.type === 'group') {
      var p = row.project || {};
      var cat = SHAPE_CATEGORY_LABELS[p.category] || p.category || '';
      out.push({
        cells: ['[' + cat + '] ' + String(p.name == null ? '' : p.name), '', '', '', '', '', ''],
        isGroup: true, status: '',
      });
      return;
    }
    var t = row.task || {};
    var indent = '';
    for (var i = 0; i < (row.level || 0); i++) indent += '　';   // 전각 공백 = 계층 1단계
    var pct = (t.status === 'complete') ? 100
      : (typeof t.progress === 'number' ? t.progress : 0);
    if (pct < 0) pct = 0; if (pct > 100) pct = 100;
    out.push({
      cells: [
        indent + (t.milestone ? '◆ ' : '') + String(t.name == null ? '' : t.name),
        String(t.assignee == null ? '' : t.assignee),
        String(t.startDate == null ? '' : t.startDate),
        String(t.endDate == null ? '' : t.endDate),
        pct + '%',
        SHAPE_STATUS_LABELS[t.status] || String(t.status == null ? '' : t.status),
        SHAPE_PRIORITY_LABELS[t.priority] || String(t.priority == null ? '' : t.priority),
      ],
      isGroup: false,
      status: String(t.status == null ? '' : t.status),
    });
  });
  return { header: TASK_TABLE_HEADER.slice(), rows: out };
}

/**
 * 표 행을 슬라이드별로 나눈다 (헤더는 매 슬라이드 반복하므로 데이터 행만 계산).
 * @param {number} rowCount    데이터 행 수
 * @param {number} rowsPerPage 한 슬라이드에 담을 데이터 행 수
 * @returns {Array<{start:number, end:number}>} 행이 0개면 [{start:0,end:0}]
 */
function paginateTableRows(rowCount, rowsPerPage) {
  var n = rowCount > 0 ? Math.floor(rowCount) : 0;
  var per = rowsPerPage > 0 ? Math.floor(rowsPerPage) : 1;
  if (n === 0) return [{ start: 0, end: 0 }];
  var pages = [];
  for (var s = 0; s < n; s += per) {
    pages.push({ start: s, end: Math.min(n, s + per) });
  }
  return pages;
}

// Node(테스트) 환경에서 순수 함수 검증할 수 있도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SHAPE_STATUS_COLORS: SHAPE_STATUS_COLORS,
    SHAPE_STATUS_ORDER: SHAPE_STATUS_ORDER,
    SHAPE_STATUS_LABELS: SHAPE_STATUS_LABELS,
    SHAPE_GEOM_DEFAULTS: SHAPE_GEOM_DEFAULTS,
    MIN_TICK_W_IN: MIN_TICK_W_IN,
    TICK_DAYS: TICK_DAYS,
    TASK_TABLE_HEADER: TASK_TABLE_HEADER,
    shpYmdToDate: shpYmdToDate,
    shpDateToYmd: shpDateToYmd,
    shpAddDays: shpAddDays,
    shpDiffDays: shpDiffDays,
    shpIsOverdue: shpIsOverdue,
    SHAPE_PRIORITY_COLORS: SHAPE_PRIORITY_COLORS,
    SHAPE_PRIORITY_LABELS: SHAPE_PRIORITY_LABELS,
    SHAPE_CATEGORY_LABELS: SHAPE_CATEGORY_LABELS,
    buildShapeRows: buildShapeRows,
    shapeGeometry: shapeGeometry,
    computeRowSlices: computeRowSlices,
    tickCountFor: tickCountFor,
    tickWidthIn: tickWidthIn,
    pickTickUnit: pickTickUnit,
    splitDaySlices: splitDaySlices,
    computeDateSlices: computeDateSlices,
    dayToX: dayToX,
    barBox: barBox,
    buildAxisCells: buildAxisCells,
    planShapeSlides: planShapeSlides,
    buildTaskTableRows: buildTaskTableRows,
    paginateTableRows: paginateTableRows,
  };
}

// ─────────────────────────────────────────────────────────────
// 브라우저 — 실제 슬라이드 그리기 (window.PptxShapes)
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    var FONT = 'Noto Sans KR';

    // 색 토큰 (도형 방식 전용 — 라이트 톤 고정)
    var C = {
      text: '1F2937',       // 본문 글자
      textSub: '6B7280',    // 보조 글자
      border: 'D1D5DB',     // 테두리
      grid: 'E5E7EB',       // 격자선 (옅게)
      headFill: 'F9FAFB',   // 축 헤더 배경
      groupFill: 'F3F4F6',  // 프로젝트 그룹 행 배경
      weekend: 'F3F4F6',    // 주말 음영
      today: 'EF4444',      // 오늘선
      dep: '94A3B8',        // 의존선
      white: 'FFFFFF',
    };

    // 글자 크기 (pt)
    var FS = {
      title: 14, titleSub: 9,
      axisTop: 9, axisBottom: 7,
      row: 8, bar: 7, legend: 8,
      tableHead: 10, tableBody: 9,
    };

    function statusColorOf(status) {
      return SHAPE_STATUS_COLORS[status] || SHAPE_STATUS_COLORS.plan;
    }

    // 텍스트 공통 옵션 — 여백 0 으로 좁은 칸에서도 글자가 밀리지 않게 한다
    function textOpts(extra) {
      var o = {
        fontFace: FONT, margin: 0, valign: 'middle', align: 'left',
        color: C.text, fontSize: FS.row, isTextBox: true, wrap: false,
      };
      Object.keys(extra || {}).forEach(function (k) { o[k] = extra[k]; });
      return o;
    }

    /**
     * 라벨이 주어진 칸 폭(인치)에 들어가는지 어림한다.
     * 한글·한자 같은 전각 글자는 글자크기(em) 만큼, 숫자/영문/기호는 0.55em 으로 잡는다.
     * (PptxGenJS 는 텍스트를 칸 밖으로 넘쳐 그리므로 넘칠 라벨은 아예 생략해야 한다)
     * @param {string} label
     * @param {number} fontSizePt 글자 크기(pt)
     * @param {number} boxW 칸 폭(인치)
     */
    function fitsLabel(label, fontSizePt, boxW) {
      var em = fontSizePt / 72;                 // 1em 을 인치로
      var wid = 0;
      for (var i = 0; i < label.length; i++) {
        var code = label.charCodeAt(i);
        wid += (code > 0x2000) ? em * 0.9 : em * 0.5;   // 전각(한글 등) vs 반각(숫자/기호)
      }
      return boxW >= wid + 0.02;                // 좌우 여유 0.02in
    }

    /** 직선(가로/세로) 하나 그리기 */
    function addLine(slide, pptx, x, y, w, h, color, width, dashType, endArrow) {
      var line = { color: color, width: width };
      if (dashType) line.dashType = dashType;
      if (endArrow) line.endArrowType = endArrow;
      slide.addShape(pptx.ShapeType.line, { x: x, y: y, w: w, h: h, line: line });
    }

    /** 채움 사각형 하나 그리기 (테두리 없음이 기본) */
    function addRect(slide, pptx, x, y, w, h, fillColor, lineColor, lineWidth) {
      var opt = { x: x, y: y, w: w, h: h, fill: { color: fillColor } };
      if (lineColor) opt.line = { color: lineColor, width: lineWidth || 0.5 };
      else opt.line = { type: 'none' };
      slide.addShape(pptx.ShapeType.rect, opt);
    }

    // ── 하단 상태 범례 (5색) ──
    // legendY 를 넘기면 그 위치에 그린다 (행이 적어 본문이 짧을 때 차트 바로 아래로 끌어올림).
    function addLegend(slide, pptx, g, legendY) {
      var sw = 0.13;                 // 색 견본 한 변
      var itemW = 1.6;               // 항목 하나가 차지할 폭
      var x = g.chartX;
      var y = (legendY != null) ? legendY : g.legendY;
      slide.addText('상태', textOpts({
        x: x, y: y, w: 0.45, h: g.legendH, fontSize: FS.legend,
        bold: true, color: C.textSub,
      }));
      x += 0.5;
      SHAPE_STATUS_ORDER.forEach(function (st) {
        addRect(slide, pptx, x, y + (g.legendH - sw) / 2, sw, sw,
          statusColorOf(st).bar, statusColorOf(st).dark, 0.5);
        slide.addText(SHAPE_STATUS_LABELS[st], textOpts({
          x: x + sw + 0.06, y: y, w: itemW - sw - 0.1, h: g.legendH,
          fontSize: FS.legend, color: C.textSub,
        }));
        x += itemW;
      });
    }

    // ── 날짜 축 헤더 2줄 ──
    function addAxis(slide, pptx, g, cell, rangeStartYmd) {
      var ds = cell.dateSlice;
      var axis = buildAxisCells(rangeStartYmd, ds.startDay, ds.endDay, cell.unit);

      // 좌측 열 헤더 ("태스크") — 축 2줄 높이를 통째로 차지
      slide.addText('태스크', textOpts({
        x: g.chartX, y: g.axisY, w: g.leftColW, h: g.axisH,
        fill: { color: C.headFill }, line: { color: C.border, width: 0.75 },
        align: 'center', bold: true, fontSize: FS.axisTop, color: C.text,
      }));

      // 상단 줄: 연/월 그룹.
      // 범위 끝에서 잘린 부분 칸(예: 마지막 며칠뿐인 달/주)은 칸보다 라벨이 길어
      // 옆 칸이나 슬라이드 밖으로 글자가 삐져나온다. 칸이 라벨을 담을 만큼
      // 넓을 때만 글자를 넣고, 아니면 칸(테두리·배경)만 그린다.
      axis.top.forEach(function (c) {
        var x = dayToX(c.startDay, ds.startDay, g.timelineX, cell.dayW);
        var w = c.days * cell.dayW;
        slide.addText(fitsLabel(c.label, FS.axisTop, w) ? c.label : '', textOpts({
          x: x, y: g.axisY, w: w, h: g.axisRowH,
          fill: { color: C.headFill }, line: { color: C.border, width: 0.75 },
          align: 'center', bold: true, fontSize: FS.axisTop, color: C.text,
        }));
      });

      // 하단 줄: 눈금 라벨 (+ 주말 음영). 마찬가지로 너무 좁은 칸은 라벨 생략.
      axis.bottom.forEach(function (c) {
        var x = dayToX(c.startDay, ds.startDay, g.timelineX, cell.dayW);
        var w = c.days * cell.dayW;
        var label = c.sub ? (c.label + ' ' + c.sub) : c.label;
        slide.addText(fitsLabel(label, FS.axisBottom, w) ? label : '', textOpts({
          x: x, y: g.axisY + g.axisRowH, w: w, h: g.axisRowH,
          fill: { color: c.weekend ? C.weekend : C.headFill },
          line: { color: C.border, width: 0.75 },
          align: 'center', fontSize: FS.axisBottom, color: C.textSub,
        }));
      });

      return axis;
    }

    // ── 본문: 격자·주말 음영·행 배경 ──
    function addBodyBackground(slide, pptx, g, cell, axis, rows, rowH) {
      var ds = cell.dateSlice;
      var rowsOnSlide = rows.length;
      var usedH = rowsOnSlide * rowH;

      // 본문 전체 테두리
      addRect(slide, pptx, g.chartX, g.bodyY, g.leftColW + g.timelineW, usedH,
        C.white, C.border, 0.75);

      // 주말 음영 (일 단위일 때만 — 주/월 단위에서는 의미가 없다)
      if (cell.unit === 'day') {
        axis.bottom.forEach(function (c) {
          if (!c.weekend) return;
          addRect(slide, pptx, dayToX(c.startDay, ds.startDay, g.timelineX, cell.dayW),
            g.bodyY, c.days * cell.dayW, usedH, C.weekend);
        });
      }

      // 세로 격자선 — 눈금 경계마다. 너무 촘촘하면(120칸 초과) 생략한다.
      if (axis.bottom.length <= MAX_GRID_LINES) {
        axis.bottom.forEach(function (c, i) {
          if (i === 0) return;   // 왼쪽 첫 경계는 본문 테두리와 겹친다
          var x = dayToX(c.startDay, ds.startDay, g.timelineX, cell.dayW);
          addLine(slide, pptx, x, g.bodyY, 0, usedH, C.grid, 0.5);
        });
      }

      // 좌측 열과 타임라인 경계선 (진하게)
      addLine(slide, pptx, g.timelineX, g.bodyY, 0, usedH, C.border, 1);

      // 가로 행 구분선 + 그룹 행 배경
      rows.forEach(function (row, i) {
        var y = g.bodyY + i * rowH;
        if (row.type === 'group') {
          addRect(slide, pptx, g.chartX, y, g.leftColW + g.timelineW, rowH, C.groupFill);
        }
        if (i > 0) {
          addLine(slide, pptx, g.chartX, y, g.leftColW + g.timelineW, 0, C.grid, 0.5);
        }
      });

      return usedH;
    }

    // ── 좌측 태스크명 열 ──
    // display.priority 가 켜져 있으면 이름 뒤에 우선순위(높음/낮음) 를,
    // display.delay 가 켜져 있으면 지연 경고(⚠) 를 붙인다 (화면 좌측 목록과 동일 규칙).
    function addLeftColumn(slide, pptx, g, rows, rowH, display, today) {
      var showPriority = !display || display.priority !== false;
      var showDelay = !display || display.delay !== false;
      rows.forEach(function (row, i) {
        var y = g.bodyY + i * rowH;
        if (row.type === 'group') {
          var p = row.project || {};
          var cat = SHAPE_CATEGORY_LABELS[p.category] || p.category || '';
          slide.addText('[' + cat + ']  ' + String(p.name == null ? '' : p.name), textOpts({
            x: g.chartX + 0.06, y: y, w: g.leftColW - 0.12, h: rowH,
            bold: true, fontSize: FS.row, color: C.text,
          }));
          return;
        }
        var t = row.task || {};
        var indent = 0.06 + (row.level || 0) * 0.14;   // 계층 들여쓰기
        var dotW = 0.09;
        // 상태 색 점
        addRect(slide, pptx, g.chartX + indent, y + (rowH - dotW) / 2, dotW, dotW,
          statusColorOf(t.status).bar);
        var label = (t.milestone ? '◆ ' : '') + String(t.name == null ? '' : t.name);
        if (showDelay && shpIsOverdue(t, today)) label += ' ⚠';
        if (showPriority && SHAPE_PRIORITY_COLORS[t.priority]) {
          label += '  [' + SHAPE_PRIORITY_LABELS[t.priority] + ']';
        }
        slide.addText(label, textOpts({
          x: g.chartX + indent + dotW + 0.05, y: y,
          w: g.leftColW - indent - dotW - 0.12, h: rowH,
          fontSize: FS.row, color: C.text,
        }));
      });
    }

    // ── 태스크 바 / 마일스톤 (+ 의존선 앵커 좌표 수집) ──
    function addBars(slide, pptx, g, cell, rows, rowH, rangeStart, display, today) {
      var showProgress = !display || display.progress !== false;
      var showPriority = !display || display.priority !== false;
      var showDelay = !display || display.delay !== false;
      var ds = cell.dateSlice;
      var geomById = {};                       // taskId → {leftX, rightX, cy}
      var barH = Math.min(0.17, rowH * 0.62);

      rows.forEach(function (row, i) {
        if (row.type !== 'task') return;
        var t = row.task;
        var y = g.bodyY + i * rowH;
        var cy = y + rowH / 2;
        var colors = statusColorOf(t.status);
        // 지연 경고 대상이면 테두리를 빨간 점선으로 (화면 .bar--overdue 와 동일 의미)
        var overdue = showDelay && shpIsOverdue(t, today);
        var edgeLine = overdue
          ? { color: C.today, width: 1.25, dashType: 'dash' }
          : { color: colors.dark, width: 0.75 };
        var startDay = shpDiffDays(rangeStart, shpYmdToDate(t.startDate));
        var endDay = shpDiffDays(rangeStart, shpYmdToDate(t.endDate));

        if (t.milestone) {
          // 마일스톤: 시작일 칸 가운데에 다이아몬드
          var mSize = Math.min(0.19, rowH * 0.72);
          var mcx = dayToX(startDay, ds.startDay, g.timelineX, cell.dayW) + cell.dayW / 2;
          if (mcx < g.timelineX - mSize || mcx > g.chartRight + mSize) return;   // 이 슬라이스 밖
          slide.addShape(pptx.ShapeType.diamond, {
            x: mcx - mSize / 2, y: cy - mSize / 2, w: mSize, h: mSize,
            fill: { color: colors.bar },
            line: overdue ? edgeLine : { color: colors.dark, width: 1 },
          });
          slide.addText(String(t.name == null ? '' : t.name), textOpts({
            x: mcx + mSize / 2 + 0.04, y: y,
            w: Math.max(0.3, g.chartRight - (mcx + mSize / 2 + 0.04)), h: rowH,
            fontSize: FS.bar, color: C.text,
          }));
          geomById[t.id] = { leftX: mcx - mSize / 2, rightX: mcx + mSize / 2, cy: cy };
          return;
        }

        var box = barBox(startDay, endDay, ds, g.timelineX, cell.dayW, 0.05);
        if (!box) return;                     // 이 기간 슬라이스에 안 걸침

        // 바 본체 (모서리 살짝 둥근 사각형)
        slide.addShape(pptx.ShapeType.roundRect, {
          x: box.x, y: cy - barH / 2, w: box.w, h: barH, rectRadius: 0.06,
          fill: { color: colors.bar }, line: edgeLine,
        });

        // 진행률 채움 (같은 색 계열 어두운 톤). complete 는 100% 취급.
        var pct = (t.status === 'complete') ? 100 : (t.progress || 0);
        if (pct < 0) pct = 0; if (pct > 100) pct = 100;
        if (showProgress && pct > 0) {
          slide.addShape(pptx.ShapeType.roundRect, {
            x: box.x, y: cy - barH / 2, w: Math.max(0.02, box.w * pct / 100), h: barH,
            rectRadius: 0.06, fill: { color: colors.dark }, line: { type: 'none' },
          });
        }

        // 우선순위 세로 띠 (높음=진한 주황 두껍게 / 낮음=연회색 얇게 / 보통=없음)
        if (showPriority && SHAPE_PRIORITY_COLORS[t.priority] && !box.clipLeft) {
          var pw = (t.priority === 'high') ? 0.05 : 0.03;
          addRect(slide, pptx, box.x, cy - barH / 2, Math.min(pw, box.w), barH,
            SHAPE_PRIORITY_COLORS[t.priority]);
        }

        // 라벨: 바가 넉넉하면 안에(흰 글씨), 좁으면 바 오른쪽 바깥에
        var name = String(t.name == null ? '' : t.name);
        if (box.w >= 1.0) {
          slide.addText(name, textOpts({
            x: box.x + 0.05, y: cy - barH / 2, w: box.w * 0.72, h: barH,
            fontSize: FS.bar, color: C.white, bold: true,
          }));
          if (showProgress) {
            slide.addText(pct + '%', textOpts({
              x: box.x + box.w * 0.72, y: cy - barH / 2, w: box.w * 0.28 - 0.05, h: barH,
              fontSize: FS.bar, color: C.white, align: 'right',
            }));
          }
        } else {
          var outX = box.x + box.w + 0.04;
          var outW = g.chartRight - outX;
          if (outW > 0.2) {
            slide.addText(showProgress ? (name + '  ' + pct + '%') : name, textOpts({
              x: outX, y: cy - barH / 2, w: outW, h: barH,
              fontSize: FS.bar, color: C.text,
            }));
          }
        }

        geomById[t.id] = { leftX: box.x, rightX: box.x + box.w, cy: cy };
      });

      return geomById;
    }

    // ── 의존성(FS) 화살표 ──
    // 선행 바의 오른쪽 끝 → 후행 바의 왼쪽 시작. 앞으로 가는 연결은 직각 3분절,
    // 뒤로 되돌아가는 연결은 행 사이를 우회하는 5분절로 그린다(방향은 항상 화살촉으로 표시).
    function addDependencies(slide, pptx, g, rows, geomById, rowH) {
      var visible = {};
      rows.forEach(function (row) { if (row.type === 'task') visible[row.task.id] = true; });

      rows.forEach(function (row) {
        if (row.type !== 'task') return;
        var succ = row.task;
        var deps = Array.isArray(succ.dependencies) ? succ.dependencies : [];
        var sg = geomById[succ.id];
        if (!sg) return;
        deps.forEach(function (predId) {
          var pg = geomById[predId];
          if (!pg || !visible[predId]) return;   // 이 슬라이드에 선행이 없으면 생략
          var px = pg.rightX, py = pg.cy;
          var sx = sg.leftX, sy = sg.cy;

          if (sx >= px + 0.12) {
            // 앞으로 가는 연결: 가로 → 세로 → 가로(화살촉)
            var mx = (px + sx) / 2;
            addLine(slide, pptx, px, py, mx - px, 0, C.dep, 1);
            addLine(slide, pptx, mx, Math.min(py, sy), 0, Math.abs(sy - py), C.dep, 1);
            addLine(slide, pptx, mx, sy, sx - mx, 0, C.dep, 1, null, 'triangle');
          } else {
            // 되돌아가는 연결: 행 사이(midY)로 우회
            var ax = px + 0.08;
            var bx = sx - 0.08;
            var midY = sy + rowH * 0.42;
            addLine(slide, pptx, px, py, 0.08, 0, C.dep, 1);
            addLine(slide, pptx, ax, Math.min(py, midY), 0, Math.abs(midY - py), C.dep, 1);
            addLine(slide, pptx, Math.min(ax, bx), midY, Math.abs(ax - bx), 0, C.dep, 1);
            addLine(slide, pptx, bx, Math.min(midY, sy), 0, Math.abs(sy - midY), C.dep, 1);
            addLine(slide, pptx, bx, sy, 0.08, 0, C.dep, 1, null, 'triangle');
          }
        });
      });
    }

    // ── 오늘 기준선 ──
    function addTodayLine(slide, pptx, g, cell, rangeStart, today, bodyUsedH) {
      var ds = cell.dateSlice;
      var todayIdx = shpDiffDays(rangeStart, today);
      if (todayIdx < ds.startDay || todayIdx >= ds.endDay) return;   // 이 슬라이스 밖
      var x = dayToX(todayIdx, ds.startDay, g.timelineX, cell.dayW) + cell.dayW / 2;
      addLine(slide, pptx, x, g.axisY, 0, (g.bodyY + bodyUsedH) - g.axisY, C.today, 1.25, 'dash');
      slide.addText('오늘', textOpts({
        x: x - 0.25, y: g.bodyY + bodyUsedH + 0.02, w: 0.5, h: 0.18,
        fontSize: FS.bar, color: C.today, align: 'center', bold: true,
      }));
    }

    /**
     * 한 프로젝트(또는 전체)의 간트 차트를 네이티브 도형으로 슬라이드에 그린다.
     * @param {object} pptx PptxGenJS 인스턴스
     * @param {{titleBase:string, projects:Array, tasks:Array, scale:string,
     *          today:Date, range:{start:Date,end:Date}, allowDateSplit:boolean,
     *          display?:{progress?:boolean, priority?:boolean, delay?:boolean,
     *                    deps?:boolean, legend?:boolean}}} opt
     *        display 는 화면의 "표시 ▾" 토글(GanttApp.getState().display). 생략 시 전부 표시.
     * @returns {number} 만든 슬라이드 수
     */
    function renderChartSlides(pptx, opt) {
      var disp = opt.display || {};
      var rows = buildShapeRows(opt.projects, opt.tasks);
      var range = opt.range;
      var rangeStart = range.start;
      var rangeStartYmd = shpDateToYmd(rangeStart);
      var totalDays = shpDiffDays(range.start, range.end) + 1;

      var plan = planShapeSlides(rows.length, totalDays, opt.scale, !!opt.allowDateSplit);
      var g = plan.geom;

      plan.cells.forEach(function (cell) {
        var slide = pptx.addSlide();
        slide.background = { color: C.white };

        // 제목 — 슬라이드가 여럿이면 (n/N) 표기
        var title = opt.titleBase + (cell.total > 1 ? ' (' + cell.index + '/' + cell.total + ')' : '');
        slide.addText(title, textOpts({
          x: g.chartX, y: g.titleY, w: g.slideW - 2 * g.chartX - 3.6, h: g.titleH,
          fontSize: FS.title, bold: true, color: C.text,
        }));
        // 우측 상단: 이 슬라이드가 담은 기간 + 눈금 단위
        var ds = cell.dateSlice;
        var sYmd = shpDateToYmd(shpAddDays(rangeStart, ds.startDay));
        var eYmd = shpDateToYmd(shpAddDays(rangeStart, ds.endDay - 1));
        var unitKo = { day: '일', week: '주', month: '월' }[cell.unit] || cell.unit;
        slide.addText(sYmd + ' ~ ' + eYmd + '  ·  ' + unitKo + ' 단위', textOpts({
          x: g.chartRight - 3.5, y: g.titleY, w: 3.5, h: g.titleH,
          fontSize: FS.titleSub, color: C.textSub, align: 'right',
        }));

        var sliceRows = rows.slice(cell.rowSlice.start, cell.rowSlice.end);
        var axis = addAxis(slide, pptx, g, cell, rangeStartYmd);
        var usedH = addBodyBackground(slide, pptx, g, cell, axis, sliceRows, plan.rowH);
        addLeftColumn(slide, pptx, g, sliceRows, plan.rowH, disp, opt.today);
        var geomById = addBars(slide, pptx, g, cell, sliceRows, plan.rowH, rangeStart,
          disp, opt.today);
        // 화면의 "표시 ▾" 토글을 그대로 따른다 (의존선·범례)
        if (disp.deps !== false) addDependencies(slide, pptx, g, sliceRows, geomById, plan.rowH);
        addTodayLine(slide, pptx, g, cell, rangeStart, opt.today, usedH);
        // 범례는 슬라이드 하단이 기본이지만, 행이 적어 본문이 짧으면 차트 바로 아래로
        // 끌어올려 빈 공간이 크게 벌어지지 않게 한다 ("오늘" 라벨 자리 0.26in 확보).
        if (disp.legend !== false) {
          addLegend(slide, pptx, g, Math.min(g.legendY, g.bodyY + usedH + 0.26));
        }
      });

      return plan.cells.length;
    }

    // ─────────────────────────────────────────────────────
    // 태스크 목록 표 슬라이드
    // ─────────────────────────────────────────────────────

    // 표 컬럼 폭(인치) 합 = 12.733 (슬라이드 13.333 - 좌우 여백 0.3*2)
    var TABLE_COL_W = [4.13, 1.4, 1.3, 1.3, 0.95, 2.15, 1.0];
    var TABLE_ROWS_PER_SLIDE = 18;   // 헤더 제외, 한 슬라이드에 담을 데이터 행 수

    /**
     * 태스크 목록 표 슬라이드를 추가한다. 행이 많으면 여러 슬라이드로 나누고
     * 매 슬라이드에 헤더를 반복한다.
     * @param {object} pptx PptxGenJS 인스턴스
     * @param {{titleBase:string, projects:Array, tasks:Array}} opt
     * @returns {number} 만든 슬라이드 수
     */
    function addTaskTableSlides(pptx, opt) {
      var rows = buildShapeRows(opt.projects, opt.tasks);
      var table = buildTaskTableRows(rows);
      var pages = paginateTableRows(table.rows.length, TABLE_ROWS_PER_SLIDE);

      pages.forEach(function (pg, pi) {
        var slide = pptx.addSlide();
        slide.background = { color: C.white };
        var title = opt.titleBase + ' — 태스크 목록' +
          (pages.length > 1 ? ' (' + (pi + 1) + '/' + pages.length + ')' : '');
        slide.addText(title, {
          x: 0.3, y: 0.12, w: 12.733, h: 0.4,
          fontFace: FONT, fontSize: 16, bold: true, color: C.text,
        });

        // 헤더 행 (굵게 + 진한 배경) — 페이지마다 반복
        var aoa = [table.header.map(function (h) {
          return {
            text: h,
            options: {
              bold: true, color: C.white, fill: { color: '374151' },
              align: 'center', valign: 'middle',
            },
          };
        })];

        table.rows.slice(pg.start, pg.end).forEach(function (r) {
          aoa.push(r.cells.map(function (cellText, ci) {
            var o = {
              color: C.text, valign: 'middle',
              align: ci === 0 ? 'left' : 'center',
            };
            if (r.isGroup) { o.bold = true; o.fill = { color: C.groupFill }; }
            // 상태 칸은 상태 색을 옅게 배경으로 깔지 않고 글자색으로만 구분한다(가독성)
            if (!r.isGroup && ci === 5 && SHAPE_STATUS_COLORS[r.status]) {
              o.color = SHAPE_STATUS_COLORS[r.status].dark;
              o.bold = true;
            }
            return { text: cellText, options: o };
          }));
        });

        slide.addTable(aoa, {
          x: 0.3, y: 0.62, w: 12.733, colW: TABLE_COL_W,
          border: { type: 'solid', color: C.border, pt: 0.5 },
          fontFace: FONT, fontSize: 10, rowH: 0.32, valign: 'middle',
          autoPage: false,
        });
      });

      return pages.length;
    }

    // 공개 API (pptx.js 가 사용)
    window.PptxShapes = {
      renderChartSlides: renderChartSlides,
      addTaskTableSlides: addTaskTableSlides,
      // 순수 함수도 브라우저 콘솔 검증용으로 노출
      buildShapeRows: buildShapeRows,
      shapeGeometry: shapeGeometry,
      planShapeSlides: planShapeSlides,
      pickTickUnit: pickTickUnit,
      buildTaskTableRows: buildTaskTableRows,
      paginateTableRows: paginateTableRows,
      TABLE_ROWS_PER_SLIDE: TABLE_ROWS_PER_SLIDE,
    };
  })();
}
