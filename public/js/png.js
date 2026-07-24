// PNG 출력 (10단계) — html2canvas 로컬 번들(public/vendor)로 간트 차트를 이미지로 저장
// - 순수 함수(캔버스 한계 판정·분할 계획·기간 등분)는 파일 상단에 두고
//   Node 테스트에서 require 할 수 있게 파일 끝에서 module.exports 한다 (export.js/drag.js 패턴).
// - 브라우저 UI(드롭다운 "PNG 저장" 클릭 → 오프스크린 복제 캡처 → 다운로드)는
//   하단 typeof document 블록에 둔다.
// - 브라우저 캔버스는 한 변이 대략 16384px 를 넘으면 그리기가 실패한다. 그래서
//   먼저 배율을 낮춰 한 장에 담아보고(chooseScale), 그래도 폭이 넘치면 기간을
//   여러 장으로 나눠 저장한다(computePngPlan + splitDayRanges).

// ─────────────────────────────────────────────────────────────
// 상수
// ─────────────────────────────────────────────────────────────

// 대부분의 브라우저가 허용하는 캔버스 한 변의 최대 픽셀 (보수적으로 16384)
var MAX_CANVAS = 16384;
// 시도할 배율 단계 (내림차순). 2 = 고해상도(레티나), 1 = 등배, 0.5 = 절반 축소.
var SCALE_STEPS = [2, 1.5, 1, 0.75, 0.5];

// ─────────────────────────────────────────────────────────────
// 순수 함수 (캔버스 한계 처리 — Node 테스트 대상)
// ─────────────────────────────────────────────────────────────

/**
 * 전체 차트를 "단일 이미지"로 낼 수 있는 최적 배율을 정한다.
 * scaleSteps 를 내림차순으로 훑어 폭·높이 모두 한계(max) 이내인 첫 배율을 반환한다.
 * 경계는 이내(<=)로 판정하므로 정확히 max 인 경우도 통과한다.
 * @param {number} fullWidth  캡처 대상 전체 CSS px 폭 (좌측목록 + 타임라인 전체폭)
 * @param {number} fullHeight 캡처 대상 전체 CSS px 높이 (헤더 + 본문 전체높이)
 * @param {number} max        캔버스 한 변 최대 px
 * @param {number[]} scaleSteps 시도할 배율(내림차순)
 * @returns {number|null} 담을 수 있는 최대 배율, 하나도 못 담으면 null
 */
function chooseScale(fullWidth, fullHeight, max, scaleSteps) {
  for (var i = 0; i < scaleSteps.length; i++) {
    var s = scaleSteps[i];
    if (fullWidth * s <= max && fullHeight * s <= max) return s;
  }
  return null;
}

/**
 * 전체 PNG 출력 계획을 세운다.
 * 1) 단일 이미지로 담기면 → { split:false, parts:1, scale, downscaled }
 * 2) 0.5 배율로도 폭이 넘치면 → 기간 분할 { split:true, parts:N, scale, downscaled }
 * @param {number} fullWidth  전체 폭 (좌측목록폭 + 타임라인 전체폭)
 * @param {number} fullHeight 전체 높이
 * @param {number} leftWidth  좌측 태스크목록 폭 (분할 시 각 장에 항상 포함)
 * @param {object} [opts] { max, scaleSteps } — 미지정 시 MAX_CANVAS / SCALE_STEPS
 * @returns {{split:boolean, parts:number, scale:number, downscaled:boolean}}
 */
function computePngPlan(fullWidth, fullHeight, leftWidth, opts) {
  opts = opts || {};
  var max = opts.max != null ? opts.max : MAX_CANVAS;
  var scaleSteps = opts.scaleSteps || SCALE_STEPS;

  // 1) 단일 이미지 시도
  var scale = chooseScale(fullWidth, fullHeight, max, scaleSteps);
  if (scale != null) {
    // scale < 2 이면 고해상도를 포기하고 낮춰 담은 것 → downscaled 안내 대상
    return { split: false, parts: 1, scale: scale, downscaled: scale < 2 };
  }

  // 2) 기간 분할: 각 장은 좌측목록 + 타임라인 일부만 담는다.
  //    splitScale = 높이 조건(fullHeight*scale <= max)을 만족하는, 1 이하 배율 중 가장 큰 값.
  //    [1, 0.75, 0.5] 순으로 검사해 첫 만족값을 쓰고, 전부 실패면 0.5.
  var lowSteps = scaleSteps.filter(function (s) { return s <= 1; })
    .sort(function (a, b) { return b - a; }); // 내림차순 [1, 0.75, 0.5]
  var splitScale = 0.5;
  for (var i = 0; i < lowSteps.length; i++) {
    if (fullHeight * lowSteps[i] <= max) { splitScale = lowSteps[i]; break; }
  }

  var timelineWidth = fullWidth - leftWidth;      // 순수 타임라인 폭
  var avail = max / splitScale - leftWidth;        // 한 장이 담을 수 있는 타임라인 px
  var parts = Math.ceil(timelineWidth / avail);
  if (parts < 2) parts = 2;                        // 분할이면 최소 2장

  return { split: true, parts: parts, scale: splitScale, downscaled: splitScale < 2 };
}

/**
 * 전체 일수를 parts 장으로 균등 분할한 [start, end) 일 인덱스 경계 배열을 만든다.
 * 나머지는 앞 장부터 한 칸씩 더 분배한다.
 * 예: splitDayRanges(10, 3) => [{start:0,end:4},{start:4,end:7},{start:7,end:10}]
 * @param {number} totalDays 전체 일수
 * @param {number} parts     장 수
 * @returns {Array<{start:number, end:number}>}
 */
function splitDayRanges(totalDays, parts) {
  var ranges = [];
  var base = Math.floor(totalDays / parts); // 각 장 기본 일수
  var rem = totalDays % parts;              // 앞 장부터 하나씩 더 받을 나머지
  var start = 0;
  for (var i = 0; i < parts; i++) {
    var size = base + (i < rem ? 1 : 0);
    ranges.push({ start: start, end: start + size });
    start += size;
  }
  return ranges;
}

// Node(테스트) 환경에서 순수 함수/상수 검증할 수 있도록 내보내기
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    MAX_CANVAS: MAX_CANVAS,
    SCALE_STEPS: SCALE_STEPS,
    chooseScale: chooseScale,
    computePngPlan: computePngPlan,
    splitDayRanges: splitDayRanges,
  };
}

// ─────────────────────────────────────────────────────────────
// 브라우저 UI (드롭다운 "PNG 저장" → 오프스크린 복제 캡처 → 다운로드)
// ─────────────────────────────────────────────────────────────
if (typeof document !== 'undefined') {
  (function () {
    'use strict';

    function $(id) { return document.getElementById(id); }

    // ── 토스트 (export.js 와 동일 패턴: toast-host + .toast .toast--success/error) ──
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

    // 파일명 접두어: 간트차트_YYYY-MM-DD
    // projectName(선택)을 주면 간트차트_프로젝트명_YYYY-MM-DD (금지문자는 '_' 치환)
    function fileStamp(d, projectName) {
      function p2(n) { return (n < 10 ? '0' : '') + n; }
      var mid = projectName ? sanitizeFileNamePart(projectName) + '_' : '';
      return '간트차트_' + mid + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
    }

    // canvas → PNG Blob → a[download] 클릭 저장
    function saveCanvas(canvas, fileName) {
      return new Promise(function (resolve, reject) {
        canvas.toBlob(function (blob) {
          if (!blob) { reject(new Error('이미지 생성에 실패했습니다.')); return; }
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 3000);
          resolve();
        }, 'image/png');
      });
    }

    function delay(ms) {
      return new Promise(function (r) { setTimeout(r, ms); });
    }

    // ─────────────────────────────────────────────────────
    // 오프스크린 복제본 구성 — 실화면 스크롤/레이아웃에 영향 없이 전체 크기로 펼침
    // ─────────────────────────────────────────────────────
    /**
     * #gantt 를 화면 밖에 복제해 전체 크기로 펼친 wrapper 를 만든다.
     * (좌측 세로 스크롤·우측 가로 스크롤 해제, 헤더 sticky 해제, 범례 상단 포함)
     * @returns {{ wrapper, ganttClone, right, head, body, legendHeight,
     *             leftWidth, timelineWidth, chartHeight, fullWidth, fullHeight }}
     */
    // 범례(#legend-bar)가 표시 중이면 복제해 wrapper 상단에 추가 (전체/프로젝트 공용)
    function appendLegendClone(wrapper, width) {
      var legendBar = $('legend-bar');
      if (!legendBar || legendBar.hidden) return;
      var legendClone = legendBar.cloneNode(true);
      legendClone.removeAttribute('id'); // 화면 요소와 id 중복 방지
      legendClone.removeAttribute('hidden');
      legendClone.style.width = width + 'px';
      wrapper.appendChild(legendClone);
    }

    function buildCaptureClone() {
      var gantt = $('gantt');
      var leftEl = $('gantt-left');
      var timelineHead = $('timeline-head');
      var timelineBody = $('timeline-body');

      // 실측: 좌측 고정폭 / 타임라인 전체폭 / 헤더 높이 / 본문 전체높이
      var leftWidth = leftEl.offsetWidth;
      var timelineWidth = timelineBody.offsetWidth;   // gantt.js 가 인라인으로 전체폭 부여
      var headHeight = timelineHead.offsetHeight;
      var bodyHeight = timelineBody.offsetHeight;      // rows*36 (전체 높이)
      var chartHeight = headHeight + bodyHeight;
      var fullWidth = leftWidth + timelineWidth;

      // 화면 밖 wrapper (실화면에 영향 없음)
      var wrapper = document.createElement('div');
      wrapper.style.position = 'absolute';
      wrapper.style.left = '-99999px';
      wrapper.style.top = '0';
      wrapper.style.margin = '0';
      wrapper.style.padding = '0';
      wrapper.style.background = '#ffffff';
      wrapper.classList.add('export-force-light');
      wrapper.style.width = fullWidth + 'px';

      // 범례를 켜져 있을 때만 상단에 포함
      var legendHeight = 0;
      appendLegendClone(wrapper, fullWidth);

      // 간트 본체 복제 후 전체 크기로 펼침
      var ganttClone = gantt.cloneNode(true);
      ganttClone.removeAttribute('id');
      ganttClone.style.visibility = 'visible';
      ganttClone.style.width = fullWidth + 'px';
      ganttClone.style.height = chartHeight + 'px';
      ganttClone.style.overflow = 'visible';

      // 좌측 body: 세로 스크롤 해제 + 전체 높이
      var cLeftBody = ganttClone.querySelector('.gantt__left-body');
      if (cLeftBody) {
        cLeftBody.style.overflow = 'visible';
        cLeftBody.style.height = bodyHeight + 'px';
      }
      // 우측: 가로/세로 스크롤 해제 + 타임라인 전체폭 고정
      var right = ganttClone.querySelector('.gantt__right');
      if (right) {
        right.style.overflow = 'visible';
        right.style.flex = '0 0 ' + timelineWidth + 'px';
        right.style.width = timelineWidth + 'px';
      }
      // 헤더 sticky 해제 (스크롤 없는 복제본에서 위치 어긋남 방지)
      var head = ganttClone.querySelector('.timeline__head');
      if (head) head.style.position = 'relative';
      var body = ganttClone.querySelector('.timeline__body');

      wrapper.appendChild(ganttClone);
      document.body.appendChild(wrapper);

      // 범례 실제 높이 반영(포함된 경우) → 전체 높이 확정
      legendHeight = wrapper.offsetHeight - ganttClone.offsetHeight;
      if (legendHeight < 0) legendHeight = 0;
      var fullHeight = legendHeight + chartHeight;

      return {
        wrapper: wrapper, ganttClone: ganttClone, right: right, head: head, body: body,
        legendHeight: legendHeight, leftWidth: leftWidth, timelineWidth: timelineWidth,
        chartHeight: chartHeight, fullWidth: fullWidth, fullHeight: fullHeight,
      };
    }

    /**
     * 프로젝트별 캡처 대상 구성: 선택 프로젝트 데이터만으로 gantt.js 의
     * buildChartDom(화면 렌더와 동일 함수 재사용)이 오프스크린에 새로 그린 차트를
     * 범례와 함께 wrapper 로 감싼다. 반환 형태는 buildCaptureClone 과 동일해
     * capturePipeline(단일/하향/분할)을 그대로 태울 수 있다.
     */
    function buildProjectCapture(projects, tasks) {
      var built = window.GanttApp.buildChartDom(projects, tasks);
      var root = built.root;
      var chartHeight = built.headHeight + built.bodyHeight;
      var fullWidth = built.leftWidth + built.timelineWidth;

      // 화면 밖 wrapper (buildCaptureClone 과 동일 형태)
      var wrapper = document.createElement('div');
      wrapper.style.position = 'absolute';
      wrapper.style.left = '-99999px';
      wrapper.style.top = '0';
      wrapper.style.margin = '0';
      wrapper.style.padding = '0';
      wrapper.style.background = '#ffffff';
      wrapper.classList.add('export-force-light');
      wrapper.style.width = fullWidth + 'px';

      appendLegendClone(wrapper, fullWidth);

      // buildChartDom 이 body 에 붙인 root 를 wrapper 안으로 이동 (정적 배치로 전환)
      root.style.position = 'static';
      root.style.left = '';
      root.style.top = '';
      wrapper.appendChild(root);
      document.body.appendChild(wrapper);

      var legendHeight = wrapper.offsetHeight - root.offsetHeight;
      if (legendHeight < 0) legendHeight = 0;

      return {
        wrapper: wrapper,
        ganttClone: root,
        right: root.querySelector('.gantt__right'),
        head: root.querySelector('.timeline__head'),
        body: root.querySelector('.timeline__body'),
        legendHeight: legendHeight,
        leftWidth: built.leftWidth,
        timelineWidth: built.timelineWidth,
        chartHeight: chartHeight,
        fullWidth: fullWidth,
        fullHeight: legendHeight + chartHeight,
      };
    }

    /**
     * 분할 캡처용: 복제본의 타임라인을 [sliceStartPx, sliceStartPx+sliceWidthPx) 구간만
     * 보이도록 조정한다. 우측 폭을 슬라이스 폭으로 줄이고 헤더/본문을 왼쪽으로 이동시킨다.
     */
    function applySlice(cap, sliceStartPx, sliceWidthPx) {
      var partWidth = cap.leftWidth + sliceWidthPx;
      cap.wrapper.style.width = partWidth + 'px';
      cap.ganttClone.style.width = partWidth + 'px';
      // 우측 창을 슬라이스 폭으로 고정 + 넘치는 부분 잘라냄
      cap.right.style.overflow = 'hidden';
      cap.right.style.flex = '0 0 ' + sliceWidthPx + 'px';
      cap.right.style.width = sliceWidthPx + 'px';
      // 헤더/본문(각자 타임라인 전체폭 유지)을 왼쪽으로 밀어 해당 구간만 노출
      var shift = 'translateX(' + (-sliceStartPx) + 'px)';
      if (cap.head) cap.head.style.transform = shift;
      if (cap.body) cap.body.style.transform = shift;
      // 범례 클론 폭도 파트 폭에 맞춤
      var legendClone = cap.wrapper.firstChild;
      if (legendClone && legendClone !== cap.ganttClone && legendClone.style) {
        legendClone.style.width = partWidth + 'px';
      }
      return partWidth;
    }

    // 공통 html2canvas 옵션 — 실제 정의는 export-capture.js(window.ExportCapture)에 있다.
    // (PNG/PPTX 가 같은 옵션을 써야 하므로 한 곳에서만 관리한다. onclone 콜백에서
    //  복제 문서에 스타일시트 본문·라이트 테마·CSS 변수를 주입해 캡처가 깨지지 않게 한다.)
    function h2cOptions(scale, width, height) {
      return window.ExportCapture.h2cOptions(scale, width, height);
    }

    // ─────────────────────────────────────────────────────
    // 캡처 파이프라인 (wrapper 소스와 무관한 공용 처리)
    // 계획 수립 → 안내 토스트 → 단일/하향/분할 저장. cap 은 buildCaptureClone
    // 또는 buildProjectCapture 결과 (동일 형태). stamp 는 파일명 접두어.
    // ─────────────────────────────────────────────────────
    async function capturePipeline(cap, stamp) {
      var plan = computePngPlan(cap.fullWidth, cap.fullHeight, cap.leftWidth);

      if (!plan.split) {
        // ── 단일 이미지 ──
        if (plan.downscaled) {
          showToastMsg('차트가 넓어 해상도를 ' + Math.round(plan.scale * 100) +
            '%로 낮춰 저장합니다.', false);
        }
        var canvas = await window.html2canvas(cap.wrapper,
          h2cOptions(plan.scale, cap.fullWidth, cap.fullHeight));
        await saveCanvas(canvas, stamp + '.png');
        showToastMsg('PNG 이미지를 저장했습니다.', false);
      } else {
        // ── 기간 분할(N장) ──
        showToastMsg('차트가 매우 넓어 ' + plan.parts + '장으로 나눠 저장합니다.', false);
        // 타임라인 전체폭(px)을 균등 분할한다. splitDayRanges 는 "총 단위 수"를 parts 로
        // 나누므로, 단위를 픽셀(=하루폭 1)로 두면 픽셀 구간이 바로 나온다. 각 장의 분할
        // 경계는 타임라인 격자·헤더 위에서 자연스러운 날짜 경계로 보이므로 별도 표기 불필요.
        var totalPx = Math.max(1, Math.round(cap.timelineWidth));
        var ranges = splitDayRanges(totalPx, plan.parts);

        for (var i = 0; i < ranges.length; i++) {
          var r = ranges[i];
          var sliceStartPx = r.start;
          var sliceEndPx = (i === ranges.length - 1)
            ? cap.timelineWidth // 마지막 장은 끝까지(반올림 오차로 잘리지 않도록)
            : r.end;
          var sliceWidthPx = sliceEndPx - sliceStartPx;

          var partWidth = applySlice(cap, sliceStartPx, sliceWidthPx);
          var partCanvas = await window.html2canvas(cap.wrapper,
            h2cOptions(plan.scale, partWidth, cap.fullHeight));
          var fileName = stamp + '_' + (i + 1) + 'of' + plan.parts + '.png';
          await saveCanvas(partCanvas, fileName);
          if (i < ranges.length - 1) await delay(300); // 연속 다운로드 사이 간격
        }
        showToastMsg(plan.parts + '장으로 저장했습니다.', false);
      }
    }

    // ─────────────────────────────────────────────────────
    // PNG 저장 실행 (범위 반영)
    // scope: window.ExportScope.choose 결과 {mode:'all'|'project', projectId, projectName}
    // ─────────────────────────────────────────────────────
    async function doPng(scope) {
      if (typeof window.html2canvas !== 'function') {
        showToastMsg('PNG 라이브러리를 불러오지 못했습니다.', true);
        return;
      }
      var s = state();
      if (s.projects.length === 0) {
        showToastMsg('저장할 차트가 없습니다.', true);
        return;
      }

      var cap = null;
      try {
        var stamp;
        if (scope && scope.mode === 'project') {
          // 프로젝트별: 선택 프로젝트 데이터만으로 오프스크린에 새로 그려 캡처
          // (다른 프로젝트의 행·바·의존선 없음, 날짜 축도 그 프로젝트 기준 재계산)
          var filtered = filterByProject(s.projects, s.tasks, scope.projectId);
          cap = buildProjectCapture(filtered.projects, filtered.tasks);
          stamp = fileStamp(new Date(), scope.projectName);
        } else {
          // 전체: 화면 차트 복제 방식 (기존 경로 유지)
          cap = buildCaptureClone();
          stamp = fileStamp(new Date());
        }
        await capturePipeline(cap, stamp);
      } catch (ex) {
        showToastMsg('PNG 저장 실패: ' + (ex && ex.message ? ex.message : ex), true);
      } finally {
        if (cap && cap.wrapper && cap.wrapper.parentNode) {
          cap.wrapper.parentNode.removeChild(cap.wrapper);
        }
      }
    }

    // ─────────────────────────────────────────────────────
    // 이벤트 바인딩 — 기존 "엑셀 ▾"(#btn-excel) 드롭다운 안의 #btn-png
    // ─────────────────────────────────────────────────────
    document.addEventListener('DOMContentLoaded', function () {
      var pngBtn = $('btn-png');
      if (!pngBtn) return;
      pngBtn.addEventListener('click', function () {
        // 드롭다운 닫기 (export.js 와 동일 처리)
        var menu = $('excel-menu');
        var excelBtn = $('btn-excel');
        if (menu) menu.hidden = true;
        if (excelBtn) excelBtn.setAttribute('aria-expanded', 'false');
        // 데이터가 없으면 모달 없이 기존 안내 토스트 유지
        if (state().projects.length === 0) {
          showToastMsg('저장할 차트가 없습니다.', true);
          return;
        }
        // 범위 선택(전체/프로젝트별) 후 실행 — 취소(null)면 아무 것도 안 함
        window.ExportScope.choose({ title: 'PNG 저장 범위' }).then(function (scope) {
          if (!scope) return;
          doPng(scope);
        });
      });
    });
  })();
}
