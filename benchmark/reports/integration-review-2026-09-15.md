# Benchmark integration v1 收尾验收

结论：Ready with trade-offs。实现、测试和运行证据可提交；不把当前方案视为对抗性评测平台，也不宣称此前偶发终态丢失已修复。未扩大到 20 题，未新增付费调用。

## 审查与修正

- 生产边界：Apps 统一进程与共享 Service composition；CLI 拥有单次 Session/Run；App 仅增加初始 Trace capture 策略。没有第二套 Agent loop、Provider 或工具执行路径；原 WebSocket Host 复用重命名后的 composition。
- 评测边界：benchmark 拥有任务准备、容器普通用户、网络策略配置、补丁转移、运行登记与分析索引。原始 Trace 和官方评分仍是依据，索引可重建。
- 修复补丁采集失败会跳过诊断下载的问题：停止解题用户进程后，采集失败仍尝试保留日志，随后报告失败；进程停止失败不下载仍可变的证据。采集与下载同时失败时保留两项异常。
- 保存并实际使用 launch-config.yaml 快照，避免配置文件后续修改导致运行哈希无法对应当时输入。
- 缺少终态类型的损坏 Trace 不得被分析索引标为 complete。
- 更新过时状态文档。运行产物、Trace payload 和配置副本只在 Git-ignore 的 jobs/artifacts 中保留。

## 验证

11 项 benchmark 测试、907 项仓库测试通过；format、format:check、typecheck、Ruff、完整 build、pnpm dev --help、verify:host 通过。失败采集链路使用边界测试验证调用顺序与异常保留，没有冒称本次重新进行了容器故障注入。

已完成的真实容器证据：Babel 和 Docusaurus 均独立官方评分 1、自然 completed、Trace complete；同时已有空补丁失败/Oracle 通过、真实超时取消与无付费重放证据。收尾修正没有新增付费运行。

## 保留限制

- 原始 Axios 缺失终态仍未复现，原因未证实；后续运行通过不能消除历史未知。
- 普通用户隔离和单独断网评分降低泄露与污染风险，不是防御任意恶意代码的完整安全证明。原始 public/shared 配置只作历史/对照用途。
- 费用只有 Provider usage，没有权威账单；未验证估价不能作为实际金额。
- 进程强杀、主机退出或采集 I/O 故障仍可能留下部分证据；run 状态与评分必须分别判读。
- Bash 的 tail/重定向和原生工具截断会限制可见输出，不保证保存每条测试的所有输出。

后续可固定 20 题候选集并分批运行；该工作不包含在本次提交中。
