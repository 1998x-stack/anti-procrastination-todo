# Start-First 故障定位与修复手册（gotchas）

> **读者对象：** Codex、Claude Code 或其他从零接手本项目的 Agent。
> **目的：** 让你在 5～10 分钟内建立正确的系统模型、区分"环境问题/部署问题/产品缺陷"，并按已记录的根因证据修复，而不是重新猜测。
> **原则：** 本文只写**已验证**的结论。已复现问题标注 `FIXED`/`OPEN`；只凭代码审查推测的风险明确标注为"推测"；未能验证的能力标注 `NOT_VERIFIED`，不得当作已通过。

本文最后随实际部署更新于 **2026-11-09**，对应 commit `71071bfed912`（部署时为 dirty worktree，详见 `meta/` 中的 release 清单）。

---

## A. 项目快速诊断入口

### A.1 架构的真实情况（先读这一段）

```
浏览器 UI (原生 ES Modules, 无构建步骤)
  ↓ 命令 + 用户确认
纯领域层 code/domain/core.js   Task → Step → Session
  ↔ 确定性建议算法 code/algorithm/suggest.js（36 模板格 / 无 LLM / 无网络）
  ↓ 单个原子事务
IndexedDB（唯一事实源，DB 名 start-first-local-v1，store: snapshots，key: root）
  ↓ 仅用户主动导出
本机 JSON 文件
```

- **不是** React/Next/Vite 项目，**没有**构建产物，**没有**后端 API 参与用户流程。
- **IndexedDB 是唯一事实源**；服务器只提供静态文件，不保存任何任务。
- `code/backend/dev-server.js` 是**仅本机、默认关闭**的研究 API 参考实现，**不参与**用户流程，**不得**公网部署。
- 浏览器列为静态应用：只需要静态 HTTP 服务 + 正确的 MIME 与缓存策略。

### A.2 目录职责

| 路径 | 职责 | 是否部署到站点 |
| --- | --- | --- |
| `index.html` | 静态入口，唯一 `<script type="module">` | ✅ |
| `code/frontend/` | 渲染、交互、计时、恢复、样式 | ✅ |
| `code/domain/` | 纯领域状态机与守卫（无 IO） | ✅ |
| `code/algorithm/` | 确定性第一步建议引擎 v2 | ✅ |
| `code/persistence/` | IndexedDB 事务封装、快照不变式、导出 | ✅ |
| `code/backend/` | 研究 API 参考实现 + SQL 蓝图 | ❌ 绝不发布 |
| `tests/` | Node 单测 + Playwright 浏览器测试 | ❌ |
| `tests/deployed/` | **已部署站点**的验证测试（真实 nginx origin） | ❌ |
| `deploy/` | Linux 部署脚本与 nginx 配置 | ❌ |
| `scripts/` | benchmark、lab API 验证脚本 | ❌ |

发布内容是**白名单**（`deploy/env.sh` 的 `SF_PUBLISH_PATHS`），不是黑名单。

### A.3 启动方式

**本地开发（仅用于跑测试，不是生产服务）：**

```bash
python3 -m http.server 4173 --bind 127.0.0.1     # playwright.config.js 内置
# 或
npm run test:e2e                                  # 自动拉起上面的服务
```

**生产/交付形态（本机 nginx 容器，仅 loopback）：**

```bash
deploy/deploy.sh          # 构建 release → 原子切换 current → 校验并 reload → 健康检查
deploy/healthcheck.sh     # 只读健康检查（27 项）
deploy/serve.sh status    # 容器状态 / URL / 当前 release
deploy/serve.sh logs 200  # 访问日志
```

### A.4 完整测试命令

```bash
npm run verify                # 语法检查 + 53 个 Node 单测/契约测试
npm run benchmark:algorithm   # 12,000 次合成调用（吞吐信息，不是用户效果证据）
npm run test:e2e              # 34 个 Chromium 用例（本地 4173 harness）
npm run verify:lab-api        # 31 项研究 API 实测（会临时监听 127.0.0.1:4317）
npm run test:e2e:deployed     # 9 个用例，针对**已部署** nginx origin（需先部署）
```

首次在干净机器上运行浏览器测试必须先装浏览器：`npx playwright install chromium`（见 GOTCHA-006）。

### A.5 正常服务状态（"健康"长什么样）

| 项目 | 正常值 |
| --- | --- |
| 访问地址 | 本机 `http://127.0.0.1:8081`；局域网 `http://192.168.169.223:8081`（已获操作方授权开启） |
| 绑定地址 | `SF_BIND=0.0.0.0`（当前值，记录在 `/home/ubuntu/apps/start-first/deploy.env`）；`docker port start-first-web 80/tcp` → `0.0.0.0:8081` |
| 容器 | `start-first-web`，镜像 `nginx:1.27-alpine`，`Up`，`restart=unless-stopped` |
| `/healthz` | `200` + body `ok` |
| `/` | `200`, `text/html; charset=utf-8`, `Cache-Control: no-store` |
| `/code/frontend/main.js` | `200`, JS MIME（`application/javascript` 也合法）, `Cache-Control: no-cache` |
| 缺失资源 | 真 `404`（不是 200 的 HTML 兜底） |
| `code/backend/*`、`tests/*`、`package.json`、`deploy/*` | `404` |
| dotfiles（`/.git/config` 等） | `403` |
| 健康检查 | `deploy/healthcheck.sh` 输出 `All health checks passed.` |

### A.6 端口与冲突（本机事实，2026-11-09）

| 端口 | 占用情况 | 结论 |
| --- | --- | --- |
| 80 / 443 | `docker-ragflow-cpu-1` 容器 | **禁止改动**，他人业务 |
| 8080 | `igateway-*` 容器 | **禁止改动** |
| 4173 | 本项目 Playwright 开发 harness（测试时临时占用） | 仅用于测试 |
| 8081 | **本项目站点**（`start-first-web`，当前 `0.0.0.0`：loopback + LAN） | 可安全重载；非回环绑定由 `deploy.env` 记录 |
| 4317 | **本项目研究 API**（仅 `START_FIRST_LOCAL_TELEMETRY=1` 时临时占用） | 用完必须停止并确认端口关闭 |

### A.7 日志与配置文件位置

| 内容 | 位置 |
| --- | --- |
| 站点访问/错误日志 | `docker logs start-first-web`（json-file，`max-size=10m`, `max-file=3`） |
| nginx 配置（生效副本） | `/home/ubuntu/apps/start-first/conf/{server.conf,headers.inc,headers-html.conf}` |
| nginx 配置（源，随代码版本化） | `deploy/nginx/*` |
| 版本目录 / 当前版本 | `/home/ubuntu/apps/start-first/releases/<release>/`、`.../current`（**相对**软链） |
| 发布元数据 | `/home/ubuntu/apps/start-first/meta/<release>.json`（含 commit、分支、工作区是否脏） |
| 部署日志 | `deploy/deploy.sh` 的 stdout（`[deploy ...]` 前缀），可自行重定向保存 |

### A.8 可以安全执行的命令

```bash
deploy/healthcheck.sh                 # 只读
deploy/serve.sh status|logs|container-config
deploy/rollback.sh --list             # 只列出，不切换
npm run verify / benchmark:algorithm  # 不触碰部署
npm run test:e2e                      # 临时起 4173，结束自动关闭
curl -sS http://127.0.0.1:8081/healthz
docker exec start-first-web nginx -t  # 只校验配置
```

### A.9 必须先获得授权的操作

- 任何**公网暴露**：把 8081 转发到互联网、加反向代理、签发证书。当前 `SF_BIND=0.0.0.0` 仅用于**可信局域网**（无 TLS），不得再扩大。
- `sudo` / `apt` 安装（本机 `ubuntu` 用户**无免密 sudo**，见 GOTCHA-013）。
- 触碰其他容器/其他项目（ragflow、igateway、tmc-*、docker-*）。
- `docker system prune`、删除 `releases/`、删除 `meta/`。
- 用真实域名/真实用户数据做验证。
- 向远端 `main` 推送或合并。

### A.10 三条"不要"

1. **不要**默认启用 `code/backend/dev-server.js`（必须 `START_FIRST_LOCAL_TELEMETRY=1` 且 `NODE_ENV!=production`，否则直接退出）。
2. **不要**为了"清干净"而清除用户浏览器里的 IndexedDB——那里是真数据，且**不能**用命令行访问；只能由用户在设置里主动删除。
3. **不要**用 IP/域名/端口的变化去判断"数据丢了"：IndexedDB 按 origin 隔离，换 origin = 换数据库（见 Known Limitations）。

---

## B. 故障索引表

| ID | 分类 | 严重程度 | 症状关键词 | 状态 | 详情 |
| --- | --- | --- | --- | --- | --- |
| GOTCHA-001 | Deployment | P1（一旦触发站点全挂） | 全站 404、healthz 却 200、current 软链、容器内路径不存在 | FIXED | [→](#gotcha-001current-软链写成绝对路径导致容器内全站-404) |
| GOTCHA-002 | Frontend | P1 | 重复提交、Enter 连按、INVALID_TITLE、"还没有保存"但任务其实已保存 | FIXED | [→](#gotcha-002重复表单提交把成功保存报成失败invalid_title) |
| GOTCHA-003 | IndexedDB | P2 | 暂停后立刻切标签、SESSION_NOT_RUNNING、假的保存失败 | FIXED | [→](#gotcha-003暂停后立刻切走标签出现假的保存失败session_not_running) |
| GOTCHA-004 | Frontend | P2 | 多标签、另一个标签写入后本标签输入框失焦、光标跳到开头 | FIXED | [→](#gotcha-004另一标签写入导致本标签输入框失焦与光标丢失) |
| GOTCHA-005 | Security | P1（若有非 HTTPS 公网部署） | crypto.randomUUID is not a function、点击无反应、isSecureContext=false | FIXED | [→](#gotcha-005非安全上下文下捕获任务静默失败cryptorandomuuid-缺失) |
| GOTCHA-006 | Testing | P1（会误判为产品缺陷） | Executable doesn't exist、chromium_headless_shell-1194、19 failed | FIXED | [→](#gotcha-006playwright-浏览器版本与缓存不匹配制造-19-个假失败) |
| GOTCHA-007 | Deployment | P2 | npm ci 失败、package-lock.json 缺失 | FIXED | [→](#gotcha-007仓库缺少-lockfile导致-npm-ci-不可用) |
| GOTCHA-008 | Testing | P3（诊断陷阱） | application/javascript、MIME 断言过严、误改 nginx | PREVENTIVE | [→](#gotcha-008mime-断言过严是诊断陷阱不是产品缺陷) |
| GOTCHA-009 | Deployment | P3 | 80/443/8080 被占用、端口冲突 | PREVENTIVE | [→](#gotcha-009本机-804438080-已被其他项目占用) |
| GOTCHA-010 | Deployment | P3 | 找不到日志、logs/ 目录为空 | PREVENTIVE | [→](#gotcha-010日志在-docker-logs不在文件系统) |
| GOTCHA-011 | IndexedDB | P3 | 删除本地数据后仍有残留、appliedCommands、revision 非 0 | OPEN | [→](#gotcha-011删除本地数据后仍保留命令-id-残留) |
| GOTCHA-012 | Frontend | P2（UX 决策） | 另一标签开始会话后本标签被切到计时页 | OPEN | [→](#gotcha-012其他标签开始会话会把本标签切到计时页) |
| GOTCHA-013 | Linux | P3 | sudo 需要密码、无法 apt 安装 nginx | PREVENTIVE | [→](#gotcha-013本机无免密-sudo不能依赖系统-nginx-或-apt) |
| GOTCHA-014 | Testing | P2 | 真实配额耗尽未验证、只做了注入 | NOT_VERIFIED | [→](#gotcha-014真实存储配额耗尽未验证仅做注入) |
| GOTCHA-015 | Testing | P2 | onblocked、版本升级阻塞未验证 | NOT_VERIFIED | [→](#gotcha-015indexeddb-版本升级阻塞onblocked未验证) |
| GOTCHA-016 | Testing | P1 | iOS Safari / Firefox / Android / 真实设备未验证 | NOT_VERIFIED | [→](#gotcha-016非-chromium-与真实移动设备未验证) |
| GOTCHA-017 | Testing | P2 | 屏幕阅读器、WCAG 2.2 AA、200% 缩放未验证 | NOT_VERIFIED | [→](#gotcha-017无障碍审计未验证) |
| GOTCHA-018 | Deployment | P1（公网阻断项） | HTTPS、域名、证书、HSTS 未配置 | NOT_VERIFIED | [→](#gotcha-018https-与域名部署未验证公网阻断项) |
| GOTCHA-019 | Testing | P3 | 长会话、休眠唤醒、改系统时钟未验证 | NOT_VERIFIED | [→](#gotcha-019长会话休眠唤醒与系统时钟修改未验证) |
| GOTCHA-020 | Deployment | P1（若钉住 DHCP 地址） | Docker 绑具体 IP、容器起不来、cannot assign requested address、租约变化 | FIXED | [→](#gotcha-020把-docker-发布钉在-dhcp-地址上会让容器在租约变化后起不来) |
| GOTCHA-021 | Deployment | P1 | 默认 rollback 可能跳到更新版本 | FIXED | [详情](#gotcha-021) |
| GOTCHA-022 | Deployment | P1 | 发布健康检查失败仍暴露半更新站点 | FIXED | [详情](#gotcha-022) |
| GOTCHA-023 | Deployment | P1 | 拓扑漂移触发 docker rm -f | FIXED | [详情](#gotcha-023) |
| GOTCHA-024 | Security | P1 | 0.0.0.0 + 无 TLS + 防火墙未验证 | OPEN | [详情](#gotcha-024) |
| GOTCHA-025 | Security | P2 | deploy.env 任意变量名污染运行环境 | FIXED | [详情](#gotcha-025) |
| GOTCHA-026 | Deployment | P2 | 未版本化 JS/CSS 跨发布切换可能混版本 | **REPRODUCED** / OPEN | [详情](#gotcha-026) |
| GOTCHA-027 | Deployment | P2 | --no-restart 仍改变 current | FIXED | [详情](#gotcha-027) |
| GOTCHA-028 | Deployment | P2 | 失败发布留下的"无法激活 release"阻塞默认回滚链 | FIXED | [详情](#gotcha-028) |
| GOTCHA-029 | Deployment | P1 | 实地部署根目录无配置归档，PR #2 后回滚被阻塞（仅自动补齐上一版） | OPEN | [详情](#gotcha-029) |

---

## C. 每个问题的完整记录

### GOTCHA-001：`current` 软链写成绝对路径导致容器内全站 404

**状态：** FIXED
**优先级：** P1（触发时表现为"部署成功但站点完全不可用"）
**类别：** Deployment
**发现环境：** Ubuntu 24.04.3 / Node v22.23.3 / Docker 29.1.3 / nginx 1.27-alpine / commit `71071bfed912` / 本机 loopback 部署

**症状：**
`deploy/deploy.sh` 报告容器创建成功，`/healthz` 返回 `200 ok`，但 `/`、`/index.html` 以及所有 JS/CSS/SVG 全部 `404`。安全响应头（CSP、nosniff）却都存在——因为 `location` 匹配成功、只有文件找不到。

**最小复现步骤：**
```bash
# 把 deploy.sh 中的 current 软链改回绝对路径后：
ln -sfn /home/ubuntu/apps/start-first/releases/<release> /home/ubuntu/apps/start-first/current
docker exec start-first-web nginx -s reload
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/     # 404
curl -s http://127.0.0.1:8081/healthz                                # 200（假阳性）
```

**关键错误信息：**（来源：`docker logs start-first-web`）
```
2026/11/09 06:34:16 [error] 30#30: *1 open() "/srv/start-first/current/index.html" failed (2: No such file or directory)
```
注意日志里的路径看似正常，迷惑性很强；真正的问题是 `/srv/start-first/current` 指向 `/home/ubuntu/apps/start-first/releases/...`。

**根因：**
部署根目录以 `-v /home/ubuntu/apps/start-first:/srv/start-first:ro` 挂载进容器，而 `deploy.sh` 用 `ln -sfn "$REL_DIR"` 写入**绝对主机路径**。绝对符号链接在容器内按容器自身根目录解析，`/home/ubuntu/...` 在容器里不存在 → nginx 找不到文档根。

**根因证据：**
```bash
docker exec start-first-web ls -l /srv/start-first/current
# 修复前：current -> /home/ubuntu/apps/start-first/releases/...
docker exec start-first-web ls -l /srv/start-first/current
# 修复后：current -> releases/20261109T064425Z-71071bfed912   （相对）
readlink -f /home/ubuntu/apps/start-first/current                # 主机侧仍可正常解析
```
另外验证过：容器内挂载确实是宿主目录（`docker inspect -f '{{json .HostConfig.Binds}}'`）。

**修复方式：**
`deploy/deploy.sh` 与 `deploy/rollback.sh` 改为**相对**软链：`ln -sfn "releases/${REL_NAME}" current.new && mv -T ...`。`mv -T` 保证切换是原子的（不会出现软链短暂不存在）。相对软链同时满足：容器内可解析、主机侧 `readlink -f` 可解析、跨目录整体搬迁仍有效。

**影响范围：** 只有本次部署；`releases/` 内容与 `conf/` 均未损坏。用户数据（IndexedDB）在浏览器端，完全不受影响。

**修复验证：**
```bash
deploy/deploy.sh                # 健康检查 27 项全 ok，且 served index.html hash == 磁盘 release 的 hash
npm run test:e2e:deployed       # 9 passed
```

**回归测试：**
- `deploy/healthcheck.sh` 新增"served content matches the release on disk"检查（比对 `curl /` 与 `readlink -f current/index.html` 的 sha256）。这条检查专门防这类"HTTP 层看起来通、内容却不是那一个 release"的问题。
- `tests/deployed/deployed.spec.js`：`deployed entry point loads with strict headers and zero external requests`。

**预防措施：**
1. 部署根目录整体挂载 + 相对软链 + `mv -T`（已落地）。
2. 健康检查必须同时校验 `/healthz`（进程活着）与**真实内容**（字节一致），不能只 curl 首页状态码。
3. 新增静态资源 404 断言：缺失资源必须返回真 404，避免 HTML 兜底掩盖问题。

**关联文件与提交：** `deploy/deploy.sh`、`deploy/rollback.sh`、`deploy/healthcheck.sh`、`deploy/nginx/server.conf`。

**Agent 快速定位提示：**
如果下次出现"`/healthz` 通、首页 404"，先执行 `docker exec start-first-web ls -l /srv/start-first/current`，看软链是不是**相对**路径；然后执行 `deploy/healthcheck.sh` 看"served index.html matches release on disk"是否失败。**不要**去改 nginx `root` 指令、也**不要**把发布内容直接复制进容器——那是掩盖症状。

---

### GOTCHA-002：重复表单提交把成功保存报成失败（INVALID_TITLE）

**状态：** FIXED
**优先级：** P1（用户看到"没有保存"，实际已保存 → 状态误报 + 冗余失败事务）
**类别：** Frontend / IndexedDB
**发现环境：** Chromium 141（Playwright build 1194）/ commit `71071bfed912` / 本地 harness 4173

**症状：**
快速连续提交同一个表单（连按 Enter、`requestSubmit()` 调两次、脚本化点击），界面显示：
`刚才的操作还没有保存（INVALID_TITLE）。请重试，输入内容仍保留。`
但数据库中任务**已经创建成功**，页面停在清单页而不会前进。

**最小复现步骤：**
```js
// 在页面上下文里同步提交两次（等价于用户极快地按两次 Enter）
const form = document.querySelector("#capture-form");
form.requestSubmit();
form.requestSubmit();
```

**关键错误信息：**（来源：页面 `.notice.error` 文本 / 事务拒绝原因）
```
刚才的操作还没有保存（INVALID_TITLE）。请重试，输入内容仍保留。
```

**根因：**
`code/frontend/main.js` 的 submit 处理器把命令写成闭包并在**执行时**读取可变的模块状态：
```js
if (await persist(s => { createTask(s,{id,title:captureDraft,now:timestamp}); ... }))
```
第一次提交成功后处理器把 `captureDraft = ""`；第二个事务被 IndexedDB 串行化，在第一次提交**之后**执行，于是闭包读到空串 → `validateTaskText("")` → `INVALID_TITLE`。
同时，`submit` 按钮的 `disabled` 不能阻止重复提交：隐式提交（Enter）与 `requestSubmit()` 仍会派发 `submit` 事件（实测两次 `submit` 均触发）。

**根因证据：**
在页面里给 `IndexedStateStore.prototype.transact` 打点后实测：
```json
{"calls":[{"id":"e022…","phase":"start"},{"id":"3b02…","phase":"start"},
          {"id":"e022…","phase":"ok"},{"id":"3b02…","phase":"rejected","error":"INVALID_TITLE"}],
 "tasks":1,"revision":1,
 "notices":"刚才的操作还没有保存（INVALID_TITLE）。请重试，输入内容仍保留。"}
```
两个 submit 事件、两个事务、一个成功一个因空标题失败——与闭包读取时机完全一致。

**修复方式：**
1. 在提交处理器内先把输入**固化为局部常量**，命令闭包只引用该常量（`capture-form`/`edit-task-form`/`step-form` 全部处理）。
2. 增加按表单 id 的在途锁 `formsInFlight`，同一意图的重复提交直接忽略，不再产生第二个事务。
3. 顺带给 `submit` 与 `click` 处理器加 `catch`，任何意外异常都转成可见错误，不再静默。

**影响范围：** 只在"同一意图被并发提交"时发生；无数据丢失，但会误报失败并写入一条无用失败事务。

**修复验证：**
```bash
npx playwright test tests/browser/fault-injection.spec.js -g "duplicate submit"
# ✓ a duplicate submit of one intent creates one task and no false failure
#   断言：屏幕进入 focus、无 .notice.error、tasks==1、revision==1
```

**回归测试：** `tests/browser/fault-injection.spec.js` → `a duplicate submit of one intent creates one task and no false failure`。

**预防措施：** 命令闭包**只允许**引用局部不可变值；禁止在闭包内读取会被成功路径修改的模块级变量。新增表单时沿用 `formsInFlight` 模式。

**关联文件与提交：** `code/frontend/main.js`（`formsInFlight`、submit/click 处理器）。

**Agent 快速定位提示：**
如果下次看到"提示没保存、但刷新后数据其实在"，先检查是**哪个** `persist` 闭包读了模块级可变状态，再检查是否存在并发提交。**不要**通过"失败就自动重试"来掩盖——会放大成重复数据。

---

### GOTCHA-003：暂停后立刻切走标签，出现假的保存失败（SESSION_NOT_RUNNING）

**状态：** FIXED
**优先级：** P2
**类别：** Frontend / IndexedDB
**发现环境：** Chromium 141 / commit `71071bfed912`

**症状：**
点击"暂停一下"后立刻切换到别的标签/应用（或页面被隐藏），再回到本标签时看到红色错误：
`刚才的操作还没有保存（SESSION_NOT_RUNNING）。请重试，输入内容仍保留。`
而会话实际上**已成功暂停**（`status: paused`，只有一条 session）。

**最小复现步骤：**
```js
// 页面内同步执行：点暂停 → 立即触发一次真实的 visibilitychange
Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
document.querySelector('button[data-action="pause"]').click();
document.dispatchEvent(new Event("visibilitychange"));
// 600ms 后恢复可见并读状态
```

**关键错误信息：**
```
刚才的操作还没有保存（SESSION_NOT_RUNNING）。请重试，输入内容仍保留。
```

**根因：**
两个触发器（暂停按钮 / `visibilitychange` 自动暂停）在同一几十毫秒内各自调用一次 `stopRunning("pause")`。两次都读到内存里仍是 `running` 的会话，于是发出两个事务：第一个 `pauseSession` 成功，第二个对**已暂停**的会话再次 `pauseSession` → `checkpointSession` 的 `ensure(status === "running")` 抛 `SESSION_NOT_RUNNING` → `persist` 把它显示成保存失败。

**根因证据：**
```json
{"notice":"刚才的操作还没有保存（SESSION_NOT_RUNNING）。请重试，输入内容仍保留。",
 "isErrorNotice":true,"sessionStatus":"paused","sessions":1,"activeMs":14,"revision":4}
```
`sessionStatus: paused` + `sessions: 1` 证明写入其实是成功的，只有提示是错的。
对应代码：`code/domain/core.js` → `pauseSession` → `checkpointSession` → `ensure(session.status === "running", "SESSION_NOT_RUNNING")`。

**修复方式：**
把 `stopRunning` 改成**串行化 + 幂等**：
- 用模块级 `stopInFlight` 承诺锁合并并发请求（后到者先 await 前者，再基于**最新**状态判断）。
- 目标状态已达成时返回 `true` 并且**不再写库**（例如已暂停时的 `pause` 请求）。
- `end` 语义补全：可以把"仅暂停"的会话结束掉（`endSession(s, id, 0, now)`）。
- `end-session` 动作改为重新 `getSession()` 读取最新状态，不再使用 await 之前捕获的旧引用。

**影响范围：** 只影响提示与冗余事务，不丢数据；但会误导用户以为数据没保存。

**修复验证：**
```bash
npx playwright test tests/browser/visibility.spec.js
# ✓ pausing and then immediately leaving the tab reports no false failure
# ✓ a visibility change during a run pauses exactly once and adds no second session
# ✓ ending a paused session still reaches the review screen and records an outcome
```

**回归测试：** `tests/browser/visibility.spec.js`（5 个用例，含"隐藏期间时间不计入已验证时间"）。

**预防措施：** 任何"幂等语义"的写操作（暂停/结束/停止）都必须有在途锁 + 目标态判断；不要把"状态已达成"当成错误。

**关联文件与提交：** `code/frontend/main.js`（`stopInFlight`、`stopRunning`、`end-session` 分支）。

**Agent 快速定位提示：**
如果下次出现"操作提示失败但数据其实已写入"，先看是不是**同一个意图触发了两个事务**（按钮 + 可见性/卸载事件）。先合并、再判断目标态，**不要**简单吞掉错误提示。

---

### GOTCHA-004：另一标签写入导致本标签输入框失焦与光标丢失

**状态：** FIXED
**优先级：** P2（多标签可用性；后台计时每 5 秒 checkpoint 会周期性触发，所以很容易遇到）
**类别：** Frontend
**发现环境：** Chromium 141 / 两个真实标签页共享同一 origin

**症状：**
标签 A 正在输入任务标题，标签 B 做了任何写入（或 B 的计时器每 5 秒 checkpoint 一次），A 会被 `BroadcastChannel` 触发整页 `innerHTML` 重绘 → 输入框失去焦点、光标回到开头。文字内容本身**没有**丢失。

**最小复现步骤：**
1. 两个标签打开同一站点。
2. 标签 A：在"今天最难开始的是什么？"里输入文字，光标放在第 3 个字符。
3. 标签 B：创建任意任务。
4. 断言标签 A 的 `document.activeElement.id` → 实际为 `BODY`（期望 `capture-input`）。

**关键错误信息：** 无错误，纯静默 UX 退化。

**根因：**
`code/frontend/main.js` 的 `render()` 每次都整体替换 `root.innerHTML`；`repo.onRemoteChange` 回调无条件调用 `render()`。节点被替换后焦点自然回到 `body`，而 `captureDraft` 之类的草稿变量虽被保留，焦点与 `selectionStart` 未被恢复。

**根因证据：**
```
Expected: "capture-input"   Received: "BODY"     （修复前的测试失败输出）
```

**修复方式：**
`render()` 在重绘前记录当前在 `#app` 内的焦点元素 `id` 与 `selectionStart/End`；当**屏幕未变化**（`screen === lastRenderedScreen`）且该元素仍存在时，重绘后恢复焦点与选区。屏幕切换时保持原有"聚焦标题"的可访问性行为。

**影响范围：** 仅多标签/后台刷新场景的输入体验；不涉及数据。

**修复验证：**
```bash
npx playwright test tests/browser/multitab.spec.js
# ✓ typing in one tab keeps focus, caret and text when another tab writes
```

**回归测试：** `tests/browser/multitab.spec.js`（含"两个真实标签不能同时启动会话"）。

**预防措施：** 任何"整树重绘"都必须显式处理焦点与选区；新增屏幕时不要绕过 `render()` 的恢复逻辑。

**关联文件与提交：** `code/frontend/main.js`（`render()`）。

**Agent 快速定位提示：**
如果下次抱怨"打字打到一半焦点跑了"，先确认是否有其他标签/后台任务在写库（`BroadcastChannel`），再看 `render()` 的焦点恢复是否被新加的提前 `return` 绕过。

---

### GOTCHA-005：非安全上下文下捕获任务静默失败（crypto.randomUUID 缺失）

**状态：** FIXED（并已在部署层规避）
**优先级：** P1（若真按普通 HTTP 公网部署，功能直接不可用且**无任何提示**）
**类别：** Security / Frontend
**发现环境：** Chromium 141，origin `http://startfirst-insecure.test:8081`（通过 `--host-resolver-rules` 映射到 127.0.0.1，未新增任何监听端口）

**症状：**
用非 localhost 的纯 HTTP 域名访问时，点"帮我开始"没有任何反应：任务不创建、没有错误提示、输入内容还在、按钮重新可用。控制台只有未捕获异常。

**最小复现步骤：**
```bash
# 复用已部署站点，仅改变 origin（不新增监听）
npx playwright test tests/browser/insecure-origin.spec.js
```
或手动：`chromium --host-resolver-rules="MAP startfirst.test 127.0.0.1" http://startfirst.test:8081/`，输入任务并提交。

**关键错误信息：**（来源：浏览器 pageerror）
```
crypto.randomUUID is not a function
```

**根因：**
两层叠加：
1. `uuid()` 直接调用 `crypto.randomUUID()`，该 API **只在安全上下文**（`https:` 或 `localhost`/`127.0.0.1`）可用；`http://真实域名` 下为 `undefined`。
2. submit 处理器只有 `try/finally` 没有 `catch`，异常变成未处理的 Promise 拒绝 → UI 静默无反应（违反"失败不得伪装成功，也不得静默"）。

**根因证据：**
```json
{"origin":"http://startfirst.test:8081","isSecureContext":false,"hasRandomUUID":false,
 "screen":"inbox","notice":null,"hasInput":true}
captured errors: [ 'pageerror: crypto.randomUUID is not a function' ]
```
同一环境下 `typeof crypto.getRandomValues === "function"` 为 `true`（它**不**要求安全上下文）。

**修复方式：**
1. `uuid()`：优先 `crypto.randomUUID()`；否则用 `crypto.getRandomValues()` 生成合规 UUID v4（设置版本/变体位）；两者都不可用时抛 `CRYPTO_UNAVAILABLE`。
2. submit 与 click 处理器补 `catch`，把异常转成可见的"操作没有完成（…）"提示，绝不静默。

**影响范围：** 任何非 HTTPS 非 localhost origin。**注意：修复只是避免静默死路，不允许据此把公网 HTTP 当作可用部署形态**——公网仍必须 HTTPS（见 GOTCHA-018）。

**修复验证：**
```bash
npx playwright test tests/browser/insecure-origin.spec.js
# ✓ the origin really is an insecure context without crypto.randomUUID
# ✓ task creation still works and is never a silent no-op
# ✓ a genuinely unavailable browser API is reported instead of failing silently
```

**回归测试：** `tests/browser/insecure-origin.spec.js`（3 个用例）。

**预防措施：** 使用安全上下文 API 前显式探测；测试必须包含"最差环境"分支；提交/动作处理器必须有 catch。

**关联文件与提交：** `code/frontend/main.js`（`uuid()`、submit/click 处理器）、`tests/browser/insecure-origin.spec.js`。

**Agent 快速定位提示：**
如果下次出现"点击没有反应、控制台有 pageerror"，先看 `window.isSecureContext` 与 `typeof crypto.randomUUID`。**不要**用"加个 polyfill 就完事"掩盖：公网部署必须走 HTTPS。

---

### GOTCHA-006：Playwright 浏览器版本与缓存不匹配制造 19 个假失败

**状态：** FIXED
**优先级：** P1（会让人误判为产品缺陷——本次审计第一轮就踩到）
**类别：** Testing
**发现环境：** 本机 `~/.cache/ms-playwright` 已存在 1248/1254 版本缓存，但项目锁定 `@playwright/test@1.56.1` 需要 **1194**

**症状：**
`npm run test:e2e` 出现 19 个失败，每个错误都是：
```
Error: browserType.launch: Executable doesn't exist at
/home/ubuntu/.cache/ms-playwright/chromium_headless_shell-1194/chrome-linux/headless_shell
```
合计 19 failed —— 极易被误判为"产品/UI 全面崩坏"。

**最小复现步骤：**
```bash
ls ~/.cache/ms-playwright                       # 只有 1248/1254，没有 1194
npm run test:e2e                                # 19 failed
npx playwright install chromium                 # 下载 1194
npm run test:e2e                                # 19 passed
```

**关键错误信息：**（来源：playwright 输出）
```
Looks like Playwright Test or Playwright was just installed or updated.
Please run the following command to download new browsers:  npx playwright install
```

**根因：**
Playwright 的浏览器可执行文件按**自己的 build 号**寻址，与系统里其他项目装的 Chromium 不共享。缺 1194 时 `browserType.launch` 直接失败，**根本没有执行任何页面逻辑**。

**根因证据：**
```bash
cat ~/.cache/ms-playwright/.links/*    # 指向 Nebula-Notebook / TraceMap 的 playwright-core
npx playwright --version               # 1.56.1
```

**修复方式：** 运行 `npx playwright install chromium`（本次下载了 chromium 1194 + headless shell 1194 + ffmpeg 1011）。系统依赖已满足，无需 `--with-deps`；CI 里仍应保留 `--with-deps`。

**影响范围：** 仅测试环境。**产品本身当时是好的**（补装浏览器后 19/19 通过）。

**修复验证：** `npm run test:e2e` → `34 passed`（含新增用例）。

**回归测试：** 不需要新增用例，但 `docs/TESTING.md` 与 README 已写明首次需 `npx playwright install chromium`。

**预防措施：** 失败信息中出现 `Executable doesn't exist` / `browserType.launch` 时，先归类为**环境问题**，不要写进 gotchas 当产品缺陷。

**关联文件与提交：** `package.json`、`playwright.config.js`、`docs/TESTING.md`。

**Agent 快速定位提示：**
看到大量 `browserType.launch` 失败 → 先 `npx playwright install chromium`。**不要**先怀疑业务代码。

---

### GOTCHA-007：仓库缺少 lockfile，导致 `npm ci` 不可用

**状态：** FIXED
**优先级：** P2
**类别：** Deployment
**发现环境：** 初始 checkout `71071bfed912`

**症状：** 仓库根目录没有 `package-lock.json`；任何"照抄文档跑 `npm ci`"的流程会失败：`npm ci can only install with an existing package-lock.json`。

**最小复现步骤：**
```bash
ls package-lock.json      # 初始：No such file
npm ci                    # 失败
```

**根因：** lockfile 从未提交；CI 也只用了 `npm install`。

**修复方式：** `npm install --no-audit --no-fund` 生成并提交 `package-lock.json`（本次新增，2290 字节，仅含 `@playwright/test` 及其依赖）。运行期依赖为空，因此 lockfile 很小。

**影响范围：** 不影响运行期（应用无运行期依赖），只影响可重复构建。

**修复验证：**
```bash
npm install --no-audit --no-fund   # added 3 packages
npm run verify                     # 53/53
```

**预防措施：** 提交 lockfile；CI 的 `browser-smoke`/`deployment-smoke` 可改用 `npm ci`（当前仍为 `npm install`，两者都可用）。

**关联文件与提交：** `package-lock.json`（新增）。

**Agent 快速定位提示：** 若有人抱怨 `npm ci` 失败，确认 lockfile 是否存在于该分支；**不要**改成全局安装依赖。

---

### GOTCHA-008：MIME 断言过严是诊断陷阱，不是产品缺陷

**状态：** PREVENTIVE
**优先级：** P3
**类别：** Testing
**发现环境：** 本次审计（自建健康检查第一轮）

**症状：** 自建健康检查报错：
```
FAIL GET /code/frontend/main.js not HTML   expected=text/javascript actual=application/javascript; charset=utf-8
FAIL GET / content-type                    expected=text/html actual=text/html; charset=utf-8
```

**根因：** **断言写错了**，不是服务器错。按 WHATWG MIME Sniffing，`text/javascript`、`application/javascript`、`application/ecmascript`、`text/ecmascript` 都是合法的 JavaScript MIME；`Content-Type` 带 `; charset=utf-8` 参数同样正确。

**修复方式：** 把断言改为"落在合法集合内"、比较前剥离参数并统一小写（`deploy/healthcheck.sh` 的 `ctype_of` / `is_js_type`）。**没有**为了通过检查去改 nginx 的 MIME 配置。

**证据 / 回归：** `deploy/healthcheck.sh` 现输出 `GET /code/frontend/main.js is JS  yes`。

**预防措施：** 断言要表达**安全/正确性质**（"不是 HTML 被当成 JS"），而不是精确字符串。遇到 MIME 断言失败，先确认合法集合，再决定是否真的需要改服务器。

**Agent 快速定位提示：** 任何 MIME 失败，先 `curl -sSI` 看真实响应，再判断断言是否过严；**不要**用 `default_type`/`types` 覆盖去迎合测试。

---

### GOTCHA-009：本机 80/443/8080 已被其他项目占用

**状态：** PREVENTIVE
**优先级：** P3
**类别：** Deployment
**发现环境：** 本机 2026-11-09

**症状：** 想"用 80 端口顺便对外提供服务"时会与既有业务冲突。

**事实证据：**
```
docker-ragflow-cpu-1       0.0.0.0:80->80, 0.0.0.0:443->443
igateway-*                 0.0.0.0:8080->8080
tmc-anythingllm            0.0.0.0:3001->3001
```
本次部署因此选择 **127.0.0.1:8081**，不新增任何公网监听。

**预防措施：** 修改任何端口/绑定前先 `ss -tlnp` + `docker ps --format '{{.Names}}: {{.Ports}}'`；**默认保持 loopback**。

**Agent 快速定位提示：** 想改 `SF_PORT`/`SF_BIND` 前先确认端口归属；**不要**停掉别人的容器腾端口。

---

### GOTCHA-010：日志在 `docker logs`，不在文件系统

**状态：** PREVENTIVE
**优先级：** P3
**类别：** Deployment

**症状：** 在 `/home/ubuntu/apps/start-first/logs/` 里找不到访问日志。

**根因：** 本次实现让 nginx 输出到容器 stdout，由 Docker json-file 驱动保存（`--log-opt max-size=10m --log-opt max-file=3`）。这样避免宿主目录需要给容器内 uid 写权限（本机无免密 sudo，chown 受限）。

**正确用法：**
```bash
deploy/serve.sh logs 200          # 最近 200 行
docker logs --since 10m start-first-web
```

**预防措施：** 不要在 `logs/` 里找日志；也不要把 `logs/` 挂进容器（会引入权限问题）。

---

### GOTCHA-011：删除本地数据后仍保留命令 ID 残留

**状态：** OPEN（已复现，低风险，需产品决策）
**优先级：** P3
**类别：** IndexedDB
**发现环境：** 已部署站点 `http://127.0.0.1:8081`

**症状：** 在"设置 → 删除此设备全部数据"并确认后，任务/步骤/会话/批次确实都清空，但快照里仍保留**命令 ID 列表**与递增后的 `revision`。

**最小复现步骤：**
1. 连续创建 3 个任务。
2. 设置 → 删除此设备全部数据 → 确认。
3. 读取 IndexedDB 快照。

**关键观察数据：**
```json
{"tasks":0,"steps":0,"sessions":0,"batches":0,"revision":4,"appliedCommandIds":4,
 "sample":["76ff86ab-…","1ae92138-…"]}
raw record contains any task text? false
```

**根因：** `code/persistence/store.js` 的 `applyCommand` 在命令返回完整状态（如 `emptyState()`）时，仍执行
`next.revision = state.revision + 1` 与 `next.appliedCommands = [...state.appliedCommands, commandId].slice(-512)`，因此 `appliedCommands` 会跨"清空"继续累积（上限 512）。

**为何暂不修：** `appliedCommands` 是**幂等日志**：保留它可以避免"清空之前发出的命令"在清空之后被重放。清空它会让 UI 契约（`appliedCommands` 去重）与跨清空边界的重放语义变弱。UI 文案只承诺清除"任务、步骤和会话"，残留的是**不含任何用户文本**的随机 UUID。这是产品取舍，需要产品方确认。

**影响范围：** 仅浏览器本地快照中的元数据；**不含**任务正文、不含任何外发数据。设备上的取证/隐私暴露面极小。

**建议修复（需确认后执行）：** 在 UI 的"清空"路径显式重置 `revision`/`appliedCommands`（例如新增 `wipe` 命令类型，由 `persistence` 层识别并重建快照），同时补充"清空后重放旧命令 ID 不得复活数据"的测试。

**Agent 快速定位提示：** 若被问"删除干净了吗"，答案是：用户内容已清空、元数据有界残留。**不要**声称"服务器上也删了"，也不要说"完全无痕"。

---

### GOTCHA-012：其他标签开始会话会把本标签切到计时页

**状态：** OPEN（设计取舍，需产品决策）
**优先级：** P2（UX）
**类别：** Frontend / 多标签

**症状：** 标签 A 停在清单页准备输入，标签 B 启动了一个 2 分钟会话；A 收到 `BroadcastChannel` 刷新后，因为共享同一 IndexedDB，A 的 `getSession()` 也返回该会话，于是 A 的屏幕被切到计时页，A 的输入被打断（草稿保留但屏幕跳走）。

**根因：** `code/frontend/main.js` `boot()` 里的 `repo.onRemoteChange` 回调根据"是否存在会话"强制设置 `screen`，而会话状态是同一 origin 共享的。

**说明：** 单设备单用户前提下"两个标签看到同一个会话"是合理的；不合理的是**无条件打断当前标签正在进行的输入**。可选方案：仅在当前屏幕为 `timer`/`review`/`inbox` 且用户没有未提交草稿时才切换；或提示"另一个标签开始了一个会话"。

**证据：** 多标签测试已覆盖"两个真实标签不能同时启动会话"（数据正确性 OK）；打断行为属于 UX，尚未被测试固化。

**Agent 快速定位提示：** 数据不会出错，别去改持久化层；改动应限定在 `onRemoteChange` 的屏幕切换条件。

---

### GOTCHA-013：本机无免密 sudo，不能依赖系统 nginx 或 apt

**状态：** PREVENTIVE
**优先级：** P3
**类别：** Linux

**事实证据：**
```bash
sudo -n true   # → sudo: a password is required
command -v nginx   # → MISSING
```
系统目录 `/srv`、`/opt` 均为 root 所有。

**结论与应对：** 本项目采用 **Docker + nginx:1.27-alpine**，把 nginx 配置文件挂载进容器（`deploy/nginx/*` → `/etc/nginx/conf.d/`），因此：
- 无需 apt/sudo；
- 配置**随代码版本化**，可 review、可回滚；
- 不污染系统 nginx、不影响其他业务站点。

**Agent 快速定位提示：** 不要尝试 `apt install nginx` / `systemctl`；要改 nginx 行为请改 `deploy/nginx/*` 并重新 `deploy/deploy.sh`（会做 `nginx -t` 再 reload）。

---

### GOTCHA-014：真实存储配额耗尽未验证（仅做注入）

**状态：** NOT_VERIFIED
**优先级：** P2
**类别：** Testing / IndexedDB

**已做的部分（可复现）：** `tests/browser/fault-injection.spec.js` 通过替换 `IDBObjectStore.prototype.put` 抛出 `QuotaExceededError`，验证了：
- 界面显示"刚才的操作还没有保存（…）"，**不会**伪装成功；
- 失败后数据确实未提交（`tasks: 0, revision: 0`）；
- 重试可以成功且只提交一次。

**仍未验证：** 真实磁盘配额耗尽、真实浏览器配额提示（如 Chrome 的存储压力驱逐）、`navigator.storage.estimate()` 相关行为、以及配额不足时 IndexedDB 打开失败的表现。

**验证方法建议：** 在真实 Chromium 上用 DevTools 或 `--enable-features=StorageQuota...`、填满磁盘后复现；或使用持久化 context 写大对象直到触发真实 `QuotaExceededError`。

---

### GOTCHA-015：IndexedDB 版本升级阻塞（onblocked）未验证

**状态：** NOT_VERIFIED
**优先级：** P2
**类别：** Testing / IndexedDB

`code/persistence/store.js` 已实现 `request.onblocked → reject("DATABASE_UPGRADE_BLOCKED")` 与 `db.onversionchange` 关闭处理，但**当前 schema 恒为版本 1**，无升级路径，因此该分支在真实浏览器中从未被触发。`tests/invariants.test.js` 只覆盖了"遇到不支持的 schemaVersion 时 fail closed（不静默清空）"。

**验证方法建议：** 手动把 DB 版本提到 2（临时脚本），在另一个标签持有连接的情况下打开，确认应用显示存储不可用而不是静默失败/静默清库。

---

### GOTCHA-016：非 Chromium 与真实移动设备未验证

**状态：** NOT_VERIFIED
**优先级：** P1
**类别：** Testing / 兼容性

**已验证：** Chromium 141（Playwright build 1194）下的 1440px / 375px / 320px 布局、明暗主题、键盘 skip link、无水平溢出（含 inbox→focus→ready→timer→review 全屏）。

**未验证（不得声称通过）：** iOS Safari、桌面 Safari、Firefox、Android Chrome、真实物理设备、浏览器存储驱逐、无痕模式下的行为。服务器环境无法运行这些组合。

**验证方法建议：** 使用真实设备或云设备农场，重点验证：IndexedDB 在 Safari 无痕模式下的行为差异、`BroadcastChannel` 支持、时间精度（`performance.now()` 精度裁剪）。

---

### GOTCHA-017：无障碍审计未验证

**状态：** NOT_VERIFIED
**优先级：** P2
**类别：** Testing / 可访问性

**已验证：** 屏幕切换后标题聚焦（`h1/h2` `tabindex=-1`）、skip link 键盘可达、`aria-pressed`/`aria-current` 状态、表单 label 关联、按钮可达性。

**未验证：** NVDA/JAWS/VoiceOver 真实屏幕阅读器朗读、WCAG 2.2 AA 完整审计（对比度、200% 缩放、重排、目标尺寸）、焦点顺序全流程。

**验证方法建议：** axe-core 自动扫描 + 真实屏幕阅读器人工走查 + 200% 缩放下的 320px 重排检查。

---

### GOTCHA-018：HTTPS 与域名部署未验证（公网阻断项）

**状态：** NOT_VERIFIED / 上线阻断项
**优先级：** P1
**类别：** Deployment / Security

**现状：** 本次部署**仅** `http://127.0.0.1:8081`（loopback，属安全上下文，`crypto.randomUUID` 可用，IndexedDB 正常）。**未**配置域名、证书、HTTP→HTTPS 跳转或 HSTS，因为未获得域名与公网授权。

**为什么不能直接用普通 HTTP 对外：** 见 GOTCHA-005，非安全上下文会缺失 `crypto.randomUUID`（已加降级，但公网仍必须 HTTPS，因为 IndexedDB/其他能力与用户信任都要求安全传输）。

**公网部署必须补齐：**
1. TLS 终结点（宿主 nginx/Caddy 或云 LB），证书自动续期；
2. HTTP→HTTPS 301 + HSTS；
3. `SF_BIND` 仍可保持 loopback，由反向代理转发；
4. **不要**把 `code/backend/dev-server.js` 接进反向代理；
5. 明确的域名与授权记录，并更新 `deploy/nginx/server.conf` 的 `server_name` 与 `SF_URL`。

---

### GOTCHA-019：长会话、休眠唤醒与系统时钟修改未验证

**状态：** NOT_VERIFIED
**优先级：** P3
**类别：** Testing / 计时

**已验证（可复现）：** `tests/browser/visibility.spec.js` 证明隐藏标签期间的时间**不计入**已验证前台时间（隐藏 1.5s 后 `activeMs` 增量 < 600ms）；刷新运行中的会话会安全暂停且不猜测后台时间。

**未验证：** 10 分钟长会话的实际精度、笔记本休眠/唤醒、跨时区或系统时钟被修改（`performance.now()` 通常是单调时钟，但 `startedAt/endedAt` 使用 `Date.now()`，时钟被改会影响这两个展示字段）、用户切到其他应用继续工作的场景（产品明确不计入，属设计取舍）。

**验证方法建议：** 长会话定时采样对比 `activeMs` 与真实时间；修改系统时钟后复测 `startedAt/endedAt` 展示；休眠唤醒后确认会话被安全暂停。

---

### GOTCHA-020：把 Docker 发布钉在 DHCP 地址上会让容器在租约变化后起不来

**状态：** FIXED（已避免，并在 `deploy.env` 中写明原因）
**优先级：** P1（触发时整体不可用，连 loopback 一起挂）
**类别：** Deployment / Linux
**发现环境：** 操作方要求开通局域网访问时（2026-11-09）

**症状（已避开，非已发生故障）：** 主机 IP 变化/路由器重启后容器无法启动：
`Error response from daemon: … cannot assign requested address`
站点（包括本机 loopback）全部不可用。仅凭 `curl` 会表现为“什么都没有”，容易误判为 nginx 配置坏了。

**最小复现步骤（隔离环境）：**
```bash
SF_BIND=192.0.2.77 SF_PORT=8099 SF_CONTAINER=start-first-dhcp-repro \
  SF_DEPLOY_ROOT=/tmp/sf-dhcp-repro bash deploy/deploy.sh
# 192.0.2.77 不属于本机 → docker run 失败：cannot assign requested address
```

**根因：** 为了“只暴露一个局域网地址”而写成 `-p 192.168.169.223:8081:80`，但该地址是 **DHCP 动态分配**：
```
$ ip -4 addr show eno1
    inet 192.168.169.223/23 … scope global dynamic noprefixroute eno1
    valid_lft 299452sec preferred_lft 299452sec
```
租约失效后内核无法绑定不再属于本机的地址，容器启动失败。

**根因证据：** `dynamic` 标记 + `valid_lft`（约 3.5 天）；网络由 NetworkManager + cloud-init/netplan 管理，`/etc/netplan/*.yaml` 未配置静态地址。

**修复方式（已采用）：** `SF_BIND=0.0.0.0`。在本机上它等价于 `lo` + `eno1`(LAN) + Docker 网桥（172.x，仅本机与容器可达），既不依赖具体地址也没有真正扩大到额外网络。同时 `SF_URL=http://127.0.0.1:8081`，让本地健康检查与测试仍走 loopback。
未来确定地址后（静态 IP 或反向代理转发）再改为 `SF_BIND=127.0.0.1 192.168.169.223` 或 `SF_BIND=127.0.0.1`。

**影响范围：** 仅发布绑定；`releases/`、`conf/`、用户数据（浏览器 IndexedDB）均不受影响。

**修复验证：**
```
docker port start-first-web 80/tcp      → 0.0.0.0:8081
curl 127.0.0.1:8081/healthz             → 200
curl 192.168.169.223:8081/healthz       → 200
docker run --rm --network bridge curlimages/curl -s -o/dev/null -w '%{http_code}' 172.17.0.1:8081/healthz   → 200（非 loopback 路径）
deploy/serve.sh restart                 → 绑定不变
deploy/healthcheck.sh                   → All health checks passed（含 warn：无 TLS 的局域网暴露）
SF_URL=http://192.168.169.223:8081 npm run test:e2e:deployed   → 9/9
```

**回归测试：** `deploy/healthcheck.sh` 改为逐地址断言“每个 `SF_BIND` 都已发布”，并对非回环地址打印 `warn`；`deploy.sh` 新增绑定/镜像/挂载**漂移检测与容器重建**；`tests/deployed/deployed.spec.js` 新增“本次验证的 origin 是否为安全上下文”的显式断言（loopback/https 断言 `crypto.randomUUID` 可用；局域网纯 HTTP 则断言走 `getRandomValues` 降级且任务仍可创建）。

**预防措施：** 钉具体地址前先用 `ip -4 addr show <iface>` 确认不是 `dynamic`；把拓扑写入 `deploy.env`（被解析、不 `source`，不能执行代码）以保证可重复。

**关联文件与提交：** `deploy/env.sh`、`deploy/deploy.sh`、`deploy/healthcheck.sh`、`tests/deployed/deployed.spec.js`、`/home/ubuntu/apps/start-first/deploy.env`。

**Agent 快速定位提示：** 若容器突然起不来且日志是 `cannot assign requested address`，先查 `SF_BIND` 是否钉了某个具体 IP、该 IP 是否仍在本机。临时解决：改成 `0.0.0.0` 或换成当前真实地址后重跑 `deploy/deploy.sh`。**不要**去改 nginx 配置或反复 `docker restart`。

---

## Follow-up review（PR #2，安全发布与回滚）

**证据边界：** 本节的 FIXED 代表 GitHub Actions 及隔离模拟测试已通过，不代表操作方的 Ubuntu 主机已经重新部署。本节不覆盖 GOTCHA-001～020 原有现场证据。详见 tests/deployment/scripts-regression.sh 和 PR #2。

### GOTCHA-021

**默认 rollback 会向前切换（FIXED / P1 / Deployment）**

症状与根因：旧 rollback.sh 从所有 release 中选择“最新且与当前不同”的目录。若按 r3→r2 回滚，再执行一次默认 rollback 反而切到 r3。安全语义应当是仅选择比当前更旧的 release。

修复：严格选择较早版本，前进到新版本必须明确指定 release 名。回滚时同时检查目标 release 的 nginx 配置归档。

验证：隔离模拟连续回滚 r3→r2→r1；再回滚明确失败。CI 在真实 nginx 容器内完成二次部署与回滚，并验证站点健康。Agent 优先使用 deploy/rollback.sh --list 核实历史，不要只比较版本是否不同。

### GOTCHA-022

**部分激活后健康检查失败（FIXED / P1 / Deployment）**

根因：旧 deploy.sh 先覆盖 nginx 配置并切换 current，再 nginx -t / healthcheck；失败时退出，站点留在不一致状态。旧 rollback.sh 不还原 nginx 配置。

修复：将每次 nginx 配置归档到 config-releases/<release>/；先用无网络的一次性 nginx 容器做语法预检；激活阶段保存原 current/配置，失败时退出钩子尝试恢复两者；rollback 也恢复目标配置。

验证：隔离注入“配置预检失败”和“发布后健康检查失败”，确认原链接及三个配置文件保持不变；真实 Docker CI 检验了正常部署与回滚。

限制：EXIT 退出钩子无法保证断电、SIGKILL 或硬盘损坏后的自动恢复。实际 Linux 服务器仍需重演故障演练；恢复后必须运行 deploy/healthcheck.sh。

### GOTCHA-023

**漂移导致自动删除容器（FIXED / P1 / Deployment）**

根因：前次部署脚本检测到镜像或端口漂移，会直接执行 docker rm -f 并重建。共享服务器上仅凭容器名不足以证明可以安全删除，而且重建失败可能让站点持续下线。

修复：fail closed。先检查容器运行状态、镜像、发布地址精确集合及文件系统根挂载；任何漂移均拒绝激活，不执行自动删容器。拓扑变更需要单独授权和回退计划。

验证：模拟现有容器绑定不符，断言旧 current/配置不变且从未调用 docker rm。Agent 应检查 docker port、docker inspect 后单独规划变更。

### GOTCHA-024

**局域网明文 HTTP 与所有网卡监听风险（OPEN / P1 / Security）**

证据：实地分支的 deploy.env 使用 SF_BIND=0.0.0.0、SF_PORT=8081，未配置 HTTPS，UFW 规则因缺乏 sudo 权限没有被验证。0.0.0.0 代表所有 IPv4 网卡；“只在局域网”不能仅凭 Docker 绑定值推断，新增网卡/路由规则也可能扩大暴露。

威胁：即使正常前端不上传任务正文，HTTP 中间人仍可能替换同源 JS，进而读取 IndexedDB 并外传用户任务。CSP 和“零业务出站请求”无法阻止被篡改的同源资源执行。

建议：优先回环绑定 + HTTPS 反向代理，或 SSH 端口转发；在可信局域网也推荐 HTTPS。若必须保留 0.0.0.0，先实际核实 nftables/iptables/UFW、云安全组、路由器端口转发和远端设备的可达边界。无证据不得标记公网安全。

本 PR 未更改用户服务器当前绑定，未远程执行任何修改。

### GOTCHA-025

**deploy.env 任意变量名注入（FIXED / P2 / Security）**

原解析器虽然没有 source 配置文件，却对任意 KEY=value 做 printf -v 赋值；恶意/误配置 PATH 等变量可能改变脚本后续命令执行环境。

修复：只允许 SF_BIND、SF_PORT、SF_URL 三个已文档化键；拒绝其他名称，且在读取前先定义错误处理函数，不执行 eval/source。

验证：测试将 PATH=/tmp/attacker-path 写入隔离 deploy.env，确认脚本拒绝执行且当前发布不变。

### GOTCHA-026

**静态资源混版本风险（OPEN / P2 / Deployment）**

现有 index.html 和 JS/CSS 路径未包含 release ID。Cache-Control: no-cache 只是重新验证；若浏览器取得 HTML 后恰好发生版本切换，后续模块请求仍可能命中新版本代码，而非同一 release 快照。

建议：如进入持续对外服务阶段，给每次发布生成不可变版本资源路径，并补充受控延迟/并发发布测试。尚未实现，不能把单文件 SHA 检查当作解决此问题。

### GOTCHA-027

**--no-restart 仍切换 live 版本（FIXED / P2 / Deployment）**

旧命令跳过重启前已经切换 current，站点实际上发生了版本变化。现在兼容参数代表真正的 stage-only：生成静态 release、归档配置及执行 preflight，但不切换 current 或 reload。

另一个问题是旧 worktreeDigest 只哈希 git status 文件名/状态，不反映改动内容。现在 release 元数据有 publishedContentSha256，计算实际发布文件的有序内容摘要。dirty release 仍不可仅靠 commit SHA 复现，应优先采用干净提交发布。

验证：隔离测试阶段发布不触及 current/配置；所有内容哈希仍需按实际服务器发布元数据核查。

---

## D. Known Limitations（能力边界，不是 BUG）

以下均为**产品边界**，请勿当作待修缺陷，也不要对外宣称已实现：

| 能力 | 现状 | 说明 |
| --- | --- | --- |
| 跨设备同步 | ❌ 未实现 | 无账户、无云同步；只有一个浏览器一个 origin |
| JSON 导入/恢复 | ❌ 未实现 | 只能**导出**快照；请勿声称"可恢复备份" |
| PWA 冷启动离线 | ❌ 未实现 | 无 Service Worker、无 manifest 安装；仅在"首次加载完成后"可离线继续操作（已有测试覆盖） |
| 服务端研究数据收集 | ❌ 未部署 | 参考实现仅 loopback 且默认关闭；前端从不上报 |
| 生产级 PostgreSQL API | ❌ 不存在 | `code/backend/schema.sql` 只是蓝图；内存实现**不得**当生产库 |
| IndexedDB 随 origin 迁移 | ❌ 不可能 | 换域名/IP/端口 = 换数据库；数据**不会**自动迁移 |
| 关闭浏览器期间的真实工作时间 | ❌ 无法确认 | 明确不计入；这是"诚实计时"的设计取舍 |
| 提醒/通知、TODO 集成、AI 建议 | ❌ 未实现 | 无 LLM、无外部集成 |
| 开源许可 | ❌ 未选择 | 公开可见 ≠ 授权复用 |
| 效果证据 | ❌ 无 | 无随机对照研究；算法吞吐量与"减少拖延"无关 |

---

## E. 新 Agent 启动检查清单（5～10 分钟，只读优先）

```bash
# 1. 定位与版本（只读）
cd /home/ubuntu/codes/anti-procrastination-todo
git status -sb && git log --oneline -1 && git rev-parse HEAD
node -v && npm -v && docker --version

# 2. 依赖与语法（只读，不改部署）
ls node_modules >/dev/null 2>&1 || npm ci         # 有 lockfile，可用 npm ci
npm run verify                                    # 期望 53/53 pass

# 3. 部署状态（只读）
deploy/serve.sh status
deploy/healthcheck.sh                             # 期望 "All health checks passed."

# 4. 端口与暴露面（只读）
ss -tln | grep -E ':8081|:4173|:4317'             # 8081 按 SF_BIND（当前 0.0.0.0）；4173/4317 不应长期监听
docker port start-first-web 80/tcp                # 应与 deploy.env 的 SF_BIND/SF_PORT 一致
cat /home/ubuntu/apps/start-first/deploy.env      # 服务器本机拓扑（绑定地址、端口、SF_URL）
for u in http://127.0.0.1:8081 http://192.168.169.223:8081; do curl -sS -o /dev/null -w "$u %{http_code}\n" "$u/healthz"; done

# 5. 站点真实性（只读）
curl -sS http://127.0.0.1:8081/healthz           # ok
curl -sSI http://127.0.0.1:8081/ | grep -iE 'content-security-policy|cache-control|x-content-type'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8081/code/backend/dev-server.js   # 404

# 6. 浏览器测试入口（只需一次环境准备）
npx playwright install chromium                   # 仅在报 Executable doesn't exist 时需要
npm run test:e2e                                  # 期望 34 passed
npm run test:e2e:deployed                         # 期望 9 passed（需站点在跑）
npm run verify:lab-api                            # 期望 31/31（会临时占用 4317）
```

**安全（无需授权）：** 上面全部只读命令、`npm run verify/test:e2e`、`deploy/healthcheck.sh`、`deploy/serve.sh status|logs`、`deploy/rollback.sh --list`、`docker exec start-first-web nginx -t`。

**必须先授权：** 把 8081 转发到互联网 / 加反向代理或证书 / 把 `SF_BIND` 再扩大；`sudo`/`apt`；停止或修改他人容器；`docker system prune`；删除 `releases/`/`meta/`/`deploy.env`；公网暴露研究 API；向远端 `main` 推送或合并。

> **当前暴露面（重要）：** 站点在 **`0.0.0.0:8081`**，即**可信局域网可达、无 TLS**（操作方明确请求）。它**不是**公网部署：不要把 8081 转发到互联网；IndexedDB 按 origin 隔离，`http://192.168.169.223:8081` 与 `http://127.0.0.1:8081` 是**两个独立数据库**。

**接手顺序建议：**
1. 先第 3、5 步确认"站点是不是真的健康"。
2. 再读本文件 B 节索引表，按症状关键词定位。
3. 修改前先跑 `npm run verify` + `npm run test:e2e` 建立基线，**再**动代码（哪怕是文档改动）。
4. 改完必须：单项回归 → 全量回归（`verify` + `test:e2e` + `test:e2e:deployed` + `verify:lab-api`）→ 重新部署 → `healthcheck` 通过 → 更新本文档。

---

## Round 3 review（PR #2 在真实 Linux 服务器上的孤立验证，2026-11-09）

**验证环境：** Ubuntu 24.04.3 LTS · Docker 29.1.3 · nginx/1.27.5（容器）· Node v22.23.3 · Chromium 141.0.7390.37 (Playwright build 1194)
**被测 commit：** `0767c05e0a642068b1833499c2e0ce261a2477fd`（分支 `verify/linux-field-validation-20261109`）
**孤立环境：** 部署根 `/home/ubuntu/apps/start-first-pr2-staging`、容器 `start-first-pr2-staging`、`127.0.0.1:18081`。**真实运行中的服务**（`start-first-web` @ `0.0.0.0:8081、`/home/ubuntu/apps/start-first`）在每个场景前后都断言了容器 ID / current 软链 / 端口绑定 / HTTP 状态未变。
**证据边界：** 本节除 GOTCHA-029 外均为**在真实 Docker + 真实 nginx 上的隔离现场实测**；GOTCHA-029 的部分数据来自**实地部署根目录的只读快照 + 其副本上的升级预演**（未修改真实服务）。不覆盖 GOTCHA-001～020 的原有现场证据。

### GOTCHA-021 / 022 / 023 / 025 / 027 的再次验证（真实 nginx，非仅 CI）

| ID | 本次真实环境验证方式 | 结果 |
| --- | --- | --- |
| 021 | 孤立根上连续默认回滚，直到最旧 release | PASS：只向更旧移动（`…792010157 -> …171485480`），到最旧后**拒绝**且不前进 |
| 022 | 用 `SF_URL=http://127.0.0.1:19999` 使激活后健康检查必败 | PASS：非零退出、输出 `restoring previous code AND nginx configuration`、current 与三个 nginx 配置文件 sha256 均恢复到失败前、容器 ID 未变、站点重新 200、无残留 `.activation-backup.*` |
| 023 | 注入镜像 / 端口 / 文档根挂载漂移（真实 `docker inspect`/`docker port`） | PASS：全部 fail-closed，报 `image drift`/`port drift`/`mount drift`，**容器 ID 未变（从未执行 docker rm -f）**，current/配置未变，站点仍 200 |
| 025 | 在孤立根写 `PATH=/tmp/attacker-path` 的 deploy.env | PASS：脚本拒绝执行（`unknown/invalid key`），当前发布未变 |
| 027 | 真实执行 `deploy.sh --no-restart` | PASS：release 与配置归档已生成、preflight 通过，但 `current` **不存在**、`conf/` 未改动 |

因此原“仅在 CI 通过”的限制已解除：以上机制**已在真实 Docker + 真实 nginx + 真实文件系统上复现并验证**（`tests/deployment/staging-fault-injection.sh`，89/89）。

### GOTCHA-026

**未版本化静态资源的跨发布混版本风险（REPRODUCED / OPEN / P2 / Deployment）**

**状态更新：** 由“代码审查推测”升级为**已复现**。实验：`tests/deployment/mixed-version-lab.mjs`（11/11 观察项）。

**症状（实测）：** 同一份文档在执行过程中拿到了**两个不同 release 的模块**：文档 HTML 来自 release A，而 `code/frontend/main.js`、`code/domain/core.js`、`code/frontend/styles.css` 均来自 release B。

**最小复现步骤：**
```bash
# 孤立 staging 环境；用带标记（MIXMARK-A/B）的仓库副本，标记只影响可观测性
SF_URL=http://127.0.0.1:18081 SF_DEPLOY_ROOT=<staging根> MIX_SHIM=<shim仓库> \
  node tests/deployment/mixed-version-lab.mjs
# 步骤：加载页面并“挂住” main.js 请求 → 真实执行 deploy.sh（切换 current）→ 放行请求
```

**真实证据：**
```
  ok   HTML in the document came from release A
  ok   deploy really switched current  -> 20261109T081433Z-… -> 20261109T081437Z-…
  ok   the same document then executed main.js from release B
       -> document HTML=release A, main.js=release B, core.js=release B, styles.css=release B
  ok   the mixed state really spans two different release directories
```
两个标记分别落在两个不同的 `releases/<name>/` 目录中，因此这**不是**观测误差。

**跨 release schema 偏移时的实际后果（实测，非推测）：**
把 release A 的 `core.js` 中 `emptyState().schemaVersion` 改成 97（模拟真实跨版本 schema 变化），其余资源来自 release B：
```json
{"screen":"inbox","hasCaptureInput":false,"errorNotice":true,
 "notice":"本地存储不可用。为了避免误以为已经保存，当前无法创建任务。请检查浏览器隐私设置或尝试常规窗口。"}
```
结论：应用**fail-closed**（`UNSUPPORTED_SCHEMA` → 存储不可用、无法创建任务），**没有**静默清空数据、**没有**伪造保存成功；既有任务（1 条）在混版本前后**完好**（`before=1 after={"tasks":1,"readError":null}`）。即：最坏现实后果是“刷新前不可用”，**不是数据损坏**。

**仍存在的风险：** 混版本窗口真实存在（HTML 与模块请求之间发生发布即可命中；模块图内部的嵌套 import 窗口更窄但同样存在）。当前 `Cache-Control: no-cache` 只保证重新验证，无法阻止跨版本取值。

**最小修复方案（已设计，尚未实现 —— 需单独变更计划）：**
1. 部署时把 `index.html` 的 `./code/`、`./assets/` 引用重写为**按发布固定**的 `/v/<REL_NAME>/…`（仅 3 处引用；`href="./"`、`#main` 保持不动，因此不改交互语义）。应用内部相对 import 会自然解析到同一 `release` 前缀，无需改动任何模块代码（不引入构建框架）。
2. nginx 新增 `location ^~ /v/`：`alias /srv/start-first/releases/$rel/…;` + `Cache-Control: public, max-age=31536000, immutable`，并复用同一套安全响应头（需要第 4 个 header snippet，且必须在 `docker run`、`deploy.sh` 的临时预检容器、`rollback.sh` 的预检容器**三处**同步挂载）。
3. 回归测试：断言服务端 `index.html` 只引用自身 release 前缀；旧 release 的 `/v/<old>/…` 在新发布后仍可取（不可变）；受控延迟下不再出现跨 release 取值。

**为什么本轮未实施：** 方案需要改动 nginx 配置、挂载清单（3 处）与部署产物，属于架构性变更；本轮预算内无法完成“实施 + 全套真实环境回归 + 文档”的闭环。按“不经证据不引入复杂方案、不为修一个问题顺带重构”的规则，保留已复现证据与设计方案，作为下一轮首选工作项。**当前不应对外宣传已解决混版本。**

**Agent 快速定位提示：** 若用户报告“刷新前突然提示本地存储不可用 / 无法创建任务”，先确认是否刚发生过发布；取 `document` 里 HTML 的来源与 `main.js` 的来源对比（或检查响应 ETag/Last-Modified 是否跨 release），**不要**先怀疑 IndexedDB 损坏（数据实测完好）。

### GOTCHA-028

**失败的发布把“永远无法激活的 release”留在 `releases/` 中，阻塞默认回滚链（FIXED / P2 / Deployment）**

**症状：** 一次失败的发布尝试（候选 nginx 配置非法、release 缺文件、含软链接等）之后，`deploy/rollback.sh`（不带参数）会**拒绝回滚**，即使存在更旧且健康的 release：
```
[deploy …] ERROR: target nginx config failed validation
# 或
[deploy …] ERROR: no archived nginx config for <release> (server.conf); rollback blocked
```
操作方失去“一键回到上一个可用版本”的能力，恰好发生在最需要它的时刻。

**最小复现步骤（孤立环境）：**
```bash
# 1) 用仓库副本注入一个非法 server.conf，执行真实 deploy（会安全失败）
printf 'server { listen 80; this_is_not_valid_directive; }\n' > $SHIM/deploy/nginx/server.conf
( cd $SHIM && env -u SF_REPO_ROOT bash deploy/deploy.sh )     # 失败，站点不受影响
# 2) 观察：新 release 与其配置归档一起留了下来
ls $SF_DEPLOY_ROOT/releases | tail -1
grep -l this_is_not_valid_directive $SF_DEPLOY_ROOT/config-releases/*/server.conf
# 3) 默认回滚链在此处被卡住
bash deploy/rollback.sh        # 拒绝
```

**真实错误日志（脱敏，来源：staging 根，nginx/1.27.5 容器）：**
```
[deploy 08:07:10Z] ERROR: target nginx config failed validation
[deploy 08:09:19Z] ERROR: no archived nginx config for 20261109T065426Z-14c0253d0eff (server.conf); rollback blocked
```

**根因及证据：** `deploy/deploy.sh` 在完整性/软链接/预检等**门控之前**就创建了 `releases/<REL>` 与 `config-releases/<REL>/`；失败后两者留在磁盘上。`deploy/rollback.sh` 的默认目标 = “比当前更旧的**最新** release”，因此这个永远无法激活的条目会成为**第一个**回滚候选并阻断整条链。
实测证据（staging 根，修复前）：
- `grep -l this_is_not_valid_directive config-releases/*/server.conf` → 2 个“毒归档”；
- 另有 4 个 release **完全没有**归档（`releases/*/` 有目录、`config-releases/*/` 不存在）；
- 默认回滚链在毒条目处停止：连续默认回滚只下移到 `…080544` 就报错，而更旧健康 release 仍然存在；
- 负控制：把 `deploy.sh` 中的隔离逻辑删除后离线契约 `ok 10` **失败**（`never-activated release left in releases/ (7 -> 8)`，退出码 1）。

**修复文件与代码位置：** `deploy/deploy.sh` —— 新增 `quarantine_unactivated_release()` 与**早期 EXIT trap**（`fail_handler`）：任何在“创建 release 之后、成功激活之前”的失败，都把 `releases/<REL>` 与 `config-releases/<REL>` **移入 `rejected-releases/`**（保留证据、移出回滚搜索路径）。该早期 trap 会被随后的激活 trap **有意替换**：一旦进入激活阶段，配置已通过预检，该 release 是合法的回滚目标，必须保留。

**回归测试：**
- `tests/deployment/scripts-regression.sh` → `ok 10: never-activated releases are quarantined and cannot block rollback`（离线，CI 覆盖；含上述负控制）
- `tests/deployment/staging-fault-injection.sh` → `S4`（真实 nginx：断言 `releases/` 不增长、`rejected-releases/` 保留证据、回滚路径中无非法归档、站点仍 200）+ `S4b`（失败预检之后**默认回滚仍能达标到更旧 release**）

**实际运行结果：** 离线 10/10；真实环境 89/89，`S4b` 断言通过（`…082147Z -> …082144Z` 严格更旧）。

**仍存在的风险：** 修复只防止**新增**污染，不清除**历史**污染。若某个部署根已经存在毒条目（非法归档或完全缺归档），默认回滚仍会被卡住。补救一行：
```bash
R=<部署根>; for f in $(grep -l this_is_not_valid_directive $R/config-releases/*/server.conf 2>/dev/null); do
  d=$(basename $(dirname $f)); mkdir -p $R/rejected-releases
  mv $R/releases/$d $R/rejected-releases/$d.legacy 2>/dev/null; mv $R/config-releases/$d $R/rejected-releases/$d.legacy.config; done
# 并另行处理“完全缺归档”的 release（同上，先移出 releases/）
```

**下一位 Agent 快速定位提示：** 如果**回滚突然拒绝**而站点其实正常，先执行 `deploy/rollback.sh --list` 与
`for d in <root>/releases/*/; do rel=$(basename $d); [ -f <root>/config-releases/$rel/server.conf ] || echo "no archive: $rel"; done`
找出无法激活的条目；**不要**手工把 `current` 软链指到别处，也不要删除健康 release 的归档。

### GOTCHA-029

**实地部署根目录的 release 早于“配置归档”机制，升级到 PR #2 后回滚被阻塞（仅自动补齐上一版）（OPEN / P1 / Deployment）**

**发现环境：** 真实运行中的部署根 `/home/ubuntu/apps/start-first`（只读审计）+ 其**副本**上的升级预演（`/home/ubuntu/apps/start-first-livecopy` + 容器 `start-first-livecopy` + `127.0.0.1:18083`，预演后已删除）。**真实服务未被修改**（容器 ID、`current`、`0.0.0.0:8081` 绑定、HTTP 200 均未变）。

**症状：** 实地根目录有 6 个 release，但 `config-releases/` **根本不存在**（这些 release 由 PR #2 之前的 `deploy.sh` 创建）。因此 PR #2 引入的、要求“目标 release 必须有归档配置”的 `rollback.sh` 在实地根上**一次也回滚不了**：
```
[deploy 08:09:19Z] ERROR: no archived nginx config for 20261109T065426Z-14c0253d0eff (server.conf); rollback blocked
```

**最小复现步骤：**
```bash
R=/home/ubuntu/apps/start-first            # 只读
ls -1 $R/releases | wc -l                  # 6
ls -1 $R/config-releases 2>/dev/null | wc -l   # 0
# 在副本上预演（不碰真实服务）

cp -a $R /tmp/livecopy && rm -f /tmp/livecopy/deploy.env
SF_DEPLOY_ROOT=/tmp/livecopy SF_CONTAINER=<新容器> SF_PORT=<空闲端口> \
  bash deploy/rollback.sh                  # -> ERROR: no archived nginx config … rollback blocked
```

**根因及证据：** PR #2 把“版本化配置归档”作为回滚的前提（这是 GOTCHA-022 的正确修复），但历史 release 在归档机制出现之前就已存在。`deploy.sh` 里有一段**遗留兼容**逻辑：仅当 `config-releases/<当前release>` 不存在时，用 `conf/` 里的**当前生效配置**回填**这一个** release。因此：
- 首次用 PR #2 的 `deploy.sh` 发布**成功之后**：`config-releases/<升级前的当前版>/` 会被回填 → **一步回滚可用**（实测：副本上回填后 `rolled back from …080929Z to …065525Z`，`All health checks passed`）；
- 再往前的第二次回滚**仍被阻塞**（实测：`ERROR: no archived nginx config for 20261109T065426Z-…`）；
- 回填的语义是“**升级前正在运行**的那份配置”，而不是该 release 历史上真正使用过的配置——对 GOTCHA-022 想防的“代码与配置不同步回滚”场景，这一点需要在变更计划里明确接受。

**影响范围：** 只影响**回滚深度**与**升级窗口内的恢复选项**；当前站点与数据不受影响（fail-closed）。若操作方在升级后立即需要深回滚，会发现只能回退一步。

**建议（需操作方变更计划，故状态为 OPEN）：**
1. 升级**前**为可能需要回退的历史 release 补齐归档（从该 release 当时的 nginx 配置可信来源复制到 `config-releases/<rel>/`）；
2. 或明确接受“只保证一步回滚”，并在变更窗口内保留一份手写恢复步骤（`ln -sfn releases/<rel> current.new && mv -T …` + `docker exec … nginx -s reload`）；
3. 升级后**必须**用 `deploy/rollback.sh` 在副本或预发环境演练一次，确认能回到上一个版本；
4. 不要在真实服务上直接验证回滚。

**仍存在的风险：** 不补齐归档时，深层回滚能力实质不可用（虽然 fail-closed 且不会造成错误状态）。此外真实根目录的 6 个 release 的归档缺失是**既有状态**，不是本轮引入的回归。

**下一位 Agent 快速定位提示：** 在把 PR #2 应用到真实服务**之前**，先跑 `ls -1 <root>/config-releases | wc -l`；若为 0，必须先按上面的建议 1/2 形成回滚计划，并确认已获得更新真实服务的授权。

---

## Round 3 未复现/未验证的事项（明确标注）

- **公网 HTTPS / 防火墙边界（GOTCHA-024、Issue #3）：** 仍未验证。`ubuntu` 无免密 sudo，`sudo -n ufw status` 被拒；本轮**未**修改 ufw/iptables/DNS/TLS，也**未**改变实地绑定（仍为 `0.0.0.0:8081`）。因此 GOTCHA-024 保持 **OPEN**，不得因为“局域网可访问”而标记 FIXED。
- **真实配额耗尽 / IDB onblocked / 非 Chromium 设备 / 屏幕阅读器 / 长会话与休眠（014/015/016/017/019）：** 本轮未新增验证，状态不变。
- **混版本修复：** 已复现未修复（GOTCHA-026）。
- **`.Config.Image` 字符串比较陷阱（PREVENTIVE / P3）：** `deploy.sh` 用 `docker inspect .Config.Image` 与 `SF_IMAGE` 做**字符串**比较。若容器当初用其它等价写法创建（如 `docker.io/library/nginx:1.27-alpine`、摘要、或不同 tag 别名），则会持续判定“image drift”并拒绝发布（fail-closed，无风险，但需要人工改为一致写法）。本轮实测：正常以 `nginx:1.27-alpine` 创建时完全匹配；用本地 tag 别名（`start-first-nginx-alias:fi`）可稳定复现“image drift”拒绝。**尚未在真实服务上遇到**，属预防性记录。
