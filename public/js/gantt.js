// 간트 차트 렌더링 로직 (3단계: 기본 렌더링)
// - 좌측 태스크 목록 + 우측 타임라인(날짜 축/태스크 바/오늘 기준선)
// - 일/주/월 보기 전환, 좌우 세로 스크롤 동기화
// - 캔버스 미사용(CSS/DOM 기반) — 이후 단계의 DOM 조작 호환 목적

(function () {
  'use strict';

  // ── 상수 ──
  var DAY_MS = 24 * 60 * 60 * 1000;                 // 하루(밀리초)
  var WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토']; // 요일 라벨
  var ROW_H = 36;                                   // 행 높이(px) — CSS --row-h 와 일치
  // 보기 단위별 하루당 픽셀 폭 (열 폭·바 위치 계산의 단일 기준값)
  var PX_PER_DAY = { day: 40, week: 12, month: 4 };

  // ── 상태별 색 팔레트 (5단계 확정 팔레트) ──
  // bar: 바 기본색 / dark: 진행률 채움·테두리·마일스톤에 쓰는 어두운 톤
  var STATUS_COLORS = {
    plan:     { bar: '#9ca3af', dark: '#6b7280' }, // 회색
    setup:    { bar: '#8b5cf6', dark: '#6d28d9' }, // 보라
    ongoing:  { bar: '#3b82f6', dark: '#1d4ed8' }, // 파랑
    complete: { bar: '#22c55e', dark: '#15803d' }, // 초록
    delayed:  { bar: '#ef4444', dark: '#b91c1c' }, // 빨강
  };
  // 알 수 없는 상태값이 들어와도 안전하게 회색으로 처리
  function statusColor(status) {
    return STATUS_COLORS[status] || STATUS_COLORS.plan;
  }

  // ── 요소별 표시 토글 설정 (localStorage 저장/복원) ──
  var DISPLAY_KEY = 'gantt.display';
  var DISPLAY_KEYS = ['progress', 'priority', 'delay', 'deps', 'legend'];
  var display = loadDisplay();

  // localStorage 에서 표시 설정을 읽어온다. (없거나 손상 시 전부 true)
  function loadDisplay() {
    var d = { progress: true, priority: true, delay: true, deps: true, legend: true };
    try {
      var raw = window.localStorage.getItem(DISPLAY_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        DISPLAY_KEYS.forEach(function (k) {
          if (typeof saved[k] === 'boolean') d[k] = saved[k];
        });
      }
    } catch (e) { /* 무시하고 기본값 사용 */ }
    return d;
  }

  // 현재 표시 설정을 localStorage 에 저장한다.
  function saveDisplay() {
    try { window.localStorage.setItem(DISPLAY_KEY, JSON.stringify(display)); }
    catch (e) { /* 저장 실패는 치명적이지 않음 */ }
  }

  // ── 줌 배율 (8단계) — 보기(일/주/월) 공통 배율 1개, localStorage 저장 ──
  // 배율 단계 배열(ZOOM_STEPS)과 인덱스 계산 순수 함수는 drag.js 상단에 정의됨.
  var ZOOM_KEY = 'gantt.zoom';

  // localStorage 에서 줌 인덱스를 읽어온다 (없거나 손상 시 100%).
  function loadZoomIndex() {
    try {
      var raw = window.localStorage.getItem(ZOOM_KEY);
      if (raw != null) return clampZoomIndex(parseInt(raw, 10));
    } catch (e) { /* 무시하고 기본값 */ }
    return clampZoomIndex(NaN); // 100% 인덱스
  }

  function saveZoomIndex(i) {
    try { window.localStorage.setItem(ZOOM_KEY, String(i)); }
    catch (e) { /* 저장 실패는 치명적이지 않음 */ }
  }

  // ── 상태 ──
  var state = {
    scale: 'day',      // 현재 보기 단위
    zoomIndex: loadZoomIndex(), // 줌 배율 단계 인덱스 (ZOOM_STEPS 기준)
    projects: [],      // 프로젝트 목록
    tasks: [],         // 태스크 목록
  };

  // 마지막 렌더 컨텍스트 (오늘 이동·줌 앵커 보정에 사용)
  var lastRender = { range: null, pxPerDay: 0 };

  // 오늘 날짜 (자정 기준 Date)
  var TODAY = stripTime(new Date());

  // 자동 지연 경고 대상 여부: 종료일이 오늘보다 이전인데 완료가 아닌 태스크
  // (status 를 자동으로 바꾸지는 않고, 시각적 경고만 부여한다)
  function isOverdue(task) {
    if (task.status === 'complete') return false;
    return parseDate(task.endDate) < TODAY;
  }

  // ─────────────────────────────────────────────────────────
  // 날짜 유틸
  // ─────────────────────────────────────────────────────────

  // 'YYYY-MM-DD' -> 로컬 자정 Date (타임존 영향 제거)
  function parseDate(str) {
    var p = String(str).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  // Date 의 시/분/초 제거 (자정으로 정규화)
  function stripTime(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }

  // n일 뒤 Date
  function addDays(d, n) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  }

  // 두 날짜 사이의 일수 차 (b - a)
  function diffDays(a, b) {
    return Math.round((stripTime(b) - stripTime(a)) / DAY_MS);
  }

  // 두 자리 0 패딩
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  // 주말 여부 (토=6, 일=0)
  function isWeekend(d) {
    var day = d.getDay();
    return day === 0 || day === 6;
  }

  // 같은 날짜인지
  function sameDay(a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
  }

  // ─────────────────────────────────────────────────────────
  // 표시 범위 계산 — scope.js 의 computeRangeForTasks(전역, 단일 정의) 사용.
  // 기존 computeRange 로직(데이터 min~max + 보기별 여유/스냅 + 오늘 포함)을
  // 그대로 옮긴 것으로, today 를 주입받아 Node 테스트가 가능하다.
  // (scope.js 는 index.html 에서 gantt.js 보다 먼저 로드된다)
  // ─────────────────────────────────────────────────────────

  // ─────────────────────────────────────────────────────────
  // 행(row) 목록 구성 — 프로젝트 그룹 + 계층 태스크
  // ─────────────────────────────────────────────────────────
  // 반환: [{ type:'group', project } | { type:'task', task, level }]
  function buildRows(projects, tasks) {
    var rows = [];
    projects.forEach(function (project) {
      rows.push({ type: 'group', project: project });

      // 이 프로젝트의 태스크만
      var own = tasks.filter(function (t) { return t.projectId === project.id; });

      // parentId -> 자식 목록 맵 (최상위 키는 '')
      var byParent = {};
      own.forEach(function (t) {
        var key = t.parentId || '';
        (byParent[key] = byParent[key] || []).push(t);
      });
      // 각 그룹을 order 순(동률이면 이름순)으로 정렬
      Object.keys(byParent).forEach(function (k) {
        byParent[k].sort(function (a, b) {
          var ao = a.order == null ? 0 : a.order;
          var bo = b.order == null ? 0 : b.order;
          if (ao !== bo) return ao - bo;
          return String(a.name).localeCompare(String(b.name));
        });
      });

      // 유효한 부모 id 집합 (없는 부모를 참조하면 최상위로 취급)
      var idSet = {};
      own.forEach(function (t) { idSet[t.id] = true; });

      // DFS 로 계층 평탄화
      var visited = {};
      function walk(parentKey, level) {
        var children = byParent[parentKey] || [];
        children.forEach(function (t) {
          if (visited[t.id]) return;  // 순환 방어
          visited[t.id] = true;
          rows.push({ type: 'task', task: t, level: level });
          walk(t.id, level + 1);
        });
      }
      walk('', 0);
      // 부모가 소속 프로젝트에 없어 누락된 태스크는 최상위로 추가
      own.forEach(function (t) {
        if (!visited[t.id]) {
          visited[t.id] = true;
          rows.push({ type: 'task', task: t, level: 0 });
        }
      });
    });
    return rows;
  }

  // ─────────────────────────────────────────────────────────
  // 타임라인 열(column) 구성 — 보기 단위별
  // ─────────────────────────────────────────────────────────
  // 반환: { top:[{label, days}], bottom:[{label, sub, days, weekend, today}] }
  function buildColumns(scale, range) {
    var top = [];
    var bottom = [];
    var start = range.start;
    var end = range.end;

    if (scale === 'day') {
      var total = diffDays(start, end) + 1;
      var curKey = null, curCell = null;
      for (var i = 0; i < total; i++) {
        var d = addDays(start, i);
        // 상단: 연/월 그룹
        var key = d.getFullYear() + '-' + d.getMonth();
        if (key !== curKey) {
          curKey = key;
          curCell = { label: d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월', days: 0 };
          top.push(curCell);
        }
        curCell.days += 1;
        // 하단: 일 + 요일
        bottom.push({
          label: String(d.getDate()),
          sub: WEEKDAY_KR[d.getDay()],
          days: 1,
          weekend: isWeekend(d),
          today: sameDay(d, TODAY),
        });
      }
    } else if (scale === 'week') {
      var w = start;
      var curKeyW = null, curCellW = null;
      while (w <= end) {
        var weekEnd = addDays(w, 6);
        var visibleDays = Math.min(7, diffDays(w, end) + 1);
        // 상단: 월 그룹 (주 시작일 기준)
        var keyW = w.getFullYear() + '-' + w.getMonth();
        if (keyW !== curKeyW) {
          curKeyW = keyW;
          curCellW = { label: w.getFullYear() + '년 ' + (w.getMonth() + 1) + '월', days: 0 };
          top.push(curCellW);
        }
        curCellW.days += visibleDays;
        // 하단: 주 시작일 (M/D)
        bottom.push({
          label: (w.getMonth() + 1) + '/' + w.getDate(),
          sub: '주',
          days: visibleDays,
          weekend: false,
          today: (TODAY >= w && TODAY <= weekEnd),
        });
        w = addDays(w, 7);
      }
    } else {
      // month
      var m = new Date(start.getFullYear(), start.getMonth(), 1);
      var curYear = null, curCellM = null;
      while (m <= end) {
        var daysInMonth = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate();
        // 상단: 연도 그룹
        if (m.getFullYear() !== curYear) {
          curYear = m.getFullYear();
          curCellM = { label: m.getFullYear() + '년', days: 0 };
          top.push(curCellM);
        }
        curCellM.days += daysInMonth;
        // 하단: 월
        bottom.push({
          label: (m.getMonth() + 1) + '월',
          sub: '',
          days: daysInMonth,
          weekend: false,
          today: (TODAY.getFullYear() === m.getFullYear() && TODAY.getMonth() === m.getMonth()),
        });
        m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
      }
    }
    return { top: top, bottom: bottom };
  }

  // ─────────────────────────────────────────────────────────
  // 렌더링
  // ─────────────────────────────────────────────────────────
  function render() {
    var hasData = state.projects.length > 0;

    // 툴바 활성 버튼 표시
    document.querySelectorAll('.scale-btn').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-scale') === state.scale);
    });

    // 범례 표시/숨김 (표시 토글 반영)
    var legendBar = document.getElementById('legend-bar');
    if (legendBar) legendBar.hidden = !display.legend;

    // '+ 태스크' 버튼: 프로젝트가 하나도 없으면 비활성 + 안내 툴팁
    var addTaskBtn = document.getElementById('btn-add-task');
    if (addTaskBtn) {
      addTaskBtn.disabled = !hasData;
      addTaskBtn.title = hasData ? '' : '먼저 프로젝트를 추가하세요';
    }

    var ganttEl = document.getElementById('gantt');
    var emptyEl = document.getElementById('empty-state');

    // 빈 상태 처리
    if (!hasData) {
      ganttEl.style.visibility = 'hidden';
      emptyEl.hidden = false;
      return;
    }
    ganttEl.style.visibility = 'visible';
    emptyEl.hidden = true;

    // 하루 폭 = 보기별 기본 폭 × 줌 배율 (8단계)
    var pxPerDay = PX_PER_DAY[state.scale] * ZOOM_STEPS[state.zoomIndex];
    var range = computeRangeForTasks(state.tasks, state.scale, TODAY);
    var totalDays = diffDays(range.start, range.end) + 1;
    var totalWidth = totalDays * pxPerDay;

    var rows = buildRows(state.projects, state.tasks);
    var bodyHeight = rows.length * ROW_H;

    var cols = buildColumns(state.scale, range);

    renderLeft(rows);
    renderHead(cols, totalWidth, pxPerDay);
    renderBody(rows, cols, range, pxPerDay, totalWidth, bodyHeight);

    // 오늘 이동·줌 앵커 보정용 컨텍스트 저장
    lastRender = { range: range, pxPerDay: pxPerDay };
    updateZoomUi();

    setupScrollSync();
    setupLeftInteractions();

    // 드래그 이동 로직에 현재 렌더 컨텍스트(하루 폭) 전달 + 위임 바인딩
    if (window.GanttDrag) window.GanttDrag.updateContext({ pxPerDay: pxPerDay });
  }

  // 날짜 -> 타임라인 x 좌표(px). 해당 날짜의 '시작(왼쪽 경계)'.
  function xOf(date, range, pxPerDay) {
    return diffDays(range.start, date) * pxPerDay;
  }

  // ── 좌측 태스크 목록 ──
  // targetBody 를 넘기면 그 요소에 그린다 (기본값 = 화면의 #gantt-left-body).
  // 오프스크린 렌더(buildChartDom)가 화면과 동일한 DOM 을 얻기 위한 최소 확장.
  function renderLeft(rows, targetBody) {
    var body = targetBody || document.getElementById('gantt-left-body');
    body.innerHTML = '';

    rows.forEach(function (row) {
      if (row.type === 'group') {
        var g = document.createElement('div');
        g.className = 'group-row';
        g.setAttribute('data-project-id', row.project.id); // 수정/삭제 진입용
        var cat = row.project.category;
        var badgeClass = cat === 'work' ? 'badge--work' : 'badge--personal';
        var badgeText = cat === 'work' ? '업무' : '개인';
        g.innerHTML =
          '<div class="group-head">' +
            '<span class="badge ' + badgeClass + '">' + badgeText + '</span>' +
            '<span class="group-head__name">' + escapeHtml(row.project.name) + '</span>' +
            // hover 시 노출되는 수정(✎)·삭제(🗑) 아이콘
            '<span class="row-actions">' +
              '<button type="button" class="icon-btn" data-action="edit-project" title="프로젝트 수정" aria-label="프로젝트 수정">✎</button>' +
              '<button type="button" class="icon-btn" data-action="delete-project" title="프로젝트 삭제" aria-label="프로젝트 삭제">🗑</button>' +
            '</span>' +
          '</div>';
        body.appendChild(g);
      } else {
        var t = row.task;
        var r = document.createElement('div');
        r.className = 'row';
        r.setAttribute('data-task-id', t.id); // 행 클릭=수정 진입용
        // 순서 변경(6단계 3/3)용 계층 메타데이터: 같은 프로젝트+같은 부모끼리만 형제
        r.setAttribute('data-project-id', t.projectId);
        r.setAttribute('data-parent-id', t.parentId || '');
        var indent = 12 + row.level * 16; // 계층 들여쓰기

        // 상태 색 점 (항상 표시)
        var dot = '<span class="status-dot" style="background:' +
          statusColor(t.status).bar + '" title="' + escapeHtml(t.status) + '"></span>';

        // 마일스톤 다이아몬드 (상태 색 적용)
        var diamond = t.milestone
          ? '<span class="task-label__diamond" style="color:' + statusColor(t.status).dark + '">◆</span>'
          : '';

        // 우선순위 배지 (높음=주황 / 낮음=회색 / 보통=없음) — 표시 토글 반영
        var badge = '';
        if (display.priority) {
          if (t.priority === 'high') badge = '<span class="prio-badge prio-badge--high" title="우선순위 높음">높음</span>';
          else if (t.priority === 'low') badge = '<span class="prio-badge prio-badge--low" title="우선순위 낮음">낮음</span>';
        }

        // 자동 지연 경고 아이콘 (표시 토글 반영)
        var warn = (display.delay && isOverdue(t))
          ? '<span class="overdue-mark" title="종료일 경과">⚠</span>' : '';

        r.innerHTML =
          '<div class="task-label" style="padding-left:' + indent + 'px">' +
            dot +
            diamond +
            '<span class="task-label__name">' + escapeHtml(t.name) + '</span>' +
            warn +
            badge +
            // hover 시 노출되는 삭제(🗑) 아이콘 (수정은 행 클릭으로)
            '<span class="row-actions">' +
              '<button type="button" class="icon-btn" data-action="delete-task" title="태스크 삭제" aria-label="태스크 삭제">🗑</button>' +
            '</span>' +
          '</div>';
        body.appendChild(r);
      }
    });
  }

  // ── 좌측 목록 상호작용 (수정/삭제 진입) — 이벤트 위임, 한 번만 바인딩 ──
  var leftBound = false;
  function setupLeftInteractions() {
    if (leftBound) return;
    leftBound = true;
    var body = document.getElementById('gantt-left-body');
    body.addEventListener('click', function (e) {
      // CRUD UI 가 아직 로드되지 않았으면 무시
      if (!window.CrudUI) return;

      // 1) 액션 아이콘 클릭 우선 처리
      var actionBtn = e.target.closest('[data-action]');
      if (actionBtn) {
        e.stopPropagation();
        var action = actionBtn.getAttribute('data-action');
        if (action === 'edit-project' || action === 'delete-project') {
          var groupEl = actionBtn.closest('[data-project-id]');
          var pid = groupEl && groupEl.getAttribute('data-project-id');
          if (!pid) return;
          if (action === 'edit-project') window.CrudUI.editProject(pid);
          else window.CrudUI.deleteProject(pid);
        } else if (action === 'delete-task') {
          var taskEl = actionBtn.closest('[data-task-id]');
          var tid = taskEl && taskEl.getAttribute('data-task-id');
          if (tid) window.CrudUI.deleteTask(tid);
        }
        return;
      }

      // 2) 태스크 행 클릭 → 수정 패널
      var rowEl = e.target.closest('[data-task-id]');
      if (rowEl) {
        window.CrudUI.editTask(rowEl.getAttribute('data-task-id'));
      }
    });
  }

  // ── 타임라인 축 헤더 (2줄) ──
  // targetHead 를 넘기면 그 요소에 그린다 (기본값 = 화면의 #timeline-head).
  function renderHead(cols, totalWidth, pxPerDay, targetHead) {
    var head = targetHead || document.getElementById('timeline-head');
    head.style.width = totalWidth + 'px';

    var pxPerDayLocal = pxPerDay; // 줌 배율 반영값 (render 에서 전달)

    var topHtml = cols.top.map(function (c) {
      return '<div class="axis-top__cell" style="width:' + (c.days * pxPerDayLocal) + 'px">' +
             escapeHtml(c.label) + '</div>';
    }).join('');

    var bottomHtml = cols.bottom.map(function (c) {
      var cls = 'axis-bottom__cell';
      if (c.weekend) cls += ' is-weekend';
      if (c.today) cls += ' is-today';
      var todayLabel = c.today ? '<span class="axis-today-label">오늘</span>' : '';
      var sub = c.sub ? '<span>' + escapeHtml(c.sub) + '</span>' : '';
      return '<div class="' + cls + '" style="width:' + (c.days * pxPerDayLocal) + 'px">' +
             '<span>' + escapeHtml(c.label) + '</span>' + sub + todayLabel +
             '</div>';
    }).join('');

    head.innerHTML =
      '<div class="timeline__head-inner">' +
        '<div class="axis-top">' + topHtml + '</div>' +
        '<div class="axis-bottom">' + bottomHtml + '</div>' +
      '</div>';
  }

  // ── 타임라인 본문 (격자 + 행 + 바 + 오늘선) ──
  // targetBody 를 넘기면 그 요소에 그린다 (기본값 = 화면의 #timeline-body).
  // depUid: 오프스크린 렌더 시 의존선 SVG 마커 id 접미사 (id 중복 방지, 화면은 '').
  function renderBody(rows, cols, range, pxPerDay, totalWidth, bodyHeight, targetBody, depUid) {
    var body = targetBody || document.getElementById('timeline-body');
    body.innerHTML = '';
    body.style.width = totalWidth + 'px';
    body.style.height = bodyHeight + 'px';

    var frag = document.createDocumentFragment();

    // 1) 세로 격자열 (주말 배경 + 경계선)
    var left = 0;
    cols.bottom.forEach(function (c) {
      var w = c.days * pxPerDay;
      var col = document.createElement('div');
      col.className = 'grid-col' + (c.weekend ? ' is-weekend' : '');
      col.style.left = left + 'px';
      col.style.width = w + 'px';
      frag.appendChild(col);
      left += w;
    });

    // 2) 행 배경/구분선
    rows.forEach(function (row, i) {
      var r = document.createElement('div');
      r.className = row.type === 'group' ? 'group-row' : 'row';
      r.style.position = 'absolute';
      r.style.top = (i * ROW_H) + 'px';
      r.style.left = '0';
      r.style.width = totalWidth + 'px';
      frag.appendChild(r);
    });

    // 3) 태스크 바 / 마일스톤 (+ 의존선 앵커 좌표 수집)
    var geom = {}; // taskId -> { leftX, rightX, cy }
    rows.forEach(function (row, i) {
      if (row.type !== 'task') return;
      var t = row.task;
      var y = i * ROW_H;

      var colors = statusColor(t.status);            // 상태 색
      var overdue = display.delay && isOverdue(t);   // 지연 경고 대상 여부

      if (t.milestone) {
        // 마일스톤: startDate 위치에 다이아몬드 (상태 색 적용)
        var mx = xOf(parseDate(t.startDate), range, pxPerDay) + pxPerDay / 2;
        var dia = document.createElement('div');
        dia.className = 'milestone' + (overdue ? ' milestone--overdue' : '');
        dia.style.left = (mx - 7) + 'px';
        dia.style.top = (y + (ROW_H - 14) / 2) + 'px';
        dia.style.background = colors.bar;
        dia.style.borderColor = colors.dark;
        // 드래그 이동용 메타데이터 (마일스톤은 시작=종료)
        dia.setAttribute('data-task-id', t.id);
        dia.setAttribute('data-start', t.startDate);
        dia.setAttribute('data-end', t.endDate);
        dia.innerHTML = '<span class="milestone__label">' + escapeHtml(t.name) + '</span>';
        frag.appendChild(dia);
        // 의존선 앵커: 다이아몬드 좌/우 꼭짓점(±7px)과 세로 중심
        geom[t.id] = { leftX: mx - 7, rightX: mx + 7, cy: y + ROW_H / 2 };
      } else {
        // 기간 바: startDate ~ endDate (endDate 포함)
        var start = parseDate(t.startDate);
        var end = parseDate(t.endDate);
        var bx = xOf(start, range, pxPerDay);
        var bw = (diffDays(start, end) + 1) * pxPerDay;
        if (bw < 4) bw = 4; // 최소 폭

        var bar = document.createElement('div');
        bar.className = 'bar' + (overdue ? ' bar--overdue' : '');
        bar.style.left = bx + 'px';
        bar.style.top = (y + 7) + 'px';
        bar.style.width = bw + 'px';
        bar.style.background = colors.bar;         // 상태 기본색
        bar.style.borderColor = colors.dark;       // 상태 어두운 톤 테두리
        // 드래그 이동용 메타데이터
        bar.setAttribute('data-task-id', t.id);
        bar.setAttribute('data-start', t.startDate);
        bar.setAttribute('data-end', t.endDate);

        // 진행률 (complete 는 100% 취급)
        var pct = t.status === 'complete' ? 100 : (t.progress || 0);
        if (pct < 0) pct = 0; if (pct > 100) pct = 100;

        var inner = '';

        // 진행률 채움 (같은 색 계열 어두운 톤) — 표시 토글 반영
        if (display.progress && pct > 0) {
          inner += '<div class="bar__fill" style="width:' + pct + '%;background:' + colors.dark + '"></div>';
        }

        // 우선순위 세로 띠 (high=진한 주황 두껍게 / low=연회색 얇게 / medium=없음) — 표시 토글 반영
        if (display.priority) {
          if (t.priority === 'high') inner += '<span class="bar__prio bar__prio--high"></span>';
          else if (t.priority === 'low') inner += '<span class="bar__prio bar__prio--low"></span>';
        }

        // 이름 라벨: 바가 좁으면 바 오른쪽 바깥에 표시
        var outside = bw < 60;
        if (outside) {
          bar.classList.add('bar--narrow'); // 바깥 라벨이 잘리지 않도록
          inner += '<span class="bar__label--outside">' + escapeHtml(t.name) + '</span>';
        } else {
          inner += '<span class="bar__label">' + escapeHtml(t.name) + '</span>';
        }

        // 진행률 텍스트 "NN%" — 표시 토글 반영, 공간이 좁으면(넓지 않으면) 생략
        if (display.progress && bw >= 46) {
          inner += '<span class="bar__pct">' + pct + '%</span>';
        }

        // 양끝 리사이즈 핸들 (6단계 2/3) — 왼쪽=시작일, 오른쪽=종료일 조절.
        // 너무 좁은 바(18px 미만)는 핸들 생략(이동만 허용). 마일스톤에는 애초에 없음.
        if (bw >= 18) {
          inner += '<span class="bar__handle bar__handle--left" data-edge="left"></span>' +
                   '<span class="bar__handle bar__handle--right" data-edge="right"></span>';
        }

        bar.innerHTML = inner;
        frag.appendChild(bar);
        // 의존선 앵커: 바 좌/우 끝과 세로 중심
        geom[t.id] = { leftX: bx, rightX: bx + bw, cy: y + ROW_H / 2 };
      }
    });

    body.appendChild(frag);

    // 3.5) 의존성(FS) 화살표 레이어 (표시 토글 반영)
    if (display.deps) {
      renderDependencies(body, rows, geom, totalWidth, bodyHeight, depUid);
    }

    // 4) 오늘 기준선 (범위 안에 있을 때만)
    if (TODAY >= range.start && TODAY <= range.end) {
      var tx = xOf(TODAY, range, pxPerDay) + pxPerDay / 2;
      var line = document.createElement('div');
      line.className = 'today-line';
      line.style.left = tx + 'px';
      line.style.height = bodyHeight + 'px';
      body.appendChild(line);
    }
  }

  // ── 의존성(FS) 화살표 레이어 (7단계) ──
  // 각 태스크의 dependencies(선행 id 목록)마다 선행 바의 오른쪽 끝 → 후행 바의
  // 왼쪽 시작으로 직각 꺾임 화살표를 그린다. SVG 는 바 뒤(맨 아래)에 깔고
  // pointer-events:none 이라 바 드래그/클릭을 방해하지 않는다.
  // depUid: 마커/레이어 id 접미사. 화면 렌더는 ''(기존 id 유지 — drag.js 가
  // #dep-layer 를 참조), 오프스크린 렌더는 '-off' 로 id 중복을 방지한다.
  function renderDependencies(body, rows, geom, totalWidth, bodyHeight, depUid) {
    var uid = depUid || '';
    // 태스크 id -> 태스크 (선행 상태 확인용)
    var byId = {};
    rows.forEach(function (row) {
      if (row.type === 'task') byId[row.task.id] = row.task;
    });

    var paths = [];
    rows.forEach(function (row) {
      if (row.type !== 'task') return;
      var succ = row.task;                                   // 후행(의존하는 쪽)
      var deps = Array.isArray(succ.dependencies) ? succ.dependencies : [];
      var sGeom = geom[succ.id];
      if (!sGeom) return;
      deps.forEach(function (predId) {
        var pGeom = geom[predId];
        var pred = byId[predId];
        if (!pGeom || !pred) return; // 선행이 화면에 없으면(삭제 등) 건너뜀
        // 선행 오른쪽 끝 → 후행 왼쪽 시작
        var d = buildDependencyPath(pGeom.rightX, pGeom.cy, sGeom.leftX, sGeom.cy);
        // 지연 강조(단순): 후행이 지연 경고 대상이거나 선행이 delayed 이면 빨강
        var warn = (display.delay && isOverdue(succ)) || pred.status === 'delayed';
        var cls = 'dep-line' + (warn ? ' dep-line--warn' : '');
        var marker = warn ? 'url(#dep-arrow-warn' + uid + ')' : 'url(#dep-arrow' + uid + ')';
        paths.push('<path class="' + cls + '" d="' + d + '" marker-end="' + marker + '" fill="none"/>');
      });
    });

    if (paths.length === 0) return; // 그릴 의존선이 없으면 레이어 자체를 생략

    // 화면 렌더(uid='')만 id="dep-layer" 유지 (drag.js 참조) — 오프스크린은 class 만
    var layerId = uid === '' ? ' id="dep-layer"' : '';
    var markup =
      '<svg' + layerId + ' class="dep-layer" width="' + totalWidth + '" height="' + bodyHeight +
        '" viewBox="0 0 ' + totalWidth + ' ' + bodyHeight + '" xmlns="http://www.w3.org/2000/svg">' +
        '<defs>' +
          arrowMarker('dep-arrow' + uid, '#94a3b8') +
          arrowMarker('dep-arrow-warn' + uid, '#ef4444') +
        '</defs>' +
        paths.join('') +
      '</svg>';

    var parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    var svg = parsed.documentElement;
    if (svg && svg.nodeName.toLowerCase() === 'svg') {
      // 첫 자식으로 삽입 → 격자·바보다 아래에 깔려 바 가장자리에 자연스럽게 물림
      body.insertBefore(document.importNode(svg, true), body.firstChild);
    }
  }

  // 화살촉 marker 정의 (userSpaceOnUse: stroke 굵기와 무관하게 크기 고정)
  function arrowMarker(id, color) {
    return '<marker id="' + id + '" markerWidth="8" markerHeight="8" refX="7" refY="3" ' +
           'orient="auto" markerUnits="userSpaceOnUse">' +
           '<path d="M0,0 L7,3 L0,6 z" fill="' + color + '"/>' +
           '</marker>';
  }

  // ─────────────────────────────────────────────────────────
  // 오프스크린 전체 렌더 (PNG 등 내보내기용, 10단계 확장)
  // ─────────────────────────────────────────────────────────
  /**
   * 주어진 데이터 서브셋으로 화면 밖에 .gantt 구조 전체를 "스크롤 없이 전체 크기"로
   * 그려 붙인다. 화면 렌더와 동일한 renderLeft/renderHead/renderBody 를 재사용하므로
   * 상태색·마일스톤·의존선·오늘선(범위 내일 때)·표시 토글이 화면과 동일하게 반영된다.
   * - 현재 state.scale / zoomIndex / display 설정 사용, 범위는 전달된 tasks 로 재계산.
   * - id 속성은 부여하지 않고 class 만 사용한다 (화면 요소와 id 중복 방지.
   *   의존선 마커 id 만 '-off' 접미사로 분리).
   * - 사용 후 반환된 root 를 호출측이 직접 제거해야 한다.
   * @returns {{root:Element, leftWidth:number, timelineWidth:number,
   *            headHeight:number, bodyHeight:number}}
   */
  function buildChartDom(projects, tasks) {
    var pxPerDay = PX_PER_DAY[state.scale] * ZOOM_STEPS[state.zoomIndex];
    var range = computeRangeForTasks(tasks, state.scale, TODAY);
    var totalDays = diffDays(range.start, range.end) + 1;
    var totalWidth = totalDays * pxPerDay;
    var rows = buildRows(projects, tasks);
    var bodyHeight = rows.length * ROW_H;
    var cols = buildColumns(state.scale, range);

    // 구조 생성 (class 만 부여 — CSS 는 화면과 동일하게 적용됨)
    var root = document.createElement('div');
    root.className = 'gantt';
    root.style.position = 'absolute';
    root.style.left = '-99999px';
    root.style.top = '0';
    root.style.overflow = 'visible';

    var left = document.createElement('div');
    left.className = 'gantt__left';
    var leftHead = document.createElement('div');
    leftHead.className = 'gantt__left-head';
    leftHead.textContent = '태스크';
    var leftBody = document.createElement('div');
    leftBody.className = 'gantt__left-body';
    leftBody.style.overflow = 'visible';     // 세로 스크롤 없이 전체 높이
    leftBody.style.height = bodyHeight + 'px';
    left.appendChild(leftHead);
    left.appendChild(leftBody);

    var right = document.createElement('div');
    right.className = 'gantt__right';
    right.style.overflow = 'visible';        // 가로 스크롤 없이 전체 폭
    right.style.flex = '0 0 ' + totalWidth + 'px';
    right.style.width = totalWidth + 'px';
    var tHead = document.createElement('div');
    tHead.className = 'timeline__head';
    tHead.style.position = 'relative';       // sticky 해제 (스크롤 없는 렌더)
    var tBody = document.createElement('div');
    tBody.className = 'timeline__body';
    right.appendChild(tHead);
    right.appendChild(tBody);

    root.appendChild(left);
    root.appendChild(right);
    document.body.appendChild(root);

    // 화면 렌더와 동일한 함수로 내용 채움 (dep 마커 id 는 '-off' 접미사)
    renderLeft(rows, leftBody);
    renderHead(cols, totalWidth, pxPerDay, tHead);
    renderBody(rows, cols, range, pxPerDay, totalWidth, bodyHeight, tBody, '-off');

    // 실측 후 전체 크기 확정 (좌측 폭은 CSS --left-w 로 화면과 동일)
    var leftWidth = left.offsetWidth;
    var headHeight = tHead.offsetHeight;
    root.style.width = (leftWidth + totalWidth) + 'px';
    root.style.height = (headHeight + bodyHeight) + 'px';

    return {
      root: root,
      leftWidth: leftWidth,
      timelineWidth: totalWidth,
      headHeight: headHeight,
      bodyHeight: bodyHeight,
    };
  }

  // ── 좌우 세로 스크롤 동기화 ──
  var scrollBound = false;
  function setupScrollSync() {
    if (scrollBound) return;  // 한 번만 바인딩
    scrollBound = true;
    var right = document.getElementById('gantt-right');
    var leftBody = document.getElementById('gantt-left-body');
    right.addEventListener('scroll', function () {
      leftBody.scrollTop = right.scrollTop; // 우측 세로 스크롤 -> 좌측 반영
    });
  }

  // ── HTML 이스케이프 (XSS 방지) ──
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─────────────────────────────────────────────────────────
  // 초기화
  // ─────────────────────────────────────────────────────────
  // ── 줌 UI 갱신: 배율 라벨 + 한계에서 버튼 비활성 (8단계) ──
  function updateZoomUi() {
    var label = document.getElementById('zoom-label');
    var btnIn = document.getElementById('btn-zoom-in');
    var btnOut = document.getElementById('btn-zoom-out');
    if (label) label.textContent = Math.round(ZOOM_STEPS[state.zoomIndex] * 100) + '%';
    if (btnIn) btnIn.disabled = (state.zoomIndex >= ZOOM_STEPS.length - 1);
    if (btnOut) btnOut.disabled = (state.zoomIndex <= 0);
  }

  // ── 줌 적용: 한 단계 이동 + 앵커 지점의 날짜가 화면에서 유지되도록 스크롤 보정 ──
  // anchorViewX: 뷰포트 내 앵커 x (생략 시 화면 중앙). Ctrl+휠은 커서 위치를 넘긴다.
  function applyZoom(dir, anchorViewX) {
    var next = nextZoomIndex(state.zoomIndex, dir);
    if (next === state.zoomIndex) return; // 한계 — 변화 없음

    var right = document.getElementById('gantt-right');
    var oldPx = lastRender.pxPerDay;
    var oldScroll = right ? right.scrollLeft : 0;
    if (anchorViewX == null) anchorViewX = right ? right.clientWidth / 2 : 0; // 중앙 앵커

    state.zoomIndex = next;
    saveZoomIndex(next);
    render(); // 새 pxPerDay 로 전체 재렌더 (lastRender.pxPerDay 갱신됨)

    // 앵커 날짜가 같은 화면 위치에 오도록 스크롤 보정
    if (right && oldPx > 0) {
      right.scrollLeft = computeAnchorScroll(oldScroll, anchorViewX, oldPx, lastRender.pxPerDay);
    }
  }

  // ── 오늘로 이동: 오늘 기준선을 뷰포트 중앙으로 스크롤 ──
  // computeRange 가 오늘을 항상 포함하므로 범위 밖 걱정 없이 이동 가능.
  function scrollToToday(smooth) {
    var right = document.getElementById('gantt-right');
    if (!right || !lastRender.range) return;
    // 오늘선 x = 오늘 열 시작 + 반 칸 (renderBody 의 today-line 과 동일 수식)
    var tx = xOf(TODAY, lastRender.range, lastRender.pxPerDay) + lastRender.pxPerDay / 2;
    var left = computeCenterScroll(tx, right.clientWidth);
    if (smooth && right.scrollTo) right.scrollTo({ left: left, behavior: 'smooth' });
    else right.scrollLeft = left;
  }

  function bindToolbar() {
    document.querySelectorAll('.scale-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        state.scale = btn.getAttribute('data-scale');
        render(); // 보기 전환 시에도 줌 배율은 유지된다 (공통 배율 1개)
      });
    });

    // 줌 −/+ 버튼 (중앙 앵커)
    var btnIn = document.getElementById('btn-zoom-in');
    var btnOut = document.getElementById('btn-zoom-out');
    if (btnIn) btnIn.addEventListener('click', function () { applyZoom(+1, null); });
    if (btnOut) btnOut.addEventListener('click', function () { applyZoom(-1, null); });

    // "오늘" 버튼 — 부드럽게 중앙 이동
    var btnToday = document.getElementById('btn-today');
    if (btnToday) btnToday.addEventListener('click', function () { scrollToToday(true); });

    // Ctrl + 휠 줌 (타임라인 위에서만, 커서 위치 앵커).
    // passive:false 로 등록해야 preventDefault(페이지 확대 방지)가 동작한다.
    var right = document.getElementById('gantt-right');
    if (right) {
      right.addEventListener('wheel', function (e) {
        if (!e.ctrlKey) return; // 일반 휠 스크롤은 그대로 둔다
        e.preventDefault();
        var anchorX = e.clientX - right.getBoundingClientRect().left;
        applyZoom(e.deltaY < 0 ? +1 : -1, anchorX);
      }, { passive: false });
    }

    bindDisplayMenu();
  }

  // "표시 ▾" 드롭다운: 열기/닫기 + 체크박스 토글 → 설정 저장·재렌더링
  function bindDisplayMenu() {
    var btn = document.getElementById('btn-display');
    var menu = document.getElementById('display-menu');
    if (!btn || !menu) return;

    // 체크박스 초기 상태를 저장된 설정으로 동기화
    menu.querySelectorAll('input[data-display]').forEach(function (cb) {
      var key = cb.getAttribute('data-display');
      cb.checked = !!display[key];
      cb.addEventListener('change', function () {
        display[key] = cb.checked;   // 설정 갱신
        saveDisplay();               // localStorage 저장
        render();                    // 즉시 반영
      });
    });

    // 버튼 클릭 → 메뉴 토글
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = menu.hidden;
      menu.hidden = !willOpen;
      btn.setAttribute('aria-expanded', String(willOpen));
    });

    // 바깥 클릭 → 메뉴 닫기
    document.addEventListener('click', function (e) {
      if (menu.hidden) return;
      if (e.target === btn || menu.contains(e.target)) return;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  async function init() {
    bindToolbar();
    await reload();
    // 최초 로드: 오늘이 바로 보이도록 즉시(부드럽지 않게) 중앙 배치
    scrollToToday(false);
  }

  // 서버에서 데이터를 다시 불러와 상태 갱신 후 재렌더링한다.
  // CRUD 저장/삭제 성공 후 crud.js 가 호출한다.
  async function reload() {
    try {
      var data = await loadData();  // crud.js 제공
      state.projects = data.projects;
      state.tasks = data.tasks;
    } catch (err) {
      state.projects = [];
      state.tasks = [];
      console.error(err);
    }
    render();
  }

  // CRUD UI(crud.js)·내보내기(export.js/png.js)가 사용할 공개 API
  // - reload(): 데이터 재로딩 + 재렌더링
  // - getState(): 현재 프로젝트/태스크의 얕은 복사본 + 현재 보기 단위(scale)·표시 토글(display)
  //   (scale/display 는 13단계 PPTX 도형 방식이 화면과 같은 눈금·요소로 다시 그리기 위해 필요)
  // - buildChartDom(projects, tasks): 오프스크린 전체 렌더 (PNG 등 내보내기용)
  window.GanttApp = {
    reload: reload,
    getState: function () {
      return {
        projects: state.projects.slice(),
        tasks: state.tasks.slice(),
        scale: state.scale,
        display: JSON.parse(JSON.stringify(display)),
      };
    },
    buildChartDom: buildChartDom,
  };

  document.addEventListener('DOMContentLoaded', init);
})();
