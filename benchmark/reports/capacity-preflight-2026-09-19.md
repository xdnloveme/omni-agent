# 容量预检 — 2026-09-19

已接入正式 benchmark 入口。只观测和记录，不做准入阈值、容量估算、并发调整或自动清理；不拉取额外探测镜像。

## 容量与预期

本次免费完整链路实测：宿主日志文件系统约 171.68 GiB 可用；Docker 探测容器根文件系统约 2.90 GiB 可用；daemon 4 CPU、约 7.74 GiB 内存。选题 1、并发 1，链路通过。这不能推导为可运行 50 题或并发 5 个重型任务。

Docker 可用空间来自已有所选任务镜像内 df -Pk /，并标注 scope=probe_container_root_filesystem、存储驱动、镜像与采集时间；不是所有挂载卷或整个 daemon 的统一容量保证。宿主 jobs/task_cache 可能共享文件系统，不能相加。若 task cache 路径尚不存在，观测其最近存在的祖先并记录 measured_path。

无本地所选任务镜像、Docker 不可用、df 不可用或超时，均记录 unknown 及原因。不会把宿主空间冒充 Docker 空间。required_bytes、capacity_sufficient 始终为 null：需求受共享层、构建临时文件和输出增长影响，尚无可靠估计。

准备前记录 before_preparation；正式执行前记录 before_execution；prepare-only 末尾记录 after_preparation。快照放在 invocation.json.capacity，终端同步打印。完全冷启动时第一份 Docker 空间可能未知；准备完成后再测。这里未新增提前拉取或另一条环境解析路径。

## 范围与所有权

- benchmark/capacity.py：宿主与容器文件系统观测、现有所选任务镜像查找、未知状态和预期说明。
- benchmark/run.py：在已有生命周期插入两次采集并沿用运行记录持久化。
- benchmark/tests/test_capacity.py：禁止额外拉取/联网、未知不替代、字节换算、超时清理。
- 现有 run/preparation 单元测试隔离容量 I/O；真实链路验证实际采集，避免单元测试意外连接 Docker。
- README：说明指标范围与非容量保证。无 Agent、Provider、任务评分逻辑或配置格式修改。

探测使用 --pull never、--network none、--read-only、--cap-drop ALL、no-new-privileges，指定 df 入口。完成或超时后删除仅本次命名的探测容器并检查其不存在，不删除用户镜像/日志/构建缓存。清理未确认会记录 unconfirmed 和 probe_container，容量未知也不冒充足够。

## 验证

免费真实 Omni→工具→封存→独立公网评分链路通过，reward=1；两阶段容量记录可读，探测清理 confirmed，作答停止先于评分启动、提交摘要一致的既有断言继续通过。耗时约 26.9 秒，不把与前次总耗时之差当作容量探测的独立开销。

Python 57 项中 41 通过、16 按容器条件跳过；其中本轮所需真实生命周期用例单独显式执行通过。Ruff 错误检查和 git diff --check 通过。最终补充的 probe_container 字段与超时清理由单元测试覆盖；完整容器试跑在该字段补充前完成，测量及生命周期逻辑一致。

本次只涉及 Python/文档，未重复 TS 全量测试、产品构建或 TUI，无付费调用。证据位于 benchmark/artifacts/capacity-preflight-2026-09-19/，已被 gitignore 排除。容器清理审计见 summary.json。
