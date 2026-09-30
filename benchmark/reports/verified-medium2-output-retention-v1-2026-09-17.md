# django__django-11885 — output retention v1 验证记录

## 最终结果：通过

用户授权安装 Rosetta 2 后，安装成功；专用 Colima 使用 Apple Virtualization.Framework + Rosetta，旧 qemu-x86_64 注册已停用。同一评分镜像的 uv 0.7.13 正常启动，最终 Agent 镜像通过无凭据入口加载检查。参考补丁 reward=1、空补丁 reward=0 后执行一次真实模型试跑。

| 指标                        | 上次基线         | 本次                       |
| --------------------------- | ---------------- | -------------------------- |
| 独立评分 reward             | 0                | **1**                      |
| FAIL_TO_PASS                | 1/1              | **1/1**                    |
| PASS_TO_PASS                | 41/43            | **43/43**                  |
| 结束状态 / 退出码           | completed / 0    | completed / 0              |
| Agent 进程耗时              | 1372.184 秒      | 1572.530 秒（26 分 13 秒） |
| 模型请求完成 / 发起         | 61/61            | 31/31                      |
| 工具调用 / 错误             | 68/5             | 38/3                       |
| 非缓存输入 / 缓存读取 token | 107252 / 3351936 | 123617 / 2268096           |
| 输出 / 总 token             | 63990 / 3523178  | 90848 / 2482561            |

结论：本轮题目结果改善，但耗时增加约 3 分 20 秒，不能声称速度改善或费用下降。模型请求区间并集 1554.541 秒，工具完成区间并集 11.255 秒；主要耗时在模型调用，包含生成、Provider 等待及传输。推理 token 84015 属于输出用量，不重复加总。实际费用未取得 Provider 账单，保持 unknown。

### 改善发生在哪里

最终补丁只修改 `django/db/models/deletion.py`：合并同模型的快速删除查询时，依据数据库的 `max_query_params` 校验合并后 SQL 参数数，超出时保留分批执行。上次失败的 `test_large_delete`、`test_large_delete_related` 本次均通过。没有修改工作区测试预期；独立评分补丁成功应用，无 Harbor exception。

Trace 显示 Agent 在自测出现大批量删除回归后继续修改生产逻辑；最终独立测试全部通过。这支持“本轮补丁更正确”，不支持将单次成功全部归因于新增输出能力或某一条提示。

### 通用输出能力与运行证据

- Trace complete，共 31041 个连续事件，结束于 run.completed；无未完成模型或工具调用。
- 17 份输出记录、18 个输出部分共 70506 字节，逐个验证正文长度、SHA256、observedBytes 与完整状态全部通过，最大部分 18218 字节。框架 output-summary 无失败。
- `output_read` 调用 0 次。因此本轮验证了真实执行中的保存完整性，没有覆盖模型主动回查路径，不能声称成功来自回查能力。
- 仍存在多条用 tail/head/grep 截取测试输出、未启用 pipefail 的命令；保存的是工具实际收到的输出，无法还原已经在 shell 管道前被过滤的内容。
- 3 个工具错误为 1 次缺少写入范围声明、2 次 grep 使用无效 path 字段；均返回明确错误后继续。未观察到环境或输出存储异常。
- 工具调用输入复核未观察到访问外部答案或独立评分资产的行为；这是可观察行为结论，不证明模型没有训练记忆。
- 三份正式提交收据校验通过；作答和评分容器已清理。没有在模型运行中修改产品实现、提示或评分逻辑。

### 可追溯信息

- 正式 job：`20260917T052056Z-615e4751e20a`；trial：`django__django-11885__N68nyis`。
- 模型选择沿用 glm-5.2；Trace payload 中出现 glm-5.2、glm-5.3 标识。
- Agent image：`sha256:d57b3fda416b91c2ae99ec145d99bc1ed42aacb0671228fb77416529aea6b20a`。
- Verifier image：`sha256:8413e906c53cca64ac7d8b48d06a228fe381a6f2ec3e4b827467ae6b740512ee`，与基线完全相同。
- 最终归档 545 个文件的凭据扫描通过，未发现所用 API key 原值；逐文件 SHA256 清单见产物中的 `audit.json`。
- 完整 Trace、输出正文、评分结果、提交及诊断记录见 `benchmark/artifacts/verified-medium2-output-retention-v1-2026-09-17/`，由 gitignore 排除。
- 本轮只修改验证报告和被忽略的验证产物，未修改生产代码，未重复运行与此无关的全量实现测试。模拟器环境发生变化，耗时差异与单次模型采样差异均需保留在结论边界内。

## 安装前诊断历史

以下为安装 Rosetta 前的诊断历史。阻塞已解除，最终结果见上方。

## 比较目标与固定条件

对照 `verified-medium2-foundation-2026-09-16.md`：上次 reward 0，FAIL_TO_PASS 1/1，PASS_TO_PASS 41/43，Agent 自然完成耗时 1372.184 秒。

本次沿用题目、题目说明、评分脚本与冻结评分镜像、coding prompt、依赖锁、Provider 选择 glm-5.2、单题 1800 秒、并发 1、自动重试 0。当前源码相对基线有 47 个文件变化，包含通用输出保留与回查能力。实际响应模型尚未取得。

## 已验证事实

- 原 QEMU 7.0.0 下，全新依赖安装结束时 Node/libuv 断言退出；旧基线镜像中重新安装相同依赖也复现，增量依赖检查正常。
- 安装阶段 `UV_USE_IO_URING=0` 对照无效，未保留到最终镜像。
- 临时复用相同依赖的镜像完成 725 个源码文件逐个哈希校验；参考补丁 reward 1、空补丁 reward 0，均无评分异常。
- 首次正式入口启动记录 `20260917T044604Z-bef87838bb18` 在 tsx/esbuild 加载阶段发生 Go heap fatal error，尚未进入 Agent 业务入口；Trace 列表为空。日志中的 reward 0 是启动失败后的空提交评分，不能作为模型能力分数。
- 无网络、无凭据启动复现相同 esbuild 故障。
- Ubuntu QEMU 8.2.2 仍出现启动崩溃；tonistiigi QEMU 10.2.3 下同一镜像进入正常参数校验。
- QEMU 10.2.3 下重新执行仓库标准 prepare 流程成功，全新依赖安装正常退出。最终候选镜像不使用临时依赖复用或 I/O 环境覆盖。
- 但 QEMU 10.2.3 下免费评分对照均未生成 reward：评分镜像中的 `uv --version` 已发生段错误，尚未进入评分逻辑。Python 版本检查正常。QEMU 10.1.3、9.2.2 的相同 uv 最小探针也失败。CPU 配置探针未解决。
- 无有效模型请求记录、无模型用量结果；未查询 Provider 账单，不将框架空值当作准确费用。

这组证据定位到本机跨架构执行工具链兼容性；不能据此归因于输出保留实现、LLM 做题策略或题目测试代码。Go 上游也记录过 QEMU 触发相同 Go heap 错误，但不能仅凭该记录断言所有故障共享同一根因：[Go issue 77572](https://github.com/golang/go/issues/77572)。

## 产物与环境变更

完整证据：`benchmark/artifacts/verified-medium2-output-retention-v1-2026-09-17/`，已确认 gitignore 覆盖；224 个文件扫描未发现本次 API key 明文。

最终标准构建源码 SHA256：`80a6af3504baf62a35a6daf891a377ca503697e2043e8effbd60d111922eddd0`。

- Agent image：`sha256:d57b3fda416b91c2ae99ec145d99bc1ed42aacb0671228fb77416529aea6b20a`
- Verifier image：`sha256:8413e906c53cca64ac7d8b48d06a228fe381a6f2ec3e4b827467ae6b740512ee`
- 专用 Colima profile：`omni-benchmark`，已启动。
- 专用虚拟机安装 Ubuntu `qemu-user-static`、`binfmt-support`；诊断阶段的最后一次 amd64 注册为 tonistiigi QEMU 9.2.2（镜像摘要见诊断日志），该状态尚未通过完整链路验证。虚拟机重启可能重建 binfmt 注册，不能将当前环境标为 ready。
- 本轮诊断容器已清理。未改动 Agent 或 benchmark 产品代码；临时构建及对照文件仅保留为被忽略的诊断产物。

## 当时的继续条件（现已完成）

当时已向用户请求安装 Apple Rosetta 2 并接受 Apple 软件许可的明确授权。得到授权后，在专用评测虚拟机启用 Rosetta，先验证最终镜像入口、uv、参考补丁 1 / 空补丁 0，再执行一次实际模型调用的单题验证。首个启动失败记录必须保留，不能覆盖或作为成功付费试跑统计。

最终评价需同时报告独立评分、运行结束原因、输出保存/回查完整性、模型请求及 token 用量。由于跨架构执行环境发生变化，运行耗时比较必须注明环境差异，不能将其全部归因于 Agent 优化。
