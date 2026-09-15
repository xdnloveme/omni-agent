# 隔离实现与无付费验证（2026-09-15）

本轮已实现评测规则前缀、完整补丁交付、派生 SWE 任务和独立评分镜像，并跑通完整 Omni 的本地模型隔离链路。补充验收后已完成新协议下的一次真实模型试跑（补丁通过、运行超时、终态缺失，详见 [单题报告](swe-isolated-single-2026-09-15.md)）；Oracle 和模拟模型的 reward 不计为能力成绩。

## 已验证

| 检查                   | 证据与结果                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| curl 网络策略          | public 对照可访问 GitHub；切到模型域名白名单后，GitHub 和原题 patch-diff 请求均失败，模型域名返回 401（未提供密钥）          |
| 其他客户端             | Python urllib 请求 GitHub 同样被拒绝                                                                                         |
| 控制组件故障           | 停止 sidecar 后模型请求失败；使用预先解析的 IP 仍连接失败，排除了仅 DNS 故障的解释                                           |
| Host/SNI 探针          | 两个变体返回 401；只记录观测，不据此宣称所有伪造/转发路径已覆盖                                                              |
| 独立评分隔离           | 声明产物送达、Agent 私有标记不继承、无模型 key；评分容器只有 lo 接口                                                         |
| 原生输入审计           | 模拟模型试验中 Trace user.input 与 instruction-submitted.txt 完全一致                                                        |
| 提交契约               | 修改、删除、未忽略的新文件均进入补丁，Agent index 不变；空提交有效，越界、超限及新增链接被拒绝                               |
| 离线官方评分对照       | 同一准备好的镜像，network=none 下：空补丁 reward=0，已知正确补丁 reward=1                                                    |
| Harbor 原生 SWE Oracle | i1-isolated-refresh，separate，reward=1，无异常                                                                              |
| 完整 Omni 隔离链路     | i2-isolated-smoke：正式 Agent + 本地模拟模型 + 前缀 + allowlist + 普通用户提交 + separate verifier，reward=1，Trace complete |

自动化检查：6 项 Python 契约测试、Ruff check/format、Shell 语法检查、仓库 format:check 和 git diff --check 通过。生产 TypeScript 本轮未改变；此前 905 项测试、typecheck、build 与 CLI/Host smoke 的证据继续适用于未改变的生产实现，本轮未重复运行这些检查。

## 实现边界

- 所有新实现位于 benchmark/，生产 Agent 系统 prompt、内核、工具和 Provider 不变。评测前缀改变任务输入协议，按 evaluation-rules-v1 记录原题、规则和最终输入摘要。
- Harbor 负责网络、容器、产物传递与评分生命周期；没有自建模型代理、防火墙或评分解析器。
- 提交采用固定基线与独立临时 Git index，复用 Git 的补丁生成/应用。采集以解题 UID 执行，避免 Git filter 获得 root。补丁实际写入与接收均限 16 MiB；采集后清理该 UID 子进程。
- v1 提交允许普通文件增删改；不接收新增 symlink 或 submodule。被 Git 忽略且未进入本次临时 index 的新文件不在提交中。非法提交在评分前失败，不伪造 reward。
- 派生任务保留原题和上游评分脚本字节；独立评分入口只校验/应用补丁后委托原脚本。Oracle 复用相同采集脚本，不另写提交算法。
- 评分准备阶段运行官方 verifier 预热依赖，必须得到预期基线失败，再生成 uv script lock；运行阶段无网。镜像摘要、构建输入摘要与依赖锁是复现依据，不宣称不同日期重新下载会天然一致。

## 定位并修正的问题

- Harbor 内核能力探针首次下载镜像超过内部期限，可能表现为 allowlist 不支持；预取其固定镜像后通过，未绕过能力检查。
- 全局 DOCKER_DEFAULT_PLATFORM=linux/amd64 与原生 ARM sidecar 冲突。隔离流程取消全局覆盖，题目 main 服务在需要构建时明确指定 amd64。
- Harbor no-network 的原生 sidecar 路径仍保留 eth0。评分 main 使用受 Harbor 支持的 Compose network_mode: none，保留原来“只有 lo”的严格断言并实际通过。
- 官方脚本会在子进程内安装 uv 并调整 PATH；镜像构建后续步骤使用已证实的 /root/.local/bin/uv 路径，没有新增兼容认证或依赖分支。
- 干净镜像解包后的 Git index stat 信息导致 apply --index 拒绝。应用前调用原生 update-index --refresh；真实文件变化仍导致失败，不重置或隐藏它。修复前的失败保留在 i1-isolated-oracle。

## 尚未完成的边界

补充验收覆盖本节原待办的重定向、代理环境变量、宿主网关与新组合生命周期，详见下节。IPv6 开放网络对照不可用，不能宣称已验证可路由 IPv6 防护；变更环境必须重测。不宣称枚举了所有代理或协议变体。

解题阶段仍是域名白名单，不是完全断网；DNS/ICMP 原生例外及同用户读取模型密钥的限制仍然存在。独立评分会执行提交代码，不构成抵御恶意评分篡改的强安全服务。没有证明消除了训练记忆或本地历史中的答案。暂不进入 50 题或宣称正式能力基线已就绪。

## 产物

- [作业汇总](../artifacts/isolation-summary.json)
- [网络探针](../artifacts/i2-network-acceptance-final/results.json)
- [离线基线/正确补丁对照](../artifacts/i1-offline/results.json)
- [完整 Omni 隔离试验](../artifacts/i2-isolated-smoke/)
- [原生 SWE Oracle 试验](../artifacts/i1-isolated-refresh/)
- [原生评分失败记录](../artifacts/i1-isolated-oracle/)
- [本轮实现快照](../artifacts/isolation-source/)

生成产物不入 Git；实现文件与报告留在当前 worktree。上述无付费阶段的模型响应来自本地 fixture；网络探针只做未认证连通性请求。后续真实模型试跑单独记录。

## 2026-09-15 补充验收

结论：Ready with trade-offs，允许在本次专用 Colima 环境进行一次真实模型链路试验，不代表通用安全认证或正式能力基线。

- 统一网络探针 i2-network-acceptance 通过：IPv4 直连、raw/search、替代端口、HTTP/HTTPS 代理环境变量、本地 sidecar 端口、宿主网关和 HTTP 重定向均未取得受限内容。宿主网关使用专用虚拟机内临时 canary 服务，开放网络可读取、白名单阶段不可读取；没有探查个人宿主服务。
- IPv6 开放网络对照也失败，属于当前环境不可用；没有验证可路由 IPv6 的策略效果。迁移环境或开启 IPv6 后必须重新验收。
- i2-timeout：10 秒进程截止，Harbor 为 AgentTimeoutError；Omni 与 Trace 为 cancelled，integrity=complete。
- i2-cancel：外部 SIGTERM，Omni 与 Trace 为 cancelled，integrity=complete；Harbor 保留非零退出失败。注入的 sleep 子进程 exit=-9；观察器回收后 pgrep UID 10001 无进程，提交已采集。初次 pgrep 中的唯一 PID 是观察器尚未回收的该子进程，原始证据保留。
- 6 项提交/输入契约测试和 Ruff 检查通过。生产实现未修改。

本轮证据覆盖明确列出的探针，不宣称穷尽所有代理、协议伪装、DNS/ICMP 隐蔽通道。原设计中的这些限制继续有效。真实模型调用单次、无自动重试，使用现有 Provider；试跑结果另行记录。

补充验收后的真实试跑暴露了新的生命周期缺口：长运行 Bash 截止时没有 Run 终态。此前模型等待场景通过不能覆盖该情况。现阶段不得将上述 Ready with trade-offs 解读为完整链路验收通过，下一步先无付费复现并定位，见单题报告。
