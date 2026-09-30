# 工具作用域说明与测试环境交接（2026-09-15）

后续已由[任务运行环境交接契约](task-runtime-contract-2026-09-15.md)替换本文的 Python 专用设计；本文保留该阶段的实际改动与验证记录。

结论：已完成两项通用工程改善，无付费模型调用。没有修改权限判定、Shell 分析、Core、Provider 或评分协议；不据此声称 Sphinx 7590 能通过，或模型无效调用数量已经下降。

## 根因与边界

- 真实 Trace 开头的 Git 命令被统一 Shell 分析标为写入范围未知，Coding 的项目指令检查因此要求有界 write_paths。Git、解释器和测试程序可能有间接写入，本次没有证据支持把它们整体放宽为只读。
- 工具原说明仅强调外部路径，unrestricted 提示也没有说明项目规则发现仍需写入目标。现在在 Coding 执行模式提示和拒绝信息中说明要求，在通用 Bash schema 中说明声明语义；没有新增命令名单或第二套 Shell 分析。
- 默认 Python 并非任务依赖所在的解释器。Benchmark 通过显式 test_python 配置，在 install 阶段以 omni-benchmark 用户、/testbed cwd、30 秒期限运行隔离 Python 探针。配置不存在或不可运行就失败，不猜路径、不安装依赖、不回退。
- Django 与 Sphinx 的测试入口不同，因此只报告验证过的 Python 路径及版本，不把 pytest 写成统一测试命令。解释器可用不等于全部依赖或测试通过。
- 复用 prepare_instruction，新增独立环境事实输入及哈希，原题原样保留；输入协议升级为 evaluation-input-v2。未配置 Python 的任务只报告 cwd。

## 本轮文件范围

```text
agents/coding/src/
├── components/prompt-catalog.ts       所有模式的项目规则作用域指引
└── instructions/scope-gate.ts         可操作的拒绝信息，判定不变
packages/tools/src/shell/
└── bash.ts                           通用路径声明说明，schema 约束不变
benchmark/
├── adapters/harbor/agent.py           验证环境并复用现有输入审计
├── configs/harbor/
│   ├── swe-verified-mini-first3.yaml  已有首批任务的解释器配置
│   └── swe-verified-mini-hard1.yaml   已有复杂题的解释器配置
├── tests/
│   ├── test_environment.py           身份、失败不回退及非 Python 边界
│   └── test_instruction.py           环境事实与原始输入的审计契约
├── README.md                         使用方式及验证范围
└── reports/environment-handoff-2026-09-15.md
```

工作树中其余历史 benchmark、prompt.ts、基线及 plan 改动不属于本轮新增。未提交、合并或回滚此前改动。

## 验证

- TypeScript 类型检查通过。
- 既有作用域、Shell access 与 Coding 基线聚焦测试：20 项通过。
- 完整测试：首次 906/907，通过失败项为 Core 循环测试 5 秒超时；未修改该测试或超时值。该文件独立复跑 44 项通过，随后完整复跑 133 文件、907 项全部通过。不能据此断言首次超时的具体原因。
- Python benchmark 测试：18 项中 15 项通过，3 项既有官方评分容器控制按默认配置跳过。本轮未修改评分器，未重复评分对照。
- 另行执行真实断网容器检查：4 个既有上游镜像，普通用户均能验证配置解释器，错误路径均被明确拒绝。Sphinx 7590 原始仓库的 test_domain_cpp.py 为 25 passed；此为原始仓库测试，不是本次 Agent 解题成功。
- Sphinx 7590/10323：Python 3.9.20；Django 11790/12193：Python 3.6.13。实际镜像 digest、环境事实、输入哈希与测试输出保存在忽略目录 benchmark/artifacts/environment-handoff-2026-09-15/。
- 四个验证容器全部删除，专用 Colima 已停止。未读取或传入模型凭据。

没有执行完整付费 Harbor 试跑，也未验证模型是否实际减少了试错。这需要后续同条件运行评估。没有包导出或依赖变更，未运行生产 build；没有 CLI 启动或配置加载实现变更，未重复 pnpm dev。
