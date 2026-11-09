import {
  emptyState, BLOCKERS, OUTCOMES, createTask, importTasks, parseBulk,
  focusTask, setBlocker, confirmStep, startSession, pauseSession,
  resumeSession, checkpointSession, interruptSession, endSession,
  recordOutcome, archiveTask
} from "../domain/core.js";
import { proposeStep } from "../algorithm/suggest.js";
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
let suggestionIndex = 0;
let chosenMinutes = 5;
let bulkDraft = "";
let bulkPreview = null;
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

function uuid() { return crypto.randomUUID(); }
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
  root.innerHTML = '<div class="app card">' + alertMessage() + content + '</div>';
}
function runActive() { return getSession()?.status === "running"; }

function loadDraft() {
  const task = getTask();
  if (!task) return;
  const suggestion = proposeStep({ title: task.title, blocker: task.blocker, index: suggestionIndex });
  stepDraft = suggestion.text;
  stepDirty = false;
}

function renderInbox() {
  const current = getSession();
  const list = state.tasks.filter(t => t.status !== "done" && t.status !== "archived");
  const cards = list.map(task => (
    '<article class="task-item"><div><div class="task-name">' + escapeText(task.title) +
    '</div><div class="task-meta">' + (task.status === "active" ? "正在聚焦" : "等待开始") +
    '</div></div><div class="task-controls"><button class="small-button" data-action="focus" data-id="' +
    escapeText(task.id) + '">帮我开始 ↗</button><button class="small-button" data-action="archive" data-id="' +
    escapeText(task.id) + '">归档</button></div></article>'
  )).join("");
  const resume = current ? '<div class="notice"><strong>上次的短行动还在这里。</strong> ' +
    '<button class="inline-link" data-action="resume-screen">回到这一步 →</button></div>' : "";
  shell(
    intro("MAKE A SMALL START", "从一件小事，<br>重新开始。", "你不需要现在做完全部。先挑一件一直难以开始的事，我们把它变得更小。") +
    '<section class="card-panel"><form id="capture-form"><label class="form-label" for="capture-input">今天最难开始的是什么？</label>' +
    '<input id="capture-input" class="field" maxlength="200" required placeholder="例如：回复那封迟迟没写的邮件" value="' +
    escapeText(captureDraft) + '"><div class="cta-row"><button class="btn btn-primary btn-wide-mobile" type="submit">帮我开始 <span aria-hidden="true">↗</span></button>' +
    '<button class="btn btn-quiet" type="button" data-action="bulk-screen">从其他清单粘贴</button></div></form></section>' +
    '<section><div class="section-title">你的待开始清单 · ' + list.length + '</div>' + resume +
    (cards ? '<div class="task-list">' + cards + '</div>' : '<p class="empty">这里暂时没有任务。先写下你想开始的一件事。</p>') +
    '</section><p class="small-note" style="margin-top:28px">你的任务只保存在此浏览器。删除浏览器数据或换设备后可能无法恢复，建议定期导出。</p>'
  );
}

function renderFocus() {
  const task = getTask();
  if (!task) { screen = "inbox"; renderInbox(); return; }
  const suggestion = proposeStep({ title: task.title, blocker: task.blocker, index: suggestionIndex });
  const chips = BLOCKERS.map(value =>
    '<button type="button" class="chip" data-action="blocker" data-id="' + value +
    '" aria-pressed="' + (task.blocker === value ? "true" : "false") + '">' + labels[value] + '</button>'
  ).join("");
  shell(header("inbox-screen", "01 / 找到启动点") +
    '<div class="hero-label">ONE THING AT A TIME</div><h2>现在先看这一件事。</h2>' +
    '<p class="active-task">' + escapeText(task.title) + '</p>' +
    '<section class="card-panel"><p class="form-label">是什么让它难以开始？</p>' +
    '<div class="chip-list" role="group" aria-label="选择目前的卡点">' + chips + '</div>' +
    '<hr class="divider"><form id="step-form"><label class="form-label" for="step-input">建议的第一小步（可以随意修改）</label>' +
    '<textarea id="step-input" class="field" maxlength="160" required>' + escapeText(stepDraft) + '</textarea>' +
    '<div class="step-suggestion">这只是建议，不是命令。你可以写自己的第一步，也可以只做两分钟。</div>' +
    '<div class="cta-row"><button class="btn btn-quiet" type="button" data-action="rotate-suggestion">换一个建议 ↺</button>' +
    '<button class="btn btn-quiet" type="button" data-action="manual-step">我自己写</button></div>' +
    '<div class="cta-row"><button class="btn btn-primary btn-wide-mobile" type="submit">用这一小步，继续 ↗</button></div>' +
    '<p class="small-note">候选规则版本 ' + escapeText(suggestion.rulesVersion) + ' · 只有你确认后才会保存为步骤。</p></form></section>'
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
  shell(header("focus-screen", "02 / 开始尝试") +
    '<div class="hero-label">YOUR NEXT SMALL ACTION</div><h2>只做这一小步就好。</h2>' +
    '<div class="card-panel timer-hero"><div class="kicker">' + escapeText(task.title) + '</div>' +
    '<p class="timer-step">' + escapeText(step.text) + '</p>' +
    '<hr class="divider"><div class="form-label">想先试多久？</div><div class="chip-list" style="justify-content:center">' +
    options + '</div><div class="cta-row" style="justify-content:center"><button type="button" class="btn btn-primary" data-action="start">开始这一小步 ↗</button></div>' +
    '<p class="small-note">计时可以随时暂停。到时间不会自动把任务标记为完成。</p></div>'
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
  const fill = document.querySelector("#progress-fill");
  if (fill) fill.style.width = Math.min(100, (ms / session.targetMs) * 100) + "%";
  const target = document.querySelector("#timer-reached");
  if (target) target.textContent = remaining <= 0 ? "预定时间到了。你可以继续，或结束并回顾。" : "";
}

function renderTimer() {
  const task = getTask();
  const step = getStep();
  const s = getSession();
  if (!task || !step || !s) { screen="inbox"; renderInbox(); return; }
  const running = s.status === "running";
  shell(header("inbox-screen", "03 / 小步行动") +
    '<div class="hero-label">STAY WITH ONE SMALL STEP</div><h2>现在，先做这一件事。</h2>' +
    '<section class="card-panel timer-hero"><span class="status-pill">' +
    (running ? "进行中" : s.status === "paused" ? "已暂停" : "待回顾") + '</span>' +
    '<div class="kicker" style="margin-top:23px">' + escapeText(task.title) + '</div>' +
    '<p class="timer-step">' + escapeText(step.text) + '</p>' +
    '<div id="timer-number" class="timer-number">' + (timerVisible ? formatTime(Math.max(0, s.targetMs - visibleElapsed())) : "···") + '</div>' +
    '<button class="inline-link" type="button" data-action="toggle-timer">' + (timerVisible ? "隐藏计时" : "显示计时") + '</button>' +
    '<div class="progress-line" aria-hidden="true"><div id="progress-fill" class="progress-fill" style="width:0%"></div></div>' +
    '<p class="small-note" id="timer-reached" role="status"></p><div class="timer-actions">' +
    (running ? '<button class="btn btn-primary" data-action="pause">暂停一下</button>' :
      s.status === "paused" ? '<button class="btn btn-primary" data-action="resume">继续这一小步</button>' : "") +
    '<button class="btn" data-action="end-session">' + (s.status === "ended" ? "填写回顾" : "结束并回顾") + '</button>' +
    '</div><p class="small-note" style="margin-top:22px">暂停不会被算作工作时间，中断也不是失败。</p></section>'
  );
  updateTimer();
}

function renderReview() {
  const s = getSession();
  if (!s) { screen="inbox"; renderInbox(); return; }
  const task = state.tasks.find(t => t.id === s.taskId);
  const choices = OUTCOMES.map(key =>
    '<button type="button" class="outcome-btn" data-action="outcome" data-id="' + key +
    '"><span>' + outcomes[key] + '</span><span aria-hidden="true">↗</span></button>'
  ).join("");
  shell('<div class="hero-label">REFLECT, DON\'T JUDGE</div><h2>刚才这一小步，<br>进展怎么样？</h2>' +
    '<p class="lead">无论发生了什么，都能从这里继续。你不用解释，也不用做完全部。</p>' +
    '<div class="card-panel"><p class="kicker">' + escapeText(task?.title || "当前任务") + '</p>' +
    '<div class="outcome-list">' + choices + '</div></div>' +
    '<p class="small-note">完成一个小步骤，不会自动完成整件任务。只有你主动确认整件完成时才会修改母任务状态。</p>'
  );
}

function renderBulk() {
  const preview = bulkPreview ? '<div id="import-preview" class="card-panel"><p class="form-label">确认要导入的 ' + bulkPreview.length +
    ' 件任务</p><ol class="import-preview">' + bulkPreview.map(s => '<li>' + escapeText(s) + '</li>').join("") +
    '</ol><div class="cta-row"><button class="btn btn-primary" data-action="bulk-confirm">确认导入</button>' +
    '<button class="btn" data-action="bulk-cancel">返回修改</button></div></div>' : "";
  shell(header("inbox-screen", "批量输入") +
    '<div class="hero-label">NO MIGRATION REQUIRED</div><h2>把已有清单粘贴过来。</h2>' +
    '<p class="lead">每行一件事，最多 20 行。导入前先让你确认，不会自动合并同名任务。</p>' +
    '<div class="card-panel"><form id="bulk-form"><label class="form-label" for="bulk-input">粘贴纯文本</label>' +
    '<textarea id="bulk-input" class="field" rows="7" required>' + escapeText(bulkDraft) + '</textarea>' +
    '<div class="cta-row"><button class="btn btn-primary" type="submit">预览任务</button></div></form></div>' + preview
  );
}

function renderSettings() {
  shell(header("inbox-screen", "设置 / 数据") +
    '<div class="hero-label">YOUR DATA IS YOURS</div><h2>保持简单，也保持透明。</h2>' +
    '<p class="lead">任务保存在当前浏览器的 IndexedDB 中；没有账户、云同步或后台上传任务正文。</p>' +
    '<div class="card-panel"><div class="settings-group"><h3>导出此设备数据</h3>' +
    '<p class="small-note">下载 JSON 快照并由你自行保管。当前版本尚不支持从 JSON 直接恢复。</p>' +
    '<button class="btn btn-primary" data-action="export">导出 JSON ↗</button></div>' +
    '<div class="settings-group"><h3>研究统计</h3>' +
    '<p class="small-note">当前未启用研究遥测，不会向服务器发送任务或使用事件。未来如开展研究，需要重新征求你的明确同意。</p></div>' +
    '<div class="settings-group"><h3 class="warning">删除本地数据</h3>' +
    '<p class="small-note">此操作会清除本浏览器保存的任务、步骤和会话，无法撤销。</p>' +
    '<button class="btn" data-action="delete-all">删除此设备全部数据</button></div></div>'
  );
}

function render() {
  if (!storageReady) {
    root.innerHTML = '<div class="notice error" role="alert">本地存储不可用。为了避免误以为已经保存，当前无法创建任务。请检查浏览器隐私设置或尝试常规窗口。</div>';
    return;
  }
  if (screen === "focus") renderFocus();
  else if (screen === "ready") renderReady();
  else if (screen === "timer") renderTimer();
  else if (screen === "review") renderReview();
  else if (screen === "bulk") renderBulk();
  else if (screen === "settings") renderSettings();
  else renderInbox();
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

async function stopRunning(purpose) {
  if (checkpointPromise) await checkpointPromise;
  const session = getSession();
  if (!session || session.status !== "running") return false;
  const delta = timerAnchor === null ? 0 : Math.max(0, Math.round(performance.now() - timerAnchor));
  const id = session.id;
  let ok;
  if (purpose === "pause") ok = await persist(s => { pauseSession(s, id, delta); });
  else ok = await persist(s => { endSession(s, id, delta, now()); });
  if (ok) timerAnchor = null;
  return ok;
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
    loadDraft();
    screen = "focus";
  } else if (action === "bulk-screen") {
    bulkPreview = null; screen = "bulk";
  } else if (action === "focus") {
    if (getSession()) { setNotice("请先结束并回顾上次会话，再选择其他任务。", true); }
    else if (await persist(s => { focusTask(s, id, now()); })) {
      suggestionIndex = 0; loadDraft(); screen = "focus";
    }
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
    const session = getSession();
    if (!session) return;
    if (session.status === "running" && !(await stopRunning("end"))) return;
    if (session.status === "paused" && !(await persist(s => { endSession(s,session.id,0,now()); }))) return;
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
        suggestionIndex=0; loadDraft(); screen="focus";
        setNotice("这次尝试已经记录。你可以把下一步变得更小，也可以先放下。");
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
  finally { if (button.isConnected) button.disabled=false; }
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
  if (event.target.id === "step-input") { stepDraft = event.target.value; stepDirty = true; }
  if (event.target.id === "bulk-input") { bulkDraft = event.target.value; bulkPreview = null; document.querySelector("#import-preview")?.remove(); }
});
root.addEventListener("submit", async event => {
  event.preventDefault();
  const form=event.target;
  const submit=form.querySelector('button[type="submit"]');
  if (submit) submit.disabled=true;
  try {
    if (form.id === "capture-form") {
      captureDraft = form.querySelector("#capture-input").value;
      const id = uuid(), timestamp=now();
      if (await persist(s => { createTask(s,{id,title:captureDraft,now:timestamp}); focusTask(s,id,timestamp); })) {
        captureDraft=""; suggestionIndex=0; loadDraft(); screen="focus";
      }
    } else if (form.id === "step-form") {
      stepDraft = form.querySelector("#step-input").value;
      const task=getTask(), id=uuid(), timestamp=now();
      const origin=stepDirty ? "manual" : "template";
      const templateId=stepDirty ? null : proposeStep({title:task.title,blocker:task.blocker,index:suggestionIndex}).templateId;
      if (await persist(s => { confirmStep(s,{id,taskId:task.id,text:stepDraft,source:origin,templateId,now:timestamp}); })) {
        chosenMinutes=5; screen="ready";
      }
    } else if (form.id === "bulk-form") {
      bulkDraft=form.querySelector("#bulk-input").value;
      try { bulkPreview = parseBulk(bulkDraft); setNotice(""); }
      catch(error) { setNotice("请输入 1～20 行有效任务，每行最多 200 个字符。",true); }
    }
  } finally {
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
    else if (getTask()) { screen="focus"; loadDraft(); }
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
