# Agent Network

Agent Network 连接独立运行的 AI 团队。每个实例有自己的协调者、员工模板、运行时和工作区。协调者可以自己接单，也可以把工作分给专业员工，先同步进度，稍后在发起会话交付结果。

核心通过 ACP 驱动 Claude Code 和 DSH，通过 MCP 提供派工、发送消息和获取结果的工具。Codex 可上报经用户选择的项目、会话用途与工具名称。企业微信入口和跨机器中转都可以单独安装。

## 从源码开始

需要 Node.js 22.13+、npm 和 POSIX 系统。macOS 使用系统 `lockf`，Linux 使用 util-linux 的 `flock`。在新目录运行以下命令。

```sh
git clone https://github.com/fengjunhui31/agent-network.git
cd agent-network
npm ci
npm run ci
npm install -g "$PWD/dist/shiyanjia-agent-network-0.9.3.tgz"
instance="$HOME/agent-network-instance"
agent-network init "$instance"
agent-network-release activate "$instance"
agent-network-release status "$instance"
```

这些步骤可在没有模型密钥和企微账号的环境中验证。运行真实员工前，在自己的实例配置网关与原生运行时。[安装、员工配置和团队互联](docs/INSTALL.md)

## 同机与跨机器协作

一个团队在通讯录里以一个 `node:别名` 对外联系，内部员工仍由本机管理。两个网络交换公开身份卡并相互批准。同一用户下的同机网络优先走 Unix socket；跨机时通过两端配置的中转建立 Noise 加密连接。进度可以在原执行仍活动时到达，晚到的结论可以回到同一会话。新实例默认关闭跨机联邦。要使用中转，请自行部署或向你的管理员取得地址和公开 Peer ID。[互联协议与数据边界](docs/design/FEDERATION.md)

| 组件 | 源码 | 用途 |
| --- | --- | --- |
| 核心 | `src/`、`scripts/` | 管理员工、工作区、会话、运行时、通讯录与升级。安装器提供 `agent-network` 和 `agent-network-release`。 |
| 企微渠道 | `packages/wecom/` | 接收私聊或群聊任务，持久保存收发队列，并将结果交付原会话。 |
| 中转服务 | `packages/relay/` | 检查参与节点身份，接受预约，转发加密流量并限制资源。 |
| 员工说明 | `skills/agent-network/` | 协调者和员工共用的操作规范，以及实例当时的能力快照。 |

[架构](docs/ARCHITECTURE.md) · [版本与升级](docs/RELEASING.md) · [贡献指南](CONTRIBUTING.md)

## 加入一台自己的机器

已有 Agent 可以按本仓库说明安装核心，再拿到主网络私下提供的邀请文件。在新机器运行 `agent-network host "$HOME/team-machine" join --invite /私有目录/team.host-invite.json --consent`。机主确认盘点范围、主网络核对并批准后，协调者可查询运行时、CLI、选定项目的 Skill/MCP 和明确授权的动作。[受管机器操作手册](skills/agent-network/references/managed-hosts.md)
