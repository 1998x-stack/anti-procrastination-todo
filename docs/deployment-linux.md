# Linux 部署手册（Start-First 静态站点）

**适用 commit：** `71071bfed912`（部署时工作区为 dirty，见 release 元数据）
**环境：** Ubuntu 24.04.3 LTS / x86_64 / Intel i5-10500（12 线程）/ 31 GiB RAM / 609 GB 可用磁盘
**状态：** 已在本机完成部署、验证、回滚演练、局域网访问验证。**未做公网/HTTPS 部署**（无授权与域名 → `NOT_VERIFIED`，见 `docs/gotchas.md` GOTCHA-018）。

---

## 1. 为什么是这套拓扑（决策与原因）

| 约束（实测） | 结论 |
| --- | --- |
| 系统没有 nginx（`command -v nginx` → 缺失），`ubuntu` 用户**无免密 sudo**（`sudo -n true` → 需要密码） | 不能 `apt install nginx`，也不能写 `/etc/nginx` |
| 应用是**无构建**的原生 ES Modules 静态站点，运行期零依赖 | 只需要一个正确的静态 HTTP 服务（MIME + 缓存 + 安全头） |
| Docker 29.1.3 可用，用户在 `docker` 组 | 用 **nginx:1.27-alpine 容器**承载静态文件，配置文件从仓库挂载 |
| 80 / 443 被 `docker-ragflow-cpu-1` 占用；8080 被 `igateway-*` 占用 | **绝不复用**，改用 8081 |
| 获授权可从局域网访问，但无域名/无公网授权 | 绑定 `0.0.0.0`（loopback + LAN，见 10.1 的 DHCP 原因）；**不**做公网转发；HTTPS 留作公网上线前置条件 |
| `code/backend/dev-server.js` 只是内存研究参考实现 | **不部署、不反代、不进容器** |

选择 Docker + 挂载配置的额外好处：nginx 配置**随代码版本化、可 review、可回滚**，不污染系统 nginx，也不影响服务器上其他业务站点。

**明确没有引入的东西（避免过度工程）：** 没有 Kubernetes、没有 CI/CD 平台、没有 Node 运行服务、没有数据库、没有 Docker Compose（单容器 + 三条 shell 脚本足够）。

---

## 2. 目录结构

```
/home/ubuntu/codes/anti-procrastination-todo/     # 代码（git 工作副本）
├── deploy/
│   ├── env.sh                 # 所有可覆盖变量（部署根、端口、绑定、镜像、发布白名单）
│   ├── deploy.sh              # 构建 release → 原子切换 → 校验并 reload → 健康检查
│   ├── healthcheck.sh         # 27 项只读健康检查
│   ├── rollback.sh            # 回滚 / --list
│   ├── serve.sh               # start|stop|restart|reload|status|logs|container-config
│   └── nginx/                 # nginx 配置源（版本化）
│       ├── server.conf        # server 块：root=current、安全头、缓存、/healthz、404 语义
│       ├── headers.inc        # 普通资源安全头 + Cache-Control: no-cache
│       └── headers-html.conf  # index.html 专用：Cache-Control: no-store
│
/home/ubuntu/apps/start-first/                     # 部署根（不在 git 里）
├── releases/<UTC时间>-<sha12>/   # 不可变发布目录（白名单拷贝的静态文件）
├── current -> releases/<…>       # 相对软链，原子切换（mv -T）
├── conf/                         # 生效的 nginx 配置副本（由 deploy.sh install）
├── meta/<release>.json           # 发布元数据：commit、分支、是否 dirty、时间、URL
└── logs/                         # 预留（当前 nginx 日志走 docker logs，见 GOTCHA-010）
```

`current` **必须是相对软链**：部署根整体挂载进容器（`:/srv/start-first:ro`），绝对主机路径在容器内不存在（GOTCHA-001）。

---

## 3. 发布内容白名单

只有下列路径会进入 release（其余一律不发布）：

```
index.html  assets/  code/frontend/  code/domain/  code/algorithm/  code/persistence/
```

**不发布：** `code/backend/`（研究 API 参考实现、`schema.sql`）、`tests/`、`tests/deployed/`、`scripts/`、`deploy/`、`docs/`、`.github/`、`package.json`、`package-lock.json`、`playwright*.config.js`。

`deploy.sh` 会**主动校验**：必需文件缺失即拒绝发布；只要发现 release 中出现 `code/backend` 就直接失败。健康检查也会断言 `/code/backend/dev-server.js`、`/tests/domain.test.js` 返回 `404`。

---

## 4. 依赖安装

```bash
# 运行期依赖：无（纯静态资源）
# 测试/部署期依赖：
npm ci                          # 使用已提交的 package-lock.json
npx playwright install chromium # 首次在新机器上必须执行（版本需与 @playwright/test 1.56.1 匹配）
# CI 上另有系统库依赖：npx playwright install --with-deps chromium
docker pull nginx:1.27-alpine   # digest: nginx@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10
```

---

## 5. 首次部署 / 日常发布

```bash
cd /home/ubuntu/codes/anti-procrastination-todo
deploy/deploy.sh            # 完整发布（含容器创建/校验/reload/健康检查）
deploy/deploy.sh --no-restart   # 只构建 release 并切换 current，不动容器
```

`deploy.sh` 的步骤（幂等，可重复执行）：
1. 读取 `deploy/env.sh`（可用 `SF_*` 环境变量覆盖）。
2. 记录 `branch` / `commit` / `dirty` 状态；dirty 时额外记录工作区摘要哈希。
3. 用 `tar` 白名单拷贝到 `releases/<UTC时间>-<sha12>/`。
4. 完整性校验（必需文件存在、`code/backend` 未出现）。
5. 写 `meta/<release>.json`。
6. `install -m 0644` 同步 nginx 配置到 `conf/`。
7. **原子切换**：`ln -sfn releases/<rel> current.new && mv -T current.new current`。
8. 核对容器拓扑（端口绑定/镜像/文档根挂载）——**有漂移则重建容器**，否则 `nginx -t` + `nginx -s reload`（零停机）。
9. 跑 `healthcheck.sh`，**失败即整体失败**（返回非 0）。

### 容器启动参数（由脚本生成，勿手工漂移）

```bash
# 由 deploy.sh 从 SF_BIND/SF_PORT 生成；当前取值为 0.0.0.0:8081（见 10.1）
docker run -d --name start-first-web --restart unless-stopped \
  -p "$SF_BIND:$SF_PORT:80" \
  -v /home/ubuntu/apps/start-first:/srv/start-first:ro \
  -v /home/ubuntu/apps/start-first/conf/server.conf:/etc/nginx/conf.d/default.conf:ro \
  -v /home/ubuntu/apps/start-first/conf/headers.inc:/etc/nginx/conf.d/headers.inc:ro \
  -v /home/ubuntu/apps/start-first/conf/headers-html.conf:/etc/nginx/conf.d/headers-html.conf:ro \
  --log-opt max-size=10m --log-opt max-file=3 \
  nginx:1.27-alpine
```

---

## 6. 启动 / 停止 / 重载

```bash
deploy/serve.sh status     # 容器状态 + URL + 当前 release + release 数量
deploy/serve.sh reload     # nginx -t 后 nginx -s reload（零停机；发布或改配置后使用）
deploy/serve.sh restart    # docker restart（短暂中断）
deploy/serve.sh stop       # 停止容器；releases/current 保留
deploy/serve.sh start      # 重新启动同一 release
deploy/serve.sh logs 200   # 最近 200 行访问日志
deploy/serve.sh container-config   # 打印挂载与端口绑定，便于核对漂移
```

---

## 7. 健康检查

```bash
deploy/healthcheck.sh    # 27 项，全部只读；输出 ok/FAIL 明细；全通过退出码 0
```

覆盖：容器运行、**每个 `SF_BIND` 地址都已发布**、9 个静态资源 200、MIME 合法性、缺失资源真 404、CSP/nosniff/Referrer-Policy/Permissions-Policy、`index.html` `no-store`、其他资源 `no-cache`、`server_tokens off`、**研究 API 与测试文件不可达**、无目录列表、dotfiles 403、**服务内容与服务磁盘 release 的字节一致（sha256）**。非回环绑定会额外打印 `warn` 行提醒无 TLS。

---

## 8. 版本更新流程

```bash
git pull --ff-only            # 或不 pull，直接改工作区（会被记录为 dirty release）
npm run verify && npm run test:e2e      # 先建立基线
deploy/deploy.sh                        # 发布 + 健康检查
npm run test:e2e:deployed               # 针对新 release 的浏览器验证
```

## 9. 回滚

```bash
deploy/rollback.sh --list                       # 列出 release（* 标记当前）
deploy/rollback.sh                              # 回滚到上一个 release
deploy/rollback.sh 20261109T063425Z-71071bfed912  # 切到指定 release
```

回滚 = 切换 `current` 软链 + `nginx -t` + `nginx -s reload` + 健康检查。**已演练验证**：回滚后 `curl /code/frontend/main.js` 的 sha256 与磁盘上目标 release 的文件**完全一致**（证明切换真的生效，而不是缓存或旧连接）。

**不会**删除任何 release；`releases/` 是唯一的回滚依赖，勿手工清理。

---

## 10. 端口与网络暴露

| 端口 | 绑定 | 说明 |
| --- | --- | --- |
| 8081 | **0.0.0.0（本机 loopback + 局域网）** | 站点唯一入口。实际可达面 = `lo` + `eno1`(LAN) + Docker 网桥（172.x，仅本机与容器可达） |
| 80 / 443 | 0.0.0.0（**他人容器**） | ragflow；本项目不使用 |
| 8080 | 0.0.0.0（**他人容器**） | igateway；本项目不使用 |
| 4173 | 127.0.0.1（仅测试期间） | Playwright 开发 harness（`python3 -m http.server`），不是生产服务 |
| 4317 | 127.0.0.1（仅显式启用时） | 研究 API 参考实现；`verify:lab-api` 结束会关闭并已断言端口不再监听 |

核查命令：`docker port start-first-web 80/tcp`、`ss -tln | grep 8081`、`deploy/healthcheck.sh`（会打印 "published on …" 并对非回环绑定发出 warn）。

### 10.1 绑定地址由 `deploy.env` 记录（可重复部署）

部署拓扑保存在 **`${SF_DEPLOY_ROOT}/deploy.env`**（本机为 `/home/ubuntu/apps/start-first/deploy.env`），由 `deploy/env.sh` **解析**（`KEY=value`，从不 `source`，不能执行代码）。优先级：**显式环境变量 > deploy.env > 内置默认值**。

这样做的原因：如果只靠"部署时传一次环境变量"，后续任何人直接跑 `deploy/deploy.sh` 都会把绑定悄悄改回 loopback，LAN 地址会莫名失效。

`SF_BIND` 支持**空格分隔的多个地址**：

```bash
SF_BIND="127.0.0.1"                    # 最保守：只允许本机
SF_BIND="0.0.0.0"                      # 所有接口（当前采用，见下）
SF_BIND="127.0.0.1 192.168.169.223"    # loopback + 指定局域网地址（需静态 IP）
```

**当前部署的取值与原因（重要）：**

```
SF_BIND=0.0.0.0
SF_PORT=8081
SF_URL=http://127.0.0.1:8081     # 本地健康检查与测试仍走 loopback
```

- 操作方要求**从局域网浏览器访问**，因此必须超出 loopback。
- **没有**绑定具体地址 `192.168.169.223`：`ip -4 addr show eno1` 显示该地址为 **`dynamic`（DHCP，租约约 3.5 天）**。把 Docker 发布钉死在某个具体地址上，一旦租约变化/路由器重启，容器会以 `cannot assign requested address` 起不来 —— 那是**连 loopback 一起失效的全面中断**。`0.0.0.0` 不受地址变化影响。
- 本机唯一非回环网卡是 `eno1`；其余地址是 Docker 网桥（172.17–172.22.0.1），只对本机与容器可达。
- **切换到静态地址 + TLS 后**应改为钉住地址或退回 `SF_BIND=127.0.0.1`（由反向代理转发），见第 12 节。

### 10.2 绑定漂移会被检测并重建容器

`deploy.sh` 会比较**期望的端口绑定、镜像、文档根挂载**与现有容器；一旦不一致就 `docker rm -f` 后按新拓扑重建，并等待容器内 nginx 就绪。避免"改端口却没生效"这类"成功但什么都没做"的问题。

### 10.3 局域网访问的已知含义（必须告知使用者）

| 含义 | 说明 |
| --- | --- |
| **IndexedDB 按 origin 隔离** | `http://192.168.169.223:8081` 与 `http://127.0.0.1:8081` 是**两个不同的数据库**。在 loopback 下创建的任务**不会**出现在局域网地址下，反之亦然。这不是 bug，也**不会**自动迁移 |
| **非安全上下文** | 局域网纯 HTTP 不是安全上下文：`crypto.randomUUID` 按规范不可用，应用改用已实现的 `crypto.getRandomValues` 降级路径（已实测通过，见 GOTCHA-005）。Service Worker / 安装型 PWA 等能力仍不可用（本项目未使用） |
| **明文传输** | 局域网内为纯 HTTP。应用本身**不向服务器发送任何任务内容**（已断言无外部请求），但同一局域网内的其他设备理论上可观察到流量。**不要**把 8081 端口转发到公网 |
| **防火墙未验证** | 本机装有 ufw，但 `ubuntu` 用户无免密 sudo，**无法**确认其策略（`sudo -n ufw status` 被拒）。同机其他容器已在 `0.0.0.0` 上对外发布（如 443/3001），说明入站到本机一般是通的。请在浏览器/另一设备上实测确认 |
| **重启后自动恢复** | `--restart unless-stopped` + Docker 保存的端口配置 → 主机重启后仍以相同绑定启动（已实测 `serve.sh restart` 后绑定不变） |

---

## 11. 常见权限问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `sudo: a password is required` | 无免密 sudo | 用 Docker 方案；不要尝试 apt/systemctl |
| 容器内 `permission denied` 写日志 | 宿主目录归 `ubuntu`，容器内 nginx worker 为 uid 101 | 日志走 `docker logs`（不挂 `logs/`），见 GOTCHA-010 |
| `docker: permission denied` | 不在 `docker` 组 | `id` 确认含 `docker`；否则需人工授权 |
| 发布目录无法写入 | `/srv`、`/opt` 为 root 所有 | 使用 `SF_DEPLOY_ROOT`（默认 `~/apps/start-first`） |
| `install: cannot create regular file` | `conf/` 权限被改 | `mkdir -p` 后重跑 `deploy.sh` |

---

## 12. HTTPS 配置要求（公网部署前必读）

当前**未配置** HTTPS，因为未获域名与公网授权。公网部署必须补齐：

1. TLS 终结点（宿主 nginx/Caddy 或云 LB）+ 证书自动续期；公网场景建议把 `SF_BIND` 退回 `127.0.0.1`（由反代转发到 `127.0.0.1:8081`），避免直挂公网。
2. HTTP → HTTPS 301 跳转 + `Strict-Transport-Security`。
3. 更新 `deploy/nginx/server.conf` 的 `server_name` 与 `SF_URL`。
4. 复核 CSP 是否需按新拓扑调整（当前为 `default-src 'self'`，不依赖任何外部域）。
5. **禁止**把 `code/backend/dev-server.js` 或任何研究 API 接进反向代理。
6. 保留 `Cache-Control` 策略：`index.html` = `no-store`，其余 = `no-cache`（文件名未做内容哈希，禁止强缓存，否则会出现版本混用）。

---

## 13. 本地测试模式 vs 正式部署模式的差异

| | 本地测试模式（`npm run test:e2e`） | 正式部署模式（`deploy/deploy.sh`） |
| --- | --- | --- |
| 服务 | `python3 -m http.server 4173`（Playwright `webServer` 自动管理） | nginx 1.27-alpine 容器 |
| 端口 | 4173，仅 127.0.0.1 | 8081，仅 127.0.0.1 |
| 安全响应头 | **无** | CSP、nosniff、X-Frame-Options、Referrer-Policy、Permissions-Policy |
| 缓存策略 | 无（服务器不设置） | `index.html` no-store；其余 no-cache |
| MIME | Python 默认 | nginx `mime.types`（JS 为 `application/javascript`，合法） |
| 缺失资源 | 目录列表/404 行为不同 | 严格 `404`（`try_files … =404`） |
| 未知路径 | 可能目录列表 | 404（无 SPA 兜底，避免把错误路径变成 200 HTML） |
| 用途 | 开发与 UI 回归（34 用例） | 交付验证（`npm run test:e2e:deployed`，9 用例） |

**两者都跑**才算通过：开发模式覆盖交互细节，部署模式覆盖真实响应头、安全上下文、真实 nginx 语义。

---

## 14. 未验证项（不要当成已完成）

- 公网域名 + HTTPS + HSTS（`NOT_VERIFIED`，见 GOTCHA-018）。
- 真实出现 `QuotaExceededError` 的配额耗尽（仅做了注入，GOTCHA-014）。
- IndexedDB 版本升级 `onblocked` 路径（GOTCHA-015）。
- 断电/重启后的数据完整性（容器 `restart=unless-stopped` 只保证服务自启）。
- 非 Chromium 浏览器与真实移动设备（GOTCHA-016）。
