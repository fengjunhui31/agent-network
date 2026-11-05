# 网络版本、构建与升级规范

这个网络是一个本机可发布的应用，专业 Agent 是它管理的执行者。应用代码、网络 Skill 和运行时适配接口随产品版本发布；用户数据与员工身份属于实例，升级应用不能换掉它们。

## 版本各管什么

| 标识 | 定义 |
| --- | --- |
| 网络版本 | `package.json.version` 是唯一手填产品版本，lockfile 与它一致。修复升 patch，兼容功能升 minor，不兼容的工具、配置或状态契约升 major；0.x 阶段也在变更记录明确兼容性。 |
| 构建标识 | `buildId` 来自发布文件路径和完整内容，不等于版本号。一个正式版本只对应一个构建物；同版本不同内容不得覆盖。包本身另有 SHA-256。 |
| 网络规范修订 | 共享 Skill 与关联规则文件的内容指纹。协调者与员工都能识别规则变化；它不替代产品版本。 |
| 能力快照修订 | 当前配置、员工、模型、运行时 slot、源代码及规范等当前状态的指纹。改某个员工不强迫全网升版。 |
| 运行时版本 | Claude Code、其 ACP 适配器、DSH 及其 hook 插件分别固定版本、独立安装。产品升级不顺带更新全部运行时。 |
| 状态布局 | 本版 `project-local-v1` 延续原目录与数据格式。未来不兼容的持久格式必须先定义读写兼容范围、迁移与回退条件，再发布。 |

`GET /health` 返回网络版本和构建标识；源码开发模式没有发布清单，`buildId` 为空。`TEAM-CURRENT.json` 同步给出网络版本、构建标识、实际应用目录、实例目录及规范修订号。

## 构建产物

`npm run build` 从明确的文件范围产生 `dist/agent-network-<版本>.tar.gz` 和同名 `.sha256`。发布包是可在 Node.js 运行的应用代码与锁定依赖清单：含源码、安装与验证脚本、测试、网络 Skill、版本规范、安全示例配置，以及 `release-manifest.json`。清单记录每个发布文件的 SHA-256、构建标识、依赖锁、Node 要求、状态布局与运行时版本说明。

发布包不携带 `node_modules`、实际员工配置、个人模型 Key、企微凭据、`.local`、聊天历史、运行时安装目录或员工工作区。部署目标准备 Node 与 `npm ci` 锁定的依赖；Claude / DSH slot 仍在实例中管理。这是应用发布包，不是包含模型、CLI 和所有原生依赖的离线安装器。

构建后在一个空目录解包、核对清单、安装锁定依赖并运行测试。使用独立实例启动无企微连接的服务，验证 `/health`、员工目录、应用与状态路径；真实运行时或企微认证另外记录验证范围。

在有上一版归档和校验文件时，运行 `npm run verify:release -- --previous /绝对路径/上一版.tar.gz`。可加 `--legacy-cli /绝对路径/旧版/agent-network` 先用旧工具启用基线。验收在临时实例中实际执行升级、回滚、并发互斥、启动失败恢复、进程中断恢复和异步升级，并检查新版操作期间是否调用 Python。

## 实例布局

```text
agent-network/                     实例根目录；开发源码可暂时与它同目录
  network.json                     用户现场配置，不由解包覆盖
  .local/                          状态与私有配置
    workspaces/assistant/          协调者的稳定工作区
    agents/  runs/  runtimes/       原生会话、结果、运行时 slot
    wecom-inbox/  wecom-outbox/     入口事件与对外发送队列
    upgrades/                      本机备份与升级操作记录
  verification/                    测试与实际部署证据
  dist/                            构建物
  releases/<版本>-<构建标识>/       已通过安装、回归和启动验证的应用目录
  current                          指向当前应用的符号链接
```

应用根目录由所运行代码确定；`LAN_INSTANCE_ROOT` 指向实例根目录。配置从实例的 `network.json` 读取，状态在该实例的 `.local`。员工工作区的绝对路径不包含应用版本；切换应用不会让原生 CLI 误以为进入另一个工作区。

核心 npm 包提供两个 Node.js 命令。`agent-network` 用于日常操作，`agent-network-release` 独立运行在待切换的服务进程之外。它在同一文件系统内安装完整的候选包，验证清单、逐文件哈希和状态布局，在临时实例安装依赖、运行测试并启动服务。成功后将安装目录移入 `releases/`，用一次原子重命名切换相对链接 `current`。实例的 `.local/release-state.json` 记录当前和上一个已验证版本，操作锁保证同一时刻只有一个切换器。

在实例的源码目录中运行下面的命令。其他目录可使用当前安装的同一脚本，并显式传 `--instance /绝对路径/到实例`。从已安装版本运行时也会识别所属实例。构建可从独立的候选源码目录完成，部署读取构建包和配套校验文件。

```sh
npm run build
instance_dir="$HOME/agent-network-instance"
agent-network-release stage "$instance_dir" --archive dist/agent-network-0.8.1.tar.gz
agent-network-release activate "$instance_dir" --archive dist/agent-network-0.8.1.tar.gz
agent-network-release status "$instance_dir"
agent-network-release rollback "$instance_dir"
```

`stage` 只做准备。普通运维可使用前台 `activate`。从协调者自己的一轮中发起升级时使用 `agent-network-release schedule "$instance_dir" --archive <构建包>`，命令立即返回操作 ID，协调者随后结束本轮。独立切换器继承实例目录，在原轮结束后完成切换。每次操作保存在 `.local/upgrades/<操作ID>/upgrade-record.json`。准备或等待超时时，旧服务恢复调度，记录保留失败原因。默认排空期限为 900 秒，可通过 `--wait 秒数` 调整。`rollback` 同样排空现有工作，目标是上一个已验证的应用目录。

从 0.2.0 源码实例首次迁移需额外传 `--bootstrap-from dist/agent-network-0.2.0.tar.gz`。切换器逐文件核对源码与旧包，预先安装并验证旧包供回退。0.2.0 本身没有排空接口，仅在连续空闲、没有任何原生子进程且接收与发送均已结束时才允许首次交接。正常从 0.3.0 起使用服务内的活动记录与派工开关。早期 0.2.0 回退目标也按其旧版启动行为运行。

## 每次升级应留下什么

- `CHANGELOG.md`：按产品版本记录用户可见变化、兼容性、迁移要求和验证范围。
- `release-manifest.json` 与包校验和：回答“交付的是哪一份代码和说明书”。
- 实例操作记录：为每次升级或回滚保留唯一操作 ID、起止时间、操作类型、前后版本和构建标识、备份位置、配置与状态校验、测试证据、实际运行 PID/应用路径、启动健康与通道认证、成功或失败原因。失败记录也保留，不覆写成成功。
- 产品版本不包含实例聊天或业务结果；实例操作记录不保存密钥、Bot Secret 或消息正文。既有 `verification/*-rollout.json` 与 `.local/upgrades/` 继续作为历史证据。

## 切换与回滚的顺序

1. 完成隔离安装、测试和启动验证后，切换器记录原服务、工作区及回退位置，持有实例操作锁。
2. 旧服务暂停启动新的顶层任务，继续把收到的企微消息和员工完成事件存入本机队列。同一任务的补充、已接单任务的派工和员工汇报可以继续。切换器同时检查原生执行、正在落盘的最终结果、接收回调、发送和会话处理。全部收尾才关闭旧服务。
3. 切换 `current`，新版以暂停派工和队列发送的方式启动，打开原实例和工作区。切换器检查服务身份、构建标识、角色说明路径和已有员工目录。启用渠道时须获得该渠道本次启动后的就绪证明；企微适配器具体核对机器人认证。核对通过后提交版本记录，再恢复调度。
4. 启动或核对失败，切换器恢复原进程或上一份已验证应用，继续使用当下的队列、记忆和文件。用户已发送的消息和员工已完成的动作保存在实例中。在企微断开和重新认证的间隙，只有已落盘的事件有本机续办保证。
5. 若切换器进程意外退出，`agent-network-release recover "$instance_dir"`、后续的版本操作或 `npm run service -- start` 会读取未完成的操作。提交前的操作回到原版本，提交后的操作继续启用已核验的版本。正常的 `npm run service -- restart` 也由独立进程排空后重启。电脑开机后的服务启动由本机运维负责。

升级记录中的 `before`、`target`、`previous`、`drain`、`service`、`phase` 和 `status` 分别描述升级现场、目标、回退位置、排空、健康检查、阶段和结果。每次失败以自己的操作 ID 保留。切换器只接受当前兼容的状态布局。



## 构建可安装的包

在干净的 GitHub 源码检出中运行 `npm ci && npm run ci`。核心构建输出 `dist/agent-network-<版本>.tar.gz`、校验文件，以及携带归档的 npm 安装器。`npm run pack:wecom` 和 `npm run pack:relay` 分别生成可选渠道和独立中转的 npm 包。使用实际的 tgz 文件路径安装；源码仓库与 npm registry 的发布分别管理。

发布应用前记录源码提交、`buildId`、SHA-256 和 npm 包摘要。中转升级沿用其私有身份目录，停止旧版本后启动新版本，核对预约与两端实际路径。部署验收应涵盖同机通信、两台机器上的中转、活动轮进度以及回到原会话的晚到结果。
