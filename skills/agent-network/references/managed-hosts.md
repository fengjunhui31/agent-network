# 受管机器

机器加入一次，当前用户环境中的运行时、工具和云端账号仍由这台机器管理。一台独立团队也可以继续只登记一个 `node:` 联系人。普通联系人不能读取机器目录或执行主机动作。

## 主网络准备邀请

中转管理员在已经准入的主网络 Peer ID 上执行一次 `agent-network-relay sponsor 主网络PeerID --config 中转配置文件`。这项权限让指定的主网络为自己的受管机器签发邀请。`unsponsor` 撤销签发权限。主网络和新机器使用同一个已固定身份的中转。

主网络所有者使用下面的命令生成私有邀请。不要把邀请放进仓库、公开文档、共享群或日志。CLI 只显示文件位置和邀请编号。邀请有效期为一天，首个有效认领会固定新机器的 UUID 和公钥。批准前通过可信渠道核对新机器的公开身份卡。

```sh
agent-network host "$PRIMARY" invite --alias research-mac --out "$HOME/research-mac.host-invite.json"
agent-network host "$PRIMARY" pending
agent-network host "$PRIMARY" approve --id 邀请编号
```

## 让新机器上已有的 Agent 接入

给它仓库地址和私下交给机主的邀请文件。按仓库 README 安装当前核心 npm 工具。目标目录可以是新的实例，`join` 会初始化、激活核心并启动登记。已有实例在显式同意后才准备联邦配置，已固定其他中转的实例需要另选目录。

```sh
agent-network host "$HOME/team-machine" join --invite "$HOME/research-mac.host-invite.json" --consent
agent-network host "$HOME/team-machine" identity
agent-network host "$HOME/team-machine" status
```

机器身份及暂存邀请保存在该实例的私有目录。待审批期间服务负责继续申请，重启后恢复，获准后清除暂存邀请并上报首份目录。`join` 可以重复运行，`--wait 秒数` 用于等待结果。邀请码持有者可以暂时联系中转的认领接口；它没有普通预约、转发或读取机器目录的权限。机主直接用 `leave` 退出，主网络用 `revoke --id 邀请编号` 撤销。

## 盘点范围与更新

默认盘点当前用户 PATH 中已知的运行时、常见 CLI 和本实例管理的运行时槽位。报告区分 PATH 与受管 profile；两处指向同一真实安装时具有相同的 installationId。`--all-cli` 可额外列出当前 PATH 上的可执行名称，未知命令只登记名称。版本探测只执行可信位置中的已知命令。当前支持识别、可查询和能通过本机受管 ACP 执行分别标记。

```sh
agent-network host "$INSTANCE" inspect
agent-network host "$INSTANCE" inspect --project docs="$PWD" --all-cli
agent-network host "$PRIMARY" list --capability lark-cli
agent-network host "$PRIMARY" detail --alias research-mac
agent-network host "$PRIMARY" refresh --alias research-mac
```

只有机主选定的项目用于项目级能力盘点。Codex 使用项目上下文读取 Skill 和 MCP 工具名，并标记部分探测失败；这条路径不读取会话历史。声明的 Skill 和运行时报告的工具分别标记。上报内容包含公开别名、版本、来源、采样时间、部分失败和已开放的具名动作。私钥、令牌、绝对路径、代码内容及原始 MCP 配置保留在机器上。profile 的绑定或云端登录状态需要按动作核实。

启动、相关目录变动、管理员刷新或本机 `sync` 均可更新快照。主网络按关系代次、修订与摘要原子置换完整快照，保留最后一次观察时间。离线期间的目录是历史观察。无需为每个运行时维持心跳。

## 授权具名动作

`inventory.refresh` 刷新盘点；`cli.version` 仅查询已知命令版本。发现飞书 CLI 只表示找到了程序。机主可选择一个具体测试文档，私下创建本机策略文件并设为 0600。doc token 仅由本机保存，对外可见的是资源别名。

```json
{"projects":{},"documents":{"team-notes":"YOUR_LOCAL_DOCUMENT_TOKEN"}}
```

```sh
agent-network host "$INSTANCE" policy --policy /私有目录/host-policy.json
agent-network host "$PRIMARY" invoke --alias research-mac --operation lark.document.read --resource team-notes
```

文档读取复用目标机器 lark-cli 的用户身份，使用本机文件中已批准的 token。缺少登录、实际文档权限或本地资源授权时返回失败。此版本不提供远程任意 shell 和飞书发消息操作。普通联邦联系人无法调用受管机器动作。主协调者在本机所有者授权的任务里使用 `host_directory` 查询机器及执行范围，模型收到的远端文档属于外部数据。

`network.json` 的 `coordinatorIdleTimeoutMs: 0` 可以关闭负责人默认的闲置取消；企微的 `.local/wecom.json` 使用 `idleTimeoutMs: 0` 并省略 `maxTurnMs`。显式为某个调用指定的执行期限单独生效。
