# 两道新题真实评测（2026-09-15）

运行 ID：`20260915T050207Z-0546c4e8c747`。两题分别来自 Babel 与 Docusaurus，均使用真实 `volcengine-agent-plan/default/glm-5.2`，每题一次、顺序执行、无自动重试。Agent 额度 1800 秒，Harbor 1830 秒，保留模型域名 allowlist 与独立断网官方评分。

## 结果

| 任务                       | 官方评分 | Agent 结果          | 进程耗时                 | Trace                       | 模型/工具调用 |
| -------------------------- | -------- | ------------------- | ------------------------ | --------------------------- | ------------- |
| babel__babel-13928         | 1        | completed，退出码 0 | 764.85 秒（12 分 45 秒） | complete，8,117 条连续事件  | 74 / 82       |
| facebook__docusaurus-10130 | 1        | completed，退出码 0 | 726.02 秒（12 分 6 秒）  | complete，11,987 条连续事件 | 69 / 85       |

两题均自然结束，没有复现此前总超时、终态丢失或未恢复 stash 的问题。不能用两题通过推断整个题库的能力分数，也不能证明此前偶发终态丢失已修复。

Babel 修复解析器作用域退出位置并新增 await/yield 回归用例；Docusaurus 修复目标页查找时的尾斜杠兼容并补充测试。最终提交只包含相关源码与测试，Babel 的调试文件已清理。检查全部工具调用未发现外部搜索或下载答案；保留上游 instruction 中的 hints，因此不宣称无提示评测，也不排除模型已有知识。

Babel 的探索性整仓库测试出现 8 个失败套件，Agent 进行了基线对照并恢复 stash；这与独立官方题目评分通过是不同结论。本报告不把整个仓库所有测试称为通过。Docusaurus 也扩大到了核心包测试和站点构建，具体结果保存在原始 Trace。两题工具调用数量较多，仍有优化验证范围和减少探索成本的空间。

## 先验证评分环境

付费前，两题分别通过原生 Harbor Oracle（官方补丁 reward=1），并在断网评分镜像中验证空补丁 reward=0。使用相同 pinned dataset commit `61366953049fd63a7dff54f67193bf39f5d1cde6`，各自镜像 digest 记录于 task derivation.json。

扩题所需变更只在 benchmark：

```text
benchmark/
├── adapters/harbor/prepare_task.py   参数化 task ID 与摘要固定的镜像
├── environments/swe-verifier/Dockerfile
│                                   预热后恢复基线，清理注入测试文件
├── configs/harbor/swe-two.yaml      两题、并发 1、每题 30 分钟
├── tests/test_prepare_task.py       保护任务/镜像匹配和上游输入不变
└── README.md                       可复现准备与运行命令
```

复用原生 Trace、官方评分和既有提交采集；没有改生产 Agent、模型、工具或取消逻辑。Babel 上游评分会新增 fixture，原来的 Axios 专用预热不能直接假定工作区仍干净，因此在评分镜像封装阶段显式恢复基线。新参数并不表示任意语言与镜像均已验证。

## 用量与证据

| 任务       | 普通 input | cacheRead | output | totalTokens |
| ---------- | ---------- | --------- | ------ | ----------- |
| Babel      | 60,655     | 2,492,160 | 26,212 | 2,579,027   |
| Docusaurus | 101,387    | 3,481,984 | 40,895 | 3,624,266   |

以上为原生 model.completed usage 累计，缓存读取不按普通输入解释；reasoning 已包含在 output，不再相加。实际金额未知，需对照 Provider 账单。lastTurnUsage 不是整题用量。

- [完整付费运行产物](../artifacts/20260915T050207Z-0546c4e8c747/)，包含 invocation、自动分析索引、每题 Trace/源码快照/输入/提交/评分，以及 audit.json。
- [无付费评分对照](../artifacts/two-task-oracle/)，包含两题 Oracle 与断网空补丁日志。
- 原生摘要中两题 Trace complete，分析索引也均 complete；归档前实际凭据精确扫描 0 命中，产物目录 Git-ignore。
- 9 项 benchmark 测试、907 项仓库测试、类型检查、格式检查通过。未改变包依赖或导出，没有重建发行包。
