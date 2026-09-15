# 隔离协议下的真实单题试跑（2026-09-15）

结论：**补丁通过，运行超时，完整链路验收未通过。** 本次按授权只跑一题、一次尝试，没有追加付费重试。不能用 Harbor 的 reward=1 掩盖 AgentTimeoutError 和缺失的原生终态。

## 结果

| 项目     | 实际结果                                                                        |
| -------- | ------------------------------------------------------------------------------- |
| 任务     | SWE-bench Multilingual：axios__axios-4731                                       |
| 模型     | 现有 volcengine-agent-plan/default，glm-5.2                                     |
| 凭据     | 仅从指定 .env 读取 ARK_AGENT_PLAN_API_KEY，复用生产 Provider                    |
| 协议     | evaluation-rules-v1 + 模型域名白名单 + 普通用户 + 补丁交付 + separate verifier  |
| 官方评分 | reward=1，官方选择的 2 个测试全部通过                                           |
| Agent    | 超时；执行阶段约 594.18 秒；进程额度 590 秒                                     |
| 原生终态 | agent/omni/result.json 缺失；Trace 最后停在 tool.execution.started，无 Run 终态 |
| 调用     | 29 次完成的模型调用，38 次工具调用，37 次工具结果                               |
| 费用     | 未知；Provider 返回的 cost=0 不是账单证据                                       |

Harbor 异常文本写“600 秒”，但 traceback 的内层是适配器根据进程退出码 124 抛出的截止异常。不能据此认定实际运行满 600 秒，或认定产物下载被外层定时器打断。实际时间以 agent_execution 时间戳为准。

## 修复与评分证据

提交修改 README.md、lib/adapters/http.js、test/unit/adapters/http.js：将默认 maxBodyLength=-1 映射为传输层 Infinity，补充默认值和显式 -1 的大请求体测试，并同步说明。

Trace seq=5685 记录聚焦测试 3 passing。seq=5767 记录撤去实现修复后的回归错误 ERR_FR_MAX_BODY_LENGTH_EXCEEDED，随后恢复修复。最后模型启动完整 HTTP adapter 测试，直到额度截止没有返回工具结果。

独立评分容器重新应用补丁，并由原始上游评分脚本恢复、注入官方测试；官方输出 tests=2、pass=2、fail=0、PASSED。评分运行时断网。Agent 自己新增的测试没有替代官方测试。

## 答案污染审查

保留的 5,820 条 Trace 事件中，工具仅有 bash、file_read、file_edit、glob、grep，没有 web_fetch/web_search 调用。逐条检查 Bash 命令，未见 curl/wget、远程 git fetch 或下载公开修复；行为为本地阅读、Git 历史、编辑、mocha 测试及回归对照。没有观察到上一轮下载 PR diff 的行为。

此结论只覆盖留存的执行证据，不证明排除了模型训练记忆、本地历史或所有隐蔽通道。24 项网络探针的适用范围见隔离报告；IPv6 的开放对照不可用，不能宣称验证了可路由 IPv6 防护。

## 新暴露的验收缺口

此前模型等待阶段的超时/取消测试能够得到完整 cancelled Trace；本次在长时间 Bash 测试中截止，未形成原生终态。**两者覆盖的是不同的生命周期状态，不能互相替代。** 当前没有证据确定是信号传播、工具取消、关闭顺序还是宽限时间导致，不能直接归因于 Harbor 或用加长时间上限代替修复。

下一步先用本地模型复现“Bash/管道仍在运行时取消”，在现有进程信号、Service 取消和工具进程所有者处定位。生产内核不应增加 benchmark 分支，适配器不应另造取消机制。修复并通过无付费验证之前，不扩展 50 题，也不宣布完整链路质量达标。本次没有为此追加付费运行。

另有 8 次工具拒绝：3 次 project_instruction_scope_undetermined、5 次 invalid_tool_input。保留为真实 Agent 工具使用表现，不在评测适配器做参数修补。

## 使用量与留存

逐次 model.completed 汇总：input=43,800，cacheRead=640,704，output=18,729，totalTokens=703,233。reasoning=16,012 属于输出的细分项，不重复加总。所有 29 次 model.started 均有 model.completed；Run 终态仍不完整。

- [原始作业与评分](../artifacts/i3-swe-isolated-single/)
- [审计数据](../artifacts/i3-swe-isolated-single/audit.json)
- [网络覆盖范围](../artifacts/i2-network-acceptance-final/coverage.json)
- [隔离验收报告](isolation-2026-09-15.md)

扫描留存 JSON/JSONL/log/txt/patch 未发现指定凭据的明文字面值。产物不入 Git，本轮未提交或合并代码。

后续责任定位：无付费对照未复现原始终态缺失，目前不能归责 Agent 内核或超时脚本的某个具体实现。已确认诊断证据不足与 Harbor 超时文案包装，见 [定位报告](termination-diagnosis-2026-09-15.md)。
