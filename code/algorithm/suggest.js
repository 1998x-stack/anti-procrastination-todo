/**
 * Start-First deterministic action engine v2.
 *
 * All task content stays on the device. This is not clinical classification,
 * user profiling, time-to-completion prediction or online AI.
 */
import { BLOCKERS, characters, validateTaskText } from "../domain/core.js";

export const RULES_VERSION = "2.0.0";
export const TASK_KINDS = Object.freeze([
  "writing", "communication", "study", "organization", "preparation", "generic"
]);

const FALLBACK = "写下一件现在能动手的最小动作";
const SCENARIOS = Object.freeze({
  writing: [
    /写(?:作|文章|报告|论文|总结|文案|方案|稿|博客)/u,
    /\b(?:write|writing|draft|essay|report|article|thesis)\b/iu
  ],
  communication: [
    /(?:回复|回邮件|回消息|发邮件|联系|沟通|写邮件|发消息)/u,
    /\b(?:reply|email|message|contact|call someone)\b/iu
  ],
  study: [
    /(?:复习|学习|背诵|做题|刷题|练习题|记单词)/u,
    /\b(?:study|revise|exam|quiz|flashcards)\b/iu
  ],
  organization: [
    /(?:整理|收拾|归档|分类文件|打扫)/u,
    /\b(?:organize|tidy|declutter|sort files)\b/iu
  ],
  preparation: [
    /(?:准备|演讲|汇报|面试|排练)/u,
    /\b(?:prepare|presentation|interview|rehearse)\b/iu
  ]
});

/** Specialized content must get only process-oriented suggestions, never advice. */
const PROFESSIONAL_CONTEXT = /(?:诊断|用药|药物|病历|就诊|医疗|治疗|起诉|诉讼|法律建议|合同争议|税务|报税|投资决策|处方|\b(?:diagnosis|medication|lawsuit|legal advice|tax return|medical advice)\b)/iu;

const CATALOG = Object.freeze({
  too_big: {
    writing: ["写出三个小标题，先不用展开", "只写下第一个标题"],
    communication: ["列出这次回复要回答的一个问题", "先写下一条需要表达的核心信息"],
    study: ["写下现在只需要复习的一个概念", "选一个问题，写出自己已知的一句话"],
    organization: ["只处理眼前的一件物品", "先选择一个最小的整理区域"],
    preparation: ["写出这次准备最先需要回答的一个问题", "只列出一个要准备的主题"],
    generic: ["把任务拆成三个小部分，只圈出其中一个", "写下一件两分钟内可以尝试的小动作"]
  },
  unclear: {
    writing: ["写下这份内容想回答的第一个问题", "先写一句你最确定的信息"],
    communication: ["写下对方最需要你回应的一个问题", "写下这条回复想传递的一句话"],
    study: ["写下目前最不理解的一个概念", "列出一个可以查证的具体问题"],
    organization: ["写下你最先想整理的一件物品", "先给一个小区域写下分类名称"],
    preparation: ["写下准备工作中第一个未知问题", "列出最先需要澄清的一件事"],
    generic: ["写下第一个还不清楚的问题", "写下现在能检查的一件具体信息"]
  },
  perfectionism: {
    writing: ["写三句暂时不给别人看的粗糙草稿", "先写一个可以随时修改的标题"],
    communication: ["先写两句不会发送的回复草稿", "用一句话写出想表达的核心意思"],
    study: ["不查答案，写下自己目前知道的一句话", "写一个允许出错的简短答案"],
    organization: ["先做一次不必完美的简单分类", "只把一件物品暂时放到合适位置"],
    preparation: ["写下一句不需要完美的开场白", "先列一个粗糙的准备提纲标题"],
    generic: ["写下一个不会公开的粗糙版本", "用一句话写出不完美也可以的起点"]
  },
  low_energy: {
    writing: ["只写一个标题，之后可以停下", "写下一句现在想到的话"],
    communication: ["先写下回复的目的，不必发送", "只写一条要传递的信息"],
    study: ["写下今天可以查看的一个概念", "只写一个待弄懂的问题"],
    organization: ["先选择一件需要处理的物品", "写下最容易整理的一个位置"],
    preparation: ["先写下需要的一件材料", "只列出一个准备事项"],
    generic: ["只写下下一步需要的一样东西", "先尝试两分钟，想停下也可以"]
  },
  distraction: {
    writing: ["关闭一个干扰页面，再写一个标题", "只写一句话，不切换到其他任务"],
    communication: ["先去掉一个干扰，再写一句草稿", "只写一条需要回复的信息"],
    study: ["先专注一个概念，写下它的名称", "先写一个问题，不切换到其他材料"],
    organization: ["只处理眼前的一件物品，不切换区域", "先圈定一个最小区域"],
    preparation: ["只写下第一条准备事项", "先列出一项要准备的东西"],
    generic: ["先移开一个干扰，再写下一步", "先用两分钟只尝试一件小事"]
  },
  skipped: {
    writing: ["先写一个标题", "写下第一个想回答的问题"],
    communication: ["写下回复的第一句话，暂时不发送", "先写下要回复的一件事"],
    study: ["写出一个现在想弄懂的问题", "只选择一个知识点并写下名称"],
    organization: ["先选择一件最容易处理的物品", "给一个小区域写下标签"],
    preparation: ["只列出要准备的第一件小事", "写下这次准备最重要的一个问题"],
    generic: [FALLBACK, "先写出一个具体的问题，不必马上回答"]
  }
});

function normalizeForMatching(value) {
  return String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
}

export function classifyTaskDetails(title) {
  const value = normalizeForMatching(title);
  if (PROFESSIONAL_CONTEXT.test(value)) {
    return { kind: "generic", reason: "professional_context_guard", ambiguous: false };
  }
  const matches = Object.entries(SCENARIOS)
    .filter(([, patterns]) => patterns.some(pattern => pattern.test(value)))
    .map(([kind]) => kind);
  if (matches.length !== 1) {
    return { kind: "generic", reason: matches.length ? "ambiguous" : "no_strong_match", ambiguous: matches.length > 1 };
  }
  return { kind: matches[0], reason: "explicit_action", ambiguous: false };
}

export function classifyTask(title) {
  return classifyTaskDetails(title).kind;
}

/** Template hard checks are intentionally conservative; manual edits are user-owned. */
export function validateCandidate(text, title) {
  if (typeof text !== "string") return false;
  const candidate = text.normalize("NFC").trim();
  if (!candidate || characters(candidate) > 160) return false;
  if (candidate === normalizeForMatching(title)) return false;
  if (/^(?:完成|搞定|解决|提高效率|彻底解决)/u.test(candidate)) return false;
  if (/(?:你很懒|你患有|你有ADHD|必须今天全部完成|保证成功|保证治愈)/iu.test(candidate)) return false;
  return true;
}

function validateIndex(index) {
  if (!Number.isSafeInteger(index) || index < 0 || index > 1_000_000) {
    throw new Error("INVALID_SUGGESTION_INDEX");
  }
}

function buildCandidates(blocker, kind) {
  const own = CATALOG[blocker][kind] || [];
  const common = kind === "generic" ? [] : CATALOG[blocker].generic;
  const broad = CATALOG.skipped.generic;
  // Exact context outranks generic; dedupe preserves stable first occurrence.
  return [...new Set([...own, ...common, ...broad])];
}

export function proposeStep({ title, blocker = "skipped", index = 0 }) {
  validateTaskText(title);
  if (!BLOCKERS.includes(blocker)) throw new Error("INVALID_BLOCKER");
  validateIndex(index);
  const detail = classifyTaskDetails(title);
  const options = buildCandidates(blocker, detail.kind)
    .filter(text => validateCandidate(text, title));
  const chosen = options.length ? options[index % options.length] : FALLBACK;
  const position = options.length ? index % options.length : 0;
  return {
    text: chosen,
    kind: detail.kind,
    blocker,
    templateId: blocker + ":" + detail.kind + ":" + position,
    rulesVersion: RULES_VERSION,
    source: "template",
    suggestedMinutes: blocker === "low_energy" ? 2 : 5,
    requiresConfirmation: true,
    explanation: "这是一个可编辑的小动作，不代表整件任务会在指定时间内完成。"
  };
}

const RETRY = Object.freeze({
  too_big: "只写下一件最小的具体动作，先不完成它",
  unclear: "写下一个目前不知道答案的问题",
  perfectionism: "只写一个不会发送的草稿标题",
  low_energy: "只写下下一步需要的一样东西",
  distraction: "先移开一个干扰，再尝试两分钟",
  skipped: "写下一个两分钟内可以尝试的动作"
});

/** Outcome-specific smaller action. Never auto-commits or marks parent done. */
export function proposeRetry({ title, blocker = "skipped", outcome, priorStepText = "" }) {
  validateTaskText(title);
  if (!BLOCKERS.includes(blocker)) throw new Error("INVALID_BLOCKER");
  if (!["partial", "not_started"].includes(outcome)) throw new Error("INVALID_RETRY_OUTCOME");
  const text = outcome === "partial"
    ? "写下刚才进行到哪里，再选一个更小的下一步"
    : RETRY[blocker];
  const safe = validateCandidate(text, title) && text !== String(priorStepText).trim()
    ? text : FALLBACK;
  return {
    text: safe,
    kind: "generic",
    blocker,
    templateId: "retry:generic:" + (outcome === "partial" ? "1" : "0"),
    rulesVersion: RULES_VERSION,
    source: "template",
    suggestedMinutes: 2,
    requiresConfirmation: true,
    explanation: "这次只尝试比之前更小的一步，也可以选择暂时放下。"
  };
}

/** Exposes only static catalog sizes; no user history or task content. */
export function catalogCoverage() {
  return BLOCKERS.map(blocker => ({
    blocker, kinds: TASK_KINDS.map(kind => ({
      kind, count: CATALOG[blocker][kind].length
    }))
  }));
}
