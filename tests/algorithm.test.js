import test from "node:test";
import assert from "node:assert/strict";
import { classifyTask, proposeStep, validateCandidate, RULES_VERSION } from "../code/algorithm/suggest.js";

test("detects only one conservative task kind", () => {
  assert.equal(classifyTask("写报告"),"writing");
  assert.equal(classifyTask("回复邮件"),"communication");
  assert.equal(classifyTask("准备面试"),"preparation");
  assert.equal(classifyTask("write report and reply email"),"generic");
  assert.equal(classifyTask("🧩"),"generic");
});

test("covers all blockers with deterministic and editable suggestions", () => {
  for (const blocker of ["too_big","unclear","perfectionism","low_energy","distraction","skipped"]) {
    const a=proposeStep({title:"写报告",blocker,index:0});
    const b=proposeStep({title:"写报告",blocker,index:0});
    assert.deepEqual(a,b);
    assert.equal(a.requiresConfirmation,true);
    assert.equal(a.rulesVersion,RULES_VERSION);
    assert.ok(a.text.length>0 && [...a.text].length<=160);
    assert.notEqual(a.text,"写报告");
  }
});

test("suggestions rotate in deterministic order", () => {
  const first=proposeStep({title:"回复邮件",blocker:"unclear",index:0});
  const second=proposeStep({title:"回复邮件",blocker:"unclear",index:1});
  assert.notEqual(first.text,second.text);
});

test("returns safe fallbacks for unknown language without guessing facts", () => {
  const r=proposeStep({title:"🧩⚙️⚙️",blocker:"skipped"});
  assert.equal(r.kind,"generic");
  assert.equal(validateCandidate(r.text,"🧩⚙️⚙️"),true);
  assert.doesNotMatch(r.text,/客户|患者|合同|账号|必须/u);
});

test("rejects invalid input or diagnostic/coercive text", () => {
  assert.throws(()=>proposeStep({title:" ",blocker:"skipped"}),/INVALID_TITLE/);
  assert.throws(()=>proposeStep({title:"写报告",blocker:"diagnosed"}),/INVALID_BLOCKER/);
  assert.equal(validateCandidate("你很懒，马上全部完成","写报告"),false);
  assert.equal(validateCandidate("写报告","写报告"),false);
});
