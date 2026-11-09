/**
 * Conservative, user-editable first-step suggestions. No remote AI, profiling or network calls.
 */
import { BLOCKERS, characters, validateTaskText } from "../domain/core.js";

export const RULES_VERSION = "1.0.0";

const CATALOG = {
  too_big: {
    writing: ["先写出三个小标题", "只写下这一篇内容要回答的一个问题"],
    communication: ["列出这次回复要回答的一个问题", "先写下一条最重要的信息"],
    study: ["把范围缩小到一个概念，并写下它的名称"],
    organization: ["只选择一个文件或物品开始整理"],
    preparation: ["先写出汇报要解决的一个核心问题"],
    generic: ["把这件事拆成三个小部分，只选择其中一个", "只写下最小的一项可以动手的工作"]
  },
  unclear: {
    writing: ["写下这篇内容的第一个待回答问题"],
    communication: ["写下对方需要你说明的一件事"],
    study: ["写下这门内容中目前最不清楚的一个概念"],
    organization: ["先找到要整理的一件具体物品"],
    preparation: ["写出准备工作中你最先需要知道的问题"],
    generic: ["写下这件事最先需要确认的一个问题", "写下一个现在能做的具体动作"]
  },
  perfectionism: {
    writing: ["写三句暂时不会公开的草稿"],
    communication: ["先写两句不会发送的回复草稿"],
    study: ["不查答案，先写下自己目前知道的一句话"],
    organization: ["只做一个不需要完美的简单分类"],
    preparation: ["写下一版粗糙的开场白，暂时不给别人看"],
    generic: ["写一段只给自己看的粗糙版本"]
  },
  low_energy: {
    writing: ["只写一个标题，完成后就可以停下"],
    communication: ["只打开一个草稿区，写下收件目的"],
    study: ["只找到一份资料，把它放在眼前"],
    organization: ["先准备一个要整理的物品"],
    preparation: ["只列出一件可能用到的材料"],
    generic: ["只准备接下来可能用到的一个工具或材料", "先做两分钟也可以选择停下"]
  },
  distraction: {
    writing: ["关闭一个无关页面，然后写一个标题"],
    communication: ["先关闭一个干扰，再写一句回复草稿"],
    study: ["把注意力放在一个概念上，写下它的名称"],
    organization: ["只处理眼前的一件物品，不切换区域"],
    preparation: ["只写下准备事项的第一条"],
    generic: ["先去掉眼前一个干扰，再写下第一步"]
  },
  skipped: {
    writing: ["先写一个标题"],
    communication: ["写下回复的第一句话，暂时不发送"],
    study: ["写出一个现在想弄懂的问题"],
    organization: ["选一件最容易处理的物品开始"],
    preparation: ["写出准备工作的第一件小事"],
    generic: ["写下现在能做的一件最小动作", "先试着做两分钟，不需要做完"]
  }
};

const KIND_WORDS = {
  writing: [/写(作|文章|报告|论文|总结|文案|方案)/u, /draft|write|essay|report/u],
  communication: [/回(复|邮件|消息)|联系|发邮件/u, /reply|email|message|contact/u],
  study: [/复习|学习|背诵|做题|练习题/u, /study|revise|exam|practice questions/u],
  organization: [/整理|收拾|归档/u, /organize|tidy|sort files/u],
  preparation: [/准备|演讲|汇报|面试/u, /prepare|presentation|interview/u]
};

export function classifyTask(title) {
  const text = String(title || "").normalize("NFC").trim().toLowerCase();
  const kinds = Object.entries(KIND_WORDS).filter(([, rules]) => rules.some(r => r.test(text))).map(([kind]) => kind);
  return kinds.length === 1 ? kinds[0] : "generic";
}

export function validateCandidate(text, title) {
  const s = String(text).trim();
  if (!s || characters(s) > 160) return false;
  if (s === String(title).trim()) return false;
  if (/^(完成|搞定|解决|提高效率|彻底解决)/u.test(s)) return false;
  if (/你很懒|你患有|你有ADHD|必须今天全部完成/iu.test(s)) return false;
  return true;
}

/** Deterministic candidates; user confirmation is always required. */
export function proposeStep({ title, blocker = "skipped", index = 0 }) {
  validateTaskText(title);
  if (!BLOCKERS.includes(blocker)) throw new Error("INVALID_BLOCKER");
  const kind = classifyTask(title);
  const primary = CATALOG[blocker][kind] ?? [];
  const common = kind === "generic" ? [] : CATALOG[blocker].generic;
  const options = [...primary, ...common, ...CATALOG.skipped.generic];
  const valid = [...new Set(options)].filter(text => validateCandidate(text, title));
  const at = ((Math.trunc(index) % valid.length) + valid.length) % valid.length;
  const text = valid[at] || "写下现在能做的一件最小动作";
  return {
    text, kind, blocker, templateId: blocker + ":" + kind + ":" + at,
    rulesVersion: RULES_VERSION, source: "template", suggestedMinutes: 5,
    requiresConfirmation: true
  };
}
