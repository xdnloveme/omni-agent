# 社区 Verified Mini 50 题基准 v1

本目录是固定 50 题基准，采用下列已锁定 HAL 版本加载的题目集合，不按 Omni 成绩换题。`manifest.json` 只维护题目身份、来源核对、覆盖范围与镜像引用；运行配置和每次结果分别由 profile 与 job 记录。

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

每题沿用对应 Harbor Verified 任务和 SWE-bench 基础镜像。`pinned_base_image` 存在时使用其 digest，否则准备时解析 `upstream_image` 并冻结；最终镜像身份记录在准备产物中。不同题目可能需要不同镜像，25+25 题不意味着只有两个镜像。

题面核对发现：Django 题的纯空白行、Sphinx 题的换行与首尾空白存在上游格式差异。统一换行、清空纯空白行、去除整体首尾空白后，50 题文本一致；原始题面与 Harbor instruction 分别记录 SHA-256。这仅是来源核对方法，不是运行时题面清洗规则。

通过正式 `pnpm run benchmark prepare` / `run` 入口准备和运行。准备阶段联网生成官方测试规范并执行空补丁与参考补丁对照；作答工具断网，提交封存后由独立评分环境按任务包声明访问官方测试资源。评分规则和参考材料不提供给作答 Agent。详见 [benchmark 契约与验收边界](../../README.md)。

## 来源复核

按清单的 Git commit/HF revision 获取源文件并校验 SHA-256。HAL 文件、作者优化 JSON 和 Mini 数据集的 ID 集合应为同一 50 题。与父集比较公开题目元数据，不需要读取参考补丁或测试补丁。题目身份核对不等于当前环境可启动，也不等于 Agent 已通过题目。
