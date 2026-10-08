# Benchmark 评测契约

[English](benchmark-evaluation.md) | 简体中文

benchmark 通过 `apps/omni/src/headless-entry.ts` 调用正式 Agent，默认使用 coding。`packages/cli/src/headless/run.ts` 负责一次新 Session 和一次 Run；Apps 装配负责 Service、模型资源、信号处理及最终 Trace 查询。Harbor 适配器与评测数据位于 `benchmark/`，生产包不依赖它们。

headless 入口要求显式提供 `--confirm-unrestricted`、`--input-file`、`--config-file`、`--output-dir`，并在 `--providers-file` 与 `--model-channel` 中选择一个。`--cwd` 默认当前目录，benchmark 适配器显式传入。入口在输出目录下创建新的 `state`，拒绝复用已有目录；仅对新状态设置 unrestricted 执行模式。调用者必须提供隔离执行环境，这个参数本身不创建操作系统沙箱。

输出采用版本 1 JSON。`request.json` 登记一次尝试；`started.json` 在提交 Run 前记录创建的 Session；`result.json` 在 Service 释放后记录最终结果及原生 Trace 关联。正常完成、协作取消、失败的退出码分别为 0、130、1。GNU timeout 或操作系统终止可能产生自己的非零退出码，且不一定有完整结果文件。

Trace 关联复用按 Session ID 查询的能力与 `TraceStorageLayout`，要求恰好一个有效原生 Run。缺失、歧义、不可读、降级或未完成的捕获均明确报告。`lastTurnUsage` 可为空，保留原生格式，不是全部模型调用的总和。`replayFile` 指向原生逐次调用记录。匹配的完成清单只证明生命周期完成，不证明账单无遗漏或任务正确。

## 评测边界

启动器在执行前冻结选题和有效 Harbor 配置。Omni 自动准备还会将模型配置文件复制到作业目录；原生配置仍引用外部文件，由调用者保留所引用的版本。完成状态按“题目 × Agent 配置”与 Harbor 原生结果核对，区分缺失、重复、执行失败与有效零分。模型用量和评分是独立事实。无效原生结果不得发布分数或费用；无效适配器证据不得抹去有效原生评分。

准备阶段允许联网构建依赖并验证官方空补丁、参考补丁对照。作答工具不能访问外网。Omni 模型传输在独立进程/容器中复用正式 Provider 实现，通过隔离且预先建立的通道连接；凭据不注入作答容器。作答进程停止并封存提交后，独立评分器应用提交并遵循任务包声明的网络策略。SWE 评分允许联网获取官方测试资源。

任务身份、源版本、镜像摘要、Agent 源码归档、配置和原生证据用于复现。环境对照不衡量 Agent 能力。进程内扩展与外部测试资源仍属于信任假设；这不是经过对抗性加固的评测服务，也不宣称等价于排行榜成绩。

命令及当前验收范围见 [benchmark 使用、验证和限制](../benchmark/README.zh-CN.md)。实施计划和单次调试记录属于本地开发产物，不构成额外契约来源。
