# Agent Network 中转服务

独立的 Node.js 服务使用 Circuit Relay v2 转发流量，并用 Noise 验证身份。请在自己的服务器上运行，使用专用低权限账户和 0700 配置目录。

```sh
# 在源码根目录执行
npm ci --prefix packages/relay
npm run pack:relay
npm install -g "$PWD/dist/shiyanjia-agent-network-relay-0.2.1.tgz"
config="$HOME/agent-network-relay/relay.json"
agent-network-relay init --config "$config" --listen /ip4/0.0.0.0/tcp/4001
agent-network-relay allow PEER_ID --config "$config"
agent-network-relay serve --config "$config"
```

在另一终端使用 `agent-network-relay status --config "$config"` 查看更新时间、预约与电路统计。`allow` 和 `remove` 管理准入，刷新后关闭不再允许的连接。`maxReservations`、`maxConnections`、`connectionsPerPeer`、`circuitsPerMinute`、`circuitBytes` 和 `circuitSeconds` 用于设置资源限额。

向选定的参与者分发地址和公开 Peer ID，私钥由中转管理员保管。客户端固定中转和远端网络的 Peer ID。应用正文只在两端解密。[互联与接入说明](../../docs/INSTALL.md#连接另一台机器上的主网络)

使用 `sponsor PEER_ID` 允许一个已准入的主网络登记自己的机器。`unsponsor PEER_ID` 取消该权限，`status` 显示活动预约。[受管机器](../../skills/agent-network/references/managed-hosts.md)
