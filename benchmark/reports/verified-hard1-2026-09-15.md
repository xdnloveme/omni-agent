# Verified 复杂单题（2026-09-15）

状态：真实运行完成，官方 reward=0，未解决；Agent 自然完成，评分与容器链路正常。任务 `sphinx-doc__sphinx-7590` 来自固定 50 题，清单唯一 `source_difficulty: >4 hours` 题；按已锁定难度和 C++ 解析器问题范围选择，未按本次得分选题。难度是人工修复估时标签，不是模型用时保证。

用户要求只加一道复杂题；原首批三题记录和固定 50 题不变。使用现有 Provider `volcengine-agent-plan/default/glm-5.2`，每题一次，无重试，Agent 1800 秒、外层 1830 秒。不修改 Agent、提示、评分或隔离逻辑。

- 问题：Sphinx C++ 文档解析器无法处理 `1q_s` 等用户自定义字面量。
- 镜像 digest：`sha256:5c86dab7120b83b3bdb4af86743a3910da328029ed92183477fe9865ea76cb2f`。
- 上游源 commit：`2e506c5ab457cba743bb47eb5b8c8eb9dd51d23d`。
- 镜像起始 HEAD：`3f69f85506e8d069fc18ee1f79b0c160321f6440`，tree `3e1532444f67959e878a83c500bd60bf5168d895`。上游预置 setup.py 依赖约束及 tox.ini 的 pytest -rA；按镜像基线采集补丁，保留这些环境修改。
- Oracle job：`20260915T092706Z-a0468dc310b2`，reward=1，有效官方报告。
- 空补丁：reward=0，有效官方报告；network=none；评分基线与源镜像一致。
- 真实 job：`20260915T093224Z-17384e164d83`。
- 配置：`benchmark/configs/harbor/swe-verified-mini-hard1.yaml`。

## 结果与责任定位

- 一次真实尝试，Agent 用时 1170.727 秒（19 分 31 秒），exit=0、status=completed；没有超时、取消或重试。该时间不含容器准备和独立评分。
- 官方 FAIL_TO_PASS：0/1，失败 `tests/test_domain_cpp.py::test_expressions`；PASS_TO_PASS：24/24。Harbor exception=null，官方补丁成功应用，报告有效。
- 失败属于 Agent 生成的题目修复不完整，已定位到 `sphinx/domains/cpp.py` 的新增 `ASTUserDefinedLiteral.get_id()`。它直接返回 `L<literal><suffix>E`，把自定义字面量当普通字面量编码，没有按字面量运算符调用生成 ID。
- 官方用例 `template<> C<a[5_udl]>` 的 ID v3/v4 实际为 `IE1CIAL5_udlE_1aE`，期望为 `IE1CIAclL_Zli4_udlEL5EE_1aE`。解析和字符串展示可用，不代表 ID/链接语义正确。
- Agent 新增的测试也采用相同的 `L...E` 预期，例如 `exprCheck('1q_s', 'L1q_sE')`，因而自测未揭示这个契约错误。官方测试替换目标测试文件后暴露问题。
- 这是具体补丁的语义错误，不是超时，也没有证据归责 benchmark 评分或容器。本轮不修改 Agent 内核、提示或题目答案，不追加付费重跑。

## Trace 与用量

原生 Trace complete，14,560 条事件序号连续；99 次模型响应、106 次工具调用、19 个 isError 工具结果（包括输入拒绝和命令失败）。常见浪费包括重复缺少 scope、错误输入参数、初始 Python 环境选错、重复测试以筛选输出。保留这些原始错误，不据此宣称运行中断。

| 非缓存输入 |  缓存读取 | 输出（含推理） |  总 token |
| ---------: | --------: | -------------: | --------: |
|     89,723 | 5,035,200 |         48,998 | 5,173,921 |

reasoning 38,911 已计入输出，不重复相加；cacheWrite=0。由逐条 model.completed usage 累加。实际费用与 Provider 套餐扣减未知，不能把 cost=0 当免费。

源码快照 SHA-256 为 `cf317f549144256d4e855226926965ba46c6c04a0807dff84f3eb5ca3746ce86`，与前批三题一致。进程与 Trace 正常收尾，未复现历史终态丢失问题。

## 访问审计与证据

检查工具调用及相关结果，未观察到外部解答或独立评分资产访问。Agent 读取初始 Git 日志、以 HEAD 版 cpp.py 做一个既有失败的对照后恢复自己的修改；可见历史只到题目基础提交和镜像准备提交，没有本题参考修复。结论只针对本次可观察 Trace，不排除公开题目的训练记忆。

凭据精确扫描检查 453 个原始证据文件，指定 API key 原始字节命中 0；未输出密钥。完整证据归档至忽略目录 `benchmark/artifacts/verified-hard1-2026-09-15/`，包含官方正负对照、paid job、补丁、原生 Trace、官方报告、analysis-index.json、audit.json 和 final-checks.json。沿用已有 gitignore，不增加生产日志实现。

Harbor 已清理所有本题容器，停止专用 Colima；清理回执在 cleanup.json。收尾检查覆盖本次配置/清单/文档 Prettier、git diff --check 和忽略规则。未改生产代码，未重跑整套 TypeScript 测试；前阶段评分代码检查见首题离线报告。

本题是固定 50 题中的单次复杂能力探针。前批 3 题通过、本题未通过，不能将有目的选择的 4 题结果当作正式 50 题或排行榜成绩。
