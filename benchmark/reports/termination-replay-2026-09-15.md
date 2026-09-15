# 终止诊断补充与重放（2026-09-15）

结论：诊断已补齐并经过真实容器链路验证；本次未复现原始终态丢失，不能宣称根因已找到或故障已修复。没有付费模型调用。

## 变更边界

```text
apps/omni/src/
├── process-signals.ts       既有信号监督器报告信号、重复信号/宽限到期强退原因
├── process-signals.test.ts  验证诊断原因及诊断异常不阻断退出
└── headless-entry.ts        同步 stderr 记录取消、Service 关闭、Trace 查询和结果写入
packages/cli/src/headless/
└── run.ts                  既有 Session 关闭前后通知进程入口
benchmark/adapters/harbor/
└── agent.py                timeout 原生 verbose 日志、实际退出码与单调耗时回执
```

没有修改 Core、模型调用、工具执行或取消策略，也没有新增取消监督器。只在 headless 入口启用结构化诊断，交互 CLI 与 Host 不增加日志。诊断包含阶段、信号、时间和 PID，不包含凭据、Prompt 或命令内容。Trace 查询阶段不等于新增 Trace flush；仍复用原有 Service/Session 生命周期。

## 实验条件与证据

- 作业：`i5-replay`，trial：`i5-replay-task__wLuWgvz`；同一 Axios 任务基础镜像，通过原生 Harbor 初始化网络策略，运行中没有重启容器或更改策略。
- 重放原付费运行的 29 轮模型响应，真实执行完整 Omni 与 38 次工具调用。用户输入和全部工具输入与原 Trace 逐项一致，比较证据保存于 `comparison.json`。
- 复用 Provider 结构，选中端点改为容器 localhost，凭据为 fixture；每个文本/思考增量间隔 10 ms，避免前次突发重放的 Trace 丢记录。
- 进程额度 120 秒，Harbor 额度 150 秒，工具额度 300 秒；这与原始 590/600 秒及真实模型响应时序不同，不是严格同条件重现。
- 到达原来的末条命令：`cd /testbed && npx mocha test/unit/adapters/http.js --timeout 30000 2>&1 | tail -15`。

| 观测               | 结果                                                                            |
| ------------------ | ------------------------------------------------------------------------------- |
| 外部进程回执       | return_code=124；elapsed_sec=120.444679                                         |
| 信号               | 一次 SIGTERM，repeated=false；没有 force_exit 记录                              |
| 取消及收尾         | abort、Session close、Service dispose、Trace query、result write 均有完成记录   |
| 信号到结果写入完成 | 单调时间差 68.990 ms                                                            |
| Omni 结果          | result.json 存在，status=cancelled                                              |
| Trace              | integrity=complete；5,825 条事件，序号连续；包含工具、批次、回合与 Run 取消终态 |

本次作业的 reward=0 来自诊断 fixture 的占位验证器，不是官方 SWE 评分；它不改变原付费题 reward=1 的结论。本次只检验运行与取消生命周期。

## 如何继续定位

如果后续再次缺失终态，可先用 `process-exit.json` 与 stderr 区分外围超时和 Omni 收尾阶段，再对照原生 Trace：有重复信号或 deadline 强退记录就调查 Apps 进程终止；已发起取消但工具没有取消事件就调查工具取消链；工具取消后关闭阶段未完成就调查相应 Session/Service 所有者；结果写入完成却采集不到文件才调查适配器采集。缺失日志本身不能证明某个分支发生，仍须结合进程与容器证据。

成功对照不能证明历史偶发问题不存在。当前保留诊断，避免通过加长超时、伪造结果或补造终态掩盖故障。

## 验证

- 聚焦生命周期测试 16 项通过；全仓库 133 个测试文件、907 项测试通过。
- typecheck、format:check、Python Ruff 检查通过。
- `pnpm dev --help` 与 `pnpm run verify:host` 通过。
- 本轮未改变包导出或依赖，没有额外执行完整发行构建。
- [作业、fixture、配置与比较证据](../artifacts/i5-diagnosis/)（本地生成产物，不入 Git）。
- [此前责任定位与对照限制](termination-diagnosis-2026-09-15.md)。
