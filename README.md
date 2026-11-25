# 任务奖励规划器

一个带奖励金机制的任务规划器：给任务按难度定个价，做完结算，钱一笔笔累加进一个「攒钱目标」进度条里。

技术栈：Node.js + Express + 原生前端（无构建步骤），数据存 **Supabase（云端 Postgres，走 PostgREST）**，没配 Supabase 时自动退到本地 **SQLite**（Node 22 内置 `node:sqlite`）。两种都零额外依赖。

## 快速开始

```bash
npm install      # 只装 express
npm start        # 打开 http://localhost:3210
```

- 换端口：`PORT=3300 npm start`
- 开发热重载：`npm run dev`
- 打开登录页：设了 `APP_PASSWORD` 时，`http://localhost:3210` 会先跳到 `/login`
- 灌示例数据（仅在没有任务时生效）：`npm run seed`
- 接口冒烟测试（26 项，需服务已启动）：`npm test`
- 前端 DOM 级测试（36 项，真正执行 app.js，需服务已启动）：`npm run test:ui`
- 登录/鉴权测试（22 项，自己拉子进程和临时数据目录）：`npm run test:auth`
- 部署到 Sealos（DevBox 路线，源码包 `award-planner-devbox.zip`）：见 [DEPLOY.md](DEPLOY.md)

## 登录

线上部署时设 `APP_PASSWORD` 环境变量，站点就有了自己的登录页（不是浏览器弹的原生登录框）：

- 访问任何页面或接口，没登录都会跳到 `/login`；接口直接返回 401 JSON。
- 登录页只有一个密码框，可以点眼睛图标显示明文；密码错误会红字提示并轻微抖动，连续错 8 次锁 5 分钟。
- 登录成功后写入 `HttpOnly` + `SameSite=Lax` 的 Cookie，有效期 30 天，手机上不用每次输密码。
- 顶栏右侧的退出图标会作废这次会话并回到登录页。
- 换 `APP_PASSWORD` 之后，所有设备的下次请求都需要重新登录。
- 服务重启（包括「发布版本 → 上线」）会清空内存里的会话，所有人需要重新输一次密码。
- 不设 `APP_PASSWORD` 就没有登录页，直接进应用（本地开发用）。
- 本地想看到登录页，两种都行：
  - 项目根建一个 `.env`，写 `APP_PASSWORD=你的密码`（服务启动时会自动读，不用装 dotenv；`.env` 已 gitignore，不会进版本库，也不会进打包的源码包）
  - 或者一条命令带变量：`$env:APP_PASSWORD='test123'; npm start`（Windows PowerShell，只对当前窗口生效）
- 部署后还看不到登录页，说明那个实例没读到 `APP_PASSWORD`，`curl /api/health` 里 `auth` 会是 `false`。

登录只管"能不能进门"，进来之后仍然在顶部选「我是谁」；两个人共用一个密码，这是有意为之的简化。

## 核心规则

### 难度与奖励金额

奖励金额**不再卡死区间**：填多少算多少（要求大于 0，上限 100000 元防误填）。三档难度只给建议值和参考区间，创建任务时自动填入建议值，也可以直接改成任意金额：

| 难度 | 颜色 | 参考区间 | 默认建议值 |
| --- | --- | --- | --- |
| 困难 | 红 | 50 元起 | 60 元 |
| 中等 | 黄 | 30-50 元 | 40 元 |
| 容易 | 绿 | 10-30 元 | 20 元 |

滑杆只负责 1-100 这段的快速取值，超过 100 直接在数字框里填（比如 150、200 都行），滑杆会停在右端但金额按输入框保存。

### 任务结构

每个任务包含：

- **任务标题 / 任务内容**
- **时间段**：开始时间、结束时间；超时未完成会自动标记「逾期」
- **难易程度**：红 / 黄 / 绿三档，卡片左侧色条与难度标签同步显示
- **奖励金额**：随意填（>0），按难度给建议值
- **完成指标**（三种形式可同时使用）：
  - 文字描述：一句可量化的验收标准
  - 子项清单：可勾选，全部勾完才算达成
  - 数值目标：填「当前 / 目标」，达到目标值自动判定达成
- **实际金额**：结算时填写，可以拿满、少拿，甚至填 0（完成了但没拿到奖励）

### 结算与汇总

- 点「结算」后任务标记为已完成，实际金额立刻累加进总进度条。
- 进度条的分母是「奖励目标」金额（比如 500 元的旅行基金），可以随时改名、改金额。
- 已完成任务可「撤销完成」，对应金额会从总进度里扣回。
- 目标达到后进度条变成金色，并显示超出金额。

### 两个成员 · 各攒各的

- 默认预置两个成员（成员 A / 成员 B）。顶部「我是」下拉切换身份，选过之后浏览器会记住。
- 每个人的任务列表和攒钱目标是**分开的**，互不影响。
- 点「链接对方」把另一个人链接上之后，双方才能互相看对方的看板；看的时候是只读，不能改对方数据。链接是互相的，解除后两边都看不到。
- 名字可以改：点身份下拉旁边的铅笔图标。
- 两个人共用同一个访问密码（`APP_PASSWORD`），身份是「自己选的」而不是真实账号——两三个人用没必要上注册登录体系。

### 手机端优先

这个页面主要是拿手机用的，所以按手机优先做：

- 窄屏是单列布局：概览卡 → 统计卡 → 任务清单，不用横向滚动。
- 顶栏只留日期，**新建任务**变成右下角的悬浮按钮，单手就能点到。
- 目标卡横向滑动（不折行），一张卡一个目标。
- 所有弹窗改成底部抽屉，从下往上滑出；头部固定、底部按钮常驻，键盘弹起来也不会把输入框和"保存"挡住。
- 输入框字号 ≥16px，iOS 聚焦时不会自动放大整页。
- 勾选框、筛选按钮、任务操作按钮都放大到手指能点准的尺寸（≥38px）。
- 适配 iPhone 刘海和底部横条（`env(safe-area-inset)`）。
- 在 iPhone Safari 里可以「添加到主屏幕」，全屏打开跟 App 差不多（没做图标和多页面缓存，就是普通网页）。

桌面端仍然是原来的双栏布局，两边互不影响。

### 多个目标 · 每个目标一套任务清单

- 目标不是只有一个。奖励金卡片上方是一排目标卡（名称 + 已攒/目标 + 百分比 + 进度条），点哪个下面就显示哪个目标的任务清单。
- 最后一格「+ 新建目标」：填名字和金额就能开一个新目标，**新目标的任务清单从空的开始**。
- 任务结算的钱只累加进它所属的目标，不会串到别的目标里。
- 「调整目标」改的是当前选中的那个目标；同一个弹窗里也能删除目标（会把该目标下的任务一起删掉，所以至少保留一个）。
- 一个成员最多 20 个目标。

## 目录结构

```
award sealos/
├── src/
│   ├── server.js      # 启动 Express、托管静态页、登录与会话、统一错误处理
│   ├── api.js         # 全部 REST 接口与参数校验
│   └── store.js       # 存储层：Supabase 适配器 / SQLite / JSON 兜底，任务派生计算与快照汇总
├── public/
│   ├── index.html     # 页面结构
│   ├── login.html     # 登录页（未登录时跳到这里）
│   ├── styles.css     # 样式
│   └── app.js         # 前端逻辑（渲染、弹窗、事件）
├── supabase/
│   └── schema.sql     # 建表 + planner_load/planner_save 两个 Postgres 函数（可重复执行）
├── scripts/
│   ├── seed-demo.mjs  # 示例数据灌入
│   └── migrate-json-to-supabase.mjs  # 把本地 planner.json 一次性导到 Supabase
├── test/
│   ├── smoke.mjs      # 接口全链路冒烟测试
│   ├── render.mjs     # jsdom 执行前端代码的 DOM 级测试
│   ├── auth.mjs       # 登录/鉴权/落库测试
│   └── supa-mock.mjs  # 假 Supabase（内存版 RPC），没真库也能验证存储通道
├── data/
│   └── planner.db     # 未配 Supabase 时生成的 SQLite 库（已 gitignore；老 planner.json 会自动迁移）
└── package.json
```

## 接口一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查，不需要登录（平台探活用） |
| GET | `/login` | 登录页；已登录或未设密码时跳回首页 |
| POST | `/api/login` | 提交 `{password}`，成功后下发会话 Cookie |
| POST | `/api/logout` | 作废当前会话并清 Cookie |
| GET | `/api/state` | 全量快照；`?user=身份`、`?view=成员id`（看队友，需已链接）、`?goal=目标id`（看哪个目标） |
| PATCH | `/api/users/:id` | 改成员名字、链接 / 解除链接（`linkedUserId`） |
| POST | `/api/goals` | 新建目标（新目标的清单为空） |
| PATCH | `/api/goals/:id` | 改目标名称 / 金额 / 备注 |
| DELETE | `/api/goals/:id` | 删除目标（连带其任务，至少保留一个） |
| POST | `/api/tasks` | 新建任务（挂到 `?goal=` 指定的目标下） |
| PUT | `/api/tasks/:id` | 编辑任务（标题、内容、时间、难度、金额、指标） |
| PATCH | `/api/tasks/:id/checklist/:itemId` | 勾选 / 取消子项 |
| PATCH | `/api/tasks/:id/numeric` | 更新数值目标当前进度 |
| PATCH | `/api/tasks/:id/status` | 待开始 ↔ 进行中 |
| POST | `/api/tasks/:id/settle` | 结算，把这笔钱记入所属目标 |
| POST | `/api/tasks/:id/reopen` | 撤销完成，从所属目标扣回 |
| DELETE | `/api/tasks/:id` | 删除任务 |

任务类接口要带 `?user=成员id&goal=目标id`；都不带时默认第一个成员、他的第一个目标（兼容老脚本）。所有写接口都返回最新快照，前端拿到后直接重渲染。

## 测试

- `npm test`：27 项接口断言，覆盖参数校验（金额越界、结束早于开始、重复结算）、勾选子项、数值进度、结算入账、撤销扣回、删除、目标改名与百分比联动。需要临时数据目录 + 独立端口，别对着真实库跑。
- `npm run test:ui`：用 jsdom 载入真实 `index.html` 并执行 `app.js`，覆盖首屏渲染、难度切换带动金额、弹窗开关、表单提交、清单勾选、结算、删除，并检查全程无未捕获异常。空库也能跑（会先建一条占位任务再删掉）。
- `npm run test:auth`：自己拉起一个带密码的子进程（端口 3211 + 临时数据目录），验证登录页可访问、未登录跳转、接口 401、错密码拒绝、登录后 Cookie 生效、退出后旧 Cookie 失效，并确认数据真的写进了库（Supabase 模式从接口回读，SQLite 模式读表，JSON 模式读文件）。

## 数据说明

存储是**可切换**的，按优先级自动选：

| 优先级 | 条件 | 存在哪 | 适合 |
| --- | --- | --- | --- |
| 1 | 配了 `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` | Supabase（云端 Postgres） | 正式部署，多设备、可视化看表、平台自动备份 |
| 2 | 没有 Supabase、Node ≥ 22 | 本地 SQLite `data/planner.db` | 本地开发、单机部署 |
| 3 | 都没有 | 本地 JSON `data/planner.json` | 兜底，功能一样但没有事务保护 |

### 用 Supabase（推荐）

1. 在 [supabase.com](https://supabase.com) 建一个项目（免费额度够两个人用）
2. 打开 **SQL Editor**，把仓库里 `supabase/schema.sql` 整段粘进去执行一次（建 4 张表 + 2 个函数）
3. 到 **Project Settings → API**，复制：
   - `Project URL` → 环境变量 `SUPABASE_URL`
   - `service_role` secret → 环境变量 `SUPABASE_SERVICE_KEY`（**不是 anon key**，service_role 才能绕过 RLS 写入）
4. 启动时带上这两个变量，`/api/health` 的 `storage` 就会变成 `supabase`

表结构：`planner_users` / `planner_goals` / `planner_tasks` / `planner_meta`，在 Table Editor 里能直接看到数据。

写入走 Postgres 函数 `planner_save(jsonb)`，**整套写入在一个事务里**完成；读取走 `planner_load()`，一次请求拿回全部数据。不装 `supabase-js`，纯 HTTP，没有额外依赖。

> `service_role` key 是能读写全库的密钥，只能放服务端环境变量，绝不能提交到仓库或放进前端。

### 用 SQLite / JSON

- SQLite：数据文件 `data/planner.db`（旁边有 `-wal`、`-shm`），事务写入，断电不会写坏
- 旧 `data/planner.json` 会在首次启动时自动导入 SQLite，原文件改名成 `planner.json.migrated` 留档
- Node 低于 22 时 `node:sqlite` 不可用，自动退回 JSON 文件存储
- 想清空重来：停服务，删掉 `data/planner.db*`（或 `planner.json`）
- 想换数据目录：`PLANNER_DATA_DIR=D:\somewhere npm start`

### 把老数据搬到 Supabase

```bash
node scripts/migrate-json-to-supabase.mjs
```

读 `data/planner.json`，整份推到 Supabase（会覆盖云端现有数据），会打印导入了多少个成员/目标/任务。

## 可以继续加的东西

- 每日 / 每周结算报表，按难度统计产出
- 连续完成奖励（streak）、逾期扣款
- 数据导出 CSV / 备份到云端
- 真正的账号体系（每人独立密码或邀请码），现在只是「同一密码 + 自己选身份」
