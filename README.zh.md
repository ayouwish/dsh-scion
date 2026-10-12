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
| 文件系统 | 导入目录 `0555`、文件 `0444`。写句柄必须先以写模式打开 `session.lock` 拿内核租约，`EACCES` 直接让写打开失败；读句柄不碰锁，所以读取和 fork 不受影响 | POSIX；Windows 忽略权限位 |
| 归属索引 | `$DSH_HOME/scion/ownership.json` 记录 imported id；导出时跳过、命令层拒绝 | 全平台 |
| 模型步 | `agent/pre-step` 返回 `{kind:'reject'}`（与 `ArchivedSessionGate` 同机制）。pre-step 在 `user/message` **之前**，所以不会把 prompt 写进日志 | 全平台 |

**fork 三层都不受影响**：fork 只读源、在别处建新 id。

## 命令

```
/scion status                            看这个 scion、本地 session、导入的只读 session
/scion init [name]                       把当前目录初始化成 scion（必要时 git init）
/scion push [--sessions a,b] [--push]    导出本地 session 并 commit（--push 顺带发布）
/scion pull [--sessions a,b] [--no-git]  git pull，然后把仓库里的 session 只读导入
/scion prune [--sessions a,b] [--dry-run]  删掉 workspace 已不再拥有的已导出 session
/scion forget <session-id>               删掉只读归属记录（文件保留）
```

scion 根 = 发起命令的 session 的工作目录，所以命令总是作用于你正在说话的那个 checkout。

### 首次发布：remote 与 upstream

`/scion init` 只做 `git init` + 写 manifest，**不替你配 remote**（凭据是你的）。所以先配一次：

```sh
cd <scion-root>
git remote add origin git@your-host:you/demo-scion.git   # 或 user@server:~/scions/demo.git（裸仓库）
```

之后 **`/scion push --push` 在没有 upstream 时会自动 `git push --set-upstream origin <branch>`**
——首次发布不需要手动 `git push -u`。若根本没有 remote，它会明确告诉先 `git remote add`。

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
dsh plugin --profile web add @asyouwish/dsh-scion@0.3.0
# 源码 checkout：通过它的 npm 脚本进入同一个启动器：
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add @asyouwish/dsh-scion@0.3.0
# 你的默认 registry 若是镜像、可能晚于刚发布的版本，就加
# --registry=https://registry.npmjs.org/

# 想直接用本地 checkout 开发：
#   dsh plugin --profile web add "file:/path/to/dsh-plugins/dsh-scion"
# 注意 `file:` 目录依赖是「硬链接」：重建仓库会就地改写已安装的插件，后新增的文件
# （如 lib/prune.js）在重跑安装前不会出现。要独立副本就先打包：
#   pnpm pack && dsh plugin --profile web add /path/to/asyouwish-dsh-scion-0.3.0.tgz

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
dsh plugin --profile web add @asyouwish/dsh-scion@0.3.0
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
- **没有 Web UI**：只有 `/scion` 命令；侧边栏不区分「本机 / 只读导入」。
- **导出的是当前有效前缀**：导出正在运行的 session 时读到的是当时的有效前缀（安全，但可能切在 turn 中间）。

## 开发

```sh
pnpm install
pnpm build      # tsc → lib/
pnpm test       # 28 个测试
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

## 模块

| 文件 | 职责 |
|---|---|
| `cordis.patch.yml` | bundle 层：向所有列出本包的 profile 插入 `/scion` 行 |
| `src/index.ts` | 插件入口：Config 校验、只读闸门、`/scion` 注册 |
| `src/service.ts` | 命令执行器（根从 session cwd 解析） |
| `src/commands.ts` | `/scion` 参数语法（纯函数，可单测） |
| `src/export.ts` | push：workspace 名下的本地 session → 仓库明文信封 |
| `src/prune.ts` | prune：删掉 workspace 已不再拥有的仓库 session |
| `src/import.ts` | pull：仓库 → 只读本地 session（cwd 本地化、归属记录、权限位） |
| `src/readonly.ts` | `agent/pre-step` 闸门 |
| `src/ownership.ts` | 本机归属索引（串行化写入 + 原子替换） |
| `src/manifest.ts` | `.dsh/scion.json` 读写与严格校验 |
| `src/repo-format.ts` | 仓库信封编解码（稠密 seq 校验） |
| `src/locate.ts` | 镜像后端的目录命名并**验证**定位 |
| `src/workspace.ts` | 本机 workspace 合成与 attach（兼作导入后自检） |
| `src/git.ts` | `git` 子进程封装 |
