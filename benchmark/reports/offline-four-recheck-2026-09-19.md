# 四道外网依赖题复核 — 2026-09-19

本轮免费验证完成：4 道题的 10 个相关官方用例，在应用官方参考补丁与测试补丁后，仍全部失败。使用各题已有上游 Linux amd64 镜像，容器明确 `--network none`，实际网络接口仅有 lo。没有模型调用，没有修改官方测试、生产实现或题单。

| 题目                     | 相关官方用例                                              | 复验     |
| ------------------------ | --------------------------------------------------------- | -------- |
| sphinx-doc__sphinx-10435 | test_latex_images                                         | 1 failed |
| sphinx-doc__sphinx-7985  | test_defaults / test_defaults_json / test_anchors_ignored | 3 failed |
| sphinx-doc__sphinx-8269  | 同上                                                      | 3 failed |
| sphinx-doc__sphinx-8475  | 同上                                                      | 3 failed |

这是聚焦诊断，通过 pytest 直接执行相关用例，不是重新运行正式 prepare、全量官方评分或 Agent 解题，不能计作新的 benchmark 成绩。补丁应用失败会立即退出；本轮全部进入 pytest 并复现预期网络相关断言失败。历史正式 prepare 的 gold 对照失败证据见前一份全量盘点报告。

## 根因和准备阶段预热的局限

- 10435：`sphinx/transforms/post_transforms/images.py` 第 68–73 行，即使目标图片存在，也只是添加 If-Modified-Since，随后仍无条件 requests.get。请求失败后不会进入图片节点改写流程。故仅预存图片不足以让此测试离线运行。
- 7985：`sphinx/builders/linkcheck.py` 中 working/broken/redirected 是当前 Builder 的内存状态，首次检查仍调用 requests.get/head。相关测试使用 freshenv=True，并对网页锚点、404 错误文本及结果条数作断言。8269、8475 本轮同样在这三项失败。
- 问题属于 taskpack 测试资源契约，不属于 Agent 或模型能力，也不是模型通道隔离失效。

## 后续边界

单纯依赖包预热不能解决。若保留这四题且评分断网，需要正式设计受控的离线响应重放：资源来源和版本可追踪、请求方法/状态/重定向/正文语义保真、未知请求明确失败、资源与评分资产只在 verifier 内使用；不能从期待断言反推并伪造响应。

此方案目前为 Not ready：尚无可证明与官方语义等价的响应资产与重放契约。未添加 HTTP monkey patch、代理兼容层、单题 URL 特例或跳过用例，也未放开评分网络。网络重放涉及外部契约变更，需先对齐具体方案后实现。

固定题单仍保持此前的 46 题已验证、4 题阻塞；46 题是历史环境证明，不代表新隔离通道下重新完成全量验收。

## 证据

`benchmark/artifacts/offline-four-2026-09-19/` 保留诊断脚本、每题原始 pytest 输出、官方补丁、容器内源码快照、结果及清理审计。目录被 gitignore 排除。4 个诊断容器均已删除。此次只新增报告及忽略的诊断证据，不涉及生产代码，未重复运行无关 TS 全量测试。
