# 官方评分网络边界调整 — 2026-09-19

按用户批准调整完成。作答、工具和提交收集保持 network_mode none；SWE 独立评分使用 Harbor 原生 public 策略访问公网。它不是逐域名白名单，不声称公网网站本身稳定。模型隔离通道及凭据边界不变。

## 验证结果

| 题目                     | 原失败用例联网复验 | 完整官方空补丁 | 完整官方参考补丁 |
| ------------------------ | ------------------ | -------------- | ---------------- |
| sphinx-doc__sphinx-10435 | 1/1 通过           | 0              | 1                |
| sphinx-doc__sphinx-7985  | 3/3 通过           | 0              | 1                |
| sphinx-doc__sphinx-8269  | 3/3 通过           | 0              | 1                |
| sphinx-doc__sphinx-8475  | 3/3 通过           | 0              | 1                |

完整对照使用归档的各题固定上游镜像、官方输入，以及本次 grade.py / Dockerfile.fragment 构建独立 verifier。复用同一官方评分入口，未修改测试、补丁、断言和计分规则。每份 control-validation.json 的 spec_manifest_sha256 已核对原始 spec-manifest.json。4 个诊断评分镜像在提取证据后删除；没有修改历史准备回执或伪装成全量正式 prepare 成功。

联网复验是在 Docker bridge / 默认构建网络下进行，证明外网资源冲突已解除；Harbor 正式运行的 public 策略由原生网络计划测试验证，本轮没有重新执行完整 Harbor Agent trial。未调用付费模型。这不是 Agent 解题成绩，也不是全部 50 题在新架构下的完整就绪证明。

## 责任与变更范围

- benchmark/taskpacks/swe/prepare.py：声明独立 public 评分；作答 baseline 与 agent phase 仍 no-network。
- benchmark/adapters/omni/prepare.py：仅强制作答断网，评分网络归还 taskpack 所有；不增加第二条运行路径。
- benchmark/taskpacks/swe/verifier/grade.py、Dockerfile.fragment：沿用官方评分对照，删除旧 validate-offline 入口名，统一 validate-controls / control-validation.json；不提供旧别名。
- benchmark/taskpacks/swe/verifier/build_dependencies.py：更正历史注释；依赖安装继续使用准备好的 wheel，测试 HTTP 不受 PIP_NO_INDEX / UV_OFFLINE 限制。
- benchmark/tests/test_prepare_task.py：原生 Harbor 网络计划证明 solver 断网、verifier public、独立评分；验证生成 Compose 没有误将 verifier 固定为 none。
- benchmark/README.md 与原有 docs/plans/benchmark-integration-v1.md：明确最新边界覆盖历史评分断网要求。

Harbor SingleStepTrial 的原生顺序已核对：run_agent → collect_artifacts → stop_agent_environment → run_verifier。提交交接仍复用现有封存与完整性校验。本轮未改动此生命周期，未新加临时代理、HTTP 重放、URL 特例、域名猜测、Agent prompt 或工具行为。

旧缓存由现有 implementation_identity 自动失效，按需重建，不迁移旧断网证明为新证明。

## 回归及限制

- Python 50 项：36 通过、14 按显式容器条件跳过。聚焦原生网络计划测试通过。
- TypeScript 首次全量 1006 通过、1 项已有 Agent loop 测试触发 5 秒超时。原样单独复跑该文件 52 项通过；降低进程并发到 2 后全量 140 文件、1007 项通过。保留全部日志，未改测试或阈值。
- format:check、typecheck、Ruff 错误检查及 git diff --check 通过。
- 本轮只改 Python benchmark 和文档；没有包依赖/导出变化，不重复构建 TypeScript 产品或启动 TUI。
- 未重新运行付费 Agent、完整 50 题准备或 Harbor 生命周期容器套件。真实评分环境未来仍可能因网站变化失败，应保留环境失败证据，不应归因于 Agent 或跳过计分测试。

证据在忽略目录 benchmark/artifacts/verifier-network-alignment-2026-09-19/：定向日志、4 套完整构建日志与官方对照、源码输入、摘要核验结果、测试日志和清理结果。
