# 社区 Verified Mini 50 题基准 v1

本目录是 Omni 当前选定的固定 50 题基准，完整采用 HAL 实际加载的题目集合，不自行增删或按 Omni 成绩换题。已核实任务身份与上游环境映射；首批三题已通过官方正负评分对照，真实运行已完成，三题均官方 resolved。当前证据见[三题报告](../../reports/verified-first3-2026-09-15.md)，历史评分阻塞见[预检报告](../../reports/verified-mini-preflight-2026-09-15.md)。

[manifest.json](manifest.json) 是唯一运行清单来源，包含全部 ID、基线 commit、源文件哈希、环境引用和首批任务。此文件目前不是可直接执行的 Harbor YAML。

## 来源核验与更正

核验日期：2026-09-15。结论：**HAL 实际使用的 50 题就是 MariusHobbhahn 发布的存储优化子集**。此前把 HAL 随机集与该精选集当成两套独立推荐不准确；HAL 页面/README 的“随机”文案与实际代码、ID 不一致，以锁定的加载代码和清单为准。

| 证据                                                                                                                                                               | 锁定版本                                   | 核验结果                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [HAL 加载代码](https://github.com/princeton-pli/hal-harness/blob/16bb03ebc11577fb5ea6dc8bb6c968387085e6aa/hal/benchmarks/swebench.py)                              | `16bb03ebc11577fb5ea6dc8bb6c968387085e6aa` | 读取固定 ID 文件，从完整 Verified 过滤任务                                                          |
| [HAL ID 清单](https://github.com/princeton-pli/hal-harness/blob/16bb03ebc11577fb5ea6dc8bb6c968387085e6aa/hal/benchmarks/swebench_verified_mini_task_ids.txt)       | 同上                                       | 50 个不重复 ID                                                                                      |
| [作者优化子集](https://github.com/mariushobbhahn/SWEBench-verified-mini/blob/1ce432065d9ed226017ef1ac88b5f91818383c64/data/subsets/size_optimized_sample_ids.json) | `1ce432065d9ed226017ef1ac88b5f91818383c64` | 与 HAL 的 ID 集合完全一致                                                                           |
| [Hugging Face Mini](https://huggingface.co/datasets/MariusHobbhahn/swe-bench-verified-mini/tree/b316c349947c29963fce3f4a65967c9807a4b673)                          | `b316c349947c29963fce3f4a65967c9807a4b673` | 与 HAL 的 ID 集合完全一致                                                                           |
| [完整 Verified](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/tree/78f471bf655a3137b2e8a75af1501690ec009ec3)                                        | `78f471bf655a3137b2e8a75af1501690ec009ec3` | 50 题全部存在；repo、base_commit、environment_setup_commit、version、problem_statement 与 Mini 相同 |
| [Harbor 任务库](https://github.com/laude-institute/harbor-datasets/tree/61366953049fd63a7dff54f67193bf39f5d1cde6/datasets/swebench-verified)                       | `61366953049fd63a7dff54f67193bf39f5d1cde6` | 全部 50 题存在，50 份 task.toml 均可由当前 Harbor 0.23.0 解析                                       |

HAL loader 未固定 Hugging Face revision，所以这只能证明上述已锁定版本的对应关系，不能证明历史榜单每次运行都使用完全相同的数据字节。相同题集也不意味着模型、预算、提示、网络规则等评测条件相同，不直接宣称可复现 HAL 榜单成绩。

## 选题方法与能力边界

作者用 16 个模型的历史运行数据，按表现、测试通过率和难度等信息聚类，按类分配样本，并优化环境存储需求；方法和比较结果见[源仓库说明](https://github.com/mariushobbhahn/SWEBench-verified-mini/blob/1ce432065d9ed226017ef1ac88b5f91818383c64/README.md)。我们复用发布结果，不重新训练聚类或自造筛选逻辑。

- 覆盖 Django 25 题、Sphinx 25 题，均为 Python 项目。不能代表 Java、PHP、Rust 或整个软件工程任务空间。
- 该子集是降低评测成本的代理指标，不保证每个新模型/Agent 的 50 题成绩都接近完整 500 题；存储优化有明确的仓库覆盖取舍。
- 上游难度标签分布为：`<15 min fix` 19 题、`15 min - 1 hour` 23 题、`1-4 hours` 7 题、`>4 hours` 1 题。标签不是 Agent 耗时预测，也不是本次重新标注。
- 不根据 Omni 的通过率筛选、替换或排除题目。首次结果保留为基线；如果以后用这些题反复优化 Agent，应称为开发/回归集，独立能力结论需另设未调试评估。
- 题面自身可能有复现代码和修复建议；本次没有将参考补丁或评分测试写入清单。不能证明模型训练阶段未见过这些公开题目。

## 上游环境与评分边界

每题沿用对应 Harbor Verified 任务和 SWE-bench 基础镜像。清单中的 `upstream_image` 是上游标签引用，首批三题另有 `pinned_base_image` 固定 digest，其余题目尚未解析/固定 digest，不能称为全部运行环境已冻结；不同题仍可能使用不同镜像，25+25 题不意味着只有两个容器镜像。

题面核对发现：25 道 Django 题的空白行中制表符/空格被 Harbor 去除，25 道 Sphinx 题只涉及换行/首尾空白差异。全部 50 题在统一换行、清空纯空白行、去除整体首尾空白后文本相同。原始 HF 题面和 Harbor instruction 分别记录 SHA-256；此规范化只用于本次审计比较，不新增运行时题面清洗或兼容逻辑。

静态映射通过不等于环境就绪。当前入口为 `python -m benchmark.taskpacks.swe.prepare`，显式指定数据集、任务和镜像；公共环境负责作答及评分两侧的 amd64 平台。首批原生 Oracle 发现上游 Python 评分器在断网阶段重新生成 TestSpec 时请求 GitHub，导致标准补丁测试通过却返回无效的 reward=0。空补丁 0 同样无效。

历史验收结论：**Ready with trade-offs**。下述首批三题结果属于当时的协议，不代表当前 v3 组合镜像已准备；使用新框架时必须重新准备并完成评分对照，其余题目同样需要逐题验收。用户已确认在联网准备阶段生成官方 TestSpec，断网评分阶段加载它并调用官方评分 API，替换原样执行上游脚本的契约。离线评分适配已实现并通过[首题 V0/V1 验收](../../reports/verified-offline-single-2026-09-15.md)，V2 三题验收已完成，V3 三题真实运行已完成，三题均官方 resolved；以[实施计划](../../../docs/plans/benchmark-integration-v1.md#官方离线评分契约修订2026-09-15已确认)的 V0–V4 门槛推进，不放开评分网络、不新增隐式回退。

## 首批 3 题与运行门槛

用户因用量将首批缩为 3 题，沿 HAL 文件的零基索引 `[0,12,25]` 取两道 Django 和一道 Sphinx。选法不读取得分，仅用于本轮试跑，不承诺统计代表性。固定 50 题及已锁定的上游镜像身份保持。

| 题目                       | 上游标题                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `django__django-11790`     | AuthenticationForm's username field doesn't set maxlength HTML attribute.                |
| `django__django-12193`     | SplitArrayField with BooleanField always has widgets checked after the first True value. |
| `sphinx-doc__sphinx-10323` | Use of literalinclude prepend results in incorrect indent formatting for code eamples    |

1. 通过既有准备入口生成首批任务，拉取并锁定镜像 digest，验证 amd64、系统兼容性、普通用户、`/testbed`、Conda/Python/测试依赖和 Omni 私有工具链隔离。
2. 在可信独立评分侧逐题做空补丁 reward=0、标准补丁 reward=1 对照，验证基线恢复、离线执行与提交交接；参考答案和评分材料不进入 Agent 执行环境。不另写评分器。
3. 通过门槛后使用 `python -m benchmark.run run` 运行。每题一次、并发 1、Harbor 无重试；Agent 1800 秒、外层 1830 秒。保留每次原生 Trace、源码快照、输入/配置、最终补丁、官方评分和用量；时间上限不是费用上限。
4. 先验收首批三题证据，再准备其余 47 题。环境/评分故障必须单独报告，不当成 Agent 解题失败，也不悄悄换题；发生重跑必须关联并保留原尝试。
5. 首次完整报告同时给出解决数/50、环境未完成数、取消数、Trace 完整性、耗时和可核实用量。环境未完成时不把较小分母的通过率冒充 50 题成绩；对小幅版本差异复测，逐题比较而非只看总分。

## 复核与本次验证

可按清单锁定的 Git commit/HF revision 取回源文件，校验文件 SHA-256；比较 HAL 文件、作者优化 JSON 和 Mini parquet 的 ID 集合应都为同一 50 题。与父集只读取公开列进行比较：instance_id、repo、base_commit、environment_setup_commit、version、problem_statement；不需要读取参考补丁或测试补丁。

本次已完成上述三方 ID、父集元数据、50 份 Harbor 配置解析和 150 个 Harbor 源文件哈希核验。临时下载与分析文件放在工作区外，不进入 Git。现有 benchmark/jobs/、benchmark/artifacts/ 忽略规则继续用于后续运行，不增加另一套日志写入器。

题集冻结阶段的静态检查结果仍有效；后续镜像、Oracle 和无效负对照结果以运行报告为准。本轮真实运行及用量以[三题报告](../../reports/verified-first3-2026-09-15.md)为准，不外推全量成绩。
