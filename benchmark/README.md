# Benchmark

当前实现与验收边界见[2026-09-19 收尾报告](reports/closeout-2026-09-19.md)。

基于 Harbor 0.23.0 的 Agent 评测环境。公共机制不绑定待测框架；Omni 是第一个适配器，SWE 是第一个任务包。当前支持 Linux Debian/Ubuntu amd64 容器。

## 职责

- `run.py`：配置检查、提前登记运行、证据索引和报告。
- `adapters/omni/`：组合镜像中的 Omni 安装、启动、输入投影和原生 Trace。
- `environments/runtime.py`：任务运行时声明、探针和环境准备。
- `environments/handoff.py`：普通用户进程收尾、产物封存和统一交接校验。
- `taskpacks/swe/`：上游任务准备、唯一 Git 补丁收集器、官方离线评分。

复用 Harbor BaseInstalledAgent/BaseAgent、task.toml、AgentContext、collect 和 artifacts。不新增调度器或模型客户端，不修改 Agent 策略。

## 前置检查

使用仓库要求的 Node/pnpm，以及 Python 3.12；依赖固定在 `pyproject.toml`/`uv.lock`。先确认 `docker version`、`docker compose version`、`docker buildx version` 能访问选定的 Docker daemon。Docker context、CLI 插件目录属于本机工具配置，不写进任务或产品代码。作业目录必须被 Docker daemon 共享；入口用只读临时容器校验实际文件可见性，失败则不启动 Agent。远程 daemon 或 Colima 的受限共享配置需显式传入 `--jobs-dir`，不能仅凭宿主目录存在判断可用。

```bash
uv sync --project benchmark --frozen
export PYTHONPATH="$PWD"
```

## 统一命令

在仓库根目录执行；所有选择、配置和执行逻辑位于 `benchmark/`，根 `package.json` 只映射命令。

```bash
# 免费预览：只读清单，不判断自动准备缓存是否可用
pnpm run benchmark list --all
pnpm run benchmark list --task sphinx-doc__sphinx-11510

# 免费静态检查：验证配置；自动准备模式不代表环境已就绪
pnpm run benchmark check --first 3

# 下列 run 命令自动准备环境后调用真实模型；先配置凭据
pnpm run benchmark run --all --concurrency 5
pnpm run benchmark run --task sphinx-doc__sphinx-11510
pnpm run benchmark run --first 3
pnpm run benchmark run --first 10 --concurrency 5
pnpm run benchmark run --sample 5 --seed 42 --concurrency 5

# 显式指定准备缓存、Agent 时间和 Docker 共享的日志目录
pnpm run benchmark run --first 3 --task-root benchmark/artifacts/my-prepared-suite \
  --timeout 1800 --jobs-dir benchmark/jobs

# 原生 Harbor 配置（也走同一个 tracked_run），以及结果报告
pnpm run benchmark check --config benchmark/configs/harbor/smoke.yaml
pnpm run benchmark run --config benchmark/configs/harbor/smoke.yaml --kind fixture
pnpm run benchmark report benchmark/jobs/JOB_ID
```

默认配置为 `configs/default.json`，可用 `--profile PATH` 替换。配置中的 `manifest`、`task_root` 相对于配置文件目录解析；命令行路径相对于当前工作目录解析。`execution` 是已有 Harbor 作业配置，适配器及其 Provider 配置仍由适配器负责，公共选题层不读取模型凭据。默认 Omni 使用 `ARK_AGENT_PLAN_API_KEY` 环境变量及已有 `omni.config.json`、`omni.providers.json`；需要切换配置文件时修改 `execution.agents[].kwargs` 的 `config_file` / `providers_file`，不要把密钥写入 profile。

- 必须显式选择 `--all` / `--task` / `--first` / `--sample` 之一，互斥；`--task` 可重复，错误或重复 ID 会拒绝执行。
- `--first N` 使用清单顺序，**不是之前人工选出的 first_batch**。`--sample N --seed S` 不放回抽样，最终仍按清单顺序执行；运行记录保留确切 ID，不依赖将来重新抽样。
- `--concurrency N` 必须为正整数，覆盖配置值；默认 1。5 表示 Harbor 同时最多执行 5 道，一道结束即补下一道，不是每 5 道等待全部完成。每题仍只尝试一次，禁止自动重试。
- `--timeout` 覆盖每题 Agent 执行时间（1–1800 秒），不包含镜像准备和 Agent setup；现有收尾宽限保持不变。
- 每次 `run` 冻结有效配置、选题 ID、seed、清单/profile SHA-256，复用每题 Trace、产物和报告索引。日志及准备产物继续由 `.gitignore` 排除。
- `--config` 是完整原生配置输入，与 suite 参数互斥；两种输入在执行前收敛到同一个校验和运行入口。`run` 默认标记 `paid`；`--kind fixture` 仅声明证据类型，**不会将真实 Provider 变成免费模型**。

**准备边界：** 默认 profile 声明自动准备插件，`run` 按选题准备并验证环境，再进入 Harbor；`prepare` 执行同样的准备与预检，但不调用模型。缓存由内容身份区分，`--task-root` 指定其根目录。未声明准备插件的 profile 和原生 `--config` 引用已准备任务，继续走同一个运行入口；`prepare` 要求显式的准备插件。`list` 和 `check` 不判断镜像是否可启动。环境健康检查复用 Harbor 的启动、探针和清理机制；50 题全部环境、评分正负对照及 5 路并行仍需单独验证。

## 免费完整链路

生成任务包，再由 Omni 适配器准备组合镜像。每次输出目录必须是新的，不覆盖旧证据。

```bash
benchmark/.venv/bin/python benchmark/tasks/execution-contract/prepare.py \
  --output benchmark/artifacts/contract-source

benchmark/.venv/bin/python -m benchmark.adapters.omni.prepare \
  --task benchmark/artifacts/contract-source/files \
  --output benchmark/artifacts/contract-omni/files

benchmark/.venv/bin/python -m benchmark.adapters.omni.prepare \
  --task benchmark/artifacts/contract-source/patch \
  --output benchmark/artifacts/contract-omni/patch

export OMNI_SMOKE_API_KEY=fixture
benchmark/.venv/bin/python -m benchmark.run check \
  --config benchmark/configs/harbor/smoke.yaml
benchmark/.venv/bin/python -m benchmark.run run \
  --config benchmark/configs/harbor/smoke.yaml --kind fixture
```

`smoke.yaml` 使用真实 Omni 和确定性本地 HTTP 模型，不调用付费 API；同一任务还由 Harbor Oracle 执行参考对照。Oracle 不代表第二个真实 Agent 框架已完成接入。

镜像准备允许下载依赖；作答阶段 setup 只注入配置。镜像 ID、源码归档摘要、依赖锁摘要和配置摘要写入 `preparation.json`。不将个人配置、`.env` 或运行产物装入源码归档。

免费模型服务仅保留在 `tasks/execution-contract/model-server.py`；Omni 夹具配置归 `adapters/omni/fixtures/`。旧 smoke、isolation-probe 任务已移除，不提供旧协议执行入口。

## SWE 任务

准备器支持固定上游 revision 下的 `swebench-verified` 和 `swebench_multilingual`。镜像必须提供 SHA-256 引用；作答断网，SWE 独立评分使用 Harbor public 网络策略，模型连接由适配器隔离承载。

```bash
benchmark/.venv/bin/python -m benchmark.taskpacks.swe.prepare \
  --output-dir benchmark/artifacts/tasks/example \
  --dataset swebench-verified --task-name TASK_ID \
  --image IMAGE_AT_SHA256 \
  --runtime-manifest benchmark/environments/profiles/swe-python.json
```

任务名、数据集和镜像均为必填项，准备器不默认选择某一道题。

随后使用 Omni `prepare` 准备组合镜像，并在原生配置中引用新的任务目录。其他 Agent 通过 Harbor 原生接口接入，任务评分和产物收集不随适配器改变。

新协议为 `isolated-swe-v3`；历史 v2/v7 派生任务必须重新准备，检查入口拒绝旧交接契约，不自动回退。固定 50 题清单和历史成绩保留，本轮不扩跑、不产生排行榜成绩。当前三题及难题配置分别引用 `artifacts/tasks/verified-mini/`、`artifacts/tasks/verified-hard1/` 下重新准备的任务；不再引用历史 v7 目录，运行前必须完成准备。

## 环境声明与时限

`environment.workdir` 和 `environment.env` 是唯一来源。`environment/runtime.json` 使用版本 2：

```json
{
  "version": 2,
  "tools": [
    {
      "name": "project-wrapper",
      "argv_prefix": ["./project-wrapper"],
      "probe_args": ["--version"],
      "description": "Repository-provided toolchain entry"
    }
  ]
}
```

没有声明时记录未验证。健康检查使用作答用户，不依赖 Agent setup；每项 30 秒，总期限为 30×工具数+10 秒，无自动重试。不同语言、wrapper 和多工具组合通过声明表达，不按语言名选择代码。

运行配置唯一声明 `benchmark.agent_timeout_sec`，默认 1800。入口生成 Harbor 外层期限（+30 秒）和原生 Agent env `BENCHMARK_AGENT_TIMEOUT_SEC`，禁止重复覆盖。构建、setup、评分各 1800 秒；交接 120 秒，其中收集命令 60 秒。故障配置可缩短作答预算。外部取消由启动器向独立会话内的 Harbor 转发一次，再等待最多 150 秒完成原生恢复；超出期限明确标记清理未确认。适配器复用公共进程停止能力后下载取消证据。

## 运行网络边界

镜像准备阶段允许联网获取依赖。作答容器使用 `network_mode: none`，从启动、工具执行到提交收集和清理均无外网接口。提交冻结后，SWE 独立评分容器使用 Harbor `public` 策略访问官方测试资源；这不是逐域名白名单。网络策略由任务包声明，其他任务包仍可采用断网评分。模型在独立容器中复用现有 Provider，只有该容器接收模型配置和凭据。

Agent 启动前建立一次性 Unix socket 会话；服务端删除监听入口后才允许 Agent 开始工作。工具子进程不继承连接，不能重新连接模型入口。取消或断连会终止 Provider 工作，没有直连回退。该边界覆盖所有工具的网络，不依赖工具名或命令黑名单；进程内扩展仍是受信任代码。

模型通道历史验收见[隔离通道报告](reports/model-channel-isolation-2026-09-18.md)，当前评分边界见[评分网络调整报告](reports/verifier-network-alignment-2026-09-19.md)，职责和变更范围见[原计划修订](../docs/plans/benchmark-integration-v1.md)。旧缓存会由已有实现摘要失效并重建；不要把历史题目就绪证明视为新通道的验收。

## 交接与错误语义

普通执行用户为 `benchmark-runner`/UID 10001，无 sudo 或 Docker socket。Agent 阶段结束后，公共交接程序确认该 UID 的进程退出，再以该用户执行收集器并清理收集子进程。产物最终放入管理身份拥有的 `/submission`，完成后最后写 `handoff.json`。

Harbor collect 失败不会自动阻止评分。评分入口必须调用公共 `validate_submission`，校验必要产物、大小和摘要；失败不生成 reward。评分器只对有效提交判题目对错。超时可以保留已有提交并评分，但不能改写为自然完成。

评分容器独立运行，按任务包声明的网络策略执行，不共享作答进程、可写工作区或模型凭据。该隔离用于非对抗性个人评测，不承诺通用恶意防作弊。

## 每次运行的证据

```text
benchmark/jobs/<job>/
├── invocation.json                 运行前登记及启动器退出状态
├── launch-config.yaml              实际 Harbor 配置快照
├── launcher.log
├── analysis-index.json             可重建索引 v2
└── <trial>/
    ├── result.json                 Harbor 原始结果
    ├── agent/                      原生日志及适配器证据
    ├── artifacts/
    │   ├── benchmark-audit/        探针、收集命令与交接审计
    │   └── submission/             封存产物及完成凭据
    └── verifier/                   评分输出或明确异常
```

适配器通过 `AgentContext.metadata.benchmark_evidence` 发布 version=1 的引用，每项包含 kind、trial 内相对 path、media_type、producer。公共索引检查文件边界、存在性、大小和摘要；Omni 自行解析 Trace，不在公共入口硬编码其目录。

`analysis-index.json` 的 `verifier_artifacts` 完整索引评分目录中的文件，保留路径、存在性、大小和 SHA-256，不解析具体任务包格式。SWE 的 `error.json` 由评分器记录 version、stage、原始异常及可获得的命令/退出码；阶段包括资产校验、工作区校验、补丁应用、执行、报告解析和结果发布。阶段表示失败位置，不表示责任归属，官方分数与 Harbor 异常均保留原样。详见[诊断验收](reports/grading-diagnostics-2026-09-19.md)。

文件存在不代表 Trace 完整，Trace 完整不代表解题成功。缺失、无效、未提供和不完整分别呈现；费用未知不记为零，不用末轮估算 Token 充当整题账单。失败和超时仍保留原始产物，无法取回时明确缺失。

```bash
benchmark/.venv/bin/python -m benchmark.run index benchmark/jobs/JOB
benchmark/.venv/bin/python -m benchmark.run report benchmark/jobs/JOB
```

`benchmark/jobs/`、`benchmark/artifacts/` 已 Git-ignore；不要将完整 Trace、凭据或原始模型请求粘贴到受版本管理的报告中。

## 验收

```bash
benchmark/.venv/bin/python -m unittest discover -s benchmark/tests -v
BENCHMARK_TEST_IMAGE=PREPARED_IMAGE_ID \
  benchmark/.venv/bin/python -m unittest benchmark.tests.test_collection -v
```

真实容器测试覆盖残留进程、收集失败、提交校验、网络及文件边界；未提供镜像时明确跳过，不冒充容器验证。SWE 官方评分测试使用 `OMNI_TEST_VERIFIER_IMAGE` 指定预先准备的评分镜像。

完整范围、阶段门槛和历史证据见 [实施计划](../docs/plans/benchmark-integration-v1.md)。

独立联网评分的免费端到端验收见[生命周期报告](reports/public-verifier-lifecycle-2026-09-19.md)。`test_public_verifier_starts_after_sealed_solver_stops` 复用上述容器验收配置，验证作答封存写入拒绝、Docker 停止/启动顺序、交接摘要和评分公网请求。该用例需要评分容器能够访问 example.com；不调用付费 Provider。

旧 allowlist 探针已随该运行方案移除，历史脚本和结果保留在忽略目录。当前网络验收由真实工具探针 `tasks/execution-contract/probe-network.py` 与生命周期测试共同完成。

### Agent deadline versus cleanup watchdog

The Omni adapter supplies the generic headless `--deadline-at-ms` argument. The deadline is computed on the container clock at process launch from the existing work budget, covering Agent startup as well as execution. It is not recomputed on model requests or recovery. `cleanup_grace_sec` (default 10) is an adapter option reserved for shutdown before the external process watchdog; it does not increase the Run work budget. The existing TERM/KILL cleanup remains the last resort. Cancelled headless runs retain their outcome/Trace even if Harbor reports a nonzero process exit. This adapter does not decide Agent completion or recover model responses.

### Native output evidence

Omni's existing state archive includes Session output manifests and sanitized bodies. The adapter writes output-summary.json and checks body sizes/digests plus transcript reference closure after collection. Capture completeness and archive integrity are independent: an interrupted capture can be archived intact; a missing body makes the archive incomplete without changing the verifier score. Local validation evidence remains under the ignored benchmark/artifacts directory.

### 自动准备与缓存

默认 suite profile 现在声明 `preparation.taskpack` 和 `preparation.adapter`。
选题、准备、校验和执行仍由一个 `tracked_run` 生命周期管理：

```bash
# 免费：准备当前 Agent 与任务镜像、校验声明的环境，不调用模型
pnpm run benchmark prepare --first 3 --jobs-dir /path/shared-with-docker/jobs
# 付费：相同准备流程后进入原来的 Harbor 调度
pnpm run benchmark run --first 3 --concurrency 3 --jobs-dir /path/shared-with-docker/jobs
```

运行前配置正确的 Docker context，导出适配器要求的凭据环境变量。公共入口不读取
宿主机的 `.env`、猜测 Docker socket 或自动启动 Docker。`prepare` 也检查凭据是否
存在，以便环境准备成功后可以直接运行，但不会把凭据传给构建或健康检查容器。
`check` 只验证配置与插件声明，不构建镜像，也不证明环境就绪。

准备插件是受信任的本地 Python 代码，由 profile 的 `entrypoint=module:Class`
显式声明，没有按题目、语言或 Agent 名称分派的公共分支：

- Taskpack 接收 options/profile 目录/manifest。`resolve(task, requirements)` 返回
  固定准备输入，`prepare(task, output, resolved)` 复用任务自己的准备器。
- Adapter 接收 options/profile 目录/execution 配置。`snapshot(work)` 检查自身配置，
  返回 identity、requirements 及私有快照信息；`prepare(task, output, snapshot)`
  复用 Agent 打包实现，输出原有 Harbor task 契约。Adapter 可把 execution 中的
  配置路径指向本次冻结副本，公共层不解释模型配置或凭据。
- 插件入口源码和本仓库准备实现会参与缓存身份；外部插件的额外依赖、模板、
  文件与版本须进入其 resolve / snapshot.identity，不能依赖未声明的可变输入。
- 环境依赖仍由 taskpack、上游 Dockerfile 和 runtime 声明负责。健康检查复用
  任务声明；它只验证所声明的探针，不能保证未声明的软件或任意业务测试通过。

缓存位于 profile 的 `task_root/<task-id>/<input-digest>/<task-id>`。键包含固定任务
输入、Agent 内容快照、准备实现和依赖锁。Omni 源码归档使用确定性的文件元数据，
不因单纯 mtime 变化误失效。相同缓存键使用文件锁串行发布；只在构建、健康检查和
文件哈希校验完成后发布完整目录。失败构建保留在 job/preparation，不作为缓存。
缓存正文损坏明确拒绝；本机 Docker 镜像被删除则重新构建，旧记录移入当前 job。
已有缓存也要重新验证镜像存在与健康检查。

`invocation.json` 从配置/准备阶段开始记录；`preparation/preflight.log` 和每题的
`prepare.log` 保存构建日志；`readiness/environment.log` 与 `readiness/artifacts/` 保存
Harbor 健康检查及任务声明的探针产物。准备失败不会进入 Agent 执行，不会发起模型请求。
任务准备按选择顺序进行，`--concurrency` 仍只控制 Harbor 作答并发，不额外引入
第二套作答调度器。变更实现或源码会准备新镜像，不会覆盖旧 job 或旧缓存证据。

不含 preparation 的 profile 和 `--config` 表示调用者已经提供了准备好的任务，
继续进入同一校验与执行入口；这不是自动准备的隐式回退。

## SWE 离线评分准备

上游提供每题对应仓库版本、镜像和测试。我们自动生成隔离容器并复用镜像层，
不为每道题维护手写环境或依赖名单。

SWE 任务包的 `build_dependencies_manifest` 可声明 Python 项目的容器解释器和
项目路径，默认 Verified profile 共用 `taskpacks/swe/profiles/python-build.json`。
构建阶段从项目 `pyproject.toml` 的 `build-system.requires` 读取依赖，使用声明的
解释器下载相容 wheel，并保存项目元数据、依赖声明和 wheel SHA-256。
这项准备位于 SWE 评分器，公共准备层和 Agent 不解析 Python 依赖。

联网预热仍使用官方评分命令；随后通过本地 wheel 目录和 `PIP_NO_INDEX=1` 保留
pip 构建隔离。镜像发布前允许测试访问公网，复用同一个评分入口
执行空补丁和官方参考补丁，分别要求 0 与 1，完成后恢复原始仓库基线。
`/tests/control-validation.json` 留存对照结果。任一控制失败即停止构建，不能进入付费作答。

该评分对照覆盖 SWE 任务包所有语言；Python wheel 准备只覆盖项目显式声明的
构建要求，不声称自动推导所有生态的任意依赖。没有可用 wheel、动态构建要求或
其他生态依赖未准备时必须明确失败，由任务包补齐其真实准备能力，不能通过跳过测试或隐藏失败宣称就绪。
对于新增或未验证的题，仍需完成自己的首次准备；共同流程和缓存并不意味着所有题已经可运行。

手动使用 SWE 准备器时，可传入：

```bash
--build-dependencies-manifest benchmark/taskpacks/swe/profiles/python-build.json
```

已有缓存包含准备实现和配置摘要，修复会生成新缓存；历史 job、补丁和分数不覆盖。

## 内部运行与运维边界

当前定位为内部评测工具。环境通过、Agent 完成和题目通过是不同事实：
`invocation.json` 记录启动器生命周期，`analysis-index.json` 汇总各 trial；
最终成绩必须结合 trial 的 `exception_info` 与 `verifier_result` 判定。
Harbor 命令退出 0 不表示每道题成功；评分异常不能当作有效的解题 0 分。

批量执行前同时检查宿主磁盘与 Docker daemon 所在磁盘，远程 daemon / Colima
的可用空间可能远小于宿主空间。`docker system df` 显示用量，不显示 daemon
文件系统剩余容量。并发数只表示调度上限，不是 CPU、内存或磁盘容量保证。
`prepare` 按顺序准备，任一题失败会终止本次准备；其余未准备题不能记为失败成绩。
需要完整盘点时逐题调用同一 `prepare --task` 入口，保留每次 job，不新增作答调度路径。

日志与缓存目前不自动过期，也不自动删除。运行者负责：

- 为每个 job 保留配置快照、原始 Trace、输出、提交和评分，分析报告链接到原始证据。
- 在删除前确认进程已结束、容器已清理，所需证据已归档；保留期限由项目自行决定。
- 缓存目录、Docker 镜像和 job 是不同资产。只对明确识别且无正在运行任务引用的资产执行清理；
  不把全局 `docker system prune` 作为日常 benchmark 命令或自动恢复手段。
- 构建失败保留失败目录；镜像缺失由既有准备流程重新构建，不手工伪造 receipt。
- 中断后检查 invocation、trial 异常、Trace 完整性和实际容器状态，再决定是否显式重跑。
  重跑是新的 job，不能覆盖旧结果；没有自动付费重试，也没有承诺原进度续跑。

真实容器的免费生命周期测试位于 `tests/test_lifecycle_containers.py`。
先用 `tests/test_preparation.py` 的显式容器测试准备 execution-contract 的 files 夹具，
再设置 `BENCHMARK_LIFECYCLE_TASK` 为准备后的任务路径，
`BENCHMARK_LIFECYCLE_ROOT` 为全新且被 Docker 共享的证据目录，运行：

```bash
benchmark/.venv/bin/python -m unittest benchmark.tests.test_lifecycle_containers -v
```

该测试调用容器内确定性模型服务，覆盖并发 5、HTTP 错误、连接断开、超时、外部取消和容器停止。
故障注入仅存在于测试服务；不会读取真实 Provider key，也不证明真实 Provider 吞吐量、
限流行为、恶意多租户隔离或模型解题能力。测试期间会停止它自己创建的故障场景容器。

## 容量预检

正式 prepare/run 自动在准备前及准备完成/执行前采集容量，写入 invocation.json.capacity 并打印摘要。记录宿主 jobs/task_cache 文件系统、已有所选任务镜像看到的 Docker 根文件系统、题数和并发。共享文件系统不得相加，容器根文件系统不代表所有挂载卷容量。

需求与是否足够明确为未知，不按题数猜测空间，不自动拦截、调整并发或删除资产。完全冷启动没有本地任务镜像时 Docker 空间为 unknown；不额外拉取探测镜像，准备后再次采集。详情和实测见[容量预检报告](reports/capacity-preflight-2026-09-19.md)。
