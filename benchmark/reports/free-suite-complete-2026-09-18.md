# 固定 50 题免费环境盘点 — 2026-09-18

## 结论

固定 `swe-verified-mini-hal-50-v1` 的 50 题全部完成盘点：**46 题通过环境验证，4 题因上游测试依赖外网而阻塞**。这不是 Agent 解题成绩，也不能据此声明全量 50 题可直接运行。

本轮完成余下 35 题的正式准备调用，另对两道依赖下载失败题各显式重试一次，共 37 个 prepare job；31 题最终通过、4 题阻塞。结合此前 15 题，累计 Django 25/25、Sphinx 21/25 通过。没有付费模型请求，没有 Agent trial，不读取真实 .env；使用仅满足配置存在性检查的占位凭据。

每题沿用 `pnpm run benchmark prepare --task <id> --jobs-dir <shared-directory>`。一次性诊断脚本最多同时调用两个独立 prepare，不增加产品调度器、生产重试机制或另一条作答路径。固定题单、评分规则、网络边界、Agent 和 Provider 代码均未修改。

## 验证证据

- 通过题均具备镜像内实际离线评分证明：空补丁为 0，官方参考补丁为 1；评分使用原有官方评估入口。
- 最终汇总重新核验全部 46 份证明与 `spec-manifest.json` 的 SHA-256 一致。此前镜像已释放的两题复用已归档的原始证明，没有伪装成重新执行评分。
- 本轮成功准备包含正式挂载预检和环境健康检查；所有 37 个 job 均无 launcher.log，analysis-index.trials 为空。
- 首次失败、重试、原始构建日志、源任务配置、评分证明、不可变镜像引用和清理回执分别保留。汇总清单同时记录验证状态与本机缓存状态。
- 本次验证只覆盖这个固定 Python 题单，不能外推为任意语言、任意 Agent 或真实 Provider 并发容量已验证。

## 四道阻塞题：官方测试与离线约束冲突

| 题目                     | 日志中的失败依据                                                                                            | 官方计分归属                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| sphinx-doc__sphinx-10435 | `test_build_latex.py::test_latex_images` 下载 python.org 图片失败，缺少预期 LaTeX 图片输出；gold 对照为失败 | PASS_TO_PASS                                                             |
| sphinx-doc__sphinx-7985  | `test_build_linkcheck.py` 的 defaults、defaults_json、anchors_ignored 访问 Google、W3C、Sphinx 网站失败     | defaults、anchors_ignored 为 FAIL_TO_PASS，defaults_json 为 PASS_TO_PASS |
| sphinx-doc__sphinx-8269  | 同上三项链接检查依赖真实外网，断网触发 DNS 失败，gold 对照不通过                                            | 三项均为 PASS_TO_PASS                                                    |
| sphinx-doc__sphinx-8475  | 同上三项链接检查依赖真实外网，断网触发 DNS 失败，gold 对照不通过                                            | 三项均为 PASS_TO_PASS                                                    |

四题均在 `RUN --network=none ... validate-offline` 阶段被拒绝发布。失败发生在参考补丁对照中，尚未运行待测 Agent，因此不能归因于模型能力。`suite-inventory.json` 的 failure_evidence 保存日志路径、行号和原文，official_affected_tests 保存与官方用例清单的交集。

这是任务包的离线资源能力与上游测试契约之间的边界问题。现有构建依赖预热能缓存安装包，但不等于能重放测试运行期间的 HTTP 响应。不能通过忽略计分用例、修改 gold、放开评分网络或写入单题 URL 特例来宣称通过。

后续处理结论为 **Not ready：需要先确定离线资源契约**。若继续支持这四题，应由 SWE taskpack 明确资源来源、响应内容/状态/重定向等语义、固定版本和完整性、隔离方式及官方结果一致性，再进行实现；公共准备层和 Agent 内核不承接题目 URL 逻辑。替换固定题单会改变评测基线，也不能静默执行。遵循仓库关于外部契约阻塞时先对齐、不得直接添加兼容或绕过路径的要求，本轮只记录阻塞。

## 两道构建下载失败的显式重试

- Sphinx-8638：第一次从 files.pythonhosted.org 获取 multiprocess wheel 超时；第二次新 job 通过完整离线对照与健康检查。
- Sphinx-8721：第一次 Ubuntu 系统包下载无法连接软件源；第二次新 job 通过完整离线对照与健康检查。

这些失败属于准备阶段传输错误，不计作 Agent 失败。诊断脚本各重试一次，未给生产命令添加隐藏重试或无限重试。原始日志的 Docker 耗时与宿主 monotonic 耗时存在明显差异，因此本报告不以这两个数字推导性能结论。

## 存储与清理

- 先归档证据，再释放本轮通过题的 agent/verifier 镜像；清理前确认专用 daemon 无容器，不强制删除镜像。
- 共完成 66 次已识别准备镜像引用删除、20 次未使用构建缓存清理，回执均成功。包含两道先前已验证题（Django-11790、Sphinx-11510）的镜像释放，其原始证明保留。
- 最终按镜像摘要逐个 inspect 确认：13 题保留完整镜像对，另外 33 道已验证题需要按需重建。Docker image ls 默认清单不足以判断引用可用性，最终状态以 inspect 为准。
- 最终 Docker 可用 16,117,370,880 字节，约 15.01 GiB；无活动或停止容器。该容量不代表足以同时缓存或运行全部 50 题。
- 镜像缺失仍由既有正式 prepare 逻辑重建，旧 receipt 不伪造、不改写。没有新增淘汰服务，日志、源任务、官方配置和证明均保留。

## 全量清单

“通过”表示已具备离线评分对照和就绪证据；“重建”表示镜像已释放。四道阻塞题没有有效的完整就绪证明。

| 题目                     | 环境结论           | 本机完整镜像对 |
| ------------------------ | ------------------ | -------------- |
| django__django-11790     | 通过               | 需重建         |
| django__django-11815     | 通过               | 保留           |
| django__django-11848     | 通过               | 保留           |
| django__django-11880     | 通过               | 保留           |
| django__django-11885     | 通过               | 保留           |
| django__django-11951     | 通过               | 保留           |
| django__django-11964     | 通过               | 保留           |
| django__django-11999     | 通过               | 保留           |
| django__django-12039     | 通过               | 保留           |
| django__django-12050     | 通过               | 保留           |
| django__django-12143     | 通过               | 保留           |
| django__django-12155     | 通过               | 保留           |
| django__django-12193     | 通过               | 保留           |
| django__django-12209     | 通过               | 需重建         |
| django__django-12262     | 通过               | 需重建         |
| django__django-12273     | 通过               | 需重建         |
| django__django-12276     | 通过               | 需重建         |
| django__django-12304     | 通过               | 需重建         |
| django__django-12308     | 通过               | 需重建         |
| django__django-12325     | 通过               | 需重建         |
| django__django-12406     | 通过               | 需重建         |
| django__django-12708     | 通过               | 需重建         |
| django__django-12713     | 通过               | 需重建         |
| django__django-12774     | 通过               | 需重建         |
| django__django-9296      | 通过               | 需重建         |
| sphinx-doc__sphinx-10323 | 通过               | 保留           |
| sphinx-doc__sphinx-10435 | 阻塞：测试依赖外网 | —              |
| sphinx-doc__sphinx-10466 | 通过               | 需重建         |
| sphinx-doc__sphinx-10673 | 通过               | 需重建         |
| sphinx-doc__sphinx-11510 | 通过               | 需重建         |
| sphinx-doc__sphinx-7590  | 通过               | 需重建         |
| sphinx-doc__sphinx-7748  | 通过               | 需重建         |
| sphinx-doc__sphinx-7757  | 通过               | 需重建         |
| sphinx-doc__sphinx-7985  | 阻塞：测试依赖外网 | —              |
| sphinx-doc__sphinx-8035  | 通过               | 需重建         |
| sphinx-doc__sphinx-8056  | 通过               | 需重建         |
| sphinx-doc__sphinx-8265  | 通过               | 需重建         |
| sphinx-doc__sphinx-8269  | 阻塞：测试依赖外网 | —              |
| sphinx-doc__sphinx-8475  | 阻塞：测试依赖外网 | —              |
| sphinx-doc__sphinx-8548  | 通过               | 需重建         |
| sphinx-doc__sphinx-8551  | 通过               | 需重建         |
| sphinx-doc__sphinx-8638  | 通过               | 需重建         |
| sphinx-doc__sphinx-8721  | 通过               | 需重建         |
| sphinx-doc__sphinx-9229  | 通过               | 需重建         |
| sphinx-doc__sphinx-9230  | 通过               | 需重建         |
| sphinx-doc__sphinx-9281  | 通过               | 需重建         |
| sphinx-doc__sphinx-9320  | 通过               | 需重建         |
| sphinx-doc__sphinx-9367  | 通过               | 需重建         |
| sphinx-doc__sphinx-9461  | 通过               | 需重建         |
| sphinx-doc__sphinx-9698  | 通过               | 需重建         |

## 归档和变更范围

完整证据位于 `benchmark/artifacts/free-suite-complete-2026-09-18/`，由 gitignore 排除：

- `suite-inventory.json`：50 题结论、证明来源、官方失败用例、缓存状态。
- `final-audit.json`：数量、无模型调用/无 Agent trial、容器残留与最终容量。
- `summary.json`：本轮 37 次准备尝试及显式重试关系。
- `cleanup.json`：镜像引用删除与缓存清理回执。
- `<task>/attempt-*`、`proof-*`、`prior-proofs/`：原始 job、失败现场与评分证明。
- 一次性诊断脚本：只用于复核本次证据，不作为正式产品入口。

本次落盘变更仅新增本报告并更新原有 `docs/plans/benchmark-integration-v1.md` 当前状态；不修改生产代码、测试、配置或题单。检查文档格式、git diff --check 与证据 gitignore；不重复运行与文档无关的 TypeScript/Python 全量测试。本轮行为验证来自上述实际容器准备与评分对照。

后续仍可使用正式 benchmark 命令选择已验证题目；执行前应检查空间并允许缺失镜像重建。四道阻塞题解决前，不应启动全量 50 题付费运行，默认准备会在失败题处终止，也不能把未准备题计为成绩 0。
