# 免费生命周期与运维验收 — 2026-09-18

## 结论

Ready with trade-offs：可以内部、小批量使用；本轮补齐真实容器并发与故障生命周期证据，不宣称无人值守生产服务验收完成。没有真实 Provider 调用或模型费用，没有删除历史镜像、改变评分语义或修改生产 Agent/Provider。

## 验收矩阵

| 场景              | 实际结果                                                                           | 边界                                                 |
| ----------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| 并发 5            | 5 个 trial 全部 reward=1；5 个不同 Session；Agent 执行区间实际重叠；Trace complete | 本地确定性模型，不证明付费 Provider 吞吐量           |
| Provider HTTP 503 | 明确 trial 异常、无有效分数，Trace complete/error                                  | 本地 HTTP 服务注入                                   |
| Provider 连接断开 | 明确 trial 异常、无有效分数，Trace complete/error                                  | 响应头之前断开，不覆盖所有 SSE 中途断流形式          |
| 5 秒期限          | Agent 退出 130、Trace complete/cancelled，无有效分数                               | 验证期限取消，不是 Provider 用量耗尽                 |
| 外部 SIGINT       | 启动器 cancelled、harbor_exited；Trace complete/cancelled                          | 另检查 Docker 确认清理，非仅信任状态字段             |
| 容器被停止        | 最终 NonZeroAgentExitCodeError，无有效分数；Trace incomplete/running               | 强制故障允许证据不完整，必须如实标记；没有恢复原进度 |
| 缓存竞争          | 两个正式 prepare 进程竞争同一新缓存；一份构建、一份复用，相同 key                  | 复用现有 FileLock 与发布逻辑                         |
| 构建后复用        | 正式 prepare 两次成功，第二次缓存命中，健康检查重跑                                | 未调用模型                                           |

共 5 项显式容器测试、6 类运行场景、10 个 Harbor trial，203.599 秒，全部通过。所有场景结束后实际检查无所属 trial 容器残留。每题一次尝试，Harbor 自动重试为零；Provider 内部重试行为不由此推断。

## 全量题库与容量限制

本轮正式 prepare 依次完成 Django-11790、11815（缓存复用）及 11848（新构建、断网正负评分对照）。结合先前 Sphinx-10323、11510 的当前机制验证，固定 50 题中目前 5 题有环境验证证据，45 题未完成环境验证。完整清单见原始证据中的 suite-inventory.json；不把未验证题计为失败或 0 分。

宿主有约 193 GiB 空间，但 Docker 虚拟机只有 99 GiB 文件系统，检查时剩余约 15 GiB，收尾约 14 GiB。发现差异后停止外层诊断排队，保留正在运行的 Django-11848 prepare 子进程直到其正常完成。外层脚本的 summary.json 因停止仅记录前两题；第三题以其完整 invocation.json 的 prepared 状态为准，suite-inventory.json 已汇总三题。本轮没有扩大磁盘或自动清理旧资产。

下一步若要验证全部 50 题，需要先决定扩容 Docker 磁盘，或明确哪些历史资产可以删除。4 核、约 8 GiB 的虚拟机可完成本次轻量并发验证，不能因此保证五道重型真实题目的容量。

## 发现及修改

- 在现有 execution-contract 测试模型服务内增加 HTTP 错误和连接断开注入；不新增另一套 Provider 或调度器。
- 新增可显式启用的 test_lifecycle_containers.py，复用正式 benchmark 入口、现有 Omni Adapter、Harbor 和独立评分器。
- 全量测试首次暴露既有取消输出测试的计时竞争：150 ms 后取消，却要求子进程此前必已输出。定向重跑通过，不能将首次失败解释为运行时丢日志。修复为在真实 writer.append 落盘后取消，保留 interrupted 和回查正文断言；10 秒计时器仅用于兜底终止。仅改测试同步，不改生产运行时。
- README 补充结果判读、daemon 容量检查、日志保留与显式清理规则。原计划顶部指向当前验收，历史记录不再充当当前待办。

## 检查

- Python 常规测试：50 项，36 通过、14 项需显式容器环境而跳过；其中新增 5 项已在上述容器验收单独运行通过。
- 准备与缓存复用容器测试：1 项通过；双进程缓存竞争诊断通过。
- 输出留存测试：修复后 21 项通过。
- 全量 TypeScript：138 文件、1001 项全部通过；类型检查通过。
- 格式检查与 git diff --check 通过；未改变包导出或依赖，不额外构建发布包；CLI/模型真实调用由免费容器链路验证，未启动交互 TUI。

本轮不是长期压力测试，不覆盖真实 Provider 限流、所有 SSE 异常、主机掉电、进度续跑、自动存储回收、任意 Agent 框架或恶意多租户安全。这些不因本轮通过而宣称完成。

## 证据

`benchmark/artifacts/free-readiness-2026-09-18/` 被 gitignore 排除，包含原始 job、配置、Trace、评分、缓存竞争回执、题库清单和测试日志。测试源码可复用；一次性诊断脚本同样归档，没有加入生产调度路径。
