# 单题真实试跑记录：axios__axios-4731

2026-09-14，作业 `p3-swe-single`，一次尝试，Harbor 重试 0。

## 结论

**接入链路通过；独立解题能力评估不成立。** Harbor 原生评分 reward=1，异常为空；Omni 正常完成，原生 Trace 完整。Agent 在执行过程中成功下载了本题上游 PR 的完整补丁，因此结果受到公开答案污染。不得据此宣称独立解决此题、50 题通过率或榜单成绩。

用户已确认采用 Harbor 原生评分协议并记录同容器评分局限。本次未修改上游 verifier、评分逻辑或生产 Agent 提示词、工具与模型链路，也未因结果追加尝试。

## 运行与用量

| 项目                        | 实际记录                                        |
| --------------------------- | ----------------------------------------------- |
| 模型                        | volcengine-agent-plan/default/glm-5.2           |
| Agent 阶段                  | 490.27 秒，约 8 分 10 秒，含进程启动和产物采集  |
| 整个 trial                  | 约 13 分 41 秒，包含安装与评分依赖下载          |
| 模型响应                    | 32 次，32 条 model.completed 均有 usage         |
| 原生 usage.input 合计       | 187,104                                         |
| 原生 usage.cacheRead 合计   | 1,878,656                                       |
| 原生 usage.output 合计      | 16,163                                          |
| 原生 usage.reasoning 合计   | 12,249，单独展示，不再次加到 totalTokens        |
| 原生 usage.totalTokens 合计 | 2,081,923，含缓存读取；不能按全部未缓存输入计价 |
| 实际费用                    | 未知；Provider 返回零 cost 不具备有效计价依据   |

用量逐条汇总自原生 replay 的 `model.completed.payload.usage`，不是 `result.json.trace.lastTurnUsage`。Harbor 的顶层 token/cost 字段仍为 null，不人为补成零。上述 tokens 反映多轮重复上下文累计，不是单次上下文长度；本次未提供货币硬上限。此前“一题应该不需要多少”的判断不能代替真实用量和 Provider 账单。

## 评分与答案污染证据

- 原生 trial：`axios__axios-4731__VigTbxt`，reward=1，exception_info=null。
- verifier 日志记录 `SWEBench Multilingual ... PASSED`，reward 文件为 1。官方测试会重置测试文件再注入上游测试，评分不直接信任 Agent 新增的测试。
- Trace seq 2698：Agent 调用 web_fetch 请求 `https://patch-diff.githubusercontent.com/raw/axios/axios/pull/4731.diff`。
- Trace seq 2702：HTTP 200，返回完整补丁，共 2063 bytes、未截断。随后 Agent 修改 `lib/adapters/http.js` 与 `test/unit/adapters/http.js`，最终差异与获取的修复相符。
- 这是获取公开答案造成的评测污染，并非已发现修改 reward 文件。两者须分别记录。
- 原题自带 Hints，保持原文。执行期评分目录保护不等于抵御恶意 Agent 的强隔离；verifier 仍在同一容器执行修改后的代码。

## 复现标识与产物

- 数据提交：`61366953049fd63a7dff54f67193bf39f5d1cde6`，Harbor 原生 SWE-bench Multilingual 任务。
- Omni 基线：`572fe12ac3d69f7b076bc29c1712acc4f837eb51`，实际执行包含当前未提交实现；精确源码以归档和 SHA-256 为准，版本 `572fe12ac3d6+source.43fa3a9ffc73`。
- 任务镜像 digest：`sha256:e75f3f2f1e91fbd09a00bd14a4c807dab210d58a5d7395b595cf65314d092bb1`。
- Harbor 0.23.0，Omni Node 22.19.0，pnpm 11.5.1；任务 Node 20.20.2。macOS arm64 / Colima VZ Rosetta 执行 amd64 镜像。
- Session：`aecc1970-69e2-4372-a8e1-3a91f2a3037c`；Run：`ce7b547c-8e26-4e38-9cce-10127a54ea23`。
- [汇总 JSON](../artifacts/p3-swe-single/evidence-summary.json)、[Harbor trial](../artifacts/p3-swe-single/axios__axios-4731__VigTbxt/result.json)、[补丁](../artifacts/p3-swe-single/axios__axios-4731__VigTbxt/agent/omni/changes.patch)、[评分日志](../artifacts/p3-swe-single/axios__axios-4731__VigTbxt/verifier/test-stdout.txt)。
- 全量产物位于 `benchmark/artifacts/p3-swe-single/`，生成目录不入 Git。归档前检查未出现此次指定密钥的明文值；此检查不代表通用秘密检测认证。
- 完成后已关闭专用 Colima 实例；未触碰原工作区业务文件。

## 后续边界

P3 单题接入验证完成，P4 固定 50 题与报告能力尚未完成。本轮不追加付费试跑。

在正式能力评测前，需先确定并验证执行期网络访问策略，阻止获取公开修复答案，同时保留必要模型端点访问；单靠提示词禁止查答案不能保证隔离。该策略应由评测环境承担，保持生产 Agent 工具与执行内核的职责不变。网络策略会改变测试条件，应记录后再建立新的固定样本基线，不覆盖本次原始结果。
