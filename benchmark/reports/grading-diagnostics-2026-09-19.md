# 评分诊断与证据索引验收 — 2026-09-19

已补齐两项确定缺口：公共索引完整发现 verifier 目录证据；SWE 评分器产生失败阶段及命令事实。保持官方分数和 Harbor 异常原样，不根据 DNS/HTTP 字符串自动归因，不运行自动参考补丁重试。

## 职责与变更

- benchmark/run.py：新增 verifier_artifacts，逐文件复用现有 evidence_file / file_info 边界检查和摘要；已索引文件复用结果，避免再次扫描正文。未知格式同样被索引，不导入 SWE 模块或理解评分文件内容。
- benchmark/taskpacks/swe/verifier/grade.py：error.json 加入 version=1、stage、command_failure（可用时包含 exit_code 与 command/argv）；原 type/message 保留。明确记录 asset_validation、baseline_validation、patch_application、evaluation、report_parsing、result_publication。
- 同一评分入口启动时清除旧 test-output.txt，防止新调用在执行前失败，却把上次测试输出当作本次证据。
- benchmark/tests/test_run.py：实际生成索引，验证任务自有/未知格式文件被收录、符号链接无效、原始文件与官方 0 分不被修改。
- benchmark/tests/test_verifier.py：复用既有真实容器测试与同一评分入口，验证阶段、命令失败、清理与正负对照。故障注入仅存在测试中，未改正式评分资产。

## 免费验证

最终在固定 Sphinx-10323 官方评分镜像中挂入当前评分器执行 9 个真实容器案例：资产损坏/缺失 2、离线依赖安装失败 1、无测试输出 1、准备命令失败 1、官方参考补丁/空补丁 2、脏工作区 1、非法补丁 1。5 个测试方法通过，另一个“重评指定历史提交”的方法因未指定提交跳过。

7 个故障均无 reward/report，分别保留预期阶段；执行错误包含退出码。资产失败不会残留注入的旧测试日志。参考补丁 1、空补丁 0。无付费请求，无残留测试容器。

最初选 Django-11815 镜像执行时，既有“删除 wheel 一定导致失败”用例不成立；换到 Sphinx 镜像仍不成立。不是将失败改判通过，而是修正故障注入前提：显式要求使用声明的解释器，从空目录离线安装 packaging，禁用缓存并忽略已安装包，再验证真实 pip 错误被保留为 evaluation 失败。可信测试脚本重封装复用现有辅助逻辑，不影响正式镜像或题目测试。两轮原始失败证据保留。

Python 默认测试 53 项中 37 通过、16 按容器条件跳过；上述评分容器测试另外显式执行。Ruff 错误检查、文档格式检查和 git diff --check 通过。本次无 TypeScript/包导出/依赖变更，不重复 TS 全量测试、构建或 TUI；此前通过结果不是本轮新验证。

## 解释边界

stage 只表示失败位置，不表示责任：patch_application 失败可能是提交不合法；evaluation 失败也不自动等于环境问题。正常官方 0 分不生成伪造异常。评分器启动前的 shell/交接校验失败以及进程硬杀未必有 error.json，此时索引仍保留外层输出/已有文件，不伪造阶段。result_publication 的磁盘故障未做真实故障注入。

证据位于 benchmark/artifacts/grading-diagnostics-2026-09-19/（gitignore），含三轮原始执行、最终汇总、回归输出及清理结果。

## 当前质量判断

内部评测用途主观工程评分从约 8/10 提升至约 8.5/10：诊断可定位性与证据可发现性改善，评分/执行路径没有增加。仍未在新隔离架构下复验真实付费 Provider 完整链路、全 50 题就绪与长期运行；公网评分受外部网站变化影响。此评分不代表排行榜成绩或生产安全认证。
