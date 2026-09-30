# 社团章程修订 Web 应用

一款面向社团章程（条款制规章）的版本化修订平台：

- 录入**首版条款及条款间引用**，原子生成不可变版本；
- 从任意已发布版本创建**草案**，对带**稳定标识**的条款进行编辑、移动、删除，并登记/删除条款引用；
- 随时查看草案相对其**基线版本**的结构差异与正文逐字差异；
- 并行草案发布时，系统把草案相对基线的改动**重放（replay）**到最新发布版：
  - **不相交**的条款改动自动合并；
  - **同一条款被双方改动**（或一方删除、另一方修改，或双方新增同标识但内容不同）→ **拒绝发布**，逐条说明冲突；
  - 重放后产生**悬空引用**（引用来源或目标条款不存在）→ **拒绝发布**并列出悬空引用；
  - 冲突/悬空时**草案原样保留**，可继续修改后再次发布；
- 草案允许**暂存悬空引用**并在界面明确标红，但**不能发布**；
- 发布成功在**单个 SQLite 原子事务**中写入不可变新版本；历史版本可完整**还原该版的条款顺序、正文与引用**，并支持任意两版差异对比。

## 定时生效排程（本轮新增）

发布草案时可指定一个**晚于当前时间的 UTC 生效时刻**：

- 发布瞬间仍然**立即写入不可变版本快照**，只是状态为“待生效（scheduled）”，进入待生效队列；条款、顺序、引用即刻固定，任何后续操作都不会修改它。
- 页面与 API 区分**当前生效版**与**最新发布版**：前者按时间点计算，后者是不可变版本序列的最后一个（草案基线与重放仍以最新发布版为准）。
- 待生效时刻必须按**发布版顺序严格递增**：定时发布的时刻必须晚于队列中的最后一个版本。
- **队列未清空时，不指定生效时刻的即时发布将被拒绝**（`QUEUE_NOT_EMPTY`），响应中说明原因并返回当前排程；队列清空后，未指定时刻自动沿用**即时生效**。
- 生效前可以**改期**或**取消**，但必须携带读取排程时拿到的 **`schedule_revision`（排程修订号）**：
  - 改期后的时刻必须**晚于当前时间**，且**不得越过相邻版本**（严格位于前后两个排队版本之间）；
  - 修订号过期（期间有其他改期/取消/发布/到点生效）或版本**已经生效** → **整次拒绝**并返回当前排程，客户端按新排程重试即可；
  - 取消后版本不生效，但**不可变快照保留**，发布历史中标记“已取消”，仍可完整查看。
- 到点后由服务端**懒激活**（下一次请求在事务内把到点版本翻转为生效），无需额外进程或定时器。
- **时点查询** `GET /api/effective?at=<UTC>` 返回指定时刻当时生效版本的**完整条款、顺序与引用**；已发生时点的结果只由 `effective_at ≤ at` 的版本决定，后续改期或取消只改动未来时间戳，**历史结果不变**。
- 草案仍以**最新发布版**为基线（即使它仍待生效或已被取消）；版本快照、版本间差异、草案编辑/重放等既有操作全部保持可用。

## 技术栈

- Node.js 20（内置 `http`，无额外 Web 框架）
- SQLite（[`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3)，同步事务）
- 浏览器端原生 HTML/CSS/JavaScript 单页应用（无需构建）

## 一键启动（Docker Compose）

需要已安装 Docker 与 Compose 插件（`docker compose version` 可用）。

```bash
docker compose up -d --build
```

启动后访问：

- **地址：** http://localhost:3000
- **端口：** 容器内固定 `3000`；宿主机端口可用环境变量 `HOST_PORT` 修改：

```bash
HOST_PORT=8080 docker compose up -d --build
# 访问 http://localhost:8080
```

停止与清理：

```bash
docker compose down            # 停止并删除容器（数据库卷保留）
docker compose down -v         # 同时删除数据库卷（清空全部数据，谨慎）
docker compose logs -f         # 查看日志
```

SQLite 数据库文件位于命名卷 `charter-data` 内（容器路径 `/data/charter.db`），首次启动若库表不存在会自动建表初始化，无需手工迁移。

## 本地直接运行（不使用 Docker）

要求 Node.js ≥ 20。

```bash
npm install
npm start
```

运行单元测试（纯业务逻辑：差异 / 三方重放 / 悬空引用 / 排程校验）：

```bash
npm test
```

运行端到端 API 冒烟测试（自动用临时数据库拉起服务、跑完即关，无需手工准备端口/数据库）：

```bash
npm run test:e2e
```

## 配置

通过环境变量配置，均有默认值：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `DB_PATH` | `./data/charter.db`（本地）/ `/data/charter.db`（Docker） | SQLite 数据库文件路径，目录不存在会自动创建；首次启动自动建表 |

Docker Compose 额外支持：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口 |

## 使用流程

1. **录入首版**：打开首页即见首版录入表单（已附 4 条示例条款与引用，可直接“发布首版”体验）。逐条填写稳定标识（字母、数字、汉字、`_`、`-`，≤40 字符）、标题、正文，并登记条款间引用；提交后原子生成不可变 `v1`。
2. **创建草案**：在“草案”页选择基线版本创建草案。可同时创建多个草案（并行修订）。
3. **编辑草案**：
   - 新增条款（获得新的稳定标识，追加后可用 ↑/↓ 移动）；
   - 编辑标题/正文（标识不可修改，保证跨版本稳定）；
   - 移动条款顺序、删除条款；
   - 新增/删除引用，允许引用暂不存在的条款——会被标记为**悬空引用**并阻止发布。
4. **查看差异**：草案页实时显示相对基线的新增/删除/修改/移动与引用增删，可打开“正文差异”查看逐字增删（`<ins>` / `<del>`）。
5. **发布**：
   - 草案存在错误级问题（空正文、悬空引用、标识重复等）时禁止发布；
   - 若基线不是最新版，发布在 `BEGIN IMMEDIATE` 事务内把改动重放到最新版；不相交改动合并成功则生成新版本；同条款双方改动或重放后悬空则返回冲突说明、回滚事务并保留草案；
   - “生效方式”可选**即时生效**或**定时生效**：填入晚于当前时间的 UTC 时刻（如 `2027-01-01T00:00:00Z`，弹窗提供 +1 小时 / 明天 00:00 UTC / +1 周快捷填充）。队列非空时只能定时，且时刻必须晚于上一排队版本。
6. **发布历史**：在“发布历史”中查看每个不可变版本（顺序/正文/引用完整还原），待生效版本标“待生效”、被取消的标“已取消”，均可点开查看快照；可下拉选择任意其他版本做两版对比。
7. **生效排程**：在“生效排程”页查看当前生效版、待生效顺序（位置、版本、UTC 生效时刻）与已取消版本；可对排队版本**改期**或**取消**（弹窗自动携带当前排程修订号，过期时提示并返回最新排程）；页面定时自动刷新，到点版本会自动转为“生效中”。
8. **时点查询**：在“生效排程”页输入任意 UTC 时刻，查看当时生效版本的完整条款、顺序与引用；已发生时点的结果不受之后改期/取消影响。

## 合并（重放）语义

设基线为 `B`，草案为 `D`，最新发布版为 `L`，逐条款判定：

| 情况 | 结果 |
| --- | --- |
| 仅 `D` 改动（新增/编辑/移动/删除） | 采用草案内容与位置 |
| 仅 `L` 改动 | 保留最新版内容 |
| `D` 与 `L` 改动完全相同（收敛） | 自动采纳，不算冲突 |
| 双方对同一标识都做了不同改动 | **冲突，拒绝发布**（`modify-modify` / `delete-modify` / `modify-delete` / `add-add`） |
| 双方都删除同一条款 | 收敛为删除 |
| 重放后任一引用的来源或目标条款缺失 | **悬空，拒绝发布** |

条款的出边（引用）跟随条款归属：条款采纳自哪一侧，其引用集就来自哪一侧。新增条款的位置按其在草案中的锚点（前一条款）插入到最新版顺序中；移动条款同理重定位。

“移动”按方向性锚点判定：旧序锚点的后继在新序中发生变化且该后继仍位于锚点之后，才算该条款被主动移动（被插队而被动让位的条款不计）。因此“草案后移 B、最新版仅修改 C 正文”这类不相交改动可以干净重放。

## HTTP API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/overview` | 标题、版本列表（含 `status`/`effective_at`）、草案列表、`current_effective_version_id`、`latest_version_id`、`schedule_revision`、待生效 `pending` |
| `POST` | `/api/initialize` | 录入并发布首版（仅一次，首版始终即时生效） |
| `GET` | `/api/versions/:id?compare=:otherId` | 查看版本快照（可选两版差异）；待生效/已取消版本同样可查 |
| `POST` | `/api/versions/:id/reschedule` | 待生效版本改期 `{effective_at, schedule_revision}` |
| `POST` | `/api/versions/:id/cancel` | 取消待生效版本 `{schedule_revision}` |
| `GET` | `/api/schedule` | 当前排程：服务器时间、修订号、当前生效版、待生效队列、已取消列表 |
| `GET` | `/api/effective?at=:isoUtc` | 时点查询当时生效版本（不传 `at` 即当前），返回完整条款/顺序/引用 |
| `POST` | `/api/drafts` | 从基线版本创建草案 `{baseline_id?, name?}`（默认基线为最新发布版） |
| `GET` | `/api/drafts/:id?diff=1` | 草案详情、问题清单、基线差异 |
| `PATCH` | `/api/drafts/:id` | 重命名草案 |
| `POST` | `/api/drafts/:id/clauses` | 新增条款 |
| `PUT` | `/api/drafts/:id/clauses/:key` | 编辑条款标题/正文 |
| `DELETE` | `/api/drafts/:id/clauses/:key` | 删除条款（相关引用保留为悬空） |
| `POST` | `/api/drafts/:id/clauses/:key/move` | 移动条款 `{ordinal}` 或 `{after}` |
| `POST` | `/api/drafts/:id/refs` | 新增引用（允许悬空暂存） |
| `DELETE` | `/api/drafts/:id/refs/:ordinal` | 删除引用 |
| `POST` | `/api/drafts/:id/publish` | 原子发布（重放/冲突拒绝/保留草案），可带 `effective_at` 定时 |

### 状态码与错误约定

- `200/201` 成功；`400` 表示请求参数本身非法：`BAD_EFFECTIVE_AT`、`PAST_EFFECTIVE_AT`、`BAD_AT`、`REVISION_REQUIRED`、`NO_CHANGES` 等。
- `409` 表示与系统当前状态冲突：
  - `QUEUE_NOT_EMPTY`：队列非空却未指定生效时刻；
  - `NON_INCREASING_TIME`：定时时刻未晚于上一排队版本；
  - `CROSSES_ADJACENT`：改期越过相邻版本；
  - `STALE_REVISION`：排程修订号过期；
  - `ALREADY_EFFECTIVE` / `ALREADY_CANCELED`：版本已生效/已取消；
  - 以及既有的 `CONFLICT`（条款合并冲突）、`DRAFT_INVALID`（悬空等草案问题）。
- 所有排程类拒绝响应都带 `schedule_revision` 与 `schedule`（当前排程完整快照），客户端可直接展示并据此重试。

### 定时发布 / 改期 / 取消 / 时点查询示例

```bash
BASE=http://localhost:3000

# 1) 编辑草案后定时发布（UTC 时刻必须晚于当前；队列非空时还必须晚于最后一个排队版本）
curl -s -X POST $BASE/api/drafts/1/publish \
  -H 'Content-Type: application/json' \
  -d '{"note":"2027 年度修订","effective_at":"2027-01-01T00:00:00Z"}'
# -> 201
# {"version_id":3,"replayed":false,"scheduled":true,"status":"scheduled",
#  "effective_at":"2027-01-01T00:00:00.000Z","schedule_revision":1}

# 队列非空时再做即时发布 -> 409，响应说明原因并返回当前排程
curl -s -X POST $BASE/api/drafts/2/publish \
  -H 'Content-Type: application/json' -d '{"note":"想插队"}'
# {"error":"QUEUE_NOT_EMPTY","message":"存在尚未生效的定时版本时，发布必须指定 UTC 生效时刻……",
#  "schedule_revision":1,"schedule":{"current_effective_version_id":2,"queue":[{"id":3,...}]}}

# 2) 读取排程，拿到 schedule_revision
curl -s $BASE/api/schedule
# {"now":"...","schedule_revision":1,"current_effective_version_id":2,
#  "queue":[{"position":1,"id":3,"note":"2027 年度修订","effective_at":"2027-01-01T00:00:00.000Z"}],
#  "canceled":[]}

# 3) 携修订号改期（必须晚于当前时间，且不得越过相邻版本）
curl -s -X POST $BASE/api/versions/3/reschedule \
  -H 'Content-Type: application/json' \
  -d '{"effective_at":"2027-02-01T00:00:00Z","schedule_revision":1}'

# 修订号过期 -> 409 STALE_REVISION，响应给出最新排程，按新 revision 重试即可
# {"error":"STALE_REVISION","schedule_revision":2,"schedule":{...当前排程...}}

# 4) 携修订号取消（快照保留，/api/versions/3 仍可完整查看）
curl -s -X POST $BASE/api/versions/3/cancel \
  -H 'Content-Type: application/json' -d '{"schedule_revision":2}'

# 5) 时点查询：当时生效版本 + 完整条款/顺序/引用
curl -s "$BASE/api/effective?at=2027-06-01T00:00:00Z"
# {"at":"2027-06-01T00:00:00.000Z","as_of_past":true,"version_id":4,
#  "version":{"id":4,"status":"effective","clauses":[...],"refs":[...]}}
curl -s "$BASE/api/effective"     # 不传 at = 查询当前生效版本
```

## 排程规则速查

| 操作 | 规则 |
| --- | --- |
| 定时发布 | 时刻晚于当前；队列非空时必须晚于最后一个排队版本（严格递增）；版本快照发布瞬间即固定 |
| 即时发布 | 队列必须为空（队列为空且未指定 `effective_at` 时沿用即时生效） |
| 改期 | 携带 `schedule_revision`；新时刻晚于当前、严格位于前后相邻版本之间 |
| 取消 | 携带 `schedule_revision`；已生效不可取消；快照保留、可查 |
| 修订号过期 / 版本已生效 | 整次拒绝（`409`）并返回当前排程 |
| 时点查询 | 返回 `effective_at ≤ at` 的最后一个未取消版本；历史时点结果不随后续操作变化 |

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── src
│   ├── server.js      # HTTP 服务、API、原子发布事务、排程改期/取消/懒到期/时点查询
│   ├── db.js          # SQLite 连接、建表与轻量迁移、版本/草案/排程快照读写
│   └── model.js       # 纯逻辑：差异、移动判定、三方重放、悬空引用、排程规则
├── public
│   ├── index.html     # 单页应用入口
│   ├── styles.css
│   └── app.js         # 首版录入 / 草案编辑 / 差异 / 发布 / 排程 / 时点查询 / 历史还原
└── test
    ├── model.test.js  # 核心合并与排程逻辑单元测试（npm test）
    ├── e2e.js         # 端到端 API 断言
    └── run-e2e.js     # e2e 运行器：临时库自动起停服务（npm run test:e2e）
```

## 数据持久化与备份

- 本地运行：数据库即 `DB_PATH` 指向的文件（默认 `./data/charter.db`，WAL 模式另有 `-wal`/`-shm` 伴生文件）。
- Docker：使用命名卷 `charter-data`，可用 `docker cp` 或直接挂载卷备份；已发布版本只追加、不更新不删除（定时版本的状态在 `scheduled → effective / canceled` 之间流转，条款快照本身不可变），具备不可变性。
- 老版本数据库可直接用新版本启动：缺失的 `status` / `effective_at` / `activated_at` / `canceled_at` / `schedule_revision` 列会自动补齐，历史版本回填为 `effective`、生效时刻取原发布时间，无需手工迁移。
