'use strict';

/* ================= state & storage ================= */

const STORE_KEY = 'studytracker:v1';
const PALETTE = ['#7c6cf0', '#34d399', '#f59e0b', '#f87171', '#38bdf8', '#e879f9', '#a3e635', '#fb923c'];

function defaultState() {
  return {
    settings: {
      focusMin: 25,
      shortBreakMin: 5,
      longBreakMin: 15,
      longBreakEvery: 4,
      dailyGoalMin: 120,
      sound: true,
      vibrate: true,
    },
    subjects: [
      { id: 's1', name: 'Maths', color: PALETTE[0] },
      { id: 's2', name: 'Science', color: PALETTE[1] },
      { id: 's3', name: 'English', color: PALETTE[2] },
    ],
    sessions: [],   // {id, date, ts, minutes, subjectId, kind:'focus'|'manual'}
    quizzes: [],    // {id, date, ts, subjectId, score, max, note}
    timer: null,    // persisted running timer, see timer engine
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      const d = defaultState();
      return {
        ...d,
        ...s,
        settings: { ...d.settings, ...(s.settings || {}) },
        subjects: Array.isArray(s.subjects) && s.subjects.length ? s.subjects : d.subjects,
        sessions: Array.isArray(s.sessions) ? s.sessions : [],
        quizzes: Array.isArray(s.quizzes) ? s.quizzes : [],
      };
    }
  } catch (e) { /* corrupted store -> start fresh */ }
  return defaultState();
}

function save() {
  state.timer = { ...timer };
  localStorage.setItem(STORE_KEY, JSON.stringify(state));
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ================= helpers ================= */

const $ = (sel) => document.querySelector(sel);

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function todayStr(d = new Date()) {
  return d.getFullYear() + '-' +
    String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');
}

function shiftDays(dateStr, delta) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + delta);
  return todayStr(d);
}

function dayInitial(dateStr) {
  return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][new Date(dateStr + 'T12:00:00').getDay()];
}

function niceDate(dateStr) {
  return new Date(dateStr + 'T12:00:00').toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short',
  });
}

function fmtMin(min) {
  min = Math.round(min);
  if (min < 60) return min + 'm';
  const h = Math.floor(min / 60), m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function subjectById(id) {
  return state.subjects.find((s) => s.id === id) || { id, name: 'Deleted subject', color: '#555c70' };
}

function minutesOn(dateStr) {
  return state.sessions.filter((s) => s.date === dateStr)
    .reduce((sum, s) => sum + s.minutes, 0);
}

function streak() {
  let n = 0;
  let d = todayStr();
  if (minutesOn(d) === 0) d = shiftDays(d, -1); // today not started yet doesn't break the streak
  while (minutesOn(d) > 0) { n++; d = shiftDays(d, -1); }
  return n;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ================= timer engine ================= */
/*
 * phase: 'focus' | 'short' | 'long'
 * status: 'idle' | 'running' | 'paused'
 * Running countdown is anchored to endsAt (wall clock), so it stays
 * correct when the tab is backgrounded or the phone screen is off.
 */

const timer = {
  phase: 'focus',
  status: 'idle',
  endsAt: 0,        // ms epoch, valid while running
  remainMs: 0,      // valid while paused
  plannedMin: 25,   // duration of current phase, captured at start
  cycle: 0,         // focus sessions completed since last long break
  subjectId: null,
};

let tickHandle = null;
let wakeLock = null;

function phaseMinutes(phase) {
  const s = state.settings;
  return phase === 'focus' ? s.focusMin : phase === 'short' ? s.shortBreakMin : s.longBreakMin;
}

function phaseLabel(phase) {
  return phase === 'focus' ? 'Focus' : phase === 'short' ? 'Short break' : 'Long break';
}

function timerRemainMs() {
  if (timer.status === 'running') return Math.max(0, timer.endsAt - Date.now());
  if (timer.status === 'paused') return timer.remainMs;
  return phaseMinutes(timer.phase) * 60000;
}

function restoreTimer() {
  const t = state.timer;
  if (!t) return;
  Object.assign(timer, {
    phase: t.phase || 'focus',
    status: t.status || 'idle',
    endsAt: t.endsAt || 0,
    remainMs: t.remainMs || 0,
    plannedMin: t.plannedMin || phaseMinutes(t.phase || 'focus'),
    cycle: t.cycle || 0,
    subjectId: t.subjectId || null,
  });
  if (timer.status === 'running') {
    if (Date.now() >= timer.endsAt) {
      completePhase(true); // finished while the app was closed
    } else {
      startTicking();
      acquireWakeLock();
    }
  }
}

function timerStart() {
  if (timer.status === 'running') return;
  if (timer.status === 'idle') {
    timer.plannedMin = phaseMinutes(timer.phase);
    timer.remainMs = timer.plannedMin * 60000;
    timer.subjectId = $('#timer-subject-sel').value || state.subjects[0]?.id || null;
  }
  timer.endsAt = Date.now() + timer.remainMs;
  timer.status = 'running';
  startTicking();
  acquireWakeLock();
  requestNotifyPermission();
  save();
  renderTimer();
}

function timerPause() {
  if (timer.status !== 'running') return;
  timer.remainMs = timerRemainMs();
  timer.status = 'paused';
  stopTicking();
  releaseWakeLock();
  save();
  renderTimer();
}

function timerReset() {
  timer.status = 'idle';
  stopTicking();
  releaseWakeLock();
  save();
  renderTimer();
}

function timerSkip() {
  advancePhase(false);
}

function selectPhase(phase) {
  if (timer.status !== 'idle') {
    toast('Reset the timer to switch phase');
    return;
  }
  timer.phase = phase;
  save();
  renderTimer();
}

function completePhase(silent = false) {
  const finished = timer.phase;
  if (finished === 'focus') {
    state.sessions.push({
      id: uid(),
      date: todayStr(),
      ts: Date.now(),
      minutes: timer.plannedMin,
      subjectId: timer.subjectId || state.subjects[0]?.id || null,
      kind: 'focus',
    });
    timer.cycle += 1;
  }
  if (!silent) {
    playBeep();
    notify(
      finished === 'focus' ? 'Focus session done! 🍅' : 'Break over!',
      finished === 'focus' ? 'Nice work — time for a break.' : 'Ready for the next focus session?'
    );
  }
  advancePhase(finished === 'focus'); // auto-start the break after focus
}

function advancePhase(autoStart) {
  stopTicking();
  if (timer.phase === 'focus') {
    timer.phase = (timer.cycle > 0 && timer.cycle % state.settings.longBreakEvery === 0) ? 'long' : 'short';
  } else {
    if (timer.phase === 'long') timer.cycle = 0;
    timer.phase = 'focus';
    autoStart = false; // focus always starts manually
  }
  timer.status = 'idle';
  if (autoStart) {
    timer.plannedMin = phaseMinutes(timer.phase);
    timer.remainMs = timer.plannedMin * 60000;
    timer.endsAt = Date.now() + timer.remainMs;
    timer.status = 'running';
    startTicking();
  } else {
    releaseWakeLock();
  }
  save();
  renderTimer();
  renderHome();
}

function startTicking() {
  stopTicking();
  tickHandle = setInterval(tick, 500);
  tick();
}

function stopTicking() {
  if (tickHandle) { clearInterval(tickHandle); tickHandle = null; }
}

function tick() {
  if (timer.status === 'running' && Date.now() >= timer.endsAt) {
    completePhase(false);
    return;
  }
  updateTimerDisplay();
}

/* ---------- wake lock / notifications / sound ---------- */

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) { /* not critical */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (timer.status === 'running') { acquireWakeLock(); tick(); }
    renderActiveTab();
  }
});

function requestNotifyPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }
}

function notify(title, body) {
  if (state.settings.vibrate && navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (navigator.serviceWorker) {
    navigator.serviceWorker.getRegistration().then((reg) => {
      if (reg) reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png' });
      else new Notification(title, { body, icon: 'icons/icon-192.png' });
    }).catch(() => {});
  } else {
    try { new Notification(title, { body }); } catch (e) {}
  }
}

function playBeep() {
  if (!state.settings.sound) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    [0, 0.25, 0.5].forEach((t, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = i === 2 ? 1047 : 784; // G5 G5 C6
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.2);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.22);
    });
    setTimeout(() => ctx.close().catch(() => {}), 1200);
  } catch (e) { /* audio unavailable */ }
}

/* ================= rendering ================= */

let activeTab = 'home';

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tab').forEach((el) => el.classList.toggle('active', el.id === 'tab-' + tab));
  document.querySelectorAll('.nav-btn').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  renderActiveTab();
  window.scrollTo(0, 0);
}

function renderActiveTab() {
  ({ home: renderHome, timer: renderTimer, quiz: renderQuiz, stats: renderStats, settings: renderSettings })[activeTab]();
}

function subjectOptions(selectedId) {
  return state.subjects.map((s) =>
    `<option value="${s.id}" ${s.id === selectedId ? 'selected' : ''}>${esc(s.name)}</option>`
  ).join('');
}

/* ---------- home ---------- */

function renderHome() {
  const today = todayStr();
  const mins = minutesOn(today);
  const goal = state.settings.dailyGoalMin;
  const pct = Math.min(1, mins / goal);

  const hour = new Date().getHours();
  $('#greeting').textContent = hour < 5 ? 'Late night grind 🌙' : hour < 12 ? 'Good morning ☀️' : hour < 17 ? 'Good afternoon 📚' : 'Good evening 🌆';
  $('#home-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

  const C = 2 * Math.PI * 86;
  const ring = $('#goal-ring-fg');
  ring.style.strokeDasharray = C;
  ring.style.strokeDashoffset = C * (1 - pct);
  ring.style.stroke = pct >= 1 ? 'var(--green)' : 'var(--accent)';
  $('#goal-minutes').textContent = fmtMin(mins);
  $('#goal-target').textContent = pct >= 1 ? 'goal reached! 🎉' : `of ${fmtMin(goal)} goal`;
  $('.goal-center').classList.toggle('done', pct >= 1);

  $('#chip-streak').textContent = streak();
  $('#chip-pomos').textContent = state.sessions.filter((s) => s.date === today && s.kind === 'focus').length;

  const weekAgo = shiftDays(today, -6);
  const recentQ = state.quizzes.filter((q) => q.date >= weekAgo);
  $('#chip-quiz').textContent = recentQ.length
    ? Math.round(recentQ.reduce((a, q) => a + (q.score / q.max) * 100, 0) / recentQ.length) + '%'
    : '–';

  const todays = state.sessions.filter((s) => s.date === today).sort((a, b) => b.ts - a.ts);
  $('#today-sessions').innerHTML = todays.length
    ? todays.map((s) => {
        const sub = subjectById(s.subjectId);
        return `<div class="list-item">
          <span class="dot" style="background:${sub.color}"></span>
          <div class="li-main">
            <div class="li-title">${esc(sub.name)}</div>
            <div class="li-sub">${s.kind === 'focus' ? '🍅 Pomodoro' : '✍️ Logged manually'} · ${new Date(s.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</div>
          </div>
          <span class="li-val">${fmtMin(s.minutes)}</span>
          <button class="icon-btn" data-action="session-del" data-id="${s.id}" aria-label="Delete">✕</button>
        </div>`;
      }).join('')
    : '<div class="empty">Nothing yet — start a focus session! 🚀</div>';
}

/* ---------- timer ---------- */

function renderTimer() {
  document.querySelectorAll('#phase-pills .pill').forEach((p) =>
    p.classList.toggle('active', p.dataset.phase === timer.phase));

  const sel = $('#timer-subject-sel');
  sel.innerHTML = subjectOptions(timer.subjectId || state.subjects[0]?.id);
  sel.disabled = timer.status !== 'idle' && timer.phase === 'focus';

  const every = state.settings.longBreakEvery;
  // dots filled since the last long break; show all filled while the long break is due
  const done = timer.cycle > 0 && timer.cycle % every === 0 ? every : timer.cycle % every;
  $('#cycle-dots').innerHTML = Array.from({ length: every }, (_, i) =>
    `<span class="cdot ${i < done ? 'done' : ''}"></span>`
  ).join('');

  const btn = $('#timer-main-btn');
  btn.textContent = timer.status === 'running' ? 'Pause' : timer.status === 'paused' ? 'Resume' : 'Start';

  $('#timer-ring-fg').classList.toggle('break', timer.phase !== 'focus');
  $('#timer-phase-label').textContent = phaseLabel(timer.phase);
  updateTimerDisplay();
}

function updateTimerDisplay() {
  const remain = timerRemainMs();
  const totalMs = (timer.status === 'idle' ? phaseMinutes(timer.phase) : timer.plannedMin) * 60000;
  const m = Math.floor(remain / 60000);
  const s = Math.floor((remain % 60000) / 1000);
  $('#timer-time').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;

  const C = 2 * Math.PI * 106;
  const fg = $('#timer-ring-fg');
  fg.style.strokeDasharray = C;
  fg.style.strokeDashoffset = C * (1 - (totalMs ? remain / totalMs : 0));

  document.title = timer.status === 'running'
    ? `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')} · ${phaseLabel(timer.phase)}`
    : 'Study Tracker';
}

/* ---------- quiz ---------- */

function renderQuiz() {
  if (!$('#quiz-date').value) $('#quiz-date').value = todayStr();
  $('#quiz-subject').innerHTML = subjectOptions($('#quiz-subject').value);

  const filterSel = $('#quiz-filter');
  const prevFilter = filterSel.value || 'all';
  filterSel.innerHTML = `<option value="all">All subjects</option>` + subjectOptions();
  filterSel.value = [...filterSel.options].some((o) => o.value === prevFilter) ? prevFilter : 'all';

  const all = [...state.quizzes].sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts);
  const filtered = filterSel.value === 'all' ? all : all.filter((q) => q.subjectId === filterSel.value);

  // summary chips
  const last7 = all.filter((q) => q.date >= shiftDays(todayStr(), -6));
  const avg = (list) => list.length ? Math.round(list.reduce((a, q) => a + (q.score / q.max) * 100, 0) / list.length) : null;
  $('#quiz-summary').innerHTML = `
    <div class="chip"><span class="chip-emoji">📊</span><span class="chip-val">${avg(all) ?? '–'}${avg(all) !== null ? '%' : ''}</span><span class="chip-label">overall avg</span></div>
    <div class="chip"><span class="chip-emoji">📅</span><span class="chip-val">${avg(last7) ?? '–'}${avg(last7) !== null ? '%' : ''}</span><span class="chip-label">last 7 days</span></div>
    <div class="chip"><span class="chip-emoji">🧮</span><span class="chip-val">${all.length}</span><span class="chip-label">quizzes</span></div>`;

  $('#quiz-chart').innerHTML = quizTrendSvg(filtered.slice(-15));

  const recent = [...filtered].reverse().slice(0, 30);
  $('#quiz-list').innerHTML = recent.length
    ? recent.map((q) => {
        const sub = subjectById(q.subjectId);
        const pct = Math.round((q.score / q.max) * 100);
        const cls = pct >= 75 ? 'good' : pct >= 50 ? 'mid' : 'bad';
        return `<div class="list-item">
          <span class="dot" style="background:${sub.color}"></span>
          <div class="li-main">
            <div class="li-title">${esc(sub.name)}${q.note ? ' · ' + esc(q.note) : ''}</div>
            <div class="li-sub">${niceDate(q.date)} · ${q.score}/${q.max}</div>
          </div>
          <span class="li-val ${cls}">${pct}%</span>
          <button class="icon-btn" data-action="quiz-del" data-id="${q.id}" aria-label="Delete">✕</button>
        </div>`;
      }).join('')
    : '<div class="empty">No quiz results yet — add your first one above 📝</div>';
}

function quizTrendSvg(quizzes) {
  if (quizzes.length < 2) {
    return '<div class="empty">Add at least two results to see the trend</div>';
  }
  const W = 320, H = 130, padL = 28, padR = 10, padT = 10, padB = 18;
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i) => padL + (quizzes.length === 1 ? iw / 2 : (i / (quizzes.length - 1)) * iw);
  const y = (pct) => padT + ih * (1 - pct / 100);
  const pts = quizzes.map((q, i) => [x(i), y((q.score / q.max) * 100)]);
  const poly = pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ');
  const grid = [0, 50, 100].map((g) =>
    `<line class="grid-line" x1="${padL}" y1="${y(g)}" x2="${W - padR}" y2="${y(g)}"></line>
     <text class="axis-label" x="${padL - 5}" y="${y(g) + 3}" text-anchor="end">${g}</text>`
  ).join('');
  const dots = pts.map((p) => `<circle class="trend-dot" cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.4"></circle>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">${grid}<polyline class="trend-line" points="${poly}"></polyline>${dots}</svg>`;
}

function addQuiz(ev) {
  ev.preventDefault();
  const date = $('#quiz-date').value;
  const subjectId = $('#quiz-subject').value;
  const score = parseFloat($('#quiz-score').value);
  const max = parseFloat($('#quiz-max').value);
  const note = $('#quiz-note').value.trim();
  if (!date || !subjectId || isNaN(score) || isNaN(max) || max <= 0) { toast('Fill in all fields'); return; }
  if (score > max) { toast('Score can’t be higher than "out of"'); return; }
  state.quizzes.push({ id: uid(), date, ts: Date.now(), subjectId, score, max, note });
  save();
  $('#quiz-score').value = '';
  $('#quiz-max').value = '';
  $('#quiz-note').value = '';
  toast(`Saved · ${Math.round((score / max) * 100)}% 🎯`);
  renderQuiz();
}

/* ---------- stats ---------- */

function renderStats() {
  const today = todayStr();
  const days = Array.from({ length: 7 }, (_, i) => shiftDays(today, i - 6));
  const perDay = days.map((d) => minutesOn(d));
  const weekTotal = perDay.reduce((a, b) => a + b, 0);
  const allTotal = state.sessions.reduce((a, s) => a + s.minutes, 0);
  const best = state.sessions.reduce((acc, s) => {
    acc[s.date] = (acc[s.date] || 0) + s.minutes; return acc;
  }, {});
  const bestDay = Object.entries(best).sort((a, b) => b[1] - a[1])[0];

  $('#stats-chips').innerHTML = `
    <div class="chip"><span class="chip-emoji">⏱️</span><span class="chip-val">${fmtMin(weekTotal)}</span><span class="chip-label">this week</span></div>
    <div class="chip"><span class="chip-emoji">📚</span><span class="chip-val">${fmtMin(allTotal)}</span><span class="chip-label">all time</span></div>
    <div class="chip"><span class="chip-emoji">🏆</span><span class="chip-val">${bestDay ? fmtMin(bestDay[1]) : '–'}</span><span class="chip-label">best day</span></div>`;

  $('#week-chart').innerHTML = weekBarsSvg(days, perDay);

  // per-subject minutes over last 7 days
  const weekAgo = days[0];
  const bySubject = {};
  state.sessions.filter((s) => s.date >= weekAgo).forEach((s) => {
    bySubject[s.subjectId] = (bySubject[s.subjectId] || 0) + s.minutes;
  });
  const rows = Object.entries(bySubject).sort((a, b) => b[1] - a[1]);
  const maxMin = rows.length ? rows[0][1] : 1;
  $('#subject-breakdown').innerHTML = rows.length
    ? rows.map(([id, min]) => {
        const sub = subjectById(id);
        return `<div class="hbar-row">
          <span class="hbar-name">${esc(sub.name)}</span>
          <div class="hbar-track"><div class="hbar-fill" style="width:${Math.max(3, (min / maxMin) * 100)}%;background:${sub.color}"></div></div>
          <span class="hbar-val">${fmtMin(min)}</span>
        </div>`;
      }).join('')
    : '<div class="empty">No study time recorded this week yet</div>';
}

function weekBarsSvg(days, perDay) {
  const W = 320, H = 150, padB = 20, padT = 14;
  const goal = state.settings.dailyGoalMin;
  const maxV = Math.max(goal, ...perDay, 30);
  const bw = 28, gap = (W - 7 * bw) / 8;
  const ih = H - padB - padT;
  const today = todayStr();
  const goalY = padT + ih * (1 - goal / maxV);
  const bars = days.map((d, i) => {
    const v = perDay[i];
    const h = Math.max(v > 0 ? 4 : 0, (v / maxV) * ih);
    const x = gap + i * (bw + gap);
    const y = padT + ih - h;
    return `<rect class="bar ${d === today ? 'today' : ''}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw}" height="${h.toFixed(1)}" rx="5"></rect>
      ${v > 0 ? `<text class="bar-label" x="${(x + bw / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${v >= 60 ? (v / 60).toFixed(1).replace('.0', '') + 'h' : v + 'm'}</text>` : ''}
      <text class="bar-label" x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${dayInitial(d)}</text>`;
  }).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">
    <line class="goal-line" x1="0" y1="${goalY.toFixed(1)}" x2="${W}" y2="${goalY.toFixed(1)}"></line>
    ${bars}</svg>`;
}

/* ---------- settings ---------- */

function renderSettings() {
  const s = state.settings;
  $('#set-focus').value = s.focusMin;
  $('#set-short').value = s.shortBreakMin;
  $('#set-long').value = s.longBreakMin;
  $('#set-every').value = s.longBreakEvery;
  $('#set-goal').value = s.dailyGoalMin;
  $('#set-sound').checked = s.sound;
  $('#set-vibrate').checked = s.vibrate;

  $('#subject-list').innerHTML = state.subjects.map((sub) =>
    `<div class="list-item">
      <span class="dot" style="background:${sub.color}"></span>
      <div class="li-main"><div class="li-title">${esc(sub.name)}</div></div>
      <button class="icon-btn" data-action="subject-del" data-id="${sub.id}" aria-label="Delete">✕</button>
    </div>`
  ).join('');
}

function changeSetting(input) {
  const key = input.dataset.setting;
  if (input.type === 'checkbox') {
    state.settings[key] = input.checked;
  } else {
    let v = parseInt(input.value, 10);
    if (isNaN(v)) return;
    v = Math.max(parseInt(input.min, 10), Math.min(parseInt(input.max, 10), v));
    input.value = v;
    state.settings[key] = v;
  }
  save();
  if (timer.status === 'idle') updateTimerDisplay();
}

function addSubject() {
  const input = $('#new-subject');
  const name = input.value.trim();
  if (!name) return;
  if (state.subjects.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
    toast('That subject already exists');
    return;
  }
  const color = PALETTE[state.subjects.length % PALETTE.length];
  state.subjects.push({ id: uid(), name, color });
  input.value = '';
  save();
  renderSettings();
  toast(`Added "${name}"`);
}

function deleteSubject(id) {
  if (state.subjects.length === 1) { toast('Keep at least one subject'); return; }
  const sub = subjectById(id);
  if (!confirm(`Delete "${sub.name}"? Past entries are kept.`)) return;
  state.subjects = state.subjects.filter((s) => s.id !== id);
  if (timer.subjectId === id) timer.subjectId = state.subjects[0].id;
  save();
  renderSettings();
}

/* ---------- backup / restore ---------- */

function exportData() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `studytracker-backup-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Backup downloaded 📦');
}

function importData(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data.sessions) || !Array.isArray(data.subjects)) throw new Error('bad format');
      if (!confirm('Replace ALL current data with this backup?')) return;
      localStorage.setItem(STORE_KEY, JSON.stringify(data));
      state = loadState();
      restoreTimer();
      renderActiveTab();
      toast('Backup restored ✅');
    } catch (e) {
      toast('That file isn’t a valid backup');
    }
  };
  reader.readAsText(file);
}

function resetAll() {
  if (!confirm('Erase ALL data? This cannot be undone.')) return;
  if (!confirm('Really sure? Last chance!')) return;
  localStorage.removeItem(STORE_KEY);
  state = defaultState();
  Object.assign(timer, { phase: 'focus', status: 'idle', cycle: 0, subjectId: null });
  stopTicking();
  save();
  renderActiveTab();
  toast('Fresh start 🌱');
}

/* ================= events ================= */

document.addEventListener('click', (ev) => {
  const el = ev.target.closest('[data-action]');
  if (!el) return;
  const a = el.dataset.action;
  if (a === 'nav') switchTab(el.dataset.tab);
  else if (a === 'timer-toggle') (timer.status === 'running' ? timerPause : timerStart)();
  else if (a === 'timer-reset') timerReset();
  else if (a === 'timer-skip') timerSkip();
  else if (a === 'phase-select') selectPhase(el.dataset.phase);
  else if (a === 'start-focus') {
    switchTab('timer');
    if (timer.status === 'idle' && timer.phase !== 'focus') timer.phase = 'focus';
    if (timer.status === 'idle') timerStart();
  }
  else if (a === 'open-log') {
    $('#log-subject').innerHTML = subjectOptions(state.subjects[0]?.id);
    $('#log-minutes').value = '';
    $('#modal-log').hidden = false;
  }
  else if (a === 'close-modal') $('#modal-log').hidden = true;
  else if (a === 'save-log') {
    const mins = parseInt($('#log-minutes').value, 10);
    if (!mins || mins < 1) { toast('Enter the minutes you studied'); return; }
    state.sessions.push({
      id: uid(), date: todayStr(), ts: Date.now(),
      minutes: Math.min(600, mins),
      subjectId: $('#log-subject').value, kind: 'manual',
    });
    save();
    $('#modal-log').hidden = true;
    renderHome();
    toast(`Logged ${fmtMin(mins)} 💪`);
  }
  else if (a === 'session-del') {
    state.sessions = state.sessions.filter((s) => s.id !== el.dataset.id);
    save();
    renderHome();
  }
  else if (a === 'quiz-del') {
    if (!confirm('Delete this quiz result?')) return;
    state.quizzes = state.quizzes.filter((q) => q.id !== el.dataset.id);
    save();
    renderQuiz();
  }
  else if (a === 'subject-add') addSubject();
  else if (a === 'subject-del') deleteSubject(el.dataset.id);
  else if (a === 'export') exportData();
  else if (a === 'import') $('#import-file').click();
  else if (a === 'reset-all') resetAll();
});

document.addEventListener('change', (ev) => {
  if (ev.target.dataset.setting) changeSetting(ev.target);
  else if (ev.target.id === 'quiz-filter') renderQuiz();
  else if (ev.target.id === 'timer-subject-sel') { timer.subjectId = ev.target.value; save(); }
  else if (ev.target.id === 'import-file' && ev.target.files[0]) {
    importData(ev.target.files[0]);
    ev.target.value = '';
  }
});

$('#quiz-form').addEventListener('submit', addQuiz);

$('#modal-log').addEventListener('click', (ev) => {
  if (ev.target.id === 'modal-log') $('#modal-log').hidden = true;
});

$('#new-subject').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); addSubject(); }
});

/* ================= boot ================= */

restoreTimer();
switchTab('home');

// console access for debugging / power use
window.app = {
  get state() { return state; },
  timer, save, renderActiveTab, todayStr, shiftDays, uid, streak, tick,
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
