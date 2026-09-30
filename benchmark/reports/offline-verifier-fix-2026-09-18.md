# SWE 离线评分环境修复 — 2026-09-18

## 结论

评分环境缺失离线构建依赖的问题已修复并通过真实容器验证。没有重跑付费 Agent，没有修改已保存的补丁，也没有改变官方测试、测试预期或关闭 pip 构建隔离。

最终原补丁重评分得到有效 reward=0：FAIL_TO_PASS 为 1/2，PASS_TO_PASS 为 7/7。失败为 `test_include_source_read_event`，断言要求 literal include 不触发 source-read；补丁触发了该事件。安装错误消失，剩下的是补丁行为不符合测试预期。

## 根因与边界

此前 Dockerfile 联网跑过官方安装/评分，但 pip 的临时隔离构建依赖没有形成离线可解析的资源。只检查 Agent 解释器版本不能发现独立 verifier 的准备不足。

每道题使用上游提供的对应版本镜像和配置，自动实例化独立环境；不是每题人工写环境。默认 Verified profile 共享 Python 构建准备声明，依赖名读取各项目元数据。其他语言保持上游准备；所有 SWE 评分镜像都必须经过同一个断网正负对照。当前没有验证全部 50 题。

## 改动范围

```text
benchmark/
├── configs/default.json                       # 默认套件声明构建依赖配置
├── taskpacks/swe/
│   ├── profiles/python-build.json              # 显式的容器解释器/项目位置
│   ├── suite.py                               # 读取声明并纳入缓存输入身份
│   ├── prepare.py                             # 生成评分环境的依赖声明；CLI 同入口
│   └── verifier/
│       ├── build_dependencies.py              # 读取 build-system.requires，准备 wheel 与摘要
│       ├── Dockerfile.fragment                # 保留联网预热，新增断网发布门槛
│       └── grade.py                           # 正负对照复用现有 grade，恢复干净基线
├── tests/test_build_dependencies.py            # 元数据驱动、显式解释器及无效输入拒绝
├── tests/test_verifier.py                      # 缺失依赖、原补丁重评分及补丁摘要
└── README.md                                  # 职责、使用方法和能力边界
```

未修改公共准备器、调度器、Agent runtime、工具或 prompt。没有题号、flit_core 名称特判；没有第二套评分逻辑或联网评分回退。

```mermaid
flowchart LR
    A[上游镜像与项目元数据] --> B[声明的解释器下载构建 wheel]
    B --> C[原官方安装与评分联网预热]
    C --> D[恢复仓库基线]
    D --> E[断网运行空补丁与官方参考补丁]
    E -->|分别为 0 和 1| F[恢复基线并发布评分镜像]
    E -->|异常或结果不符| G[构建失败 阻止付费执行]
    F --> H[原评分入口评估 Agent 封存补丁]
```

构建要求没有可用 wheel、动态构建依赖或其他语言依赖未备齐时会明确失败，不声称能自动推导任意生态的全部依赖。

## 真实证据

最终准备 job：`20260918T060420Z-14b527caa277`，state=prepared。

最终 verifier 镜像：`sha256:2c01acd534c7dea1a9cba1906ff5ad5d6f4a5a4f6749f839bc8359a650f4a04a`。

- 构建过程使用 `RUN --network=none`：empty=0，gold=1。
- 元数据声明 `flit_core>=3.7`，实际下载 wheel 版本 4.1.0，并记录 SHA-256；名称不来自产品代码名单。
- 独立容器的 network_mode=none，5 项评分集成测试通过，覆盖资产损坏、缺失测试输出/准备命令失败、缺失离线 wheel、gold/empty、封存补丁。
- 原补丁 SHA-256：`2ad4f32746685fc3c378247e8facf2e89bb325af182569956ee84c37538c711f`。
- 原补丁结果：`benchmark/artifacts/offline-verifier-fix-final-2026-09-18/omni-verifier-test-33d015d8f425/report.json`。
- 构建声明与断网对照证明：同目录 `build/`。
- 36 项普通 Python 回归通过；9 项 opt-in 测试默认跳过，其中本轮相关 5 项已经单独启用并通过，其余交接/准备集成未重复运行。
- TypeScript 1,001 项通过；typecheck、格式检查及 git diff --check 通过。未更改包依赖或导出，未重跑 pnpm build；本轮真实构建对象是评分 Docker 镜像。

旧付费 job 和无效评分结论保留；本次是独立、免费重评分证据，不覆盖历史。全部原始产物留在 gitignore 范围内。
