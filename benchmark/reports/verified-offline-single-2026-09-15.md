# Verified 首题离线评分验收（2026-09-15）

结论：**V0/V1 单题评分闭环通过，V2 首批五题仍待验收，不进入付费运行。**
本次只运行官方 Oracle、空补丁和故障夹具，模型调用 0；没有修改生产 Agent、Provider、prompt、Tool 或 Trace。

## 目标和实现边界

此前正确补丁已通过 79 项测试，却因 `make_test_spec` 在断网评分阶段请求 GitHub 而被写成 reward 0。
修复所有者是 `benchmark/environments/swe-verifier`：联网准备完整官方 TestSpec，JSON 持久化并做字段集合、版本、哈希及往返校验；断网恢复后执行未改写的官方 eval，并调用官方 `get_logs_eval` / `get_eval_report`。
SWE-bench 4.0.3 和依赖通过 `grade.py.lock` 固定；旧上游脚本只保留为来源证据。

`prepare_task.py` 中 Oracle 的补丁基线改为镜像开始时的 HEAD，复用同一个 `collect-submission.sh`。
评分前校验镜像 HEAD/tree 和干净工作区，再复用现有补丁应用入口。没有新增模型客户端、Agent 循环、评分算法、容器调度器或日志框架。

## 固定输入与身份

- 题目：`django__django-11790`，源数据集 `swebench-verified`。
- Harbor 数据源提交：`61366953049fd63a7dff54f67193bf39f5d1cde6`。
- 基础镜像 digest：`sha256:061b5e37b0dfc15512b9604c843618b47aece8e603d08d0926c3990e0e9b3ac4`。
- 成功派生任务：`benchmark/artifacts/tasks/verified-mini-v6/django__django-11790`，协议 `isolated-swe-v2`。
- 镜像起始 HEAD：`84a9058f3ff86c9e7b27cc134460437fc9a4aac1`；tree：`616cc5cf3c5e7ab5043a4d0773e46698db77937e`。
- TestSpec SHA-256：`7daf90c96cc54f543f4ea1014f96fd967e0553c1e09f002dcba9d1137a2aaa30`。
- 官方 eval SHA-256：`a0536177263f6ec0a039b874f129a6d7a0325ef5729db0a5de2f6e76c79d8080`。

## 实际运行结果

全部直接对照容器都使用 Docker `network=none`，记录容器配置、进程退出码、原始测试日志、官方报告或错误诊断。

| 场景                               | 退出码 | reward | 官方结果/错误                            |
| ---------------------------------- | ------ | ------ | ---------------------------------------- |
| 正确补丁                           | 0      | 1      | FAIL_TO_PASS 2/2，PASS_TO_PASS 77/77     |
| 空补丁                             | 0      | 0      | FAIL_TO_PASS 0/2，PASS_TO_PASS 77/77     |
| 规范内容损坏，预置旧分数           | 1      | 不生成 | SHA-256 不匹配；旧 reward/report 清除    |
| eval 文件缺失，预置旧分数          | 1      | 不生成 | FileNotFoundError；旧 reward/report 清除 |
| 官方输出边界内没有可解析测试       | 1      | 不生成 | 官方 parser 没有有效测试结果             |
| 准备命令 `false`，随后执行正常测试 | 1      | 不生成 | 顶层 eval 命令失败，没有被后续测试掩盖   |

后两项通过在可信测试夹具内重新封装损坏的规范来触发执行/报告校验，不是通过 hash 错误提前退出。未修改官方 parser、判分函数或运行中的网络策略。
有效的未解决结果退出 0 表示“评分完成”，题目是否解决由官方报告和 reward 表达；不可再将评分进程异常映射为 reward 0。

Harbor 原生 Oracle 完整链路也通过：

- Benchmark run：`20260915T074655Z-2127190c90a8`。
- Trial：`django__django-11790__XJ2hUzT`。
- `verifier_environment_mode=separate`，reward 1，`exception_info=null`。
- 已检查有效官方报告：2 项 FAIL_TO_PASS、77 项 PASS_TO_PASS 全部成功。
- 总耗时约 163 秒，含本次评分镜像构建等待；Oracle 生成补丁约 4 秒。这不是 Agent 解题耗时。

## 验证与局限

- Python 基础测试：12 项通过；默认跳过的 3 个容器测试已单独运行，覆盖上表 6 个真实场景，全部通过（约 92 秒）。
- Ruff、`pnpm run format`、`format:check`、`typecheck` 和 `git diff --check` 通过。
- 默认并行全量两次均为 906/907，同一原有 Agent 循环测试超过 5 秒。该文件单独运行 44/44；完整单工作进程运行 907/907。保留失败日志，不把默认并行描述成通过；未修改测试逻辑或超时值，未将此问题归责于本次 benchmark 改动。
- 没有修改 Node 包导出、引用、依赖或 CLI 组合，因此未执行 Node 构建或 TUI smoke；本次相关运行验证为真实评分镜像构建与 Harbor 链路。
- ARH 完成 Discovery，但预检因可信目录不包含现有临时 Python 环境和 Docker socket 被拒绝（receipt `preflight_0a1bb195-6127-4c0b-a932-c24ff0aa6f54`），没有 ARH Run。继续使用用户已选定的 benchmark/Harbor 入口及项目自有容器测试，没有调整 ARH 信任配置。
- 构建迭代曾暴露 uv 参数顺序错误及观察器参数泄漏到 Conda 的调用错误。最终修正为正确 uv 调用、保留官方脚本 `$0` 与空参数、只观察顶层命令失败。失败构建日志原样保留；仅 v6 通过验收。
- 单题通过不证明其余 49 题环境可用，不是 Agent 能力成绩。Sphinx 镜像预置差异仍需 V2 实际检查；合成基线回归仅证明采集器不会重复提交已提交的镜像变更。
- 独立评分容器仍运行提交代码，不作完整对抗性防作弊保证。此次未新增或重新认证全部隔离攻击面。

## 证据和下一步

原始证据归档于 `benchmark/artifacts/verified-offline-single-2026-09-15/`，由 Git ignore 排除：包括所有构建日志、`controls/`、`control-summary.json`、官方 scoring assets、镜像身份、Harbor job、检查日志及清理记录。真实运行使用全新目录，没有覆盖此前无效评分证据。

下一步执行 V2：其余四题采用相同评分契约，首批五题各验证正确/空补丁、实际镜像基线、提交交接、隔离和清理。五题全部验收后再进入 V3 真实模型运行；本次没有启动任何付费试跑。
