# 独立模型通道与全程断网验收 — 2026-09-18

本轮已完成实现与免费验收。准备阶段可联网；作答和评分容器使用 `network_mode: none`，模型执行在独立容器。复用现有 Provider、缓存、工具入口和 Trace，没有修改 Agent 内核、提示策略或官方评分规则，也没有付费 API 请求。

## 边界与职责

| 所有者         | 本轮变化                                                                                              |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| Models         | Unix socket 帧传输、单次接入、流终态、取消/断连；服务端调用原 `ModelRuntime`                          |
| App            | 窄 `AgentModelService` 与远端装配；模型选择复用 `ConfigService`/Provider 归一化，管理能力留在本地服务 |
| Apps           | 通用 headless 通道选项、独立模型进程入口与释放                                                        |
| Benchmark 环境 | 将 no-network 声明落实为没有外网接口的 Compose 配置                                                   |
| Omni 适配器    | 模型容器/只读通信卷、配置与密钥仅注入模型侧、退出回执接入现有证据索引                                 |

客户端在 Agent/扩展/工具启动前连接；服务端关闭监听、移除 socket 路径后才返回 ready。工具没有模型凭据，不继承连接，也不能重新接入监听地址。取消先通知 Agent 完成原生 Trace 收尾，再停止模型服务。故障不回退为直连。

已删除整容器模型域名 allowlist、SWE 的模型域名参数、作答容器里的 Provider 配置/密钥注入，以及旧 allowlist 探针。普通产品的本地 headless 入口保留；benchmark 只走隔离通道。

## 最终免费容器验收

执行 `benchmark.tests.test_lifecycle_containers`，5 个测试方法全部通过，合计 10 次真实 Harbor/Omni trial。内部调用的是正式 `benchmark.run run` 入口；模型使用本地确定性 HTTP fixture，**这些成绩不表示 LLM 解题能力**。

| 场景              | 次数 | 实际结果                                                          |
| ----------------- | ---: | ----------------------------------------------------------------- |
| 并发 5            |    5 | 5 个独立 Session，执行区间重叠，均 reward=1，Trace 完整           |
| 执行期限          |    1 | 按预期取消，Trace 为 cancelled/complete，无有效成绩               |
| 外部取消          |    1 | 启动器 cancelled，Trace 为 cancelled/complete，完成清理           |
| 容器丢失          |    1 | 明确失败，无有效成绩；强制终止留下 incomplete Trace，没有伪造完成 |
| Provider HTTP 503 |    1 | 明确失败，错误 Trace 完整，无有效成绩                             |
| Provider 连接中断 |    1 | 明确失败，错误 Trace 完整，无有效成绩                             |

5 次正常 trial 均由真实 Bash 工具执行网络探针并记录：

- 作答容器仅有 `lo`；IPv4/IPv6 外部地址连接均返回 ENETUNREACH。
- `curl https://example.com` 返回 6；模型容器的本地 HTTP 端口在作答侧不可连接。
- 模型 socket 路径已删除，重新连接返回 ENOENT。
- 没有模型 key 或 Provider 配置文件；工具没有继承模型连接，不能通过 `/proc/<Agent pid>/fd` 重新打开父进程 socket。
- 独立评分容器同样只有 `lo`，评分脚本实际检查该条件并保存 `network.txt`。

最终确认专用 daemon 无残留容器、无残留通信卷。

## 代码验证与发现的修复

- TypeScript：140 个测试文件、1007 项测试全部通过。
- Python：默认 50 项中 36 项通过、14 项按环境声明跳过；上述 5 个真实容器生命周期测试已另外显式执行并通过。其他跳过项不宣称本轮重新验证。
- `format:check`、`typecheck`、完整 `build`、Python 静态检查及 `git diff --check` 通过。
- 连续模型流、Provider 失败、取消传播、第二次连接拒绝、私有 header 不出模型侧、原始配置与 Provider 默认值/别名的边界均有真实 Unix socket 测试。
- 既有缓存消费者会在终态提前结束读取；通道先消费结束标记再交付终态，防止下一请求错位。
- 首次容器诊断发现 `PreparedModelContext` 带有本地 manifest；改为只序列化正式 `ModelRequest` 字段。失败记录保留。
- 第一版免费网络探针未声明写入范围，未实际执行；该轮 reward=1 不作为隔离通过证据。修正 fixture 输入后重新执行全部验收，没有修改 Agent 规则。

当前源码归档与最终镜像摘要一致：`09b2de710fbf468f88aef10e123397ad7f8890c75c20c3839077a7653573bc4f`。该摘要不包含凭据、根配置或运行日志。

## 证据与资产

- [最终汇总](../artifacts/model-channel-isolation-2026-09-18/summary.json)：每次 trial、Trace、网络探针与模型退出结果。
- [完整原始证据](../artifacts/model-channel-isolation-2026-09-18/final/)：原生 Trace、工具输出、Harbor 结果、评分及错误日志。
- [源码一致性](../artifacts/model-channel-isolation-2026-09-18/source-integrity.json)、[最终资源审计](../artifacts/model-channel-isolation-2026-09-18/final-audit.json)。
- `initial-request-rejection/`、`initial-probe-not-executed/`、`lifecycle-r6/`、`lifecycle-r7/` 保留中间诊断与复验，不覆盖历史。

本轮已按明确镜像 ID 删除 14 个无容器引用的中间镜像；没有全局 prune，没有清理历史题目镜像。保留最终 Agent/Verifier 镜像和全部日志。Docker 文件系统目前约 **4.9 GiB 可用**，容量仍紧张，不能据此承诺可同时准备全部 50 题。产物目录已被 Git ignore。

## 适用范围与剩余事项

- 已验证本地 Colima/Linux amd64、单次会话和并发 5 的免费 fixture；尚未调用真实火山 Provider，也未重新跑 SWE 付费题。独立模型端的云 API 连通性/真实负载仍需后续验证。
- 一次通道绑定一个模型配置、单个在途请求；部分流取消或传输断连会终止该会话，无隐式重连。16 MiB 是单帧传输边界，不是 token 或轮数预算；模型预算继续由既有 `ModelRuntime` 校验。
- 进程内扩展仍是受信任代码。本方案不承诺抵御恶意进程内代码注入、容器逃逸或任意多租户攻击。
- 原有固定 50 题中，4 道官方测试依赖真实外网的问题仍独立存在。没有放开评分网络、跳过计分测试或替换题单。
