# 三题免费环境预检 — 2026-09-18

## 结果

三题均通过，未调用模型，无付费 Agent run。第二轮全命中缓存且无重新打包；没有修改产品代码、题库或为单题增加例外。

固定 50 题清单实际只涵盖 Django 与 Sphinx 两个仓库，因此本次选择 3 题覆盖 2 个仓库，而不是原先建议的 3 个仓库。此验证不能外推到其他仓库、其他语言或全部 50 题。

| 题目                     | 任务 Python                     | 断网空补丁 | 断网参考补丁 | 第二轮缓存 |
| ------------------------ | ------------------------------- | ---------- | ------------ | ---------- |
| django__django-11790     | Python 3.6.13 :: Anaconda, Inc. | 0          | 1            | 命中       |
| sphinx-doc__sphinx-10323 | Python 3.9.20                   | 0          | 1            | 命中       |
| sphinx-doc__sphinx-11510 | Python 3.9.20                   | 0          | 1            | 命中       |

## 执行

两次使用同一正式入口：

```bash
pnpm run benchmark prepare \
  --task django__django-11790 \
  --task sphinx-doc__sphinx-10323 \
  --task sphinx-doc__sphinx-11510 \
  --jobs-dir /private/tmp/omni-benchmark-p0/three-task-preflight
```

使用占位凭据满足 prepare 的存在性校验，不加载真实 API key，不执行 run 命令。Docker 连接及共享目录由本机环境参数指定，没有写进产品代码。

- 首轮 job：20260918T061116Z-c87499366f90，520.543 秒；Django-11790、Sphinx-10323 新建并执行断网对照，Sphinx-11510 命中此前已验证镜像。
- 第二轮 job：20260918T062021Z-0e596f320547，14.838 秒；三题全部 cache_hit=true，缓存键与首轮相同。
- 两次 invocation.state=prepared，analysis-index.trials=[]，没有 launcher.log 或 Agent 作答。
- 所有缓存命中项的 prepare.log 为 0 字节；每题仍执行 Harbor 环境健康检查，探针 status=verified；最终日志挂载预检通过。
- 从三题不可变 verifier 镜像提取 offline-validation.json，核对其 spec_manifest_sha256 与 spec-manifest.json 字节摘要一致；均为 empty=0、gold=1。
- 缓存命中复用已验证镜像，不重新执行金标/空补丁；本次未把缓存复用误称为第二轮重新评分。
- 检查结束后，benchmark-readiness、benchmark-mount-check、benchmark-preflight-evidence 容器均无残留。

## 证据

全部原始证据归档于 `benchmark/artifacts/three-task-preflight-2026-09-18/`，被 gitignore 排除：两个完整 job、两次命令日志，以及 `images/<task-id>/` 下的评分证明、依赖声明和上游评分规范摘要。

本轮只验证环境及缓存，不产生 Agent 能力成绩。不重跑无关全量单元测试；没有生产代码改动，文档执行格式检查与 git diff --check。
