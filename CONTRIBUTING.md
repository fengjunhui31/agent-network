# 贡献指南

从 `origin/master` 建分支，一个 Pull Request 解决一个可验证的问题。先读 [Agent 开发入口](AGENTS.md)，理解哪些代码属于核心、渠道或中转。

```sh
git clone https://github.com/fengjunhui31/agent-network.git
cd agent-network
git switch -c feat/your-change
npm ci
git add <改动的文件>
npm run ci
```

在自己的 fork 推送分支，向本仓库的 `master` 提交 Pull Request。写清触发条件、行为变化、验证结果及升级或回退要求。[Pull Request 模板](.github/PULL_REQUEST_TEMPLATE.md)

测试使用临时实例、虚构联系人和记录式渠道。不要提交现场配置、平台凭据、聊天记录、工作区、真实网络地址或中转身份。需要真实模型或渠道验证时，在你管理的实例上运行，并在 PR 中说明验证范围。

源码、核心构建物、可选渠道与中转有独立版本和校验值。应用行为变化时，同步更新对应使用指南和变更记录。[构建与升级](docs/RELEASING.md)
