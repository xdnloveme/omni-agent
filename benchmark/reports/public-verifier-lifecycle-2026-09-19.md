# 独立联网评分端到端验收 — 2026-09-19

两项必做验收完成。只新增测试与证据，没有修改生产运行时、Agent、提示、工具或评分规则。

## 正式运行链路

复用现有 execution-contract/files 任务、真实 Omni 和免费确定性模型服务，经 `python -m benchmark.run run` 正式入口执行（与 pnpm run benchmark 使用同一入口；本轮没有另跑 pnpm 外壳）。使用独立 public 评分配置，实际 Harbor 网络策略与提交交接均被执行。

最终单次试跑 reward=1，测试通过，耗时约 19.5 秒。模型服务为本地 fixture，无真实 Provider 凭据或付费请求；这验证基础设施，不表示 LLM 解题能力。

## 实际证据

- 作答工具网络探针：仅 lo；IPv4 公网访问被阻止；模型凭据不在作答侧。
- 作答侧封存后，管理进程临时降为实际 benchmark-runner UID/GID，尝试打开两个提交文件、handoff.json 以写入，以及在提交目录创建新文件，均被权限拒绝。测试复用 handoff.file_info / validate_submission，不实现另一套摘要协议。
- Docker 原生事件：作答主容器 die 早于独立评分容器 start 约 0.579 秒。使用同一 Docker 时间轴和容器 ID 关联，非宿主/容器时钟猜测。
- 独立评分容器在 Harbor public 策略下访问 https://example.com，收到 HTTP 200。
- 封存时、评分收到时、网络探针结束时，两个提交文件和交接回执的 SHA-256 一致；collection_id 与实际交接回执相同。
- 所有本轮容器、通信卷清理完成；测试构建的 verifier 镜像已删除，保留原有 Agent/Verifier 基础镜像。
- 当前 Agent 源码归档摘要与复用镜像的 preparation.json 一致：09b2de710fbf468f88aef10e123397ad7f8890c75c20c3839077a7653573bc4f。

## 权限含义与中间诊断

最初把“评分容器内同 UID 不能写提交复制件”作为断言，真实执行发现 Harbor 复制目录后的权限并不满足该假设。该断言不对应 Agent 的可达边界：作答容器已停止，评分容器没有运行 Agent，也没有共享提交写入通道。因此未为此增加生产 chmod 或兼容逻辑。

修正后的验收分别在正确的所有者验证：作答侧验证封存写入拒绝；宿主观测作答容器停止；评分侧校验复制件的完整性。不能据此声称评分容器中的 root 或受信任评分代码无法修改复制件。本方案也不抵御恶意宿主或容器逃逸。

另有一次测试 Dockerfile 使用裸 sha256 作为 FROM 导致构建失败；最终直接复用任务原有固定基础镜像 Dockerfile，不添加镜像别名。原始失败日志和修正后两次成功结果均保留。

## 变更与回归

- benchmark/tests/test_lifecycle_containers.py：新增一个 opt-in 真实端到端行为测试，复用已有 run_case、配置和清理流程。
- benchmark/tests/fixtures/verify_public_submission.py：测试专用封存写入探针、网络与摘要证据；不进入生产工具/运行时。
- Python 默认 51 项中 36 通过，15 项按真实容器条件跳过；新增容器用例已单独显式执行并通过两次，其中最终源码版为最后一次。
- Ruff 错误检查、git diff --check 通过。测试只涉及 Python/文档，没有重新执行未修改的 TypeScript 全量测试、构建或 TUI。

前一轮四道 SWE 的完整官方评分对照与本轮通用链路验收互为补充：前者证明参考补丁 1/空补丁 0，后者证明真实 Agent 交接后独立联网评分。尚未重跑真实付费模型或全部 50 题，也未重跑其余容器故障场景；不能外推为全部环境已重新发布。

证据：benchmark/artifacts/public-verifier-lifecycle-2026-09-19/（已 gitignore）。final/public-verifier-order.json 保存事件与摘要关联；final/public-verifier/jobs 保存原生 Trace、结果、提交、交接和网络日志；audit.json 保存清理结果。
