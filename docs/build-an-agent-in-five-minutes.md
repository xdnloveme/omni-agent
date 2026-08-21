# 五分钟构建一个 Agent

本教程使用可执行的 [`examples/minimal-agent`](../examples/minimal-agent) 说明 Omni Agent 的
Builder Harness。示例没有模型和凭证依赖；它会真实执行 Manifest 解析、Descriptor 验证、
Composition Planning 和 Blueprint 构建。

## 1. 运行完整装配链

在仓库根目录执行：

```bash
pnpm install
pnpm run example:minimal
```

预期输出：

```json
{
  "agentId": "minimal-example",
  "promptProfile": "minimal.default",
  "toolComponents": ["minimal.echo"],
  "exposedTools": ["echo_text"]
}
```

这条命令执行的是真实 Builder 主链：

```text
agent.yaml (Recipe)
  -> Manifest Validator
  -> Blueprint Descriptor (Parts Catalog)
  -> AgentCompositionPlanner (Planning Director)
  -> ResolvedAgentComposition (Immutable Build Plan)
  -> AgentBlueprint.build() (Concrete Builder)
  -> AgentModule
```

完整产品运行时再由 `AgentRuntimeAssembler` 事务式连接 Session、Context、Permission、Trace
等基础设施。Agent 包不需要知道这些 Host 资源如何创建。

## 2. 理解四个文件

```text
examples/minimal-agent/
├── agent.yaml
│   # 唯一 Recipe：选择 Prompt、Tool、Capability 及顺序
├── package.json
│   # Agent 包身份，并导出根模块和 ./agent.yaml
└── src/
    ├── index.ts
    │   # 唯一公共入口：agentBlueprint
    ├── blueprint.ts
    │   # 按不可变 Plan 构建 AgentModule
    ├── demo.ts
    │   # 可执行的无模型装配演示
    └── components/tool-catalog.ts
        # Tool Descriptor 与 Factory 的唯一所有者
```

边界规则：

- `agent.yaml` 只决定“选择什么、按什么顺序”，不包含实现路径和执行策略。
- Catalog 声明包能提供什么，并将 Descriptor 与 Factory 放在同一个定义中。
- Planner 校验 Recipe 引用、展开 Bundle、检查重复与依赖。
- Blueprint 只能消费 `context.composition`，不得重新读取 YAML 或补默认组件。
- Tool 自己拥有 authorization、execution 和 timeout 策略。

## 3. 修改 YAML，观察动态装配

把 `agent.yaml` 中的 Tool 序列改成空序列：

```yaml
tools:
  sequence: []
```

再次运行 `pnpm run example:minimal`，`toolComponents` 和 `exposedTools` 都会变为空数组。
恢复 `- tool: minimal.echo` 后，Tool 会重新出现。

这是“启动时动态组装、运行时 Plan 冻结”。YAML 修改在下一次启动或重建时生效，不会热修改
正在执行的 AgentInstance。

如果 YAML 引用了 Catalog 中不存在的 `minimal.unknown`，Planner 会在创建任何 Runtime 资源前
失败。它不会静默忽略，也不会回退到隐藏默认值。

## 4. 增加一个组件

增加 Tool 时只做两件事：

1. 在 `src/components/tool-catalog.ts` 增加一个 Descriptor + Factory 定义。
2. 在 `agent.yaml` 的 `tools.sequence` 中选择它。

不要在 Blueprint 中新增默认 Tool 数组，也不要在 CLI 或 App 中增加 `switch(agentId)`。
如果多个 Tool 经常作为一个有意义的能力集合出现，可以在 Blueprint Descriptor 中声明
Bundle，再由 YAML 使用 `- bundle: <component-id>` 选择。

## 5. 开发时验证

仓库内置 Agent 可以使用：

```bash
pnpm dev -- agent describe coding
pnpm dev -- agent validate coding
pnpm dev -- agent plan coding --json
```

- `describe` 查看 Blueprint 可提供的组件。
- `validate` 验证 Manifest 与 Descriptor 能否组合。
- `plan` 查看 Bundle 展开后的有效顺序。

编辑器通过 [`schemas/agent-manifest-v2.schema.json`](../schemas/agent-manifest-v2.schema.json)
提供 YAML 补全和结构诊断。Schema 是编辑器辅助合同；Runtime 的安全 Parser/Validator 仍是
执行时唯一权威。自动化测试使用相同的有效和无效样例防止二者漂移。

## 完成标准

一个 Agent Package 至少应满足：

- 包名与 Manifest ID 符合 `@omni-agent/agent-<id>` 约定。
- 根模块只导出 `agentBlueprint`，同时导出 `./agent.yaml`。
- Descriptor 与实现来自同一个 Package-private Catalog。
- YAML 是组件选择和顺序的唯一来源。
- Blueprint 只构建 Plan 选择的组件，并正确释放自己创建的领域资源。
- `agent validate`、`agent plan`、类型检查和行为测试通过。

更完整的合同、安全规则和外部安装方式见 [Agent Package](agent-package.md)。
