# 运行环境审计与输入预算修复（2026-09-15）

已修复两个已确认问题：失败探针证据未独立保存，以及环境观察缺少整体模型输入预算。本轮仅修改 Benchmark，未改 Agent 内核、权限判断、容器镜像或评分器。

## 职责与行为

- runtime.py 负责探针审计：在现有 setup 日志目录独占创建 runtime-probes.jsonl，记录时间戳、声明、执行身份与工作目录、每项开始、返回的完整 stdout/stderr 与退出码，以及完成或异常。每条记录写后 flush；再次使用同一审计路径会明确失败，不覆盖旧尝试。
- 非零退出、空输出、超时和取消都中止后续执行并记录失败；异常原样向上传播。硬终止可能只留下开始记录，不能据此判断成功；进程返回前的输出若 Harbor 未提供，无法重建。
- run.py 复用现有分析索引，增加 runtime_probes 文件引用；索引中的 present 只代表文件存在，不代表探针完成。
- agent.py 的既有 prepare_instruction 负责输入投影：整个环境段连同说明前缀最多 16 KiB UTF-8。过大时显式省略所有 stdout/stderr 正文，保留完整工具声明并标记 observations_omitted；原始返回内容保留在 setup 审计。声明本身过大则拒绝，不截断路径或参数。
- 输入协议为 evaluation-input-v4，记录实际环境段字节数、预算、省略状态及输入哈希。审计与输入预算各在自己的责任方，不把原始日志大小限制混入就绪判定。

## 路径审查

- 通用 runtime 模块的 cwd、user、audit_path 来自调用者；可执行文件路径来自任务声明。测试覆盖不同工作目录，不依赖个人目录。
- 活动 adapters/configs/environments 未发现 /Users/ 开发者目录依赖。ROOT 从模块位置推导，配置允许显式指定源目录；历史报告和原始日志中的本机路径是证据，不是执行配置。
- /testbed、/home/omni-benchmark、/opt/omni 等是现有隔离 SWE 适配器的容器布局约定，贯穿安装、权限和补丁交付。本轮未伪装成支持任意布局，也未仅替换某个 cwd 造成上下游不一致。支持新布局必须整体修改这个适配器契约。
- Python 安装位置仅存在具体 SWE 环境声明中，未回到通用代码。

## 文件范围

```text
benchmark/
├── adapters/harbor/runtime.py       逐步探针审计，异常继续抛出
├── adapters/harbor/agent.py         整体环境输入预算与投影审计
├── run.py                          复用运行索引定位探针日志
├── tests/test_environment.py       错误、超时、取消、禁止覆盖及动态工作目录
├── tests/test_instruction.py       多工具、多字节输出预算与声明完整性
├── tests/test_run.py               不完整审计文件仍可定位且不被改写
├── README.md                       当前契约和路径限制
└── reports/runtime-audit-budget-2026-09-15.md
```

## 验证与局限

format、format:check、typecheck 和 git diff --check 通过。TypeScript 全量 133 文件、907 项通过；Benchmark 21 项中 18 项通过，3 项既有评分器容器控制跳过。

测试包括真实本地 Python/Node 探针执行，以及可控注入的非零退出、超时和取消，验证审计保留已有结果和大段失败输出且不执行后续探针。模型输入测试覆盖 16 个工具及多字节内容，确认包含前缀的预算、工具声明不变、显式省略和声明超预算拒绝。

未重跑付费模型或 Docker：本轮不改变 Harbor 执行调用的身份、工作目录、超时或网络边界，修改集中在宿主侧审计和输入投影。不能据此声称模型通过率提高。未改生产包依赖、导出或 CLI 启动实现，未重复 build 或 pnpm dev。原始检查日志归档在忽略目录 benchmark/artifacts/runtime-audit-budget-2026-09-15/。
