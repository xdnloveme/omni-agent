# 运行网络默认值修复与严格隔离边界 — 2026-09-18

> 历史阶段记录：整容器 allowlist 已被独立模型通道替换，旧探针已归档。当前边界以 `model-channel-isolation-2026-09-18.md` 为准。

## 结论

已修复 SWE 运行容器默认 public 导致 Agent 阶段结束后恢复公网的问题。**尚未实现模型与工具的严格隔离**：当前 agent phase 的模型域名 allowlist 对整个容器生效，不能把它称为“工具完全断外网”。严格通道设计与候选改动范围已补入原计划，未用代理或工具黑名单绕过。

## 根因、所有者与变更

Harbor 0.23.0 的 `Trial._phase_network_policy` 在 finally 中恢复 environment baseline；SingleStepTrial 随后收集产物。此前 SWE taskpack 将 runtime baseline 设为 public，混淆了镜像构建联网与容器运行网络策略。

- `benchmark/taskpacks/swe/prepare.py`：baseline 改为 no-network，清空上游 inherited allowed_hosts。构建保留原生网络能力，Agent phase 的既有模型 allowlist 与独立离线 verifier 暂不改动。
- `benchmark/tests/test_prepare_task.py`：生成实际任务后，调用 Harbor 原生网络计划解析器，验证 Agent baseline 和评分 baseline/phase 均为 no-network，模型 allowlist 仅在 Agent phase 生效。
- `benchmark/tests/probe_network.py`：复用既有网络探针，调用 Harbor 原生阶段上下文，分别验证正常返回、异常、取消之后先前允许的域名不能再访问；不复制切网实现。
- README 与原计划：明确严格隔离尚未完成，不沿用历史白名单结论声称满足新要求。

实现身份参与现有缓存摘要，后续正式 prepare 会重建。没有原地修改 50 题历史缓存、评分证明或执行付费任务。

## 免费容器证据

使用既有 Django-11815 冻结镜像承载探针，以 example.com 作为无凭据网络正对照；这是网络阶段诊断，不是完整 Agent run 或新镜像全链路验收。

| 场景     | 允许阶段          | 退出后的 no-network |
| -------- | ----------------- | ------------------- |
| 正常结束 | HTTP 200 / exit 0 | exit 35，连接被中断 |
| 抛出异常 | HTTP 200 / exit 0 | exit 35，连接被中断 |
| 取消     | HTTP 200 / exit 0 | exit 35，连接被中断 |

最终探针有 30 条记录，现有外部站点、宿主网关/代理、重定向、直连地址、sidecar 停机阻断断言通过。IPv6 公网正对照不可用，故 IPv6 独立验证仍为未验证；不宣称覆盖 DNS/ICMP 隐蔽通道、所有代理协议或恶意进程内扩展。

第一次探针在构造 Harbor 抽象 Trial 类时失败，finally 清理执行；第二次改用具体 SingleStepTrial 验证正常/异常通过；第三次增加取消用例并消除按异常文本判断，通过。三次记录全部保留。诊断仅调用该 pinned 版本不依赖 Trial 实例状态的阶段上下文，不启动第二个真实 trial。

全部探针结束后 Docker 无残留容器，无模型调用。原始记录位于被 gitignore 排除的 `benchmark/artifacts/network-boundary-2026-09-18/`。

## 检查与剩余范围

- Benchmark Python：50 项，36 通过、14 条件跳过；网络容器探针单独实际执行。
- TypeScript：138 文件、1001 测试通过；typecheck 通过。
- Python 格式、文档格式与 diff 检查；没有依赖或导出变动，不重复 build/TUI 启动。
- 尚未证明模型隔离通道可用；尚未进行严格通道的免费假模型闭环、真实模型调用或全题重验。四道上游联网测试的离线资源契约仍未解决。

下一阶段必须在正确的模型装配边界实现专用通信能力，并删除整容器模型 allowlist 路径；不能只为 Bash 切网，因为 web_fetch/web_search 是进程内工具。
