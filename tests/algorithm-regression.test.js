import test from "node:test";
import assert from "node:assert/strict";
import {
  RULES_VERSION, TASK_KINDS, catalogCoverage, classifyTask,
  classifyTaskDetails, proposeStep, proposeRetry, validateCandidate
} from "../code/algorithm/suggest.js";
import { BLOCKERS } from "../code/domain/core.js";

const prompts = {
  writing: ["写报告", "draft essay", "写论文", "write article"],
  communication: ["回复邮件", "reply email", "联系同事", "写邮件"],
  study: ["复习数学", "study for exam", "学习英语", "背诵单词"],
  organization: ["整理文件", "organize files", "收拾桌面", "tidy room"],
  preparation: ["准备面试", "prepare presentation", "排练演讲", "准备汇报"],
  generic: ["🧩⚙️", "处理一件难事", "开始这个项目", "unknown task"]
};
const expectedKinds = Object.keys(prompts);
const actionStart = /^(?:先|只|写|选|列|不查|把|给|用|关闭)/u;

test("v2 catalog has all 36 blocker×kind cells, with at least two choices", () => {
  assert.equal(RULES_VERSION, "2.0.0");
  const coverage = catalogCoverage();
  assert.equal(coverage.length, 6);
  for (const row of coverage) {
    assert.ok(BLOCKERS.includes(row.blocker));
    assert.deepEqual(row.kinds.map(c => c.kind), TASK_KINDS);
    assert.ok(row.kinds.every(c => c.count >= 2));
  }
});

test("144 synthetic task×blocker cases always return executable, safe, bounded candidates", () => {
  let checks = 0;
  for (const kind of expectedKinds) for (const title of prompts[kind]) for (const blocker of BLOCKERS) {
    const a = proposeStep({ title, blocker, index: 0 });
    const b = proposeStep({ title, blocker, index: 0 });
    assert.deepEqual(a, b, title + " / " + blocker);
    assert.equal(a.kind, kind, title);
    assert.equal(a.blocker, blocker);
    assert.equal(a.requiresConfirmation, true);
    assert.equal(a.rulesVersion, RULES_VERSION);
    assert.equal(a.source, "template");
    assert.match(a.text, actionStart);
    assert.equal(validateCandidate(a.text, title), true);
    assert.ok([...a.text].length <= 160);
    assert.ok([2, 5].includes(a.suggestedMinutes));
    assert.doesNotMatch(a.text, /你很懒|你患有|保证完成|必须今天全部完成/iu);
    checks++;
  }
  assert.equal(checks, 144);
});

test("classification is conservative under ambiguous, professional, mixed and unknown titles", () => {
  assert.equal(classifyTask("写文章并回复邮件"), "generic");
  assert.deepEqual(classifyTaskDetails("写报告并回复邮件").reason, "ambiguous");
  assert.equal(classifyTask("写一份医疗诊断报告"), "generic");
  assert.equal(classifyTaskDetails("为客户提供法律建议").reason, "professional_context_guard");
  assert.equal(classifyTask("做年度报税"), "generic");
  assert.equal(classifyTask("write report"), "writing");
  assert.equal(classifyTask("write reporting dashboards"), "writing"); // explicit write
  assert.equal(classifyTask("contactless payment"), "generic"); // no substring guesses
  assert.equal(classifyTask("💡"), "generic");
});

test("professional domains receive task-organization suggestions, never domain advice", () => {
  for (const title of ["诊断问题", "做年度报税", "准备诉讼材料", "review medication", "legal advice"]) {
    const result = proposeStep({ title, blocker: "unclear" });
    assert.equal(result.kind, "generic");
    assert.doesNotMatch(result.text, /应该服|建议投资|立刻起诉|确保报税/u);
    assert.equal(result.requiresConfirmation, true);
  }
});

test("rotation is deterministic, bounded and rejects malformed indexes", () => {
  const a = proposeStep({ title: "写报告", blocker: "too_big", index: 0 });
  const b = proposeStep({ title: "写报告", blocker: "too_big", index: 1 });
  assert.notEqual(a.text, b.text);
  assert.deepEqual(a, proposeStep({ title: "写报告", blocker: "too_big", index: 0 }));
  for (const index of [-1, NaN, Infinity, -Infinity, 0.5, 1e20, "2", null]) {
    assert.throws(() => proposeStep({ title: "写报告", index }), /INVALID_SUGGESTION_INDEX/);
  }
  const million = proposeStep({ title: "写报告", index: 1000000 });
  assert.ok(million.text);
});

test("retry on no-start or partial effort returns a smaller user-confirmed action", () => {
  for (const blocker of BLOCKERS) {
    const normal = proposeStep({ title: "写报告", blocker });
    const retry = proposeRetry({
      title: "写报告", blocker, outcome: "not_started", priorStepText: normal.text
    });
    assert.notEqual(retry.text, normal.text);
    assert.equal(retry.suggestedMinutes, 2);
    assert.equal(retry.requiresConfirmation, true);
    assert.equal(retry.kind, "generic");
    assert.equal(validateCandidate(retry.text, "写报告"), true);
    const partial = proposeRetry({ title: "写报告", blocker, outcome: "partial" });
    assert.equal(partial.suggestedMinutes, 2);
    assert.equal(partial.requiresConfirmation, true);
    assert.doesNotMatch(partial.text, /必须完成|失败/u);
  }
  assert.throws(() => proposeRetry({ title: "写报告", outcome: "task_done" }), /INVALID_RETRY_OUTCOME/);
});

test("no user title, note or identifiers are interpolated into templates", () => {
  const secret = "SECRETPERSON-023456";
  for (const blocker of BLOCKERS) {
    const result = proposeStep({ title: secret + " 写报告", blocker });
    assert.equal(result.text.includes(secret), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("candidate hard guard rejects diagnostic, non-action and giant suggestions", () => {
  assert.equal(validateCandidate("你很懒，赶紧做", "写报告"), false);
  assert.equal(validateCandidate("完成这件事", "写报告"), false);
  assert.equal(validateCandidate("保证成功", "写报告"), false);
  assert.equal(validateCandidate("a".repeat(161), "写报告"), false);
  assert.equal(validateCandidate("", "写报告"), false);
  assert.equal(validateCandidate("先写一句话", "写报告"), true);
});
