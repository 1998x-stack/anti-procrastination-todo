# Start-First 测试与验证报告

**被测 commit：** `71071bfed912fd023ac45e68bc5e87b8398e600c`（`main`）+ 本次会话的工作区修改（含 5 个产品修复与新增测试）
**部署 release：** `20261109T064425Z-71071bfed912`（`/home/ubuntu/apps/start-first/current`）
**报告时间：** 2026-11-09（UTC）
**总体结论：** 所有**已运行**的检查全部通过；**公网 HTTPS 部署、真实配额耗尽、非 Chromium/真实设备、无障碍审计**明确为 `NOT_VERIFIED`（见第 7 节与 `docs/gotchas.md`），因此**不**声明"完全通过/可上线"。

---

## 1. 环境（记录以便复现与归因）

| 项目 | 值 |
| --- | --- |
| 发行版 | Ubuntu 24.04.3 LTS (noble) |
| 内核 | `7.0.0-38-generic` |
| 架构 | x86_64 |
| CPU | Intel Core i5-10500 @ 3.10 GHz，6 核 / 12 线程 |
| 内存 / 磁盘 | 31 GiB / 609 GB 可用 |
| Node.js | **v22.23.3**（nvm，与 CI 的 Node 22 对齐；`engines: >=20`） |
| npm | 10.9.9 |
| Docker | 29.1.3 |
| nginx（容器内） | **nginx/1.27.5**（镜像 `nginx:1.27-alpine`，digest `sha256:65645c7b…f2f2a10`） |
| 浏览器（测试用） | Chromium **141.0.7390.37**（Playwright build **v1194**，headless shell） |
| Playwright | `@playwright/test` 1.56.1 |
| 部署模式 | Docker + nginx 静态托管，**仅 `127.0.0.1:8081`**（无公网、无 TLS） |

---

## 2. 命令与结果总览

| # | 命令 | 退出码 | 数量 | 耗时 | 日志位置 |
| --- | --- | --- | --- | --- | --- |
| 1 | `npm run check` | 0 | 9 个模块语法检查 | <0.5 s | `/tmp/sf-logs/verify-*.log` |
| 2 | `npm test` | 0 | **53 passed / 0 failed** | 0.69 s | 同上 |
| 3 | `npm run verify`（check+test） | 0 | 53 passed | 0.69 s | 同上 |
| 4 | `npm run benchmark:algorithm` | 0 | 12,000 次调用全部接受 | 77.8 ms（吞吐 154,322/s） | `/tmp/sf-logs/benchmark.log` |
| 5 | `npm run test:e2e`（Chromium，4173 harness） | 0 | **34 passed / 0 failed** | 8.8 s | `/tmp/sf-logs/acc-e2e.log` |
| 6 | `npm run verify:lab-api`（研究 API 实测） | 0 | **31/31 checks passed** | 1.39 s | 见第 5 节 |
| 7 | `deploy/deploy.sh` | 0 | 发布 + 27 项健康检查 | ~4 s | `/tmp/sf-logs/…` |
| 8 | `deploy/healthcheck.sh` | 0 | **27 ok / 0 FAIL** | 0.22 s | 见第 6 节 |
| 9 | `npm run test:e2e:deployed`（真实 nginx origin） | 0 | **9 passed / 0 failed** | 3.7 s | `/tmp/sf-logs/acc-dep.log` |

基线对比：审计开始时 `npm run test:e2e` 为 **19 passed**（原有用例）；本次新增 15 个用例（多标签、可见性/计时诚实性、故障注入、非安全上下文、窄屏全流程），现为 **34 passed**，且原有 19 个用例**全部仍然通过**（无回归、未删除或弱化任何既有断言）。

---

## 3. 端到端场景（真实 Chromium，已执行）

### 3.1 开发 harness（`npm run test:e2e`，34 用例，按文件）

| 文件 | 用例数 | 覆盖内容 |
| --- | --- | --- |
| `flow.spec.js` | 11 | 完整黄金路径（捕获→卡点→可编辑小步→2 分钟会话→暂停→回顾）、运行中刷新安全恢复、批量导入 + 导出 JSON、任务正文外发检查、**并发客户端只产生一个运行中会话**、XSS 以文本渲染、删除本地数据、首次加载断网后可继续、编辑任务后刷新保留、撤销最近一批导入 |
| `retry.spec.js` | 2 | `not_started` 生成更小重试且不提交、不结束母任务、保留旧 Step/Session；`partial` 生成可编辑继续且不产生重复会话 |
| `ui.spec.js` | 8 | 1440px 桌面布局与无横向溢出、320px/375px 主 CTA 可达、卡点选择 + 实时字数、计时隐藏/显示、明暗主题持久化、回顾选项独立且不静默完成任务、**320px 全屏幕（inbox→focus→ready→timer→review）无横向溢出**、屏幕标题聚焦与 skip link |
| `visibility.spec.js`（新增） | 5 | 暂停后立刻切走**不报假失败**、隐藏期间时间**不计入**已验证时间、重复可见性事件只暂停一次、暂停态结束仍可回顾并记录结果、运行中刷新安全暂停且不猜测后台时间 |
| `multitab.spec.js`（新增） | 2 | **两个真实标签**不能同时启动会话；另一标签写入时本标签**保留焦点、光标与文字** |
| `fault-injection.spec.js`（新增） | 4 | IndexedDB 写入失败**必须报失败且不伪装成功**、失败后重试只提交一次、事务中止后旧快照完好、重复提交只创建一个任务且无假失败 |
| `insecure-origin.spec.js`（新增） | 3 | 非安全上下文确实无 `crypto.randomUUID`、任务创建仍可用且不静默、Web Crypto 完全缺失时必须显示错误 |

### 3.2 已部署站点（`npm run test:e2e:deployed`，9 用例）

针对真实 nginx origin（`http://127.0.0.1:8081`）：

1. 入口加载 + 严格安全响应头 + **零外部请求**（断言所有子请求都属于本站 origin，无 requestfailed，无 console error）。
2. **安全上下文**：`isSecureContext === true`、IndexedDB 可用、`crypto.randomUUID()` 可用、DB `start-first-local-v1` 已创建。
3. **CSP 实际生效**：注入的内联 `<script>` 无法执行（`script-src 'self'`）。
4. 黄金路径在**部署 origin** 上完成，刷新后状态正确；运行中刷新后**仍只有 1 个会话且不是 running**；`partial` 结果保留 Step 文本、会话 outcome 为 `partial`、`activeMs` 为有限数值。
5. 导出 JSON 可下载且内容可解析（`schemaVersion: 1`，含刚创建的任务）。
6. 删除本地数据后刷新仍为 0 件。
7. 研究 API 与运行时无关路径**不可达**（`/api/v1/telemetry/*` → 404；`code/backend/*`、`tests/*`、`package.json`、`deploy/deploy.sh` → 404；dotfiles → 403）。
8. 拼错的资源返回**真 404**（不会退化成 200 的 HTML，避免 MIME 混用）。
9. `/healthz` → 200 `ok`。

---

## 4. 算法验证

- **36 个卡点 × 任务类型模板格**：`catalogCoverage()` 断言 6×6 全部存在且每格 ≥2 个候选（单测）。
- **144 个合成案例**：36 格 × 4 个代表性标题，断言确定性（两次调用深度相等）、可执行动词开头、长度 ≤160、`requiresConfirmation === true`、无 LLM、无诊断/保证类措辞。
- **分类保守性**：模糊标题（"写文章并回复邮件"）、专业场景（医疗/法律/税务/用药）、混合、未知（emoji）一律回退到 `generic`，并带 `reason` 说明。
- **非法 index 拒绝**：`-1, NaN, Infinity, -Infinity, 0.5, 1e20, "2", null` 全部抛 `INVALID_SUGGESTION_INDEX`。
- **用户手写内容不被覆盖**：`validateCandidate` 拒绝"完成/搞定/解决…"类空泛建议与超长/空串；模板**不插入**用户标题（用 `SECRETPERSON-023456` 断言输出中不含该串）。
- **partial / not_started 重试**：`proposeRetry` 保留旧 Step/Session 不变，只生成**新的更小**候选，且要求用户确认（浏览器 E2E 中进一步断言 `steps: 2 / sessions: 1`、旧 step 文本原样保留）。
- **性能（信息性，不代表用户效果）**：12,000 次合成调用，77.8 ms，约 **154,322 次/秒**（Node v22.23.3，i5-10500，单进程）。
  **该数字不构成"减少拖延"的效果证据**，仅说明算法本身不是瓶颈。

---

## 5. 研究 API（lab-only）专项实测

`npm run verify:lab-api` → **31/31 通过**。它启动真实的 `code/backend/dev-server.js` 子进程并断言：

| 分组 | 断言（全部通过） |
| --- | --- |
| 默认状态 | 未设置 `START_FIRST_LOCAL_TELEMETRY=1` 时**直接退出（exit 1）**且**无监听**；`NODE_ENV=production` 时同样拒绝启动 |
| 绑定 | 显式启用后监听 `127.0.0.1:4317`；**从本机非回环地址 `192.168.169.223:4317` 不可达** |
| 传输加固 | 未知路径 404（含带 query string）、GET 打 POST 路由 404、错误 content-type 415、超大正文（70 KiB）413、缺失 Bearer 401；`/healthz` 为 `no-store` |
| 同意与令牌 | `consent:false` → 400；合法同意 → 201 且**写令牌与删除令牌不同**；写令牌不能删除、删除令牌不能写事件（均为 401） |
| 事件语义 | 首次批量 `accepted:1`；**相同 eventId 幂等重放** `accepted:0, duplicate:1`；**相同 id 不同 payload → 409**；受限字段（`taskTitle`）被拒且**响应不回显提交文本**；未知事件名被拒；批量中有一条非法则**整体拒绝（原子）** |
| 删除 | 删除接口只接受 `{}`（否则 400）；合法删除返回已删条数与 UUID 收据；**删除后写令牌与删除令牌均失效（401）** |
| 关闭 | 进程停止后 **4317 不再可达**，`ss -tln` 无残留 |

额外设计性质（已断言）：错误响应使用**恒定公开错误码与文案**，不回显攻击者可控字段值（不构成字段级 oracle）。

**未部署证明：** 已部署站点上 `POST /api/v1/telemetry/registrations` 与 `/api/v1/telemetry/events:batch` 均返回 `404`（`tests/deployed/deployed.spec.js`）。该服务**未**接入任何反代，**未**使用 PostgreSQL（实现为内存版）。

---

## 6. 部署健康检查（27 项，全部 ok）

```
ok  container running / loopback bind only 127.0.0.1:8081
ok  /healthz 200 · / 200 · /index.html 200 · main.js/styles.css/core.js/suggest.js/store.js/icon.svg 200
ok  JS MIME 合法 · / 为 text/html · icon.svg 为 image/svg+xml
ok  缺失资源真 404（不退化 HTML 兜底）
ok  CSP / nosniff / Referrer-Policy / Permissions-Policy 存在
ok  index.html Cache-Control: no-store · 其他资源 no-cache
ok  server_tokens off
ok  code/backend/dev-server.js、schema.sql、tests/* 均 404
ok  无目录列表 · dotfiles 403
ok  服务内容与磁盘 release 的 index.html sha256 一致
```

**运维演练（已实测）**
- `deploy/serve.sh reload`：`nginx -t` 通过 + 平滑 reload（零停机）。
- `deploy/rollback.sh`：切到上一 release 后，`curl /code/frontend/main.js` 的 sha256 **等于**目标 release 磁盘文件（`1237b7be…`），证明切换真实生效；再切回修复版（`ff96e168…`）同样一致。
- `deploy/serve.sh stop` → 8081 **连接被拒**且 `ss -tln` 无记录；`serve.sh start` → 同一 release 恢复，健康检查全过。

---

## 7. 未运行 / 未验证（`NOT_VERIFIED`，不得视为通过）

| 项目 | 原因 | 影响 |
| --- | --- | --- |
| 公网域名 + HTTPS + HSTS | 无域名与公网授权（未授权不外发） | **上线阻断项**，见 GOTCHA-018 |
| 真实存储配额耗尽（真实 `QuotaExceededError`） | 仅做了**注入**（已证明失败被正确上报、不伪装成功） | 真实配额路径未验证，GOTCHA-014 |
| IndexedDB 版本升级 `onblocked` | 当前 schema 恒为 v1，无升级路径可触发 | GOTCHA-015 |
| iOS Safari / 桌面 Safari / Firefox / Android Chrome / 真实设备 / 无痕模式 | 服务器环境无法运行 | GOTCHA-016 |
| 屏幕阅读器（NVDA/JAWS/VoiceOver）、WCAG 2.2 AA 完整审计、200% 缩放 | 需人工与辅助技术 | GOTCHA-017 |
| 10 分钟长会话精度、休眠唤醒、系统时钟被修改 | 需人工长时操作 | GOTCHA-019 |
| 断电/重启后的数据完整性 | 需真实中断 | 容器 `unless-stopped` 只保证服务自启，不保证数据 |
| JSON 导入恢复、跨设备同步、PWA 冷启动离线 | **产品未实现**（属能力边界，非测试遗漏） | 不得对外宣称已实现 |
| 研究数据真实收集与留存 | 未部署、无真实同意流程 | 不得宣称已有线上研究能力 |

---

## 8. 发现并修复的问题（详见 `docs/gotchas.md`）

| ID | 症状 | 根因摘要 | 状态 | 回归测试 |
| --- | --- | --- | --- | --- |
| GOTCHA-001 | 部署后全站 404（`/healthz` 却 200） | `current` 软链写成绝对主机路径，容器内无法解析 | FIXED | 健康检查新增"内容与磁盘 release 字节一致"；deployed 用例 1 |
| GOTCHA-002 | 重复提交把**成功**保存报成失败（`INVALID_TITLE`） | 命令闭包在执行时读取已被成功路径清空的模块状态；无在途锁 | FIXED | `fault-injection.spec.js` 重复提交用例 |
| GOTCHA-003 | 暂停后立刻切标签出现假失败（`SESSION_NOT_RUNNING`） | 按钮与 `visibilitychange` 并发触发两个暂停事务 | FIXED | `visibility.spec.js` 5 用例 |
| GOTCHA-004 | 另一标签写入导致本标签输入失焦、光标丢失 | 整树重绘未保存/恢复焦点与选区 | FIXED | `multitab.spec.js` |
| GOTCHA-005 | 非安全上下文下捕获任务**静默失败** | `crypto.randomUUID` 需安全上下文；提交处理器无 `catch` | FIXED | `insecure-origin.spec.js` 3 用例 |
| GOTCHA-006 | 19 个浏览器测试失败 | Playwright 浏览器 build 不匹配（缺 1194） | FIXED（环境） | 无（`npx playwright install chromium`） |
| GOTCHA-007 | `npm ci` 不可用 | 仓库缺 `package-lock.json` | FIXED | 已提交 lockfile |
| GOTCHA-008 | MIME 断言失败 | **断言过严**（`application/javascript` 合法），非产品缺陷 | PREVENTIVE | 健康检查改为合法集合校验 |
| GOTCHA-011 | 删除本地数据后仍有命令 ID 残留 | `applyCommand` 跨清空保留幂等日志（≤512） | **OPEN**（P3，需产品决策） | 已记录观察数据 |
| GOTCHA-012 | 其他标签开始会话会打断本标签 | `onRemoteChange` 无条件切换屏幕 | **OPEN**（P2 UX 决策） | 数据正确性已覆盖 |

**本次新增代码级回归测试：15 个浏览器用例**（`visibility` 5、`fault-injection` 4、`insecure-origin` 3、`multitab` 2、`ui` 新增 1）+ **1 个集成脚本**（`scripts/verify-lab-api.mjs`，31 项断言）+ **1 个部署验证套件**（`tests/deployed/deployed.spec.js`，9 用例）。

---

## 9. 剩余风险与上线阻断项

1. **HTTPS/域名部署未验证**（阻断公网）。必须在获批域名后配置 TLS + HSTS，并重跑 `test:e2e:deployed`。
2. **未验证真实配额耗尽与 IDB 升级路径**（GOTCHA-014/015），存储异常的真实表现仍是未证实的假设。
3. **`OPEN` 项**：删除数据后的元数据残留（GOTCHA-011）、多标签屏幕打断（GOTCHA-012）需产品决策。
4. **设备矩阵与无障碍审计缺失**（GOTCHA-016/017）。README 已声明这些是发布门槛，不得绕过。
5. **研究 API 仍不可生产化**：无持久化存储、无真实同意 UI、无留存运维。当前仅 loopback 参考实现。
6. **无效果证据**：算法吞吐量、用例通过数都**不**证明能减少拖延。README/文档中的措辞保持"prototype"。

---

## 10. 干净代码副本重部署（已实测）

按 `docs/deployment-linux.md` 从**远端分支的干净 clone** 完整重部署，使用**独立**部署根/端口/容器名以证明流程不依赖本机既有状态：

```bash
git clone --branch deploy/linux-nginx-hardening-and-fixes --single-branch \
  https://github.com/1998x-stack/anti-procrastination-todo.git
git rev-parse --short HEAD                       # dbe0a3e
SF_DEPLOY_ROOT=/tmp/sf-clean/deploy-root SF_PORT=8082 SF_CONTAINER=start-first-web-clean \
  bash deploy/deploy.sh                           # All health checks passed.
npm ci                                            # OK（lockfile 生效）
npm run verify                                    # 53/53
SF_URL=http://127.0.0.1:8082 npm run test:e2e:deployed   # 9/9
```

结论：**退出码全 0**，对新 origin 的真实浏览器验证 9/9 通过。验证后已清理演练容器与临时目录（`docker rm -f start-first-web-clean`、`rm -rf /tmp/sf-clean`），并确认 8082/4317 不再监听。

## 11. CI 结果（PR #1，run 42575391695）

| Job | 结果 | 耗时 | 覆盖 |
| --- | --- | --- | --- |
| `unit-tests` | **pass** | 5 s | `npm run verify` + `benchmark:algorithm`（Node 22） |
| `lab-api-reference` | **pass** | 6 s | `npm run verify:lab-api`（31 项） |
| `browser-smoke` | **pass** | 45 s | `npm run test:e2e`（34 用例 + 截图 artifact） |
| `deployment-smoke` | **pass** | 38 s | 真实 `deploy.sh` + `npm run test:e2e:deployed`（9 用例），在干净 runner 上部署并验证 |

PR：<https://github.com/1998x-stack/anti-procrastination-todo/pull/1>

## 12. 最终验收逐项结果（阶段 8）

| # | 验收项 | 结果 | 证据 / 原因 |
| --- | --- | --- | --- |
| 1 | 从干净代码副本按文档可重新部署 | **PASS** | 第 10 节：干净 clone + `npm ci` + `deploy.sh` + 9/9 部署测试全通过 |
| 2 | 本机（或授权 HTTPS）站点可真实打开 | **PASS（本机）** / HTTPS `NOT_VERIFIED` | `http://127.0.0.1:8081` 真实 Chromium 全流程通过；公网 HTTPS 无授权 |
| 3 | 静态资源全部正确加载 | **PASS** | 健康检查 9 个资源 200 + MIME 合法；浏览器零 requestfailed、零 console error |
| 4 | 创建任务到结束回顾完整流程成功 | **PASS** | `flow.spec.js` 黄金路径 + `deployed.spec.js` 在部署 origin 上重跑 |
| 5 | 刷新后任务与会话数据保持正确 | **PASS** | 刷新运行中会话→安全暂停且只有 1 个会话；`activeMs` 不猜测后台时间 |
| 6 | 无未授权的外部任务正文请求 | **PASS** | 断言所有子请求属于本站 origin；正文不出现在任何 URL 中（合成串验证） |
| 7 | 完整 Node.js 测试通过 | **PASS** | 53/53（本机 + CI） |
| 8 | 完整 Playwright Chromium 测试通过 | **PASS** | 34/34（本机 + CI）+ 部署 origin 9/9 |
| 9 | 算法基准正常执行并记录环境 | **PASS** | 12,000/12,000，77.8 ms，环境见第 1 节；已声明不是用户效果证据 |
| 10 | 研究 API 未对公网暴露 | **PASS** | 默认禁用、拒绝 production、仅 loopback（LAN 地址实测不可达）、站点上 `/api/v1/telemetry/*` 404 |
| 11 | 重载/诊断/回滚已演练 | **PASS** | reload 零停机；回滚后服务内容与目标 release sha256 一致；stop/start 同 release 恢复 |
| 12 | `docs/gotchas.md` 已建立、可复现、有根因证据 | **PASS** | GOTCHA-001..019，每个已复现项附最小复现与脱敏证据；推测项明确标注；未验证项标 `NOT_VERIFIED` |
| 13 | `docs/deployment-linux.md`、`docs/test-report.md` 已完成 | **PASS** | 均已提交 |
| 14 | Git 工作区变更清晰、无隐私信息 | **PASS** | 4 个独立提交，工作区干净；已扫描无 token/私钥/真实任务文本 |

**总体状态：不声明"完全通过"。** 上表 13 项 PASS，1 项部分（第 2 项公网 HTTPS，为 `NOT_VERIFIED`），另有第 7 节列出的 7 类未验证门槛与 2 个 `OPEN` 项需产品决策。

## 13. 局域网访问（已开通）与逐项复核

操作方要求“能在局域网浏览器里打开”，因此发布绑定从仅 loopback 扩展为 `0.0.0.0`（受 DHCP 影响的取舍见 GOTCHA-020），并重新做了完整验证：

| 检查 | 结果 |
| --- | --- |
| 绑定 | `docker port start-first-web 80/tcp` → `0.0.0.0:8081`；`ss -tln` → `0.0.0.0:8081` |
| 本机 loopback | `http://127.0.0.1:8081/` → 200（1587 bytes） |
| 局域网地址 | `http://192.168.169.223:8081/` → 200（同字节数）；响应头含 CSP / nosniff / `no-store` |
| 非 loopback 网络路径 | 另起容器经 Docker 网桥访问 `172.17.0.1:8081` 与 `192.168.169.223:8081` → 均 200 |
| 重启持久性 | `deploy/serve.sh restart` → 绑定不变，健康检查全过 |
| **局域网 origin 真实浏览器验证** | `SF_URL=http://192.168.169.223:8081 npm run test:e2e:deployed` → **9/9**（含非安全上下文降级路径上的完整创建→会话→刷新→导出→删除流程） |
| 健康检查 | 27 项全过 + `warn 0.0.0.0:8081 … plain HTTP (no TLS)` |

**已验证的局域网环境差异：** 该 origin 下 `window.isSecureContext === false`、`typeof crypto.randomUUID === 'undefined'`（符合规范），应用依靠 `crypto.getRandomValues` 降级路径工作；测试套件现在会**显式声明**本次验证的是哪种 origin，而不是默认假定安全上下文。

**未能验证：** 主机防火墙策略（`ubuntu` 无免密 sudo，`sudo -n ufw status` 被拒）以及**从另一台真实设备**发起的连接。旁证：同机其他服务（`0.0.0.0:443`、`0.0.0.0:3001` 等）已在向局域网发布。

## 14. 复现本报告

```bash
cd /home/ubuntu/codes/anti-procrastination-todo
npm ci
npx playwright install chromium
npm run verify                     # 53 passed
npm run benchmark:algorithm        # 12000 accepted
npm run test:e2e                   # 34 passed
npm run verify:lab-api             # 31/31
deploy/deploy.sh                   # 发布 + 27 项健康检查
npm run test:e2e:deployed          # 9 passed
deploy/rollback.sh --list          # 回滚点列表
```


---

## 15. Follow-up code review (PR #2, not a Linux server retest)

Sections 1–14 above remain the original Codex Ubuntu 24.04 field results.
This section documents GitHub code review, isolated failure injection and
GitHub Actions; no SSH connection or new deployment to the operator's live
0.0.0.0:8081 server has been performed.

PR: https://github.com/1998x-stack/anti-procrastination-todo/pull/2

### Findings and scope

- P1 FIXED (CI): default rollback could jump forward after a prior rollback.
- P1 FIXED (CI): invalid nginx config/reload/health check could leave partial activation; now candidate config is preflighted and old code/config restored on failure.
- P1 FIXED (CI): container drift no longer triggers automatic docker rm -f on shared server.
- P1 OPEN: no proof of LAN-only restriction for 0.0.0.0 or HTTPS; HTTP-injected same-origin JS could read IndexedDB.
- P2 FIXED (CI): deploy.env key allowlist, truthful stage-only semantics, content-based published SHA, exclusive deployment locking.
- P2 OPEN: unversioned JS/CSS requests could straddle a release switch and mix artifacts.

### Verification method

CI unit job runs a disposable fake-Docker release/rollback fault injection
harness in tests/deployment/scripts-regression.sh. A separate CI job runs real
nginx in Docker, performs two releases, rolls back, checks served bytes and
executes deployed Playwright scenarios. These checks do not validate live
firewall policies or actual user devices.

Before field adoption, re-check the active deploy.env, container identity and
ports, TLS/firewall topology, release+config restoration and real-device paths.
Only amend GOTCHA-024 once external reachability and HTTPS have evidence.
