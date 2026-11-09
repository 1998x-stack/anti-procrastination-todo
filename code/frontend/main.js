import {
  emptyState, BLOCKERS, OUTCOMES, createTask, importTasks, parseBulk,
  focusTask, setBlocker, confirmStep, startSession, pauseSession,
  resumeSession, checkpointSession, interruptSession, endSession,
  recordOutcome, archiveTask, editTask, undoImport
} from "../domain/core.js";
import { proposeStep, proposeRetry } from "../algorithm/suggest.js";
import { IndexedStateStore, createExport } from "../persistence/store.js";

const root = document.querySelector("#app");
const settingsShortcut = document.querySelector("#settings-shortcut");
const repo = new IndexedStateStore();

let state = emptyState();
let screen = "inbox";
let notice = "";
let isError = false;
let storageReady = false;
let captureDraft = "";
let stepDraft = "";
let stepDirty = false;
let currentSuggestion = null;
let suggestionIndex = 0;
let chosenMinutes = 5;
let bulkDraft = "";
let bulkPreview = null;
let editingTaskId = null;
let editDraft = "";
let editingUpdatedAt = null;
let timerAnchor = null;
let checkpointPromise = null;
let timerVisible = true;

const labels = {
  too_big: "事情太大",
  unclear: "不知道第一步",
  perfectionism: "担心做错",
  low_energy: "没精力",
  distraction: "容易分心",
  skipped: "暂时说不清，跳过"
};
const outcomes = {
  step_done: "第一小步完成了",
  partial: "做了一部分",
  not_started: "还是没能开始",
  task_done: "整件任务已经完成"
};

const blockerDetails = {
  too_big: "范围太广，先切一小块",
  unclear: "不知道要先做什么",
  perfectionism: "想一次做好，迟迟不动笔",
  low_energy: "今天只有一点精力",
  distraction: "总被其他事情拉走",
  skipped: "直接使用通用建议"
};
const outcomeDetails = {
  step_done: "这一步已经完成，不代表整件事完成",
  partial: "有一点进展，就值得留下",
  not_started: "没有关系，下次可以再缩小一些",
  task_done: "只有你确认，才会结束这件事"
};
const THEME_KEY = "start-first:visual-theme";
function preferredTheme() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    if (value === "light" || value === "dark") return value;
  } catch { /* Browser preference storage is optional. */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
let currentTheme = preferredTheme();
function setTheme(theme) {
  currentTheme = theme;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem(THEME_KEY, theme); } catch { /* Preference-only state. */ }
}
setTheme(currentTheme);
function flowSteps(stage) {
  const labels = ["找到卡点", "确定小步", "开始行动", "温和回顾"];
  return '<nav aria-label="任务启动进度"><ol class="flow-steps">' +
    labels.map((label, index) => '<li class="' + (index < stage ? "done" : index === stage ? "active" : "") +
      '"' + (index === stage ? ' aria-current="step"' : "") + '><span class="step-no">0' +
      (index + 1) + '</span>' + label + '</li>').join("") + '</ol></nav>';
}


function uuid() {
  // crypto.randomUUID() requires a secure context (https or localhost). A plain
  // HTTP origin on a real hostname does not have it, and calling it there threw
  // an unhandled TypeError that made task creation fail silently.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    // crypto.getRandomValues() is available in non-secure contexts too.
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  }
  throw new Error("CRYPTO_UNAVAILABLE");
}
function now() { return Date.now(); }
function escapeText(text) {
  return String(text ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[ch]);
}
function getTask() { return state.tasks.find(t => t.id === state.activeTaskId) ?? null; }
function getSession() { return state.sessions.find(s => s.id === state.activeSessionId) ?? null; }
function getStep() {
  const task = getTask();
  return task ? state.steps.find(s => s.id === task.currentStepId) ?? null : null;
}
function setNotice(text, error = false) {
  notice = text;
  isError = error;
}
function alertMessage() {
  return notice ? '<div class="notice' + (isError ? ' error' : '') + '" role="status">' +
    escapeText(notice) + '</div>' : "";
}
function header(back, eyebrow) {
  return '<div class="overline"><button type="button" class="inline-link" data-action="' + back +
    '">← 返回</button><span>' + escapeText(eyebrow) + '</span></div>';
}
function intro(label, title, subtitle) {
  return '<div class="hero-label">' + label + '</div><h1>' + title + '</h1>' +
    '<p class="lead">' + subtitle + '</p>';
}
function shell(content) {
  root.innerHTML = '<div class="app' + (screen === "inbox" ? " is-workspace" : "") + '">' + alertMessage() + content + '</div>';
}
function runActive() { return getSession()?.status === "running"; }

function loadDraft() {
  const task = getTask();
  if (!task) return;
  currentSuggestion = proposeStep({ title: task.title, blocker: task.blocker, index: suggestionIndex });
  stepDraft = currentSuggestion.text;
  stepDirty = false;
}

function renderInbox() {
  const current = getSession();
  const list = state.tasks.filter(t => t.status !== "done" && t.status !== "archived");
  const cards = list.map(task => {
    if (editingTaskId === task.id) {
      return '<form class="task-item" id="edit-task-form"><label class="form-label" for="edit-task-input">修改任务标题</label>' +
        '<input id="edit-task-input" class="field" required maxlength="200" value="' + escapeText(editDraft) + '">' +
        '<div class="task-controls"><button type="submit" class="small-button">保存修改</button>' +
        '<button type="button" class="small-button" data-action="cancel-edit">取消</button></div></form>';
    }
    return '<article class="task-item"><div class="task-body"><div class="task-name">' + escapeText(task.title) +
      '</div><div class="task-meta' + (task.status === "active" ? " is-active" : "") + '">' +
      (task.status === "active" ? "正在聚焦" : "等待开始") +
      '</div></div><div class="task-controls"><button class="small-button" data-action="focus" data-id="' +
      escapeText(task.id) + '">帮我开始 ↗</button><button class="small-button" data-action="edit-task" data-id="' +
      escapeText(task.id) + '">编辑</button><button class="small-button" data-action="archive" data-id="' +
      escapeText(task.id) + '">归档</button></div></article>';
  }).join("");
  const lastUndoableBatch = [...state.batches].reverse().find(batch =>
    !batch.undoneAt && !state.steps.some(step => batch.taskIds.includes(step.taskId)));
  const undoButton = lastUndoableBatch ?
    '<button class="btn btn-quiet" type="button" data-action="undo-import" data-id="' +
      escapeText(lastUndoableBatch.id) + '">撤销最近一批导入 ↶</button>' : "";
  const resume = current ? '<div class="notice"><strong>你上一次的行动还在这里。</strong> ' +
    '<button class="inline-link" data-action="resume-screen">回到这一步 →</button></div>' : "";
  const capture = '<section class="card-panel capture-card">' +
    '<div class="capture-head"><span class="capture-step">STEP 01 · 写下一件难事</span><span class="light-pill">不用先列计划</span></div>' +
    '<form id="capture-form"><label class="form-label" id="capture-heading" for="capture-input">今天最难开始的是什么？</label>' +
    '<input id="capture-input" class="field" maxlength="200" required autocomplete="off" placeholder="例如：回复那封迟迟没写的邮件" value="' +
    escapeText(captureDraft) + '" aria-describedby="capture-hint">' +
    '<p class="field-hint" id="capture-hint">不必写得完美，只要是一件真实存在的事。</p>' +
    '<div class="cta-row"><button class="btn btn-primary btn-large btn-wide-mobile" type="submit">帮我开始 <span aria-hidden="true">↗</span></button>' +
    '<button class="btn btn-quiet" type="button" data-action="bulk-screen">从其他清单粘贴</button></div></form></section>';
  const tasks = '<section class="inbox-section" aria-label="待开始清单">' +
    '<div class="section-title"><span>你的待开始清单 · ' + list.length + '</span><span class="section-count">' +
    list.length + ' 件待处理</span></div>' + undoButton + resume +
    (cards ? '<div class="task-list">' + cards + '</div>' :
      '<div class="empty"><span class="empty-icon" aria-hidden="true">↗</span><strong>这里还很清爽。</strong>先写下一件事，不必一次计划好全部。</div>') +
    '</section>';
  const aside = '<aside class="workspace-aside" aria-label="使用方法与隐私">' +
    '<section class="note-card"><div class="eyebrow">A GENTLER WAY TO BEGIN</div>' +
    '<h3>先开始。<br>不用先做到完美。</h3>' +
    '<p>一个清晰的小动作，比一长串待办更容易靠近。这里没有打卡惩罚，只有你自己决定的下一步。</p>' +
    '<span class="note-mark" aria-hidden="true">↗</span></section>' +
    '<section class="method-card"><h3>只需要三个动作</h3>' +
    '<div class="method-step"><span class="method-number">01</span><div><strong>写下难事</strong><span>不用拆成一整套计划</span></div></div>' +
    '<div class="method-step"><span class="method-number">02</span><div><strong>缩小第一步</strong><span>选择卡点，改写一个建议</span></div></div>' +
    '<div class="method-step"><span class="method-number">03</span><div><strong>从两分钟开始</strong><span>随时暂停，进度由你决定</span></div></div>' +
    '</section><div class="trust-row"><span aria-hidden="true">◈</span><span><strong>本地优先。</strong> 任务只保存在当前浏览器，清除浏览器数据后可能丢失。请定期导出。</span></div>' +
    '</aside>';
  shell('<div class="workspace-grid"><div class="workspace-primary">' +
    '<div class="hero-copy">' +
    intro("START SMALL · BE KIND TO YOURSELF",
      '从一件小事，<br><span class="highlight-word">重新开始。</span>',
      "你不需要现在做完全部。先挑一件一直难以开始的事，我们把它变得更小。") +
    '</div>' + capture + tasks + '</div>' + aside + '</div>');
}

function renderFocus() {
  const task = getTask();
  if (!task) { screen = "inbox"; renderInbox(); return; }
  const suggestion = proposeStep({ title: task.title, blocker: task.blocker, index: suggestionIndex });
  const chips = BLOCKERS.map(value =>
    '<button type="button" class="blocker-card' + (value === "skipped" ? " skip" : "") +
    '" data-action="blocker" data-id="' + value + '" aria-label="' + escapeText(labels[value]) +
    '" aria-pressed="' + (task.blocker === value ? "true" : "false") + '">' +
    '<span class="blocker-title">' + escapeText(labels[value]) + '</span>' +
    '<span class="blocker-detail" aria-hidden="true">' + escapeText(blockerDetails[value]) + '</span></button>'
  ).join("");
  shell(header("inbox-screen", "STEP 01 / 04") + flowSteps(0) +
    '<div class="focus-header"><div class="hero-label">ONE THING AT A TIME</div><h2>现在先看这一件事。</h2>' +
    '<p class="focus-task-label">当前任务</p><p class="active-task">' + escapeText(task.title) + '</p></div>' +
    '<div class="focus-grid"><section class="card-panel">' +
    '<p class="form-label" id="blocker-heading">是什么让它难以开始？</p>' +
    '<div class="blocker-list" role="group" aria-labelledby="blocker-heading">' + chips + '</div>' +
    '<form id="step-form"><div class="step-section"><label class="form-label" for="step-input">建议的第一小步（可以随意修改）</label>' +
    '<div class="step-editor-wrap"><textarea id="step-input" class="field" maxlength="160" required aria-describedby="step-hint step-count">' +
    escapeText(stepDraft) + '</textarea><p class="step-counter" id="step-count">' + [...stepDraft].length + ' / 160</p></div>' +
    '<div class="step-suggestion" id="step-hint">✦ 这是建议，不是命令。试着把它改成你现在能做到的一个小动作。</div>' +
    '<div class="cta-row"><button class="btn btn-quiet" type="button" data-action="rotate-suggestion">换一个建议 ↺</button>' +
    '<button class="btn btn-quiet" type="button" data-action="manual-step">我自己写</button></div>' +
    '<div class="cta-row"><button class="btn btn-primary btn-large btn-wide" type="submit">用这一小步，继续 ↗</button></div>' +
    '<p class="small-note">候选规则版本 ' + escapeText(suggestion.rulesVersion) + ' · 只有你确认后才会保存为步骤。</p>' +
    '</div></form></section>' +
    '<aside class="guidance-card"><span class="glyph" aria-hidden="true">✳</span>' +
    '<strong>不用解决整件事。</strong><p>先找到一个能动手的入口。哪怕只是打开文件、写下一个标题，也已经足够具体。</p>' +
    '<p class="fineprint">你随时可以改写建议。系统不会判断你的心理状态，也不会替你完成任务。</p></aside></div>'
  );
}

function renderReady() {
  const task = getTask();
  const step = getStep();
  if (!task || !step) { screen = "inbox"; renderInbox(); return; }
  const options = [2, 5, 10].map(minutes =>
    '<button class="chip" type="button" data-action="duration" data-id="' + minutes +
    '" aria-pressed="' + (chosenMinutes === minutes ? "true" : "false") + '">' + minutes + ' 分钟</button>'
  ).join("");
  shell(header("focus-screen", "STEP 02 / 04") + flowSteps(1) +
    '<div class="hero-label">YOUR NEXT SMALL ACTION</div><h2>只做这一小步就好。</h2>' +
    '<p class="lead">把注意力放在一个真实动作上。不用计划下一小时，也不用现在完成整件事。</p>' +
    '<section class="card-panel session-card"><span class="status-pill">准备好了，可以随时开始</span>' +
    '<p class="session-task">' + escapeText(task.title) + '</p>' +
    '<p class="session-action">' + escapeText(step.text) + '</p>' +
    '<div class="duration-panel"><label class="form-label" id="duration-label">想先试多久？</label>' +
    '<div class="duration-list" role="group" aria-labelledby="duration-label">' + options + '</div></div>' +
    '<button type="button" class="btn btn-primary btn-large" data-action="start">开始这一小步 ↗</button>' +
    '<p class="timer-tip">你可以随时暂停。时间结束时，不会自动把任务标记为完成。</p></section>'
  );
}

function formatTime(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, "0") + ":" + String(seconds % 60).padStart(2, "0");
}
function visibleElapsed() {
  const s = getSession();
  if (!s) return 0;
  const extra = s.status === "running" && timerAnchor !== null ? Math.max(0, performance.now() - timerAnchor) : 0;
  return s.activeMs + extra;
}
function updateTimer() {
  const session = getSession();
  const number = document.querySelector("#timer-number");
  if (!session || !number) return;
  const ms = visibleElapsed();
  const remaining = Math.max(0, session.targetMs - ms);
  if (timerVisible) number.textContent = formatTime(remaining);
  const ring = document.querySelector("#timer-circle");
  if (ring) ring.style.setProperty("--progress", (timerVisible ? Math.min(100, (ms / session.targetMs) * 100) : 0) + "%");
  const target = document.querySelector("#timer-reached");
  if (target) target.textContent = remaining <= 0 ? "预定时间到了。你可以继续，或结束并回顾。" : "";
}

function renderTimer() {
  const task = getTask();
  const step = getStep();
  const s = getSession();
  if (!task || !step || !s) { screen="inbox"; renderInbox(); return; }
  const running = s.status === "running";
  const paused = s.status === "paused";
  shell(header("inbox-screen", "STEP 03 / 04") + flowSteps(2) +
    '<div class="hero-label">STAY WITH ONE SMALL STEP</div><h2>现在，先做这一件事。</h2>' +
    '<p class="lead">把目光留给手里的第一步。你可以慢慢来，也可以随时停下。</p>' +
    '<section class="card-panel session-card"><span class="status-pill' + (paused ? ' is-paused' : '') + '">' +
    (running ? "进行中" : paused ? "已暂停" : "待回顾") + '</span>' +
    '<p class="session-task">' + escapeText(task.title) + '</p>' +
    '<p class="session-action">' + escapeText(step.text) + '</p>' +
    '<div id="timer-circle" class="timer-circle' + (timerVisible ? '' : ' is-hidden') + '" aria-label="当前短会话时间">' +
    '<div class="timer-readout"><div id="timer-number" class="timer-number" role="timer" aria-live="off">' +
    (timerVisible ? formatTime(Math.max(0, s.targetMs - visibleElapsed())) : "···") +
    '</div><p class="timer-caption">' + (timerVisible ? '剩余尝试时间' : '专注当下这一步') + '</p></div></div>' +
    '<div class="timer-tools"><button class="inline-link" type="button" data-action="toggle-timer">' +
    (timerVisible ? "隐藏计时" : "显示计时") + '</button></div>' +
    '<p class="small-note" id="timer-reached" role="status"></p>' +
    '<div class="timer-actions">' +
    (running ? '<button class="btn btn-primary btn-large" data-action="pause">暂停一下</button>' :
      paused ? '<button class="btn btn-primary btn-large" data-action="resume">继续这一小步</button>' : "") +
    '<button class="btn btn-large" data-action="end-session">' +
    (s.status === "ended" ? "填写回顾" : "结束并回顾") + '</button></div>' +
    '<p class="timer-tip timer-footer">暂停不会算进尝试时间。结束本次尝试，也不代表失败。</p>' +
    '</section>');
  updateTimer();
}

function renderReview() {
  const s = getSession();
  if (!s) { screen="inbox"; renderInbox(); return; }
  const task = state.tasks.find(t => t.id === s.taskId);
  const choices = OUTCOMES.map(key =>
    '<button type="button" class="outcome-btn' +
    (key === "step_done" ? " is-primary" : key === "task_done" ? " is-task-done" : "") +
    '" aria-label="' + escapeText(outcomes[key]) + '" data-action="outcome" data-id="' + key + '">' +
    '<span class="outcome-title">' + escapeText(outcomes[key]) + '</span>' +
    '<span class="outcome-hint" aria-hidden="true">' + escapeText(outcomeDetails[key]) + '</span></button>'
  ).join("");
  shell(header("inbox-screen", "STEP 04 / 04") + flowSteps(3) +
    '<div class="hero-label">REFLECT, DON\'T JUDGE</div><h2>刚才这一小步，<br>进展怎么样？</h2>' +
    '<p class="lead">无论发生了什么，都能从这里继续。你不用解释，也不用做完全部。</p>' +
    '<section class="card-panel"><p class="focus-task-label">这次尝试的是</p>' +
    '<p class="active-task">' + escapeText(task?.title || "当前任务") + '</p>' +
    '<div class="outcome-list">' + choices + '</div></section>' +
    '<div class="review-soft-note">✦ 完成一个小步骤，不会自动完成整件任务。选择「整件任务已经完成」时，我们会再次确认。</div>'
  );
}

function renderBulk() {
  const preview = bulkPreview ? '<section id="import-preview" class="card-panel">' +
    '<div class="capture-head"><span class="capture-step">IMPORT PREVIEW</span><span class="light-pill">' +
    bulkPreview.length + ' 件</span></div><p class="form-label">确认要导入的 ' + bulkPreview.length +
    ' 件任务</p><ol class="import-preview">' + bulkPreview.map(s => '<li>' + escapeText(s) + '</li>').join("") +
    '</ol><div class="cta-row"><button class="btn btn-primary" data-action="bulk-confirm">确认导入</button>' +
    '<button class="btn" data-action="bulk-cancel">返回修改</button></div></section>' : "";
  shell(header("inbox-screen", "批量输入") +
    '<div class="hero-label">NO MIGRATION REQUIRED</div><h2>把已有清单粘贴过来。</h2>' +
    '<p class="lead">每行一件事，最多 20 行。导入之前先由你确认，不会合并同名任务。</p>' +
    '<section class="card-panel"><form id="bulk-form">' +
    '<label class="form-label" for="bulk-input">粘贴纯文本</label>' +
    '<textarea id="bulk-input" class="field" rows="7" required aria-describedby="bulk-hint">' +
    escapeText(bulkDraft) + '</textarea>' +
    '<p class="field-hint" id="bulk-hint">建议每行写一件具体的事，不要包含不想保存在浏览器里的敏感内容。</p>' +
    '<div class="cta-row"><button class="btn btn-primary btn-large" type="submit">预览任务 ↗</button></div></form></section>' +
    preview);
}

function renderSettings() {
  shell(header("inbox-screen", "设置 / 数据") +
    '<div class="hero-label">YOUR DATA IS YOURS</div><h2>保持简单，也保持透明。</h2>' +
    '<p class="lead">任务保存在当前浏览器的 IndexedDB 中；没有账户、云同步或后台上传任务正文。</p>' +
    '<section class="card-panel">' +
    '<div class="settings-group"><h3>外观与阅读</h3>' +
    '<p>可以根据环境选择明亮或深色界面。只在此浏览器保存外观偏好。</p>' +
    '<div class="settings-switch"><span class="settings-tag">当前：' + (currentTheme === "dark" ? "深色模式" : "明亮模式") +
    '</span><button class="btn" type="button" data-action="toggle-theme" aria-pressed="' +
    (currentTheme === "dark" ? "true" : "false") + '">' + (currentTheme === "dark" ? "切换为明亮模式" : "切换为深色模式") +
    '</button></div></div>' +
    '<div class="settings-group"><h3>导出此设备数据</h3>' +
    '<p>下载 JSON 快照并由你自行保管。当前版本尚不支持从 JSON 直接恢复。</p>' +
    '<button class="btn btn-primary" data-action="export">导出 JSON ↗</button></div>' +
    '<div class="settings-group"><h3>研究统计</h3>' +
    '<p>当前未启用研究遥测，不会向服务器发送任务或使用事件。如未来开展研究，将重新征求你的明确同意。</p>' +
    '<span class="settings-tag">当前状态：未启用</span></div>' +
    '<div class="settings-group"><h3 class="warning">删除本地数据</h3>' +
    '<p>此操作会清除本浏览器保存的任务、步骤和会话，无法撤销。建议先导出 JSON 文件。</p>' +
    '<button class="btn btn-minor-danger" data-action="delete-all">删除此设备全部数据</button></div></section>'
  );
}

let lastRenderedScreen = null;
function render() {
  root.dataset.screen = screen;
  const changedScreen = screen !== lastRenderedScreen;
  if (!storageReady) {
    root.innerHTML = '<div class="notice error" role="alert">本地存储不可用。为了避免误以为已经保存，当前无法创建任务。请检查浏览器隐私设置或尝试常规窗口。</div>';
    return;
  }
  // A refresh caused by another tab (BroadcastChannel) or by the timer must not
  // steal focus or the caret from someone who is actively typing. Record the
  // focused field, then restore it when the same screen is re-rendered.
  const focused = document.activeElement;
  const caret = focused && focused !== document.body && root.contains(focused) && focused.id
    ? { id: focused.id, start: focused.selectionStart ?? null, end: focused.selectionEnd ?? null }
    : null;
  if (screen === "focus") renderFocus();
  else if (screen === "ready") renderReady();
  else if (screen === "timer") renderTimer();
  else if (screen === "review") renderReview();
  else if (screen === "bulk") renderBulk();
  else if (screen === "settings") renderSettings();
  else renderInbox();
  lastRenderedScreen = screen;
  if (changedScreen) {
    const heading = root.querySelector("h1, h2");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      requestAnimationFrame(() => { if (heading.isConnected) heading.focus({ preventScroll: true }); });
    }
  } else if (caret) {
    const next = root.querySelector('[id="' + caret.id + '"]');
    if (next) {
      next.focus({ preventScroll: true });
      if (caret.start !== null && typeof next.setSelectionRange === "function") {
        try { next.setSelectionRange(caret.start, caret.end ?? caret.start); } catch { /* field type without text selection */ }
      }
    }
  }
}

async function persist(change) {
  try {
    state = await repo.transact(change, uuid());
    setNotice("");
    return true;
  } catch (error) {
    const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
    setNotice("刚才的操作还没有保存（" + code + "）。请重试，输入内容仍保留。", true);
    render();
    return false;
  }
}

let stopInFlight = null;
/**
 * Stop the running session exactly once, even when several triggers race:
 * the pause button, a tab-visibility change, page unload and the periodic
 * checkpoint can all ask for the same stop within the same few milliseconds.
 * Without this guard the losing request re-applies `pauseSession` to an already
 * paused session, which throws SESSION_NOT_RUNNING and shows a false
 * "not saved" error even though the first transaction committed.
 */
async function stopRunning(purpose) {
  if (stopInFlight) await stopInFlight.catch(() => { /* first request owns the error */ });
  const session = getSession();
  if (!session) return true;
  if (purpose === "pause" && session.status !== "running") return true;
  if (purpose === "end" && session.status === "ended") return true;
  const run = (async () => {
    if (checkpointPromise) await checkpointPromise;
    const current = getSession();
    if (!current) return true;
    const delta = timerAnchor === null ? 0 : Math.max(0, Math.round(performance.now() - timerAnchor));
    let ok;
    if (current.status === "running") {
      ok = purpose === "pause"
        ? await persist(s => { pauseSession(s, current.id, delta); })
        : await persist(s => { endSession(s, current.id, delta, now()); });
    } else if (current.status === "paused" && purpose === "end") {
      ok = await persist(s => { endSession(s, current.id, 0, now()); });
    } else {
      ok = true;  // already in the requested state; nothing left to write
    }
    if (ok) timerAnchor = null;
    return ok;
  })();
  stopInFlight = run;
  try { return await run; } finally { if (stopInFlight === run) stopInFlight = null; }
}

async function checkpoint() {
  const session = getSession();
  if (!session || session.status !== "running" || timerAnchor === null || checkpointPromise) return;
  const duration = Math.max(0, Math.round(performance.now() - timerAnchor));
  if (duration < 5_000) return;
  const anchorAfter = performance.now();
  checkpointPromise = repo.transact(s => { checkpointSession(s, session.id, duration); }, uuid())
    .then(next => { state = next; timerAnchor = anchorAfter; })
    .catch(() => { setNotice("计时记录保存失败，请暂停并检查本地存储。", true); })
    .finally(() => { checkpointPromise = null; });
  await checkpointPromise;
}

async function onAction(action, id) {
  if (action === "inbox-screen") {
    if (runActive()) {
      if (!window.confirm("当前计时还在进行中。要暂停并返回清单吗？")) return;
      if (!(await stopRunning("pause"))) return;
    }
    screen = "inbox";
  } else if (action === "focus-screen") {
    if (getSession()) return;
    suggestionIndex = 0;
    if (getStep()) { stepDraft = getStep().text; stepDirty = true; currentSuggestion = null; }
    else loadDraft();
    screen = "focus";
  } else if (action === "bulk-screen") {
    bulkPreview = null; screen = "bulk";
  } else if (action === "focus") {
    if (getSession()) { setNotice("请先结束并回顾上次会话，再选择其他任务。", true); }
    else if (await persist(s => { focusTask(s, id, now()); })) {
      suggestionIndex = 0; loadDraft(); screen = "focus";
    }
  } else if (action === "edit-task") {
    const task = state.tasks.find(t => t.id === id);
    if (!task) return;
    editingTaskId = id; editDraft = task.title; editingUpdatedAt = task.updatedAt;
  } else if (action === "cancel-edit") {
    editingTaskId = null; editDraft = ""; editingUpdatedAt = null;
  } else if (action === "undo-import") {
    if (!window.confirm("撤销最近一批未开始的导入任务？")) return;
    if (await persist(s => { undoImport(s, id, now()); })) setNotice("最近一批任务已撤销。");
  } else if (action === "archive") {
    if (!window.confirm("归档这件事？它不会被标记为完成。")) return;
    await persist(s => { archiveTask(s, id, now()); });
  } else if (action === "blocker") {
    if (stepDirty && !window.confirm("更换卡点会替换尚未确认的手写内容。确定更换吗？")) return;
    if (await persist(s => { setBlocker(s, getTask().id, id, now()); })) {
      suggestionIndex = 0; loadDraft();
    }
  } else if (action === "rotate-suggestion") {
    if (stepDirty && !window.confirm("你已修改建议，确定用新建议覆盖当前草稿吗？")) return;
    suggestionIndex++; loadDraft();
  } else if (action === "manual-step") {
    if (stepDirty && !window.confirm("清空当前草稿并自己写第一步吗？")) return;
    stepDraft = ""; stepDirty = true;
  } else if (action === "duration") {
    chosenMinutes = Number(id);
  } else if (action === "start") {
    const task = getTask(), step = getStep();
    if (!task || !step) return;
    if (await persist(s => { startSession(s, { id:uuid(), taskId:task.id, stepId:step.id, minutes:chosenMinutes, now:now() }); })) {
      timerAnchor = performance.now(); screen="timer";
    }
  } else if (action === "pause") {
    await stopRunning("pause");
  } else if (action === "resume") {
    const current = getSession();
    if (current && await persist(s => { resumeSession(s, current.id); })) timerAnchor=performance.now();
  } else if (action === "end-session") {
    // `end` must also close a session that was only paused, and it must re-read
    // fresh state instead of a reference captured before an awaited write.
    if (!getSession()) return;
    if (!(await stopRunning("end"))) return;
    screen = "review";
  } else if (action === "resume-screen") {
    screen = getSession()?.status === "ended" ? "review" : "timer";
  } else if (action === "toggle-timer") {
    timerVisible = !timerVisible;
  } else if (action === "outcome") {
    const session=getSession();
    if (!session) return;
    if (id === "task_done" && !window.confirm("确认整件任务已经完成，而不只是第一小步？")) return;
    if (await persist(s => { recordOutcome(s,session.id,id,now()); })) {
      if (id === "partial" || id === "not_started") {
        suggestionIndex=0;
        const task=getTask();
        const prior=state.steps.find(step => step.id === session.stepId);
        currentSuggestion=proposeRetry({
          title:task.title, blocker:task.blocker, outcome:id, priorStepText:prior?.text ?? ""
        });
        stepDraft=currentSuggestion.text;
        stepDirty=false;
        screen="focus";
        setNotice("这次尝试已经记录。已为你缩小下一步，仍可以自由修改或先放下。");
      } else screen="inbox";
    }
  } else if (action === "bulk-confirm") {
    if (!bulkPreview) return;
    const lines=[...bulkPreview], ids=lines.map(()=>uuid());
    if (await persist(s => { importTasks(s, {lines,ids,batchId:uuid(),now:now()}); })) {
      bulkDraft=""; bulkPreview=null; screen="inbox";
      setNotice("已将 " + lines.length + " 件任务保存在此浏览器。");
    }
  } else if (action === "bulk-cancel") {
    bulkPreview=null;
  } else if (action === "toggle-theme") {
    setTheme(currentTheme === "dark" ? "light" : "dark");
  } else if (action === "export") {
    const text = createExport(state);
    const url = URL.createObjectURL(new Blob([text], {type:"application/json;charset=utf-8"}));
    const link=document.createElement("a");
    link.href=url; link.download="start-first-export-" + new Date().toISOString().slice(0,10) + ".json";
    document.body.append(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
    setNotice("已生成 JSON 下载。请将文件保存在自己信任的位置。");
  } else if (action === "delete-all") {
    if (!window.confirm("确定删除此浏览器中的全部任务、步骤、会话吗？此操作不可撤销。")) return;
    if (await persist(() => emptyState())) {
      captureDraft=""; stepDraft=""; bulkDraft=""; bulkPreview=null; timerAnchor=null;
      screen="inbox"; setNotice("本地数据已删除。");
    }
  }
  render();
}

root.addEventListener("click", async event => {
  const button = event.target.closest("button[data-action]");
  if (!button) return;
  if (button.disabled) return;
  button.disabled=true;
  try { await onAction(button.dataset.action, button.dataset.id); }
  catch (error) {
    // Never let an unexpected exception become a silent no-op: the user must
    // know that nothing was saved.
    setNotice("操作没有完成（" + (error instanceof Error ? error.message : "UNKNOWN_ERROR") + "）。输入内容仍保留，可以重试。", true);
  }
  finally { if (button.isConnected) button.disabled=false; render(); }
});
settingsShortcut.addEventListener("click", async () => {
  if (runActive()) {
    if (!window.confirm("先暂停当前会话再打开设置吗？")) return;
    if (!(await stopRunning("pause"))) return;
  }
  screen="settings"; render();
});
root.addEventListener("input", event => {
  if (event.target.id === "capture-input") captureDraft = event.target.value;
  if (event.target.id === "edit-task-input") editDraft = event.target.value;
  if (event.target.id === "step-input") {
    stepDraft = event.target.value; stepDirty = true;
    const counter = document.querySelector("#step-count");
    if (counter) counter.textContent = [...stepDraft].length + " / 160";
  }
  if (event.target.id === "bulk-input") { bulkDraft = event.target.value; bulkPreview = null; document.querySelector("#import-preview")?.remove(); }
});
const formsInFlight = new Set();
root.addEventListener("submit", async event => {
  event.preventDefault();
  const form=event.target;
  // Implicit submission (Enter) and requestSubmit() still fire a submit event
  // even while the submit button is disabled, so the button flag alone cannot
  // prevent a duplicate submission of one user intent.
  if (formsInFlight.has(form.id)) return;
  formsInFlight.add(form.id);
  const submit=form.querySelector('button[type="submit"]');
  if (submit) submit.disabled=true;
  try {
    if (form.id === "capture-form") {
      // Capture the title in a local binding: the persisted command must not
      // re-read module state that a concurrent success handler can clear.
      const title = form.querySelector("#capture-input").value;
      captureDraft = title;
      const id = uuid(), timestamp=now();
      if (await persist(s => { createTask(s,{id,title,now:timestamp}); focusTask(s,id,timestamp); })) {
        captureDraft=""; suggestionIndex=0; loadDraft(); screen="focus";
      }
    } else if (form.id === "edit-task-form") {
      const title = form.querySelector("#edit-task-input").value;
      editDraft = title;
      const id = editingTaskId, expectedUpdatedAt = editingUpdatedAt;
      if (id && await persist(s => {
        editTask(s,id,{title,expectedUpdatedAt,now:now()});
      })) {
        editingTaskId=null; editDraft=""; editingUpdatedAt=null;
        setNotice("任务标题已保存。");
      }
    } else if (form.id === "step-form") {
      const text = form.querySelector("#step-input").value;
      stepDraft = text;
      const task=getTask(), id=uuid(), timestamp=now();
      const origin=stepDirty ? "manual" : "template";
      const templateId=stepDirty ? null : (currentSuggestion ?? proposeStep({title:task.title,blocker:task.blocker,index:suggestionIndex})).templateId;
      if (await persist(s => { confirmStep(s,{id,taskId:task.id,text,source:origin,templateId,now:timestamp}); })) {
        chosenMinutes=5; screen="ready";
      }
    } else if (form.id === "bulk-form") {
      bulkDraft=form.querySelector("#bulk-input").value;
      try { bulkPreview = parseBulk(bulkDraft); setNotice(""); }
      catch(error) { setNotice("请输入 1～20 行有效任务，每行最多 200 个字符。",true); }
    }
  } catch (error) {
    // A thrown error (e.g. an unavailable browser API) must be surfaced, not
    // swallowed into an apparent no-op.
    setNotice("操作没有完成（" + (error instanceof Error ? error.message : "UNKNOWN_ERROR") + "）。输入内容仍保留，可以重试。", true);
  } finally {
    formsInFlight.delete(form.id);
    if (submit?.isConnected) submit.disabled=false;
    render();
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && runActive()) void stopRunning("pause").then(() => { if(!document.hidden) render(); });
  else if (!document.hidden && storageReady) render();
});
window.addEventListener("pagehide", () => {
  if (runActive()) void stopRunning("pause");
});
setInterval(() => {
  if (!storageReady || !runActive()) return;
  updateTimer();
  void checkpoint();
}, 500);

async function boot() {
  try {
    state=await repo.read();
    storageReady=true;
    const session=getSession();
    if (session?.status === "running") {
      state=await repo.transact(s => { interruptSession(s,session.id); },uuid());
      setNotice("上次的会话已安全暂停。关闭页面期间的时间没有计入。");
    }
    if (getSession()?.status === "ended") screen="review";
    else if (getSession()) screen="timer";
    else if (getTask()) {
      screen="focus";
      if (getStep()) { stepDraft = getStep().text; stepDirty = true; currentSuggestion = null; }
      else loadDraft();
    }
    repo.onRemoteChange(async () => {
      try {
        state = await repo.read();
        if (getSession()) screen=getSession().status==="ended"?"review":"timer";
        else if (screen==="timer"||screen==="review") screen="inbox";
        render();
      } catch { setNotice("其他标签修改了数据，但刷新失败，请手动刷新。",true); render(); }
    });
    render();
  } catch {
    storageReady=false;
    render();
  }
}
void boot();
