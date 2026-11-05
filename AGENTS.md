# Agent Network 开发入口

从 [README](README.md) 和 [贡献指南](CONTRIBUTING.md) 开始。这个文件用于代码贡献，运行中的员工从实例工作区读取自己的说明。

1. 从 `origin/master` 创建分支，在独立检出中开发。仓库地址为 https://github.com/fengjunhui31/agent-network 。
2. 核心在 `src/`，运行时、验证和切换工具在 `scripts/`。渠道和中转分别位于 `packages/wecom/` 与 `packages/relay/`。员工说明位于 `skills/agent-network/`。
3. 添加或修改源文件后先暂存，再运行 `npm ci` 和 `npm run ci`。集成测试使用隔离实例，说明用的是真实网络、真实模型还是记录式传输。
4. 开 Pull Request 到 `master`，写明行为变化、验证结果与兼容性。面向用户的变动要同步安装文档、网络规范或变更记录。
5. 私人实例保存在检出目录之外。提交示例时使用占位符和本机临时身份。

作为使用方，如果机器主人要求加入网络，读[受管机器操作手册](skills/agent-network/references/managed-hosts.md)，向主人取得私有邀请并取得本机盘点同意。邀请和机主配置保存在实例私有目录；仓库中的示例不提供部署凭据。
