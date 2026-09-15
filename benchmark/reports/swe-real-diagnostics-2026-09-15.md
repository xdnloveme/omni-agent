# 真实 Agent 诊断试跑（2026-09-15）

结论：真实付费链路再次触发了 590 秒进程截止，但没有复现终态丢失。Omni 正常取消并输出完整 Trace。本次官方题目 reward=0，与原付费试跑 reward=1 不同，不能把两次结果合并。

## 条件与边界

- 作业 `i6-swe-real-diagnostics`，trial `axios-isolated__wMWNxXJ`，同一 `axios__axios-4731` 镜像与任务。
- 真实 `volcengine-agent-plan/default/glm-5.2`，读取原 .env 中的 `ARK_AGENT_PLAN_API_KEY`，复用生产 Provider；一次尝试，零 Harbor 自动重试。
- 保留 590 秒进程额度、600 秒 Harbor 上限、原生模型域名 allowlist，以及独立断网官方评分。
- 源码包含上一轮已验证的诊断；本轮没有修改生产代码、取消规则、Prompt 或采集协议。运行中没有干预 Agent 工作区。

## 生命周期结果

| 观测           | 结果                                                            |
| -------------- | --------------------------------------------------------------- |
| 长工具自身超时 | 300 秒后返回 tool_timeout，Agent 随后继续执行                   |
| 进程外层回执   | return_code=124，elapsed_sec=590.527686                         |
| 进程信号       | 一次 SIGTERM，repeated=false；没有 force_exit 记录              |
| 信号至结果落盘 | 单调时间差 46.656 ms                                            |
| 关闭阶段       | Session、Service、Trace 查询及结果写入均完成                    |
| Omni 终态      | cancelled；result.json 已采集                                   |
| Trace          | complete，2,946 条连续事件，包含工具、批次、回合及 Run 取消终态 |

这证明本轮真实工具超时和进程取消链路正常，不证明原偶发故障已经修复。原始终态丢失的根因仍未证实。

## 本次题目失败的证据链

1. Agent 修改了 `lib/adapters/http.js` 等文件；聚焦 body length 测试返回 3 passing（Trace seq 2829）。
2. Agent 随后执行 `git stash`，开始比较原始代码的完整测试（seq 2939）。
3. 该工具运行中触发总进程截止（seq 2942–2946），后续没有恢复改动的调用。
4. 采集的补丁为 1,589 字节，仅新增未跟踪的 `repro_maxbody.js`，不含实际修复；普通 `git stash` 不会保存这个未跟踪脚本。
5. 独立官方评分：2 项测试，1 项通过，默认 maxBodyLength 测试失败，reward=0。

因此，本次失败可定位到 Agent 在额度内的测试安排和工作区管理：暂存修复后未恢复，最终提交缺失修复。采集器按既定协议提交结束时的工作区差异，没有证据表明它丢失已存在于工作区的修复。不应自动恢复 stash 或替 Agent 补写答案来提高得分；如改进，应在后续单独评审 Agent 的工作策略和额度感知。

## 行为审计与费用

25 次模型完成、27 次工具调用，工具只有 bash/glob/file_read/grep/file_write/file_edit。检查实际调用未见下载答案、外部搜索、curl/wget 或 git fetch；这不排除模型已有知识，不能推断绝对无污染。

Provider usage 合计：input=27,524，cacheRead=393,984，output=10,160，totalTokens=431,668；reasoning=8,386 是输出统计的一部分，不重复相加。没有权威账单数据，不把 Provider 的零估价当作实际免费。

## 证据与收尾

[本地完整产物](../artifacts/i6-swe-real-diagnostics/)包含源码快照、配置、输入、Trace、stderr、退出回执、补丁、官方评分输出及 audit.json；生成产物不入 Git。归档前对实际凭据做精确字节扫描，匹配为 0。

本轮没有代码变更，未重复全仓库测试；上一轮 907 项测试与诊断真实重放已通过。本轮以真实 Provider、真实工具和独立官方验证器验证上述运行事实。
