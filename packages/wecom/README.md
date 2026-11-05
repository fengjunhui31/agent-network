# 企业微信渠道适配器

`@shiyanjia/agent-network-wecom` 将企业微信智能机器人连接到一个已有 Agent Network 实例。包负责 SDK 认证和重连、群和私聊规则、附件、收发队列、聊天记忆，以及员工完成后的原会话验收。主协调者的名字和员工配置由实例指定。

首次接入或从 0.5.x 升级时，在实例启用新版核心前安装此模块：

```sh
agent-network channel "$HOME/agent-network-instance" install wecom "$PWD/dist/shiyanjia-agent-network-wecom-0.7.3.tgz"
```

从源码根目录执行 `npm run pack:wecom` 生成上面的包。将 `wecom.example.json` 的字段填入实例的 `.local/wecom.json`，权限设为 `600`。已有机器人直接使用原文件。已有实例升级时执行核心 `activate`；同版本切换渠道时执行服务重启。申请绑定时可在本机的私有配置中读取 `pairingCode`。渠道启动会保留原 `.local/wecom-inbox/`、`.local/wecom-outbox/`、工作区共享记忆和会话键。

核心同时支持没有渠道的实例。执行 `agent-network channel INSTANCE disable` 并重启可以关闭渠道。配置和队列仍在实例目录。

开发时在仓库根执行 `npm ci`、`npm ci --prefix packages/wecom` 和 `npm run test:wecom`。完整交互见[消息时序](docs/FLOW.md)。[项目仓库](https://github.com/fengjunhui31/agent-network)

本版按本机票据将外部节点的进度和结果送回原群或私聊。活动轮里直接发送来源明确的进度，原轮结束后由同一会话续办。跨网正文隔离于跨群共享记忆。本机所有者也可使用 `agent-network channel INSTANCE request GROUP_ID KEY MESSAGE_FILE` 委托协调者在已启用群中发一条消息。重复使用相同 KEY 复用同一待办和发送记录。

### 长任务

配合核心 0.8.3 或支持活动超时的版本，企微任务默认连续 15 分钟没有运行时进展时结束。在实例的 `.local/wecom.json` 可设 `idleTimeoutMs`，单位为毫秒，还可用 `maxTurnMs` 显式设定总时限。两项均接受正整数。若未设置总时限，持续产生进展的任务可以跨过原来的 15 分钟。旧核心继续使用固定期限。执行记录与来源会话会区分网络超时、手动停止、服务关闭和来源未知的运行时取消。
