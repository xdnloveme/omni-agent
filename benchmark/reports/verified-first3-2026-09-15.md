# Verified 首批三题（2026-09-15）

状态：V2 环境验收、V3 三题真实运行均已完成，3/3 官方 resolved，全部自然完成，0 超时、0 基础设施错误、0 重试。固定 50 题不变，用户将本次付费批次缩为两道 Django 和一道 Sphinx，每题一次、并发 1、不自动重跑；Agent 1800 秒、Harbor 1830 秒。未修改 Agent、模型策略或评分逻辑。

| 题目                     | Oracle | 空补丁 | 正确补丁官方回归结果                 |
| ------------------------ | ------ | ------ | ------------------------------------ |
| django__django-11790     | 1      | 0      | FAIL_TO_PASS 2/2，PASS_TO_PASS 77/77 |
| django__django-12193     | 1      | 0      | FAIL_TO_PASS 1/1，PASS_TO_PASS 11/11 |
| sphinx-doc__sphinx-10323 | 1      | 0      | FAIL_TO_PASS 1/1，PASS_TO_PASS 40/40 |

所有空补丁对照运行在 `network=none`，均有有效官方报告；Oracle 使用 Harbor separate verifier 完成真实提交交接。Sphinx 基础镜像相对题目源提交增加 pytest `-rA` 输出选项；已确认此变更保留于镜像，且未混入 Oracle 补丁。评分镜像与上游镜像 HEAD/tree 对照一致。验证容器在付费开始前全部清理。

- 派生任务：`benchmark/artifacts/tasks/verified-mini-v6/` 下本批三个任务，沿用上一轮已验收评分代码及依赖锁。
- Oracle job：`20260915T080308Z-d0f595399ae3`，约 9 分 54 秒，含镜像构建。
- 真实 job：`20260915T081424Z-6708b9afbd0c`。
- 模型：现有 Provider `volcengine-agent-plan/default/glm-5.2`；凭据只从原 `.env` 的 `ARK_AGENT_PLAN_API_KEY` 进入运行环境，不写入配置或报告。

## 真实运行结果

| 题目                     | reward | Agent 进程耗时 | 官方 FAIL_TO_PASS / PASS_TO_PASS | Trace                   |
| ------------------------ | ------ | -------------- | -------------------------------- | ----------------------- |
| django__django-11790     | 1      | 16 分 25 秒    | 2/2；77/77                       | complete，13,364 events |
| django__django-12193     | 1      | 10 分 47 秒    | 1/1；11/11                       | complete，4,896 events  |
| sphinx-doc__sphinx-10323 | 1      | 19 分 14 秒    | 1/1；40/40                       | complete，13,264 events |

三题 Omni status=completed、进程 exit=0、Harbor exception=null；Trace 序号逐条连续。以上耗时为适配器测得的 Agent 进程时间，包含进程启动和收尾，不含容器准备及独立评分。整个串行 Harbor job 约 60 分 3 秒。所有题只运行一次。3/3 仅代表本批三题，不是固定 50 题或正式排行榜成绩。

## 可核实用量

逐条累加原生 Trace 的 `model.completed.payload.usage`，不把最后一轮上下文估算当累计用量。

| 题目         | 非缓存输入 |  缓存读取 | 输出（含推理） | 模型响应 / 工具调用 |
| ------------ | ---------: | --------: | -------------: | ------------------: |
| Django 11790 |     89,817 | 2,115,456 |         41,325 |             46 / 48 |
| Django 12193 |     48,085 | 1,870,592 |         18,114 |             79 / 79 |
| Sphinx 10323 |     76,363 | 3,673,216 |         43,430 |             77 / 83 |
| 合计         |    214,265 | 7,659,264 |        102,869 |           202 / 210 |

总 token 7,976,398；其中 reasoning 86,309 已含于输出，不能再次相加。缓存写入为 0。实际金额及 Agent Plan 额度扣减未知：Harbor cost_usd=null，原生 cost=0 无计价依据，不能报告免费，也不套用未经核实的单价。

## Trace 行为与责任边界

- 三题都存在工具输入或 scope 声明错误，生产校验返回结构化拒绝后继续执行；`tool.result.isError` 分别 6、14、13 条，包括校验拒绝和正常非零命令，不等于题目失败。Django 12193 还生成一次不存在的工具名，得到 Tool not found，未发生执行旁路。
- Django 11790 首次推理较长，后续重复执行测试以改变输出过滤方式；曾指定不存在的测试模块。最终修改 forms.py 和对应测试，官方回归全部通过。
- Django 12193 先使用系统 Python，切换题目 Conda 后仍缺可选 psycopg2；为局部渲染复现多次构造临时 stub。官方目标是 CheckboxInput 的 attrs 不被修改，官方评分覆盖 1 个目标及 11 个保留测试，均通过。不能据此宣称 PostgreSQL 全量环境或测试已验证，也不把可选依赖缺失直接归为 Agent 内核故障。
- Sphinx 在 Docutils 解析细节上进行了长推理，随后调整 literalinclude、补测试、文档与 CHANGES。存在错误参数、错误测试名和重复测试；最终官方 41 项全部通过。
- 这些证据说明解题链路可完成且有策略效率改进空间；本次没有复现超时后终态缺失，也没有证明 Agent 内核存在新故障。未在本批修改 Agent 逻辑、提示、Provider 或评分代码。

## 答案访问与隔离审计

逐题检查工具输入及相关输出，未观察到访问外部解答、参考补丁或独立评分资产。Django 11790 查阅了题面明确提到的历史回归提交 `5ceaf14686` 及其父版本，另查看镜像准备空提交、搜索本地历史；检查到的输出未包含本题参考修复。Sphinx 开始时读取已有 Git 日志。仓库自带测试属于正常可读源码，与后置注入的官方评分测试区分。

这是一项观察性结论，不保证模型训练时未见过公开题目，也不扩大既有隔离威胁模型。评分复用独立、断网的官方 API 环境；本次不重新宣称全部网络绕过探针已覆盖。

三份真实运行源码归档 SHA-256 均为 `cf317f549144256d4e855226926965ba46c6c04a0807dff84f3eb5ca3746ce86`，与各自 source.json 一致。凭据精确扫描检查本轮原始证据 854 个文件，命中 0；只输出命中统计，未输出密钥。此检查针对指定 key 的原始字节，不是通用秘密扫描。

## 归档与检查

完整本地证据保存在忽略目录 `benchmark/artifacts/verified-first3-2026-09-15/`，包括 Oracle、空补丁对照、paid job、原生 Trace、源码快照、输入、补丁、官方报告、analysis-index.json、audit.json 和 final-checks.json。沿用现有 benchmark/artifacts/ 忽略规则，不新增日志实现。

三题容器已由 Harbor 清理，专用 Docker daemon 无遗留容器；Colima 停止结果见本地 cleanup.json。运行及分析使用既有入口与本地临时脚本，没有另建评分器或生产日志链路。

本次变更仅批次配置、清单和文档；收尾执行针对这些文件的 Prettier、git diff --check 及忽略规则检查。没有再次运行整套 TypeScript 测试：本批未改生产代码，上一阶段评分实现的检查结果单列于首题离线报告，不将历史测试冒充本轮检查。其余 47 题尚未运行；本次不自动扩题。
