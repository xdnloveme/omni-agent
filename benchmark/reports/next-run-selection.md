# 下一次单题运行选择

记录日期：2026-09-18。

- 题集：`swe-verified-mini-hal-50-v1`。
- 题目：`sphinx-doc__sphinx-11510`。
- 题面标题：source-read event does not modify include'd files source。
- 清单难度：1–4 hours（上游人工标签，不是 Agent 耗时预测）。
- 选择理由：固定 50 题中的未运行题，考察文件包含、源码读取和事件处理的跨模块理解；与此前中等偏难题同档，不作为严格等难度对照。
- 当前状态：用户后续授权的一次付费运行已完成，reward=0，Agent 自然完成；目标测试 1/2、回归 7/7 通过。详见 [本次报告](verified-11510-2026-09-18.md)。
- 后续：本题不自动重跑。先依据已保留 Trace 分析；通用准备器的离线构建依赖缺口另行收敛。

题目身份、版本、哈希和镜像映射以 [manifest.json](../suites/swe-verified-mini-hal-50-v1/manifest.json) 为唯一来源，不在本文维护第二套配置。不要将参考补丁、评分测试或分析结论注入 Agent 作答上下文。

## 2026-09-29 后续单题

本次选 sphinx-doc__sphinx-9229，与 9461 同为上游 1–4 hours 档。已通过正式 pnpm benchmark 入口完成一次付费作答，reward=0，目标 0/1、回归 13/13，自然完成；运行与错误分析见 [9229 报告](verified-9229-2026-09-29.md)。没有自动安排下一次重跑。

## 2026-10-02 后续单题

本次选择 sphinx-doc__sphinx-8035，固定题集内无已知付费作答记录。已有 1–4 hours 档均已运行，改选同为 autodoc 的 15 min–1 hour 档，明确不是等难度对照。一次正式运行已完成：reward=1，目标 1/1、回归 2/2，自然完成；见 [8035 报告](verified-8035-2026-10-02.md)。不自动重跑。
