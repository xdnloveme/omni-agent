# Verified Mini 首批五题：环境验证与评分阻塞（2026-09-15）

结论：**尚未通过付费前门槛，真实模型调用 0 次。** 不是 Agent 解题失败。首题标准补丁的 79 项测试全部通过，但评分程序在断网容器中联网失败，最终 reward=0 无效。不能把这个 0 计入能力分数，也不能把同样报错的空补丁 0 当作有效负对照。

## 已完成与最小改动

- 原 `prepare_task.py` 增加 `--dataset swebench-verified`，仍复用 Harbor TaskClient 和同一个 `prepare`。
- 原准备器直接指定基础镜像，跳过上游 Dockerfile 安装。本次保留其环境定义，只固定 FROM digest；执行与评分环境共用这段上游定义。已实际完成首题 uv 安装、评分依赖预热和镜像构建。
- 源码构建在 arm64 daemon 默认选择 arm64，导致第一轮五题都无法使用 amd64 镜像。准备器现只固定 Compose main 为 linux/amd64；网络隔离 sidecar 仍由 Harbor 选择本机平台。
- 五题镜像已下载并固定 digest，生成 v1/v2 两版任务，旧版未覆盖。首批付费 YAML 已生成，但门槛未通过，未执行。
- 未修改 Agent、Provider、工具、原生 Trace 或上游评分脚本；未放开评分网络。

## 运行证据

原始产物归档在 `benchmark/artifacts/community-first5-2026-09-15/`，运行任务保存在 `benchmark/artifacts/tasks/verified-mini-v1/` 与 `verified-mini-v2/`，均由 Git-ignore 排除。

| 尝试                                   | 结果                           | 解释                                                                                         |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| Oracle `20260915T070227Z-133ea8b0435a` | 5 个构建失败                   | 未指定 main 平台，错误为 no match for platform in manifest；未进入测试，已修复并确认容器清理 |
| Oracle `20260915T070439Z-af56e9c283bf` | 首题 reward=0；随后中止        | `django__django-11790__B6tdSnY`：79 tests，OK；随后 parser ConnectionError，评分无效         |
| 首题断网空补丁                         | 79 tests，2 failures；reward=0 | 测试按预期失败，但 parser 同样 ConnectionError；不是有效评分对照                             |

`empty-controls.json` 的原检查仅看进程退出与 reward，因此错误地记录了 passed=true。原记录保留，`validation-audit.json` 明确将其撤销为 invalid-score；后续门槛必须要求成功生成官方评分报告及标准补丁正对照，不能只检查 0/1 文件。

源码树探测：三个 Django 镜像包含额外 SWE-bench 空提交，但树与官方 base_commit 一致。Sphinx 10323 的上游镜像在 tox.ini 增加 pytest `-rA`，属于环境测试日志配置。Omni 采集补丁已使用运行前镜像 HEAD；Oracle 封装仍使用 config.base_commit，两者不一致，后续须统一以执行前快照为比较基线，避免把环境改动重复提交。Sphinx 9698 未完成该探测，不声明通过。

## 评分根因与责任

官方上游脚本在测试完成后生成 `/parser.py`，调用 `swebench==4.0.3` 的 `make_test_spec(datum)`。构建 TestSpec 会进入 `make_env_script_list` → `get_requirements_by_commit` → `requests.get`，读取 GitHub 上固定 environment_setup_commit 的 requirements。

这段缓存是 Python 进程内 `@cache`，预热一次不会把请求结果持久化到下一次离线评分进程。uv 缓存只能解决包下载，不能解决这个请求。实际失败 URL 指向 Django `0668164b4ac93a5be79f5b87fae83c657124d9ab/tests/requirements/py3.txt`。

责任属于 benchmark 与上游评分脚本的离线契约不匹配。Docker 正确阻止了外网；本轮没有真实 Agent，更不能归责 Agent。

## 后续契约调整（已确认，待实施）

设计结论：**Not ready for paid evaluation**。原计划同时要求“上游评分脚本字节不变”和“独立评分全程断网”，在上述 Python 任务上不能按现状同时满足。

用户已确认采用官方评分 API 的离线适配，保留官方规则并调整封装契约；最新范围、文件树和门槛见[实施计划](../../docs/plans/benchmark-integration-v1.md#官方离线评分契约修订2026-09-15已确认)。本报告的历史失败证据不变；后续新方案已通过[首题 V0/V1 验收](verified-offline-single-2026-09-15.md)，五题仍未就绪。以下为已确认的方案：

1. 准备阶段联网：固定 SWE-bench 版本，通过官方接口生成 TestSpec 和 eval 脚本，持久化规范并记录来源、版本和哈希；这些材料只进入可信评分环境。
2. 评分阶段断网：读取预生成的 TestSpec，执行官方生成的测试脚本，通过官方评分 API 产出报告。不在评分阶段重新构建环境规范，不重新实现测试解析和 resolved 判定。
3. 原上游脚本保留为来源证据；它不再是原样执行入口。删除被替代的运行路径，不保留自动回退、猴子补丁、下载代理或联网兜底。
4. 评分器异常或官方报告缺失应成为环境/评分错误，不能落成解题 reward=0。Oracle 和真实 Agent 使用同一镜像起始快照采集补丁。
5. 重做五题的标准补丁=1、空补丁=0、离线网络与评分异常反例，再启动真实 Agent；保留全部旧尝试，不改题。

当时预计目录（现已完成首题实现，实际变更以新验收报告为准）：

```text
benchmark/
├── adapters/harbor/prepare_task.py      复用官方规范生成，统一补丁比较基线
├── environments/swe-verifier/
│   ├── Dockerfile                     准备官方规范与离线依赖
│   ├── test.sh                        调用唯一离线评分入口
│   └── grade.py                       官方 TestSpec 持久化/加载及评分 API 薄适配
├── tests/                             保护离线正负对照和评分异常不冒充 0
└── reports/                           保留契约、版本和运行证据
```

继续原样执行上游脚本并放开评分网络会削弱已确认的隔离边界；不推荐。给 requests 打补丁或添加隐式缓存代理会引入兼容旁路，也不推荐。AGENTS.md 要求外部契约阻塞时先对齐方案，不能未经确认添加 workaround/compatibility path。用户已确认替换评分封装，计划已修订原“原样脚本执行”约定；不再等待同一契约的重复确认。

## 检查与清理

准备器契约测试覆盖上游安装保留、镜像固定、Verified 路径、amd64 main 及原始题面/评分脚本不变；11 项 benchmark 测试、Ruff、全仓格式与 diff 检查通过，派生任务和归档证据的 Git-ignore 已验证。生产格式、类型检查与 907 项测试此前均通过；后续改动仅位于 Python benchmark，没有新增生产依赖或导出，不重建生产发行包。

Oracle 和空补丁工作已中止，专用 Docker 实例检查无残留容器。没有读取或传递模型凭据，没有付费调用。镜像与原始日志保留用于后续复验。
