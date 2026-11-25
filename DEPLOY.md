# 部署到 Sealos（2-3 人使用 · 手机为主）

已选定路径：**DevBox**。本地不装 Docker、不配镜像仓库、不推镜像，全部在 Sealos 云端完成。

## 〇、这份手册对应哪个版本

| 项目 | 当前值 |
| --- | --- |
| 源码包 | `award-planner-devbox.zip`（约 70 KB，只含源码，不含 `node_modules`） |
| 建议的版本说明 | `1.6`（每次更新递增，别重复用同一个号） |
| 运行时 | Node.js 22，单进程，0.2 核 / 256 Mi 就够 |
| 对外端口 | `3210` |
| 数据 | 首选 Supabase（云端 Postgres，表 `planner_*`）；未配 Supabase 时用 SQLite `planner.db`（默认 `./data/`，正式环境在 `/data/`） |
| 数据结构 | v3：成员 → 多个目标 → 每个目标一套任务清单 |
| 当前功能 | 自带登录页（密码进站·可退出）、双人看板（互相可见·只读）、多目标、三种完成指标、奖励金额随意填（三档难度给建议）、手机端底部抽屉与悬浮新建 |

目录里应该有：`package.json`、`package-lock.json`、`README.md`、`DEPLOY.md`、`src/`、`public/`、`supabase/`、`scripts/`。

## 一、DevBox 部署（主路径）

### 1. 创建 DevBox

Sealos 控制台 → DevBox → 新建：

- 运行时：**Node.js 22**
- 配置：1 核 / 2 GiB 足够
- 创建后进入 IDE：用内置的 VSCode Web，或按面板提示用 Cursor / JetBrains / SSH 连进来

### 2. 导入代码

用项目根目录的 **`award-planner-devbox.zip`**。两种方式任选：

- 拖进 DevBox 的文件面板，然后在终端解压：
  ```bash
  unzip award-planner-devbox.zip        # 镜像里没有 unzip 就用下面这条
  python3 -m zipfile -e award-planner-devbox.zip .
  ```
- 或者把项目推到 GitHub / Gitee，DevBox 里 `git clone` 下来

### 3. 装依赖并跑起来

```bash
npm ci --omit=dev
PORT=3210 PLANNER_DATA_DIR=./data APP_PASSWORD=你的密码 npm start
```

想先用 Supabase 连真库，就在命令里再带上两个变量：

```bash
SUPABASE_URL=https://xxxxx.supabase.co SUPABASE_SERVICE_KEY=你的service_role_key \
PORT=3210 APP_PASSWORD=你的密码 npm start
```

日志里出现 `任务奖励规划器已启动: http://localhost:3210` 就成功了。

> `APP_PASSWORD` 建议用**纯英文数字**（至少 6 位），别用中文和表情——密码会进 Cookie 签名和表单提交链路，非 ASCII 在个别浏览器/代理上容易出怪问题。

然后到 DevBox 的「网络配置」里把 **3210** 端口打开公网访问，拿到公网测试地址，浏览器（手机直接开也行）打开——会跳到 `/login` 登录页，输入刚才那个 `APP_PASSWORD` 就进去了。登录状态保留 30 天，中途点右上角退出图标可以主动退出。

想确认服务活着，不用带密码：

```bash
curl http://<公网测试地址>/api/health
# {"ok":true,"uptime":...,"dataDir":"/data","storage":"sqlite","dataFile":"/data/planner.db","dataFileReadable":true,"auth":true}
```

`storage` 显示 `supabase` 或 `sqlite` 就说明跑在数据库上；如果是 `json`，说明没配 Supabase 且容器里的 Node 低于 22，退回了旧的文件存储（能用，但少了事务保护，建议把运行时换成 Node 22）。

> DevBox 里跑的是开发实例：数据写在容器磁盘的 `./data`，只是用来验证页面。真正给 2-3 个人用的是第 4 步「上线」之后的应用。

### 4. 建 Supabase 数据库（推荐，10 分钟）

数据不再跟着容器走，换镜像、重启、扩容都不影响。

1. 打开 [supabase.com](https://supabase.com) 注册，**New project**，region 选 **Northeast Asia (Tokyo)** 或 **Southeast Asia (Singapore)**（国内延迟低一些）
2. 等 1-2 分钟初始化完成，进 **SQL Editor** → New query → 把仓库里 `supabase/schema.sql` 内容整段粘贴 → **Run**
3. 到 **Project Settings → API** 复制两样东西：
   - `Project URL`（形如 `https://abcdefgh.supabase.co`）
   - `service_role` secret（在 `Project API keys` 里，标着 `service_role`、默认隐藏，点 Reveal）
4. 本地/DevBox 试连一次：

```bash
SUPABASE_URL=https://xxxxx.supabase.co SUPABASE_SERVICE_KEY=eyxxxx \
PORT=3210 APP_PASSWORD=abc12345 node src/server.js
curl http://127.0.0.1:3210/api/health
# 期望 storage=supabase、readable=true
```

跑起来后回到 Supabase 的 Table Editor，看到 `planner_users` / `planner_goals` / `planner_tasks` 里已经有两条成员记录，就算通了。

> `anon` key 不行，它会被 RLS 拒绝写入；只能用 `service_role`，且只能配在服务端。

### 5. 发布版本 → 上线

1. DevBox 面板点「**发布版本**」，填版本说明（比如 `1.5`），它会自动把当前环境打包成 OCI 镜像
2. 构建成功后点「**上线**」，进入「应用管理」创建正式应用

### 6. 上线后补这些配置（DevBox 不会替你配）

**先想清楚数据放哪**：推荐 Supabase（云端数据库），不再依赖容器的存储卷。

**方案 A：Supabase（推荐）**

| 配置项 | 值 | 不配的后果 |
| --- | --- | --- |
| 环境变量 `SUPABASE_URL` | `https://xxxxx.supabase.co` | 会退回容器里的 SQLite |
| 环境变量 `SUPABASE_SERVICE_KEY` | `service_role` secret | 连不上，启动直接报错提示 |
| 环境变量 `APP_PASSWORD` | 你自己定 | 公网域名谁拿到都能改你的任务和金额 |
| 实例数（副本） | **1** 就够 | 可以多副本（数据库是共享的），但没必要多花钱 |

存储卷、`PLANNER_DATA_DIR` **都不用配**了——数据在 Supabase，容器重建也不受影响。

上线前记得先在 Supabase 的 SQL Editor 执行 `supabase/schema.sql`，否则启动会报 `planner_load 返回 404`。

**方案 B：容器本地存储（不推荐，仅当不想用云端）**

| 配置项 | 值 | 不配的后果 |
| --- | --- | --- |
| 实例数（副本） | **1** | 多副本各写一个库文件，互相覆盖（SQLite 是单文件数据库，不支持多实例写） |
| 存储卷 | 1 Gi，挂载路径 **`/data`** | 重新部署就回到初始态 |
| 环境变量 `PLANNER_DATA_DIR` | **`/data`** | 写到容器临时目录，照样丢数据 |
| 环境变量 `APP_PASSWORD` | 你自己定 | 公网域名谁拿到都能改你的任务和金额 |

端口保持 **3210** 并打开外网访问，其余用默认。

### 7. 上线后看一眼

1. 打开正式域名，先出现**登录页**，输密码能进（`curl https://<域名>/api/health` 返回 `ok:true`、`auth:true`、`storage` 为 `supabase`）
2. 顶部「我是」能切成员，「链接对方」之后能切到队友看板（只读）
3. 加一条任务 → 在应用管理里**重启应用** → 刷新，任务还在 = 数据库生效
4. 手机打开正式域名：单列布局、右下角有「＋ 新建任务」、点新建是底部抽屉
5. 到 Supabase 的 Table Editor 看 `planner_tasks`，能看到刚建的那条任务

**老数据不用管**：如果容器里还留着旧版 `planner.json`、又没配 Supabase，服务启动时会自动导入 SQLite，原文件改名成 `planner.json.migrated` 留档。配了 Supabase 则**不会**自动上传本地文件（避免把测试数据带上线），需要迁移就手动跑 `node scripts/migrate-json-to-supabase.mjs`。

## 二、以后改代码怎么更新

1. 在 DevBox 里改（或重新拖新的 zip 覆盖 `src/`、`public/`）
2. `npm ci --omit=dev`（依赖没变可以跳过）
3. 重启进程：Ctrl+C 后重跑第 3 步那条命令，先用测试地址确认效果
4. 「发布版本」填 `1.5` → 「上线」，正式应用换成新镜像

**数据在数据库里，重新上线不会丢。** 用 Supabase 时数据完全跟容器无关；用 SQLite 时要保证存储卷还挂着。版本号只是标记，不填不会失败，但出问题不好回滚定位。

**登录状态会清一次**：会话存在进程内存里，重启/发版后两个人都要重新输一次密码（十几秒的事，Cookie 里旧的会话 id 已经不在服务端了）。

## 三、备份与恢复

**用 Supabase 时**：数据在云端，不需要自己备份文件。

- 日常：Supabase 控制台 → **Database → Backups**，免费版有平台自动备份（保留期按套餐）
- 手动留一份：Table Editor 里对 `planner_tasks` / `planner_goals` / `planner_users` 用 Export 导出 CSV
- 想整体导出：SQL Editor 里 `select planner_load();`，把返回的 JSON 复制下来就是全量快照
- 恢复：把导出的 CSV 重新上传，或写个脚本调用 `planner_save(jsonb)` 整份写回

**用 SQLite 时**：全部数据就是一个库文件 `planner.db`（WAL 模式，旁边还有 `planner.db-wal`、`planner.db-shm`）。

1. 应用管理里把应用**停掉**（或缩容到 0），让数据库没有写入
2. 应用管理 → 终端：

```bash
ls -l /data
cp /data/planner.db /data/planner.db.bak-$(date +%Y%m%d)
```

3. 把 `/data/planner.db`（要连 `-wal`、`-shm` 一起，或先停应用让 WAL 落盘）下载到本地留档

**恢复**

把备份的 `planner.db` 覆盖回 `/data/planner.db`（旧的 `-wal`、`-shm` 一并删掉），重启应用。

> 停应用再拷是关键：SQLite 在写入过程中直接拷二进制文件，可能拷到半写状态。停掉后拷就是一致的。
> 如果 `planner.db` 真损坏了（极少见），把 `planner.json.migrated` 改名回 `planner.json`、删掉坏的 db，重启会自动重新导入最近一次迁移时的快照。

## 四、为什么还绕不开「应用管理」

DevBox 是开发环境：可以暂停、公网地址是临时的、容器磁盘不属于生产存储。2-3 个人长期使用的那个实例，一定是「上线」之后跑在应用管理里的。DevBox 只是把「写代码 → 出镜像 → 上线」这条链路省掉了本地 Docker 和镜像仓库。

## 五、踩坑清单

1. **DevBox 暂停了，公网地址打不开**：正常，不是坏了，重新启动即可。
2. **忘了 `npm ci` 直接 `npm start`**：报 `Cannot find module 'express'`。
3. **端口没在 DevBox 网络配置里开放**：公网地址 502 / 连接超时。
4. **上线后没挂存储卷**（SQLite 模式）：表现是"每次更新版本任务就没了"。用 Supabase 不会有这个问题。
5. **上线后没设 `PLANNER_DATA_DIR=/data`**（SQLite 模式）：同上，数据写到容器内临时目录。
6. **`APP_PASSWORD` 留空**：站点就没有登录页，任何人拿到域名都能进。本地开发图方便可以留空，线上一定设。
7. **Supabase key 用了 anon**：启动报错或写入被 RLS 拒绝，要用 `service_role`。
8. **忘了执行 `supabase/schema.sql`**：`/api/health` 报 `planner_load 返回 404`，说明函数没建。
9. **国内访问 Supabase 慢**：项目建在新加坡/东京region延迟低一些；实在卡就换回 SQLite + 存储卷。
7. **`APP_PASSWORD` 用了中文/表情**：密码要落进 Cookie 签名和表单提交，非 ASCII 在个别浏览器/代理上会出怪问题。改用英文数字，至少 6 位。
8. **上线后副本 > 1**：最致命，多个 Pod 各持一份内存状态写同一文件。锁死 1。
9. **DevBox 重建/删环境**：`./data` 里的测试数据会没，正式数据在存储卷里不受影响。
10. **改了 `package.json` 依赖但没重打锁文件**：`npm ci` 会报 lock 不一致，改用 `npm install` 临时救急并提交新的 lock。
11. **忘了发新版本就以为上线生效**：DevBox 里改的代码不点「发布版本」，正式应用还是旧镜像。
12. **重启后有人说"被登出了"**：正常，会话在内存里，重启即失效，重新输密码即可。
13. **忘了密码**：改应用的环境变量 `APP_PASSWORD` 保存后会自动重启，之后所有人要用新密码重新登录（数据不受影响）。
14. **反复输错密码被锁**：同一 IP 连续错 8 次会锁 5 分钟，等一会儿或换到手机流量再试。
15. **部署后看不到登录页，直接进了应用**：说明这个实例没读到 `APP_PASSWORD`。先 `curl https://<域名>/api/health` 看 `auth` 字段——`false` 就按顺序查：① 应用管理的环境变量里有没有填（在 DevBox 里设的不会带到应用上）；② 有没有点「发布版本」并「上线」，跑的可能还是旧镜像；③ 保存环境变量后应用有没有重启。填好后重启，`auth` 变 `true` 才会出现登录页。

## 六、备选：镜像 + 应用管理（不用 DevBox）

有自己的镜像仓库（或想用 CI 构建）时走这条：本地/CI 构建镜像 → push 到仓库 → 应用管理直接填镜像地址。项目里 `Dockerfile` 已就绪：

```powershell
docker build -t award-planner:1.4 .
# 国内加速（Docker Hub 直连常失败时用）
docker build --build-arg BASE_IMAGE=docker.m.daocloud.io/library/node:22-alpine --build-arg NPM_REGISTRY=https://registry.npmmirror.com -t award-planner:1.4 .
docker run --rm -p 3210:3210 -v planner-data:/data -e APP_PASSWORD=test123 award-planner:1.4
```

Apple 芯片机器构建时加 `--platform linux/amd64`。注意这台机器 `~/.docker/daemon.json` 里配的三个加速源（ustc / 网易 / 百度）现在全部 DNS 失效，直连 Docker Hub 会超时，需要手动从 `docker.m.daocloud.io` 拉基础镜像，或把 mirrors 换成可用的地址（`docker.m.daocloud.io`、`docker.1ms.run` 实测可用）。

## 七、关于「2-3 个人」

现在是**两个成员各自的看板**：顶部「我是」切换身份，每人一套目标（可建多个），每个目标带自己的任务清单，互不影响；点「链接对方」之后双方可以互相看进度（只读），不想看了点「解除链接」。

**手机用**：页面是按手机优先做的——窄屏单列、右下角悬浮「＋ 新建任务」、目标卡横向滑动、弹窗是底部抽屉、输入框 16px 防 iOS 放大。DevBox 那个公网测试地址或者上线后的正式域名，直接在手机浏览器打开就行；iPhone 用 Safari 打开后点「分享 → 添加到主屏幕」，就能像 App 一样从桌面点开。

**注意**：DevBox 测试地址在 DevBox 暂停后会失效，长期用要走上线后的应用域名。

两点要知道：

- **登录只管进门，不管身份**。两个人共用一个 `APP_PASSWORD`；进站之后还是在顶部自己选「我是谁」。想防住"故意切别人身份"，得做真正的账号体系（见下一节）。
- 登录状态：`HttpOnly` Cookie，有效期 30 天，点右上角退出即作废；同一 IP 连错 8 次锁 5 分钟；换密码或重启服务后所有人都要重新登录。
- 域名 + 密码一起发给对方就行，别把域名贴到公开群里——密码再强，陌生人看到地址也会先试探一波。
- 每个成员最多 20 个目标；删目标会连带删掉它名下的任务，所以至少保留一个。

## 八、想再加人 / 换真账号

- **加人（还是共享密码）**：改 `src/store.js` 里的 `DEFAULT_USERS` 增加一条（新库生效）；已经跑起来的库则直接往 `users` 表插一行、不用给 `goals` 加数据（新成员会自动得到一个空目标），顶部下拉就会多出一个身份。
- **真账号（每人自己的密码、邀请码注册）**：要加用户表和登录态。`store.js` 按成员分片的结构（`users` + `boards`）可以沿用，改动集中在 `api.js` 的鉴权中间件和前端身份条，工作量比现在这套大不少；朋友之间互相看数据的需求，现在这样够用。
