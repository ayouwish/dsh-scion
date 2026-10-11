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

`/scion push` 不带参数会导出**该 workspace 的全部本地 session**，明文 JSONL 体积可能很大
（实测一个 147 session 的 workspace ≈ 394 MB）。只想要一部分就显式选择：

```
/scion push --sessions <id1>,<id2> --push
```

已导出的文件不会被自动删除；要瘦身需手动 `rm .dsh/sessions/<id>.jsonl` 后重新 commit
（目前没有 `drop` 子命令，见「限制」）。

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

```sh
# 1. 装进 profile。必须用「当初装这个 profile 的那个 pnpm 大版本」：
#    `dsh plugin add` 会转发给 PATH 上的 pnpm，store 版本不匹配会报
#    ERR_PNPM_UNEXPECTED_STORE。
cd ~/.dsh/profiles/web
npx --yes pnpm@10.33.2 add "file:/path/to/dsh-plugins/dsh-scion"

# 2. 在 profile 的 patch 层加一行（本插件不是 bundle，需要显式挂载）。
#    裸 `- id: scion` 是「改已存在的行」，会被拒为
#    `patch: entry "scion" not found`；新增行必须用 insert:。
#    ~/.dsh/profiles/web/cordis.patch.yml
#    - insert:
#        - id: scion
#          name: '@asyouwish/dsh-scion'
#          config:
#            enabled: true

# 3. 重启 dsh web。dsh-hmr 忽略 **/node_modules，所以插件「代码」更新不会热重载，
#    只有 profile 的 patch 文件会被监听。
```

> 验证：`/scion status` 会打印 `branch` / `remote` / `upstream` / `worktree` 四行。
> 完整示例见 [examples/cordis.patch.yml](examples/cordis.patch.yml)。

## 限制（已知，未做）

- **不搬运附件**：session 里的图片/文件是内容寻址引用，目前不会随仓库搬运。
- **没有 `drop` 子命令**：已导出的 session 文件不会自动删除或瘦身，需要手动 `rm` + commit。
- **跨版本拒绝**：仓库里的 session format 版本与本地 writer 不一致时拒绝导入（迁移链只前进不降级）。
- **`cwd` 之外的耦合**：导入后建议重启一次 dsh，让 workspace 的 canonical 索引重建；
  正常流程下 `attachSession` 会触发懒加载重索引，但「cwd 目录当时还不存在」这类陈旧缓存需要重启。
- **没有 Web UI**：只有 `/scion` 命令；侧边栏不区分「本机 / 只读导入」。
- **导出的是当前有效前缀**：导出正在运行的 session 时读到的是当时的有效前缀（安全，但可能切在 turn 中间）。

## 开发

```sh
pnpm install
pnpm build      # tsc → lib/
pnpm test       # 17 个测试
pnpm verify     # build + test
```

测试分三层：

- `tests/unit.spec.ts` —— 命令语法、仓库信封、manifest、归属索引、目录名镜像（纯逻辑）
- `tests/closed-loop.spec.ts` —— **对真实 JSONL 后端**跑完整闭环：A 导出 → B 在不同绝对路径导入 →
  只读（校验目录与文件权限位）→ 幂等重导 → A 继续写 → B 追加 → 写打开被拒；外加本地 id 冲突与版本闸门
- `tests/loader-composition.spec.ts` —— 经真实 cordis Loader 挂载、`/scion` 注册、配置错误不激活

## 模块

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：Config 校验、只读闸门、`/scion` 注册 |
| `src/service.ts` | 命令执行器（根从 session cwd 解析） |
| `src/commands.ts` | `/scion` 参数语法（纯函数，可单测） |
| `src/export.ts` | push：本地 session → 仓库明文信封 |
| `src/import.ts` | pull：仓库 → 只读本地 session（cwd 本地化、归属记录、权限位） |
| `src/readonly.ts` | `agent/pre-step` 闸门 |
| `src/ownership.ts` | 本机归属索引（串行化写入 + 原子替换） |
| `src/manifest.ts` | `.dsh/scion.json` 读写与严格校验 |
| `src/repo-format.ts` | 仓库信封编解码（稠密 seq 校验） |
| `src/locate.ts` | 镜像后端的目录命名并**验证**定位 |
| `src/workspace.ts` | 本机 workspace 合成与 attach（兼作导入后自检） |
| `src/git.ts` | `git` 子进程封装 |
