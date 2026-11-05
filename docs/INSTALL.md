# 安装和使用 Agent Network

需要 POSIX 系统、Node.js 22.13+、npm，以及 macOS 的 `lockf` 或 Linux 的 `flock`。将实例放在源码目录之外。`current` 指向已启用版本，员工工作区、凭据、队列和记忆放在实例的 `.local/`。

## 安装

```sh
git clone https://github.com/fengjunhui31/agent-network.git
cd agent-network
npm ci
npm run ci
npm install -g "$PWD/dist/shiyanjia-agent-network-0.9.1.tgz"
instance="$HOME/agent-network-instance"
agent-network init "$instance"
agent-network-release activate "$instance"
agent-network-release status "$instance"
```

`npm run ci` 会构建核心安装器、中转和企微三个本地 npm 包，并用一个临时实例验证安装。`init` 生成示例配置，已有实例沿用其配置。`activate` 从安装器中提取并核对应用，对指定实例进行切换。也可用 `node scripts/release.mjs activate "$instance" --archive dist/agent-network-0.9.1.tar.gz` 从源码检出激活应用。

开发调试时，可设置 `LAN_INSTANCE_ROOT` 为独立实例目录后运行 `npm start`。

## 选择自己的负责人

`coordinatorId` 指向 `agents` 中一个具有 `manager: true` 的员工。员工 ID 用于路由和会话归属，`name` 是显示名，`instructions` 是职责和人设。例如可把新实例的负责人配置为：

```json
{
  "coordinatorId": "research-lead",
  "agents": {
    "research-lead": {
      "template": "coordinator",
      "name": "阿岚",
      "instructions": "你负责研究组的协调、派工和验收。"
    }
  }
}
```

将这一片段与现场已有员工配置合并。企微配置可省略 `agentId`，自动选用该负责人。只改名字或人设时保留原员工 ID，这样会话和工作区继续对应原身份。员工名称与人设由实例所有者选择。

## 启用员工以及可选渠道

1. 按需调整实例的 `network.json`，设置主协调者、员工模板、模型 ID 和能力说明。模型 ID 应与自己的网关实际路由一致。
2. 在实例的 `.local/credentials.json` 填写模型网关配置，参照 `credentials.example.json`，将文件权限设为 `600`。Claude Code 使用 Anthropic Messages 接口，DSH 使用 Chat Completions 接口。
3. 使用 `agent-network runtimes "$HOME/agent-network-instance" install` 安装并核验各运行时，然后用 `agent-network agent "$HOME/agent-network-instance" list` 查看员工。
4. 需要企微入口时，执行 `agent-network channel "$HOME/agent-network-instance" install wecom "$PWD/dist/shiyanjia-agent-network-wecom-0.7.3.tgz"`。安装器在实例内放置独立渠道包和 `.local/wecom.example.json`，按示例填写权限为 `600` 的 `.local/wecom.json`；已有机器人继续使用原文件。安装后重启实例使配置生效。关闭时用 `agent-network channel INSTANCE disable` 后重启。没有配置渠道的核心实例直接运行。
5. 由 0.5.x 升级一个已使用企微的实例时，先用新版 npm 安装器执行上面的 `channel install`，再执行 `agent-network activate INSTANCE`。本地源码也可先构建独立渠道 tgz，再用 `LAN_INSTANCE_ROOT=... node scripts/channel.mjs install wecom /绝对路径/shiyanjia-agent-network-wecom-0.7.3.tgz` 安装。启用渠道时，切换器会核对本次启动的渠道就绪时间。

普通成员或其他独立主网络加入时，执行 `agent-network member "$HOME/agent-network-instance" guide`。成员由加入方选项目并取得批准，两个同机主网络可用 `--mode network` 仅开放一个文本通信节点。

### 三种运行时分别怎样接入

| 已有工具 | 接入方式 | 首次核对 |
| --- | --- | --- |
| Claude Code | 在实例安装 `claude` 执行适配器，员工选 `runtime: "claude"`。模型网关支持 Anthropic Messages。 | `agent-network runtimes "$HOME/agent-network-instance" install claude` |
| DSH | 在实例安装 `dsh`，员工选 `runtime: "dsh"`。网关提供 Chat Completions，与 DSH 同版本的 hook 插件随 slot 安装。 | `agent-network runtimes "$HOME/agent-network-instance" install dsh` |
| Codex | 安装带 app-server 的本机 Codex CLI，选目录预览后以成员身份申请。当前提供会话、Skill、MCP 和项目脚本的只读目录。 | `agent-network member "$HOME/agent-network-instance" discover --runtime codex --project "$PWD"` |

逐项配置、验证和入网命令见[运行时接入手册](../skills/agent-network/references/coordinator.md#按运行时接入)。npm 安装的实例可在 `current/skills/agent-network/references/coordinator.md` 阅读同一份手册。

## 参与迭代

从 GitHub 仓库的 `master` 建分支，运行 `npm run ci`，通过 Pull Request 提交改进。详见 [贡献指南](../CONTRIBUTING.md)。

共享网络规范见安装目录下的 `skills/agent-network/SKILL.md`，版本升级和回滚见 `docs/RELEASING.md`。

## 连接另一台机器上的主网络

1. 中转管理员在源码仓库用 `npm install -g "$PWD/dist/shiyanjia-agent-network-relay-0.2.1.tgz"` 安装中转，在服务账号的 0700 目录中执行 `agent-network-relay init --config /私有目录/relay.json --listen /ip4/0.0.0.0/tcp/4001`，再以同一账号运行 `agent-network-relay serve --config /私有目录/relay.json`。通过可信渠道把实际地址和中转 Peer ID 给参与者。
2. 各实例在自己的 `network.json` 加入下面的字段，把占位值换成真实地址和 Peer ID，然后重启服务。

```json
{"federation":{"enabled":true,"routing":"local-first","relay":{"address":"/dns4/relay.example.org/tcp/4001","peerId":"替换为中转 Peer ID"},"peerTaskPolicy":{"allowedTemplates":[],"crossNetworkFiles":false}}}
```

3. 各自在本机执行 `agent-network member INSTANCE identity` 导出公开卡。中转管理员对两张卡分别执行 `agent-network-relay allow PEER_ID --config /私有目录/relay.json`。用 `agent-network member INSTANCE relay-status` 查看预约。备份本机私有的 `.local/federation/`，私钥只由本机保管。
4. 例如 A 把 B 登记为 `studio`。B 将自己的公开卡交给 A，A 签发只允许该卡使用的邀请，把邀请交回 B。双方各在自己的机器上运行相应命令。

```sh
# A
agent-network member "$INSTANCE_A" invite --card b-card.json > invitation.json
# B
agent-network member "$INSTANCE_B" join --mode network --invite invitation.json --id studio --alias ops --consent
# A
agent-network member "$INSTANCE_A" approve --id node:studio
agent-network member "$INSTANCE_A" status --id node:studio
```

查看 `status` 的 `route` 可以辨别实际选路。B 的维护者用 `member INSTANCE inbox --id node:ops` 查看收件，用 `reply --id node:ops --request-id 消息编号 --message 文字` 回传进度或结论。可在 `allowedTemplates` 指定本机非负责人模板，由本机网关处理纯文本。跨机只须网络向中转建立出站连接。已存在的旧版同机关系需双方先撤销或退出，再重新邀请。

本机所有者可以委托已启用的企微机器人发一条消息，使用 `agent-network channel INSTANCE request GROUP_ID 唯一键 任务正文文件`。同一键只产生一次群任务，状态和企微回执在实例的渠道队列中查看。

受管机器的邀请、一次批准、本机盘点、刷新、按能力查询与撤销，见[机器接入手册](../skills/agent-network/references/managed-hosts.md)。
