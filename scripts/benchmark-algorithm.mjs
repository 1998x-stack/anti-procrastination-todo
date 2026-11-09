/**
 * Reproducible local microbenchmark; NOT a real-world productivity effectiveness metric.
 * npm run benchmark:algorithm
 */
import { performance } from "node:perf_hooks";
import { proposeStep, classifyTask } from "../code/algorithm/suggest.js";

const titles = [
  "写报告", "回复邮件", "复习数学", "整理文件", "准备面试",
  "处理一件难事", "🧩 一件不想开始的事", "准备法律诉讼材料"
];
const blockers = ["too_big", "unclear", "perfectionism", "low_energy", "distraction", "skipped"];
const samples = 12000;
for (let i = 0; i < 1000; i++) proposeStep({ title: titles[i % titles.length], blocker: blockers[i % blockers.length], index: i % 3 });
const t0 = performance.now();
let accepted = 0;
for (let i = 0; i < samples; i++) {
  const title = titles[i % titles.length], blocker = blockers[i % blockers.length];
  const proposal = proposeStep({ title, blocker, index: i % 4 });
  if (proposal.text && proposal.requiresConfirmation) accepted++;
  classifyTask(title);
}
const elapsedMs = performance.now() - t0;
if (accepted !== samples || elapsedMs <= 0) throw new Error("BENCHMARK_VALIDATION_FAILED");
process.stdout.write(JSON.stringify({
  benchmark: "v2 deterministic suggestion + classification",
  samples, accepted,
  elapsedMs: Number(elapsedMs.toFixed(2)),
  throughputSuggestionsPerSecond: Math.round(samples / (elapsedMs / 1000)),
  caveat: "Node CI microbenchmark, not user outcome and not a latency SLO"
}, null, 2) + "\n");
