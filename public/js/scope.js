// 내보내기 범위 선택 (10단계 확장) — 엑셀/PNG 공용 범위 모달 + 공유 순수 함수
// - 순수 함수(파일명 정리·프로젝트 필터·날짜 범위 계산)는 파일 상단에 두고
//   Node 테스트에서 require 할 수 있게 파일 끝에서 module.exports 한다 (export.js 패턴).
// - computeRangeForTasks 는 gantt.js 에 있던 computeRange 로직을 옮겨온 "단일 정의"다.
//   gantt.js 는 이 전역 함수를 호출한다 (중복 정의 금지). today 를 인자로 주입받아
//   Node 테스트에서 결정적으로 검증할 수 있다 (생략 시 오늘).
// - 브라우저 UI(#scope-backdrop 모달, window.ExportScope.choose)는 하단
//   typeof document 블록에 둔다. export.js/png.js 가 내보내기 전에 이 모달로
//   "전체 / 선택한 프로젝트" 범위를 사용자에게 묻는다 (11단계 PPTX 에서도 재사용).

// ─────────────────────────────────────────────────────────────
// 날짜 헬퍼 (gantt.js IIFE 내부와 동일 규칙 — Node 테스트를 위해 자체 보유)
// ─────────────────────────────────────────────────────────────

// 'YYYY-MM-DD' -> 로컬 자정 Date (타임존 영향 제거)
function ymdToDate(str) {
  var p = String(str).split('-');
  return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
}

// Date 의 시/분/초 제거 (자정으로 정규화)
function dateStripTime(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// n일 뒤 Date
function dateAddDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// 해당 주의 월요일로 스냅 (월=0 ... 일=6 오프셋)
function snapToMondayOf(d) {
  var offset = (d.getDay() + 6) % 7;
  return dateAddDays(d, -offset);
}

// 해당 주의 일요일로 스냅
function snapToSundayOf(d) {
  var offset = (7 - d.getDay()) % 7;
  return dateAddDays(d, offset);
}

// ─────────────────────────────────────────────────────────────
// 순수 함수 (Node 테스트 대상)
// ─────────────────────────────────────────────────────────────

// 파일명 금지 문자: \ / : * ? " < > | (제어문자는 아래에서 코드값으로 별도 처리)
var FORBIDDEN_FILE_CHARS = /[\\/:*?"<>|]/g;

/**
 * 파일명에 쓸 수 없는 문자(\ / : * ? " < > |)와 제어문자(코드 0~31)를 '_' 로 치환한다.
 * (엑셀·PNG 내보내기의 "프로젝트별 파일명"에 공용. 일반 문자·한글·공백은 유지)
 */
function sanitizeFileNamePart(name) {
  var s = String(name == null ? '' : name).replace(FORBIDDEN_FILE_CHARS, '_');
  // 제어문자는 소스에 리터럴/이스케이프를 두지 않고 문자 코드로 판정해 치환한다
  var out = '';
  for (var i = 0; i < s.length; i++) {
    out += s.charCodeAt(i) < 32 ? '_' : s.charAt(i);
  }
  return out;
}

/**
 * 특정 프로젝트와 그 소속 태스크만 추려 반환한다.
 * (태스크의 parentId/dependencies 는 같은 프로젝트 안에서만 맺어지므로 그대로 유지)
 * @returns {{projects: object[], tasks: object[]}}
 */
function filterByProject(projects, tasks, projectId) {
  return {
    projects: projects.filter(function (p) { return p.id === projectId; }),
    tasks: tasks.filter(function (t) { return t.projectId === projectId; }),
  };
}

/**
 * 표시 범위 계산 — gantt.js 의 기존 computeRange 와 동일 규칙 (단일 정의, 이동해 옴).
 * 데이터 min~max 에 보기별 여유를 더하고, today 를 항상 범위에 포함한다.
 * - day:   앞뒤 ±7일
 * - week:  앞뒤 ±2주 후 주 시작(월)/끝(일)으로 스냅
 * - month: 앞뒤 ±1개월 후 월초/월말로 스냅
 * @param {object[]} tasks  {startDate, endDate} 를 가진 태스크 목록 (빈 배열 허용)
 * @param {string} scale    'day' | 'week' | 'month'
 * @param {Date} [today]    기준일 (생략 시 오늘 — 테스트에서는 주입해 결정성 확보)
 * @returns {{start: Date, end: Date}}
 */
function computeRangeForTasks(tasks, scale, today) {
  var t = dateStripTime(today || new Date());
  var minDate, maxDate;

  if (!tasks || tasks.length === 0) {
    // 데이터 없으면 기준일 앞뒤 1개월
    minDate = dateAddDays(t, -30);
    maxDate = dateAddDays(t, 30);
  } else {
    tasks.forEach(function (tk) {
      var s = ymdToDate(tk.startDate);
      var e = ymdToDate(tk.endDate);
      if (!minDate || s < minDate) minDate = s;
      if (!maxDate || e > maxDate) maxDate = e;
    });
    // 기준일(오늘)을 항상 범위에 포함 (데이터가 전부 과거/미래여도 오늘선·이동 동작)
    if (t < minDate) minDate = t;
    if (t > maxDate) maxDate = t;
  }

  var start, end;
  if (scale === 'day') {
    start = dateAddDays(minDate, -7);
    end = dateAddDays(maxDate, 7);
  } else if (scale === 'week') {
    start = snapToMondayOf(dateAddDays(minDate, -14));
    end = snapToSundayOf(dateAddDays(maxDate, 14));
  } else {
    // month
    start = new Date(minDate.getFullYear(), minDate.getMonth() - 1, 1);
    end = new Date(maxDate.getFullYear(), maxDate.getMonth() + 2, 0);
  }
  return { start: start, end: end };
}

// Node(테스트) 환경에서 순수 함수 검증할 수 있도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    sanitizeFileNamePart: sanitizeFileNamePart,
    filterByProject: filterByProject,
    computeRangeForTasks: computeRangeForTasks,
    ymdToDate: ymdToDate,
    dateStripTime: dateStripTime,
    dateAddDays: dateAddDays,
    snapToMondayOf: snapToMondayOf,
    snapToSundayOf: snapToSundayOf,
  };
}

// ─────────────────────────────────────────────────────────────
// 브라우저 UI — 범위 선택 모달 (window.ExportScope.choose)
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    // 프로젝트 구분 라벨 (gantt.js 좌측 배지와 동일 규칙)
    var CATEGORY_LABEL = { work: '업무', personal: '개인' };

    // 선택된 레이아웃 라디오 값을 읽는다 (없으면 기본 'fit')
    function readLayout() {
      var els = document.getElementsByName('scope-layout');
      for (var i = 0; i < els.length; i++) {
        if (els[i].checked) return els[i].value;
      }
      return 'fit';
    }

    // 선택된 차트 표현 방식 라디오 값을 읽는다 (없으면 기본 'image' — 기존 동작 유지)
    function readChartMode() {
      var els = document.getElementsByName('scope-chart-mode');
      for (var i = 0; i < els.length; i++) {
        if (els[i].checked) return els[i].value;
      }
      return 'image';
    }

    /**
     * 범위 선택 모달을 띄우고 사용자의 선택을 Promise 로 돌려준다.
     * @param {{title?: string, layouts?: boolean, showLayout?: boolean}} [opts]
     *   title: 모달 제목 (예: '엑셀 내보내기 범위')
     *   layouts(=showLayout): true 이면 PPTX 전용 섹션 3개를 함께 보이고 결과에
     *   layout / chartMode / includeTable 을 포함한다.
     *     · #scope-mode-chart  차트 표현 (이미지 / 도형)
     *     · #scope-layout      슬라이드 레이아웃 (fit / split)
     *     · #scope-table       태스크 목록 표 포함 체크박스
     *   미지정(엑셀/PNG)이면 세 섹션 모두 hidden, 결과에도 해당 필드가 없다.
     * @returns {Promise<{mode:'all'|'project', projectId:string|null, projectName:string,
     *                    layout?:string, chartMode?:'image'|'shapes', includeTable?:boolean}|null>}
     *          취소(취소 버튼·배경 클릭·Esc) 시 null
     */
    function choose(opts) {
      opts = opts || {};
      var withLayout = !!(opts.layouts || opts.showLayout);
      return new Promise(function (resolve) {
        var backdrop = $('scope-backdrop');
        if (!backdrop) {
          // 모달 마크업이 없으면(비정상) 전체 범위로 진행해 기능 자체는 살린다
          var fallback = { mode: 'all', projectId: null, projectName: '' };
          if (withLayout) {
            fallback.layout = 'fit';
            fallback.chartMode = 'image';
            fallback.includeTable = false;
          }
          resolve(fallback);
          return;
        }
        var titleEl = $('scope-title');
        var radioAll = $('scope-mode-all');
        var radioProject = $('scope-mode-project');
        var select = $('scope-project');
        var confirmBtn = $('scope-confirm');
        var cancelBtn = $('scope-cancel');
        var layoutSection = $('scope-layout');        // PPTX 전용 (없을 수도 있음)
        var layoutFit = $('scope-layout-fit');
        var chartModeSection = $('scope-mode-chart');  // PPTX 전용 — 차트 표현(이미지/도형)
        var chartImage = $('scope-chart-image');
        var tableSection = $('scope-table');           // PPTX 전용 — 태스크 목록 표 포함
        var includeTable = $('scope-include-table');

        var s = (window.GanttApp && window.GanttApp.getState())
          ? window.GanttApp.getState()
          : { projects: [], tasks: [] };
        var projects = s.projects;

        // 열 때마다 초기화: 기본 "전체 프로젝트", 셀렉트는 비활성
        if (titleEl) titleEl.textContent = opts.title || '내보내기 범위';
        radioAll.checked = true;
        radioProject.checked = false;
        radioProject.disabled = projects.length === 0; // 방어 (호출측이 먼저 걸러줌)
        select.disabled = true;
        select.innerHTML = '';
        projects.forEach(function (p) {
          var opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = '[' + (CATEGORY_LABEL[p.category] || p.category) + '] ' + p.name;
          select.appendChild(opt);
        });

        // PPTX 전용 섹션들: 요청 시에만 표시하고 기본값으로 초기화
        // (요청 없으면 계속 hidden → 엑셀/PNG 동작 불변)
        if (chartModeSection) {
          chartModeSection.hidden = !withLayout;
          if (withLayout && chartImage) chartImage.checked = true;   // 기본 = 이미지
        }
        if (layoutSection) {
          layoutSection.hidden = !withLayout;
          if (withLayout && layoutFit) layoutFit.checked = true;     // 기본 = fit
        }
        if (tableSection) {
          tableSection.hidden = !withLayout;
          if (withLayout && includeTable) includeTable.checked = false; // 기본 = 꺼짐
        }

        // Tab 트랩 (12단계) — activate 는 아래에서 backdrop.hidden = false 직후 호출
        var trap = null;

        // 닫기 공통 처리: 리스너 해제 → 모달 숨김 → 결과 전달
        function cleanup(result) {
          radioAll.removeEventListener('change', onRadio);
          radioProject.removeEventListener('change', onRadio);
          confirmBtn.removeEventListener('click', onConfirm);
          cancelBtn.removeEventListener('click', onCancel);
          backdrop.removeEventListener('click', onBackdrop);
          document.removeEventListener('keydown', onKey);
          if (trap) { trap.deactivate(); trap = null; }
          // 다음 호출(엑셀/PNG) 대비 PPTX 전용 섹션 원복
          if (layoutSection) layoutSection.hidden = true;
          if (chartModeSection) chartModeSection.hidden = true;
          if (tableSection) tableSection.hidden = true;
          backdrop.hidden = true;
          resolve(result);
        }
        function onRadio() {
          // "선택한 프로젝트"를 골라야 셀렉트 활성화
          select.disabled = !radioProject.checked;
        }
        function onConfirm() {
          var result;
          if (radioProject.checked) {
            var id = select.value;
            var picked = null;
            for (var i = 0; i < projects.length; i++) {
              if (projects[i].id === id) { picked = projects[i]; break; }
            }
            if (!picked) { cleanup(null); return; } // 방어: 선택할 프로젝트가 없음
            result = { mode: 'project', projectId: picked.id, projectName: picked.name };
          } else {
            result = { mode: 'all', projectId: null, projectName: '' };
          }
          if (withLayout) {
            result.layout = readLayout();
            result.chartMode = readChartMode();
            result.includeTable = !!(includeTable && includeTable.checked);
          }
          cleanup(result);
        }
        function onCancel() { cleanup(null); }
        function onBackdrop(e) { if (e.target === backdrop) cleanup(null); }
        function onKey(e) { if (e.key === 'Escape') cleanup(null); }

        radioAll.addEventListener('change', onRadio);
        radioProject.addEventListener('change', onRadio);
        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
        backdrop.addEventListener('click', onBackdrop);
        document.addEventListener('keydown', onKey);

        backdrop.hidden = false;
        // Tab 트랩 활성화 (12단계)
        if (window.FocusTrap) trap = window.FocusTrap.activate(backdrop);
      });
    }

    // 공개 API (export.js / png.js / 이후 PPTX 등에서 사용)
    window.ExportScope = { choose: choose };
  })();
}
