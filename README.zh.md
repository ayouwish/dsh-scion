# @asyouwish/dsh-scion

**Scion**（接穗）—— 一个用 git 搬运的「workspace + 选定 session」单元。

从母本剪下一枝、嫁接到新的砧木上：把本机的 session 导出到 git 仓库，在另一台机器上
导入成**只读**副本，从它 fork 出自己的 session 继续干活。**可以合并的只有 workspace，
session 只 fork 不 merge。**

## 为什么 session 不能 merge

session 日志是**追加式、自描述**的记录：`seq` 从 0 稠密连续，fork 切口由日志里
`session/end-seed` 的标记事件承载。两台机器往同一个 id 追加会撞上同一批 seq，
产出的日志后端会直接拒绝加载。所以：

- 导入的 session **按构造只读**；
- 想接着干，就 fork 成一个本机拥有的**新 id**；
- `parentSession` 血缘跨机器仍然可解析，因为 id 全局稳定。

## 三层只读防御

| 层 | 机制 | 覆盖 |
|---|---|---|
| 文件系统 | 导入目录 `0555`、文件 `0444` —— **但 `session.lock` 保持可写**：DSH 在**任何** attach 时都会以写模式打开它来拿内核租约，而它的投影层只为 live session 写 checkpoint（列表标题就来自那里）。真正的写入依然被拒：追加事件会在不可写的日志上拿到 `EACCES`，靠 rename 的日志重写又需要可写目录。读句柄不碰锁，所以读取和 fork 不受影响 | POSIX；Windows 忽略权限位 |
| 归属索引 | `$DSH_HOME/scion/ownership.json` 记录 imported id；导出时跳过、命令层拒绝 | 全平台 |
| 模型步 | `agent/pre-step` 返回 `{kind:'reject'}`（与 `ArchivedSessionGate` 同机制）。pre-step 在 `user/message` **之前**，所以不会把 prompt 写进日志 | 全平台 |

**fork 三层都不受影响**：fork 只读源、在别处建新 id。

这个「租约例外」不是审美问题：完全 `0555`/`0444` 的导入根本 attach 不上，表现就是 sync
下来的会话永远未命名、每次打开都重新 fold 一遍日志。`/scion pull` 和插件加载（它会就地修好
旧版本留下的导入）都只把 `session.lock` 留成可写。

## 命令

```
/scion status                            看这个 scion、本地 session、导入的只读 session
/scion init [name] [--remote <url>]      把当前目录初始化成 scion（必要时 git init）
/scion remote [<url>]                    查看，或设置 origin 仓库地址
/scion push [--sessions a,b] [--push]    导出本地 session 并 commit（--push 顺带发布）
/scion pull [--sessions a,b] [--no-git]  git pull，然后把仓库里的 session 只读导入
/scion prune [--sessions a,b] [--dry-run]  删掉 workspace 已不再拥有的已导出 session
/scion forget <session-id>               删掉只读归属记录（文件保留）
```

scion 根 = 发起命令的 session 的工作目录，所以命令总是作用于你正在说话的那个 checkout。

`status` / `init` / `forget` 当场返回。`push` / `pull` / `prune` 是重活（实测一个 147 session
的目录 ≈ 394 MB，外加 git），所以在有 job registry 的组合里它们会跑成**后台 job**：命令立刻
返回 job id，逐 session 的进度与明细流进 job 的输出 ring，属主 session 可以 kill，完成时在会话
内收到通知（需要时用 `job_output <id>` 读取）。没有 job registry（未组合 `dsh-jobs`，或没有
controller 服务该 agent）时，同一份工作同步执行，输出就是命令文本。

### Web 面板：这个仓库带了哪些 session、来自哪台机器

会话头部会多一个 **Scion** 动作，点开就是当前 workspace 仓库的树：

```
scion dsh-stories                     master → origin/master · clean
origin https://***@example.com/team/dsh-scion.git
repo 147 session(s) · 394.0 MiB · local 147 cwd-matching, 32 exportable, readonly 6
▾ …/project/dsh-stories   32 session(s)
  └ 8f3c…  344 events  10-11 21:55  12.3 KiB   本机·可导出
▾ /home/alice/project/dsh-stories   115 session(s)
  └ 02b1…  340 events  10-10 09:12  8.1 MiB    只读导入
```

导出的 session 按**导出它的那台机器**分组（manifest 里的 `originRoot`），每行给出事件数、
导出时间、仓库文件大小，以及本机身份：workspace 内可导出 / 只读导入 / 都不是。顶部一行重复
分支、upstream 与导出、只读计数。

客户端这一侧只是传输：面板直接 `fetch('/api/scion/tree?session=<id>')`（host 路由会解析该
session 的 cwd，也接受绝对路径 `?root=`），所以**不需要**生成式的 remote contract。该路由和
其他 Host API 路由一样由浏览器 connection 准入，**拿不到 connection 就 fail-closed**；没有
浏览器 HTTP 载体的宿主（Electron）不会注册这条路由。

导入的会话有两处标记：侧栏行上有 `只读·<机器>`（`sidebar.session.row.leading`，数据来自按页缓存的
`GET /api/scion/imports`），会话头部还有一个 **只读徽标**（`conversation.session.header.utilities`）：`GET /api/scion/session?session=<id>`
返回本机的归属记录，只有导入的会话才渲染 `只读 · <机器>`，所以同步来的只读副本不会被误当成本机工作。

配色只走 DSH 的 design token：面板读 `--dsw-alias-*`（surface / label / border / state）、
`--ds-font-family-code` 与用户可调的 `--dsh-content-font-size-secondary`，并带**明暗通用**的兜底值，
因此跟随 dsh-web 的浅色/深色主题，不写死调色板。

前端产物由 `scripts/build-client.mjs` 构建，用的是 **harness checkout 里的 esbuild** —— 因为
DSH 的 client 构建预设是仓库内部文件、没有作为包发布。checkout 不在同级目录时用
`DSH_HARNESS_DIR` 指定；产出的 `lib/client.js` 随 npm 包发布，使用者无需这个构建。

### 首次发布：remote 与 upstream

仓库地址是交给 scion 的，不用碰命令行 `git`。初始化时给，或之后随时给：

```
/scion init my-work --remote git@your-host:you/demo-scion.git
/scion remote git@your-host:you/demo-scion.git     # 新增或更新 origin
/scion remote                                      # 查看 remote 与 upstream
```

git 接受的各种 URL 都行（`https://…`、`git@host:path`、`ssh://…`、本地路径）。带凭据的 URL
会原样保存，但**显示时一律打码**（`https://***@host/…`）。

之后 **`/scion push --push` 在没有 upstream 时会自动 `git push --set-upstream origin <branch>`**
——首次发布不需要手动 `git push -u`。若根本没有 remote，它会明确告诉先用 `/scion remote <url>`。

`/scion pull` 用 `git pull --ff-only`：两边都改了 workspace 时它会失败并要求显式 merge。
这是故意的——**只有 workspace 需要 merge**；session 文件永不冲突，因为导入的是只读副本。

### 选择导出哪些 session

`/scion push` 不带参数导出的是 **DSH 记在该 workspace 名下的 session**：workspace 记录
account 里的 id，且其 header 的 cwd 等于该目录——和侧边栏分组用的是同一条两条件规则。
子 agent（subagent）子会话、以及从未挂载到该 workspace 的会话，默认**不导出**。
这点很重要，因为明文 JSONL 很大（实测一个 147 session 的目录 ≈ 394 MB，其中只有 32 个
是 workspace 成员）：

```
/scion push --sessions <id1>,<id2> --push
```

显式选择会按「canonical cwd 等于该 root 的全部本地 session」校验，所以 subagent 子会话
**可以**按需导出。若宿主机没有 workspace registry，或该目录还没有任何记录，则回退到
整个 cwd 匹配集合。`/scion status` 会同时打印两个数字（`local` = 可导出，`all` = cwd 匹配）。

已导出的文件不会被自动删除；`/scion prune` 是 push 的显式逆操作。它会删掉 workspace
已不再拥有的 session（即默认导出范围的补集）、移除对应 manifest 记录并 commit；
`/scion prune --dry-run` 只报告同一份计划、不删任何东西。prune 只处理 manifest 里有记录的
session——没有记录的 `.jsonl` 只报为 *unmanaged*、绝不触碰；全新 clone 且本机没有本地
session 时也不会误删。`--sessions <id>` 则按精确选择删除，也用于删掉本地 log 已消失的
session。

## 仓库布局

```
<scion-root>/
  .dsh/scion.json                        manifest：scionId / name / sessionFormatVersion / sessions[]
  .dsh/sessions/<sessionId>.jsonl        明文 JSONL 信封（可 diff、可 review）
  <workspace files...>                   workspace 内容本体，唯一会被 merge 的东西
```

仓库文件格式（本插件自有，不是 DSH 的物理格式）：

```
{"type":"scion/session","schemaVersion":1,"sessionFormatVersion":4,...}   第一行：信封
{"type":"turn/start","seq":0,...}                                        之后每行一个原始事件
```

导入走 persistence 的公开 API（`create` + `append` + `flush`），所以编码、压缩、分帧、
校验全部由后端负责。

## L0：传输层不改写事件内容

导入唯一替换的值是 header 的 `cwd`——DSH 的 workspace 成员资格、跨会话读授权、sandbox 根、
`AGENTS.md` 发现都读它，所以这是强制的。**事件 payload 逐字节保留，不做任何路径改写。**

代价是历史里的绝对路径仍是原机器的路径。插件用一条 system prompt 来源提示缓解；
若将来真的需要跨机路径可移植性，再引入占位符变换（已评估，未采用）。

## 安装

dsh-scion 是一个 **bundle**：装上就等于挂好。`dsh plugin` 会把它加进 profile 的
`dsh.profile.bundles`，再由包自带的 `cordis.patch.yml` 插入 `/scion` 那一行 ——
不需要手写任何 profile 条目。

```sh
# 发布版（打包的 DSH 应用）：
dsh plugin --profile web add @asyouwish/dsh-scion@0.4.0
# 源码 checkout：通过它的 npm 脚本进入同一个启动器：
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add @asyouwish/dsh-scion@0.4.0
# 你的默认 registry 若是镜像、可能晚于刚发布的版本，就加
# --registry=https://registry.npmjs.org/

# 想直接用本地 checkout 开发：
#   dsh plugin --profile web add "file:/path/to/dsh-plugins/dsh-scion"
# 注意 `file:` 目录依赖是「硬链接」：重建仓库会就地改写已安装的插件，后新增的文件
# （如 lib/prune.js）在重跑安装前不会出现。要独立副本就先打包：
#   pnpm pack && dsh plugin --profile web add /path/to/asyouwish-dsh-scion-0.4.0.tgz

# 之后重启 dsh web。dsh-hmr 忽略 **/node_modules，插件「代码」不会热重载。
```

要改 bundle 的配置，就在 profile 自己的 patch 里写一条 id 定向行（该层在所有 bundle
层之后应用，行仍归 bundle 所有；**不要**再用 `insert:` 重复一遍，那会挂载两次）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: scion
  config:
    enabled: true
    readonlyGate: true
```

**从 0.2.0 升级**（那一版靠手写 `insert:` 行挂载）：`dsh plugin` 只激活「新增的依赖」，
所以别原地升级，而是先删再装，同时删掉旧的 `insert:` 行：

```sh
dsh plugin --profile web remove @asyouwish/dsh-scion
dsh plugin --profile web add @asyouwish/dsh-scion@0.4.0
```

`dsh plugin` 即使只是重装了一遍包也会报成功，`remove` 也可能偶发非零退出（重试即可）。
两条路走完都要确认 profile `package.json` 的 `dsh.profile.bundles` 里多出了
`@asyouwish/dsh-scion` —— 挂载靠的是这个列表项，不是 dependencies；少一项就会
「装上了但 `/scion` 不存在」。

**一个 profile 只用一个 pnpm 大版本。** `dsh plugin` 最终会转发给某个 pnpm：源码
checkout 用 `PATH` 上的那个，打包应用用安装自带的那个。profile 的 `node_modules`
属于「最后一次写它的 pnpm」的 store ——
`~/.dsh/profiles/web/node_modules/.modules.yaml` 里的 `packageManager` / `storeDir`
就是证据，而 pnpm 10/11 分别用 `store/v10` / `store/v11`。拿另一个大版本指向它会触发
purge 重建 `node_modules`（非交互时直接以
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` 中止）。先读 `.modules.yaml` 里记的版本，
然后一直用它；要把 profile 换到另一个大版本，就用目标 pnpm 跑一次带
`--config.confirmModulesPurge=false` 的安装。

> 验证：`/scion status` 会打印 `branch` / `remote` / `upstream` / `worktree`，
> 以及 `local`（可导出）与 `all`（cwd 匹配）两个计数。
> 完整示例见 [examples/cordis.patch.yml](examples/cordis.patch.yml)。

## 限制（已知，未做）

- **不搬运附件**：session 里的图片/文件是内容寻址引用，目前不会随仓库搬运。
- **没有 `drop` 子命令**：`/scion prune` 是 push 的显式逆操作，但 prune 永不自动发生——
  单独 export 不会删除任何文件。
- **subagent 子会话默认不导出**：它们不属于 workspace 记录；要带走需显式
  `/scion push --sessions <id>`。
- **跨版本拒绝**：仓库里的 session format 版本与本地 writer 不一致时拒绝导入（迁移链只前进不降级）。
- **`cwd` 之外的耦合**：导入后建议重启一次 dsh，让 workspace 的 canonical 索引重建；
  正常流程下 `attachSession` 会触发懒加载重索引，但「cwd 目录当时还不存在」这类陈旧缓存需要重启。
- **面板依赖浏览器 HTTP 载体**：Scion 动作读的是 `GET /api/scion/tree`，没有这条路由的宿主
  （Electron 走 IPC fetch）会显示取数失败而不是树。
- **导出的是当前有效前缀**：导出正在运行的 session 时读到的是当时的有效前缀（安全，但可能切在 turn 中间）。

## 开发

```sh
pnpm install
pnpm build      # tsc → lib/ + 浏览器半（scripts/build-client.mjs）
pnpm test       # 52 个测试
pnpm verify     # build + test
```

测试分三层：

- `tests/unit.spec.ts` —— 命令语法、仓库信封、manifest、归属索引、目录名镜像（纯逻辑）
- `tests/closed-loop.spec.ts` —— **对真实 JSONL 后端**跑完整闭环：A 导出 → B 在不同绝对路径导入 →
  只读（校验目录与文件权限位）→ 幂等重导 → A 继续写 → B 追加 → 写打开被拒；外加本地 id 冲突与版本闸门
- `tests/export-scope.spec.ts` —— 对真实后端校验导出归属与 prune：默认只导出 workspace 记录 account 里的 id，
  显式 `--sessions` 仍可选中 subagent 子会话，没有可用 workspace 记录时回退到 cwd 相等；prune 恰好删掉补集，
  不碰 unmanaged 文件，且本机没有本地 session 的 clone 不会误删
- `tests/loader-composition.spec.ts` —— 经真实 cordis Loader 挂载：仅凭包内的 `dsh.bundle`
  补丁层就能挂上 `/scion`，profile 自己的层可覆盖它，坏 config 不激活
- `tests/jobs.spec.ts` —— 后台 job 适配（注册、流式输出、cancel 变 killed、失败结算、无 registry 回退）
  与服务路由：有 registry 时 `push` 提交 job，没有时同步执行
- `tests/git.spec.ts` —— 仓库状态、首次 push 的 upstream，以及 remote 新增/更新与凭据打码
- `tests/remote.spec.ts` —— 仓库地址的命令面：`/scion init --remote` 一步到位、`/scion remote`
  的新增/更新/查看，以及不在 git 工作区时的拒绝
- `tests/tree.spec.ts` —— 面板 host 半（对真实后端 + 真实仓库）：按机器分组、本机/只读/可导出标记、
  字节合计，以及路由的 200/400/405/403
- `tests/client-bundle.spec.ts` —— 在 VM 里加载真实产物：closure-factory 注册、externals 走注入的
  `require`、会话头部动作的注册，以及**主题 token 守卫**（不允许写死深色调色板）

## 模块

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | bundle 层：向所有列出本包的 profile 插入 `/scion` 行 |
| `src/index.ts` | 插件入口：Config 校验、只读闸门、`/scion` 注册 |
| `src/service.ts` | 命令执行器（根从 session cwd 解析） |
| `src/commands.ts` | `/scion` 参数语法（纯函数，可单测） |
| `src/export.ts` | push：workspace 名下的本地 session → 仓库明文信封 |
| `src/prune.ts` | prune：删掉 workspace 已不再拥有的仓库 session |
| `src/jobs.ts` | push/pull/prune 的后台 job 适配（可选 peer：`dsh-jobs`） |
| `src/tree.ts` | 面板快照：manifest 里的 session 按导出机器分组 |
| `src/route.ts` | `GET /api/scion/tree`，由浏览器 connection 准入 |
| `src/client/` | 浏览器半：会话头部的 Scion 面板（slot 注册 + React） |
| `scripts/build-client.mjs` | 用 harness 的 esbuild 产出 `lib/client.js`（closure factory） |
| `src/import.ts` | pull：仓库 → 只读本地 session（cwd 本地化、归属记录、权限位） |
| `src/readonly.ts` | `agent/pre-step` 闸门 |
| `src/ownership.ts` | 本机归属索引（串行化写入 + 原子替换） |
| `src/manifest.ts` | `.dsh/scion.json` 读写与严格校验 |
| `src/repo-format.ts` | 仓库信封编解码（稠密 seq 校验） |
| `src/locate.ts` | 镜像后端的目录命名并**验证**定位 |
| `src/workspace.ts` | 本机 workspace 合成与 attach（兼作导入后自检） |
| `src/git.ts` | `git` 子进程封装，含 remote 配置（`/scion remote`） |
