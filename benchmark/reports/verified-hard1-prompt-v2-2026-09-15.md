# Coding 策略提示真实对照（2026-09-15）

结论：新版提示在这次 Sphinx 7590 单次复跑中未解决旧版的 ID 语义错误，官方 reward 仍为 0；耗时和 token 增加。不据此证明通用能力提升，也不从单次对照断言提示必然造成退化。未追加尝试或自动回滚提示。

## 对照条件

- 旧 job：`20260915T093224Z-17384e164d83`，见[旧版报告](verified-hard1-2026-09-15.md)。
- 新 job：`20260915T114319Z-dc69244e14f0`。
- 同一道固定 50 题中的 Sphinx 7590，模型 `volcengine-agent-plan/default/glm-5.2`，Agent 1800 秒、外层 1830 秒，每轮一次，无自动重试。
- 使用同一派生任务 `verified-hard1-v6/sphinx-doc__sphinx-7590`、镜像 digest、评分协议与原生运行入口，复用已通过的 Oracle=1、空补丁=0 对照。
- 新容器、新会话；没有注入旧补丁、失败日志、参考解答或题目专属提示。
- 两份实际 source.tar 逐文件比较，仅 `agents/coding/src/prompt.ts` 内容变化，无新增/删除文件。实际模型请求确认包含新的独立测试预期规则。
- instruction-submitted.txt、state/providers.json、state/config.json 逐字节一致。研究者已分析此题，因此属于开发回归，不是未见题盲测；也未控制模型采样随机性或做多次重复。

## 结果与用量

| 指标                 |      旧提示 |      新提示 |
| -------------------- | ----------: | ----------: |
| 官方 reward          |           0 |           0 |
| FAIL_TO_PASS         |         0/1 |         0/1 |
| PASS_TO_PASS         |       24/24 |       24/24 |
| Agent 进程耗时       | 19 分 31 秒 | 25 分 17 秒 |
| 非缓存输入 token     |      89,723 |     120,704 |
| 缓存读取 token       |   5,035,200 |   9,260,416 |
| 输出 token（含推理） |      48,998 |      66,800 |
| 总 token             |   5,173,921 |   9,447,920 |
| 模型响应 / 工具调用  |    99 / 106 |   132 / 147 |

新轮自然完成，exit=0、status=completed、Harbor exception=null；无超时。Trace complete，20,074 条事件序号连续。耗时增加 29.62%，总 token 增加 82.61%；这些不是金额涨幅。reasoning 56,081 已包含在输出中，cacheWrite=0。统计来自逐条 model.completed usage，非最后一轮上下文估计。

**实际费用及 Agent Plan 套餐额度扣减未知。**Harbor cost_usd=null，原生 cost=0 没有可靠计价依据；不能报告免费或按 token 比例推断实付金额。本次是实际付费模型链路，不是模拟模型。

## 失败定位与行为观察

仍失败于 `test_expressions` 中 `template<> C<a[5_udl]>` 的 ID v3/v4：

- 实际：`IE1CIAL5E_udl_1aE`
- 官方期望：`IE1CIAclL_Zli4_udlEL5EE_1aE`

新实现的 `ASTUserDefinedLiteral.get_id()` 返回 `self.literal.get_id(version) + self.suffix`，仍未按字面量运算符调用编码。新增测试使用 `exprCheck(expr, 'L' + i + 'E' + suffix)`，依旧与实现共享错误假设。新提示已送达，但未在这个关键决策点产生所需的独立验证行为。

新轮增加了整数/浮点/字符串相关检查和文档构建 fixture，也对一个既有 std-domain 失败做原代码对照；验证面扩大，但没有覆盖正确的 ID 语义依据。这能说明本次增加检查不等于提高正确性。

19 个 isError 工具结果包含输入拒绝和命令失败，未中断运行；本次无证据表明运行时内核、提交或评分故障导致失败。未观察到外部答案或独立评分资产访问，Git 调用为初始历史检查；该结论限于可观察 Trace，不排除训练记忆。

## 归档与边界

完整证据位于忽略目录 `benchmark/artifacts/verified-hard1-prompt-v2-2026-09-15/`，包括原生 Trace 与分片请求、source-comparison.json、comparison.json、官方报告和 analysis-index.json。凭据精确扫描 716 个原始文件，指定 API key 原始字节命中 0。Harbor 容器已清理，专用 Colima 已停止。

本轮没有新增生产代码修改，保留已授权的 prompt 与基线修改。报告执行 Prettier、git diff --check、归档忽略规则检查；没有重复运行生产测试，前一轮提示修改后全套 907 项已通过。没有再开付费重跑。
