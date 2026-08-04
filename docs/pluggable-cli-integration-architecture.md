# 可插拔外部 CLI 集成架构设计

> 状态：RFC (Request for Comments)
> 适用范围：omni-agent monorepo
> 目标：设计一套通用、可扩展的外部 CLI 工具集成架构

---

## 目录

1. [业界解法调研对比](#1-业界解法调研对比)
2. [关键决策点分析](#2-关键决策点分析)
3. [推荐架构分层设计](#3-推荐架构分层设计)
4. [与现有代码的衔接](#4-与现有代码的衔接)
5. [扩展示例（设计走查）](#5-扩展示例设计走查)
6. [未解决问题 / 待确认项](#6-未解决问题--待确认项)
7. [附录：长任务异步 + 事件回灌主循环 —— mini-agent sidecar 模式参考](#7-附录长任务异步--事件回灌主循环--mini-agent-sidecar-模式参考)

---

## 1. 业界解法调研对比

### 1.1 MCP (Model Context Protocol) — Anthropic

**机制**：基于 JSON-RPC 2.0 的 client-server 协议。Host（LLM 应用）通过 Client 与 Server 建立有状态会话。Server 暴露 tools、resources、prompts 三种能力。工具通过 `tools/list` 发现、`tools/call` 调用。支持 stdio（本地子进程）和 HTTP/SSE（远程）两种传输方式。

```
Host (LLM App) ──► Client ──► Server (Tool Provider)
                              ├── tools/list → 工具发现
                              ├── tools/call → 工具调用
                              └── resources/read → 资源读取
```

**优点**：
- 已成为行业标准，OpenAI、Google DeepMind、Anthropic 均采用
- 传输无关（stdio/HTTP），支持本地和远程
- 有状态会话支持进度追踪、取消、错误上报
- 工具可动态注册/注销
- 丰富的社区生态（GitHub server、filesystem server 等开箱即用）

**缺点**：
- 每个集成需独立 server 进程，简单 CLI 包装存在过度开销
- 输出只定义输入 schema，无输出 schema 标准化
- 有状态会话增加复杂度
- 凭证管理留给各 server 自行实现，无统一标准
- 协议仍在快速演进（最新 spec 2025-06-18）

**对我们的借鉴**：
- `inputSchema` 格式（JSON Schema）直接可复用
- stdio 传输模式适合本地 CLI 包装
- 工具发现机制（`tools/list`）可借鉴做插件注册
- 未来可提供 MCP adapter 让外部 client 使用我们的工具

---

### 1.2 oclif 插件系统 (Salesforce)

**机制**：Node.js CLI 框架，插件以 npm 包分发。命令通过文件系统约定（`src/commands/` 目录）或 `package.json` 声明发现。支持运行时安装（`mycli plugins:install`），使用 `oclif.manifest.json` 缓存命令元数据加速加载。提供生命周期 hooks（`init`、`prerun`、`postrun`）。

```typescript
// oclif 命令定义示例
export default class CreateIssue extends Command {
  static description = 'Create a GitHub issue'
  static flags = {
    title: Flags.string({ char: 't', required: true }),
    repo: Flags.string({ char: 'r', default: '.' }),
  }
  async run() { /* ... */ }
}
```

**优点**：
- 大规模验证（Salesforce CLI 50+ 插件）
- TypeScript 原生，flags/args 强类型
- npm 分发，运行时安装无需重建
- Manifest 缓存加速加载
- Hooks 机制支持横切关注点

**缺点**：
- 设计为「构建 CLI」而非「包装现有 CLI」
- 插件接口基于类继承，非声明式
- 无「为 LLM 消费的 tool schema」概念
- 加载多个插件有启动延迟

**对我们的借鉴**：
- npm 包分发 + manifest 缓存的发现模式
- Hooks 生命周期（pre-execute/post-execute）
- 运行时安装能力的 UX 设计
- flags 的类型定义模式

---

### 1.3 VSCode Extension API

**机制**：双层注册——声明式 `package.json` contribution points（命令、配置、菜单等）+ 命令式 `registerCommand` handler。Extensions 通过 activation events 懒加载。Configuration 使用 JSON Schema 定义设置项。内建 SecretStorage API 管理凭证。

```jsonc
// 声明层 (package.json)
{
  "contributes": {
    "commands": [{ "command": "gh.createIssue", "title": "Create Issue" }],
    "configuration": {
      "properties": {
        "gh.token": { "type": "string", "scope": "machine" }
      }
    }
  },
  "activationEvents": ["onCommand:gh.createIssue"]
}
```

**优点**：
- 元数据（声明式）与行为（命令式）优雅分离
- 懒激活最小化资源占用
- JSON Schema 驱动的配置，IDE 自动补全
- 内建 SecretStorage 解决凭证安全问题
- 海量生态证明模式可扩展

**缺点**：
- 与 VSCode 运行时紧耦合
- Extension Host 进程模型增加复杂度
- 无「输出解析」标准
- 面向 UI 交互，非 headless agent 执行

**对我们的借鉴**：
- **声明式 manifest + 命令式 handler** 的分层模式（核心借鉴）
- Activation events / 懒加载策略
- Configuration 的 JSON Schema 声明
- SecretStorage 接口抽象

---

### 1.4 Backstage Plugin (Spotify/CNCF)

**机制**：一切皆插件，前后端独立。Backend 插件通过 `createBackendPlugin` 创建，声明服务依赖（logger、httpRouter 等），运行时注入。Extension points 允许模块扩展已有插件。插件间完全隔离，仅通过网络通信。

**优点**：
- 插件完全隔离（无共享状态）
- Extension points 允许深度定制
- 服务注入模式干净、可测试
- 经大规模验证

**缺点**：
- 极重量级（完整 React + Express 应用）
- 面向开发者门户，非 agent 工具系统
- 插件创建样板代码多
- 不适用于 CLI 包装场景

**对我们的借鉴**：
- Extension point + module 的扩展模式概念
- 服务注入模式（声明依赖，运行时提供）
- 插件间隔离的安全边界思路

---

### 1.5 LangChain / OpenAI Function Calling

**机制**：

**LangChain**：通过 `@tool` 装饰器或 `BaseTool` 子类定义工具。从函数签名/类型注解自动推断 JSON Schema。执行函数返回字符串或结构化结果。

**OpenAI Function Calling**：工具定义为 JSON Schema 对象，随 API 请求发送。模型返回 `tool_calls`（函数名 + 参数），应用侧执行并返回结果。纯 schema 契约，执行完全由应用控制。

```json
{
  "type": "function",
  "function": {
    "name": "create_issue",
    "description": "Create a GitHub issue",
    "parameters": {
      "type": "object",
      "properties": {
        "title": { "type": "string" },
        "repo": { "type": "string" }
      },
      "required": ["title", "repo"]
    }
  }
}
```

**优点**：
- JSON Schema 作为通用工具定义格式已成为事实标准
- 类型推断消除 schema 重复定义
- 语言无关（任何能生成 JSON Schema 的语言均可）
- 与 LLM 交互模式天然契合

**缺点**：
- 无内建 CLI 包装模式（需手写 subprocess 代码）
- LangChain 绑定 Python 生态
- 无输出解析/验证标准
- 无认证/凭证管理机制

**对我们的借鉴**：
- JSON Schema 作为 inputSchema 的标准格式（已采用）
- 从 TypeScript 类型自动生成 schema 的模式
- 工具定义与执行分离的契约思路

---

### 1.6 声明式命令定义 (go-go-golems/glazed, Pydantic AI)

**机制**：使用 YAML/JSON 声明式定义工具，包含 typed args、命令模板（插值语法）、输出解析规则。工具运行时从声明文件自动生成可执行实例。

```yaml
# go-go-golems/glazed 风格
name: gh-issue-create
description: Create a GitHub issue
flags:
  - name: title
    type: string
    required: true
  - name: body
    type: string
  - name: labels
    type: stringList
command: ["gh", "issue", "create", "--title", "{{title}}"]
conditionalFlags:
  body: ["--body", "{{body}}"]
  labels: ["--label", "{{labels|join:,}}"]
output:
  format: text
  extract: "url:regex:^(https://github.com/\\S+)"
```

**优点**：
- 非开发者可定义工具（运维、Prompt 工程师）
- 版本可控、可 diff、可 review
- 语言无关
- 从 CLI `--help` 可半自动生成
- 「做什么」与「怎么运行」分离
- 目录扫描即可发现新工具

**缺点**：
- 复杂逻辑（条件分支、重试、多步骤）表达力有限
- 模板插值遇 shell 转义容易出错
- regex/JSONPath 解析在输出格式变化时脆弱
- 无统一标准格式
- 调试不如命令式代码直观

**对我们的借鉴**：
- **最直接适用的模式**——声明式定义 CLI 包装
- typed args → CLI flags 映射机制
- 命令模板 + 条件参数拼装
- 输出解析规则（json/regex/text）
- 目录自动发现机制

---

### 1.7 凭证/认证管理模式

**业界常见方案**：

| 方案 | 机制 | 安全性 | 便利性 | 跨平台 |
|------|------|--------|--------|--------|
| OS Keychain | macOS Keychain / Linux gnome-keyring / Windows Credential Manager | 高 | 中 | 需适配 |
| 环境变量 | `GITHUB_TOKEN` 等 | 低 | 高 | 好 |
| 配置文件 | `~/.config/tool/credentials.yml` | 低 | 高 | 好 |
| OAuth Flow | 浏览器授权 → 本地 callback → token 存储 | 高 | 低 | 好 |
| Git Credential Helper | stdin/stdout 协议 | 中 | 中 | 好 |
| 加密配置 | Electron safeStorage / age 加密 | 高 | 中 | 需适配 |

**最佳实践（分层降级）**：
1. 优先读环境变量（CI/CD 友好）
2. 其次读 OS Keychain（交互式开发安全）
3. 最后检查工具原生凭证（如 `gh auth status`）
4. 未认证时引导用户完成认证流程

**对我们的借鉴**：
- 分层降级策略（env → keychain → native → prompt）
- 每个集成声明所需凭证类型
- 凭证存储抽象接口，实现可替换
- 项目已依赖 `keytar`（OS Keychain 库），可直接复用

---

### 调研总结对比

| 维度 | MCP | oclif | VSCode | Backstage | LangChain | 声明式 | 凭证管理 |
|------|-----|-------|--------|-----------|-----------|--------|----------|
| 适用于 CLI 包装 | ★★★ | ★★ | ★★ | ★ | ★★ | ★★★★ | ★★★★ |
| 实现复杂度 | 高 | 中 | 高 | 极高 | 低 | 低-中 | 中 |
| 可扩展性 | 高 | 高 | 高 | 高 | 中 | 高 | 中 |
| 与现有架构契合度 | 中 | 中 | 中 | 低 | 高 | 高 | 高 |
| 社区/标准化程度 | 高 | 中 | 高 | 中 | 高 | 低 | — |

**结论**：推荐以「声明式命令定义」为核心，融合 MCP 的 schema 标准、oclif 的发现/加载模式、VSCode 的 manifest 分层，搭配分层凭证管理。

---

## 2. 关键决策点分析

### 2.1 Tool 粒度：每操作一个 tool vs 单 tool + action 参数

**方案 A：每操作一个 tool**
```
gh_issue_list, gh_issue_create, gh_pr_list, gh_pr_create, gh_pr_merge ...
```

**方案 B：单 tool + action 参数**
```
github(action: "issue_list", params: {...})
github(action: "pr_create", params: {...})
```

| 维度 | 方案 A (细粒度) | 方案 B (粗粒度) |
|------|----------------|----------------|
| LLM 选择精度 | 高——tool 名直接语义化 | 低——需理解 action 枚举 |
| Schema 简洁性 | 每个 tool schema 小而专注 | 单 schema 需 union type 或 anyOf |
| tool 数量膨胀 | 可能 50+ tools 占用 context | 少数 tools 但 schema 复杂 |
| 可组合性 | 好——agent 自由组合 | 差——需理解内部路由 |
| 错误提示 | 精确——「issue_create 缺少 title」 | 模糊——需额外上下文 |

**推荐：方案 A（细粒度），配合命名空间约定和懒加载**

理由：
1. LLM 在 tool selection 阶段的准确率高度依赖 tool name 的语义清晰度
2. 每个 tool 的 schema 简洁，参数验证精确，错误信息直观
3. 通过命名空间前缀（`gh_issue_list`）保持逻辑分组
4. 通过配置控制哪些 tool 激活，避免 context window 膨胀
5. 与现有 `AgentTool` 接口完全兼容，无需修改

缓解 tool 数量问题的策略：
- 按需激活：用户配置启用哪些集成，只加载对应 tools
- 分组注册：每个集成定义一组 tools，整组启用/禁用
- 描述精炼：优化 description 减少 token 占用

---

### 2.2 认证管理放在哪一层、如何隔离不同集成的凭证

**架构决策**：认证管理作为**独立的横切层**，位于「集成能力层」中，通过 `CredentialProvider` 接口抽象。

```
┌─────────────────────────────────────────┐
│           Tool 生成器 / 执行器            │
│  ┌────────────────────────────────────┐  │
│  │      CredentialProvider 接口        │  │
│  └────────┬───────────┬──────────────┘  │
│           │           │                  │
│     ┌─────▼───┐ ┌────▼────┐ ┌────────┐ │
│     │ EnvVar  │ │Keychain │ │ Native │ │
│     │Provider │ │Provider │ │  Auth  │ │
│     └─────────┘ └─────────┘ └────────┘ │
└─────────────────────────────────────────┘
```

**凭证隔离策略**：
- 每个集成声明自己的 credential scope（如 `github`、`feishu`）
- CredentialProvider 按 scope 隔离存取
- 集成 A 无法访问集成 B 的凭证
- 凭证查找链路：env → keychain → native tool auth → 引导用户认证

**推荐理由**：
1. 项目已依赖 `keytar`，可直接用于 OS Keychain 操作
2. 独立层允许统一测试凭证流程（mock CredentialProvider）
3. 声明式凭证需求让集成定义自文档化
4. 分层降级兼顾 CI/CD（env）和交互开发（keychain）

---

### 2.3 输出解析如何做到结构化又灵活

**推荐：可组合的 OutputParser 策略模式**

```
OutputParser
├── JsonOutputParser      — 直接 JSON.parse，可选 JSONPath 提取
├── RegexOutputParser     — 正则匹配 + 命名捕获组
├── LineOutputParser      — 按行分割，配合过滤/映射
├── TemplateOutputParser  — 基于输出模板解析（表格、key:value）
└── PassthroughParser     — 原样返回文本（兜底）
```

**设计原则**：
1. **默认宽松**：未指定解析器时，使用 Passthrough 返回原始文本——LLM 自身有理解能力
2. **渐进结构化**：从 Passthrough 开始，按需升级到 JSON/Regex 解析
3. **可组合**：支持管道式组合（先 regex 提取，再 json parse）
4. **容错**：解析失败时降级到原始文本，附加解析错误说明，不硬报错

**示例**：
```yaml
output:
  # gh issue list --json 输出
  parser: json
  extract: "$[*].{number, title, state, url}"

output:
  # gh issue create 文本输出
  parser: regex
  pattern: "^(?<url>https://github.com/\\S+)"

output:
  # 复杂场景：先提取 JSON 块，再解析
  pipeline:
    - parser: regex
      pattern: "```json\\n(?<json>[\\s\\S]*?)\\n```"
    - parser: json
      extract: "$.result"
```

**推荐理由**：
1. 许多 CLI 支持 `--json` 输出（gh、jq 等），JSON 解析覆盖最常见场景
2. Regex 覆盖文本输出中提取关键信息的场景
3. Passthrough 兜底让系统永远不因解析失败而阻塞
4. 管道组合保证灵活性不牺牲结构化
5. LLM 本身善于理解非结构化文本，过度解析反而有害

---

### 2.4 MCP 协议复用 vs 自研轻量插件层

**对比**：

| 维度 | 复用 MCP | 自研轻量层 | 混合方案 |
|------|----------|------------|----------|
| 实现成本 | 中-高（需实现 client/server） | 低 | 低-中 |
| 生态复用 | 高——可直接用社区 MCP servers | 无 | 部分 |
| 架构复杂度 | 高——多进程通信 | 低——同进程 | 中 |
| 性能 | IPC 开销 | 无额外开销 | 视具体场景 |
| 灵活性 | 受协议约束 | 完全自主 | 最灵活 |
| 未来扩展 | 可与任何 MCP client 互操作 | 封闭 | 可选互操作 |

**推荐：自研轻量插件层 + 可选 MCP 适配器（混合方案）**

理由：
1. **当前阶段**：omni-agent 是本地 CLI 工具，不需要远程 tool serving，多进程通信是过度工程
2. **核心需求**：把 CLI 命令包装成 `AgentTool`，同进程执行即可
3. **未来兼容**：设计时遵循 MCP 的 schema 规范（JSON Schema for inputSchema），未来写一层薄 adapter 即可暴露为 MCP server
4. **性能优势**：同进程加载，零 IPC 开销，工具调用延迟 = CLI 执行时间
5. **已有生态**：`keytar` 已在依赖中，无需额外基础设施

具体做法：
- 内部插件层用 TypeScript 同进程加载
- 插件定义遵循 MCP tool schema 格式（name/description/inputSchema）
- 预留 `packages/mcp-adapter` 位置，未来可导出为 MCP server
- 对于已有成熟 MCP server 的工具，提供 MCP client 直接桥接的能力

---

## 3. 推荐架构分层设计

### 3.1 架构总览

```mermaid
graph TB
    subgraph "Agent Loop (现有)"
        AL[Agent Loop] --> |"调用"| AT[AgentTool[]]
    end

    subgraph "Tool 生成器层"
        TF[ToolFactory] --> |"生成"| AT
        TF --> |"读取"| CD
        TF --> |"注入"| CA
    end

    subgraph "命令定义层"
        CD[CLIIntegrationDef[]] --> |"定义"| CMD[命令模板]
        CD --> |"定义"| SCH[输入 Schema]
        CD --> |"定义"| OP[输出解析规则]
        CD --> |"声明"| AUTH[认证需求]
    end

    subgraph "集成能力层"
        CA[CredentialProvider] --> ENV[EnvProvider]
        CA --> KC[KeychainProvider]
        CA --> NA[NativeAuthProvider]
        HC[HealthChecker] --> |"检查"| BIN[CLI Binary]
        CFG[IntegrationConfig] --> |"管理"| SET[用户设置]
    end

    subgraph "扩展机制"
        REG[IntegrationRegistry] --> |"发现"| FS[文件系统扫描]
        REG --> |"加载"| NPM[npm 包]
        REG --> |"注册"| TF
    end
```

### 3.2 集成能力层 (Integration Capability Layer)

**职责**：管理认证、配置、工具可用性检测。

#### CredentialProvider 接口

```typescript
interface CredentialProvider {
  /** 获取指定集成的凭证 */
  resolve(scope: string): Promise<Credential | null>;
  /** 存储凭证 */
  store(scope: string, credential: Credential): Promise<void>;
  /** 清除凭证 */
  clear(scope: string): Promise<void>;
  /** 检查凭证是否可用 */
  check(scope: string): Promise<boolean>;
}

interface Credential {
  type: 'token' | 'oauth' | 'basic' | 'custom';
  value: Record<string, string>;  // 如 { token: "ghp_xxx" } 或 { client_id, client_secret }
  expiresAt?: number;
}
```

#### 分层凭证解析链

```typescript
// 凭证解析顺序
class ChainedCredentialProvider implements CredentialProvider {
  private providers: CredentialProvider[];
  // providers = [EnvCredentialProvider, KeychainCredentialProvider, NativeToolCredentialProvider]

  async resolve(scope: string): Promise<Credential | null> {
    for (const provider of this.providers) {
      const cred = await provider.resolve(scope);
      if (cred) return cred;
    }
    return null;
  }
}
```

#### HealthChecker

```typescript
interface HealthCheck {
  /** CLI 二进制是否存在 */
  binary: string;
  /** 版本检查命令 */
  versionCommand?: string;
  /** 最低版本要求 */
  minVersion?: string;
  /** 认证状态检查命令 */
  authCheckCommand?: string;
}
```

#### IntegrationConfig

每个集成的配置项（用户可覆盖）：

```typescript
interface IntegrationConfig {
  /** 集成 ID */
  id: string;
  /** 是否启用 */
  enabled: boolean;
  /** 自定义环境变量覆盖 */
  env?: Record<string, string>;
  /** 额外的 CLI flags（全局追加） */
  globalFlags?: string[];
}
```

---

### 3.3 命令定义层 (Command Definition Layer)

**职责**：声明式定义单个 CLI 操作的完整规范。

#### CLIIntegrationDefinition（集成级别）

```typescript
interface CLIIntegrationDefinition {
  /** 集成唯一 ID，作为 tool 名前缀 */
  id: string;                    // e.g. "gh"
  /** 集成显示名 */
  displayName: string;           // e.g. "GitHub CLI"
  /** CLI 二进制名 */
  binary: string;                // e.g. "gh"
  /** 健康检查配置 */
  health: HealthCheck;
  /** 认证配置 */
  auth: AuthDefinition;
  /** 该集成下的所有命令定义 */
  commands: CLICommandDefinition[];
}
```

#### CLICommandDefinition（命令级别 = 对应一个 AgentTool）

```typescript
interface CLICommandDefinition {
  /** 命令名（与集成 id 组合成 tool name：`${integrationId}_${name}`） */
  name: string;                  // e.g. "issue_create"
  /** tool description（给 LLM 看） */
  description: string;
  /** 输入参数 schema (JSON Schema) */
  inputSchema: JSONSchema;
  /** 命令构建规则 */
  command: CommandTemplate;
  /** 输出解析规则 */
  output: OutputDefinition;
  /** 命令级认证覆盖（可选） */
  authOverride?: AuthDefinition;
  /** 超时（ms） */
  timeout?: number;
  /** 是否确认执行（危险操作） */
  requireConfirmation?: boolean;
}
```

#### CommandTemplate（命令模板）

```typescript
interface CommandTemplate {
  /** 固定子命令部分 */
  subcommands: string[];         // e.g. ["issue", "create"]
  /** 参数到 CLI flags 的映射 */
  args: ArgMapping[];
  /** 全局追加的 flags */
  globalFlags?: string[];
  /** 工作目录（可选） */
  cwd?: string;
  /** 环境变量注入（可选） */
  env?: Record<string, string>;
  /** 标准输入内容（可选，来自参数） */
  stdin?: string;
}

interface ArgMapping {
  /** 对应 inputSchema 中的参数名 */
  param: string;
  /** CLI flag 名 */
  flag: string;                  // e.g. "--title"
  /** 映射类型 */
  type: 'flag-value'             // --title "xxx"
      | 'flag-repeated'          // --label a --label b (数组)
      | 'flag-boolean'           // --draft (布尔)
      | 'flag-json'              // --json (值为 JSON 序列化)
      | 'positional';            // 无 flag，位置参数
  /** 参数缺失时是否省略整个 flag */
  omitIfEmpty?: boolean;         // default: true
  /** 值转换（可选） */
  transform?: 'join-comma' | 'json-stringify' | 'quote';
}
```

#### OutputDefinition（输出解析规则）

```typescript
interface OutputDefinition {
  /** 期望输出格式 */
  format: 'json' | 'text' | 'lines' | 'silent';
  /** 解析管道 */
  parsers?: OutputParser[];
  /** 成功判定（默认 exitCode === 0） */
  successCondition?: {
    exitCode?: number;
    outputContains?: string;
  };
  /** 追加到命令的格式化 flag（如 --json） */
  formatFlag?: string;
  /** JSON 输出时指定 fields（如 gh --json number,title） */
  jsonFields?: string[];
}

type OutputParser =
  | { type: 'json'; extract?: string }           // JSONPath 提取
  | { type: 'regex'; pattern: string; groups?: string[] }
  | { type: 'lines'; filter?: string; map?: string }
  | { type: 'passthrough' };
```

#### AuthDefinition

```typescript
interface AuthDefinition {
  /** 凭证 scope（对应 CredentialProvider 的 key） */
  scope: string;                 // e.g. "github"
  /** 凭证类型 */
  type: 'token' | 'oauth' | 'env' | 'native';
  /** 环境变量名（token 注入方式） */
  envVar?: string;               // e.g. "GITHUB_TOKEN"
  /** 认证状态检查命令 */
  checkCommand?: string;         // e.g. "gh auth status"
  /** 引导认证命令 */
  loginCommand?: string;         // e.g. "gh auth login"
  /** 是否必需（false 表示可匿名使用部分功能） */
  required?: boolean;
}
```

---

### 3.4 Tool 生成器层 (Tool Factory)

**职责**：将声明式 `CLIIntegrationDefinition` 自动转换为 `AgentTool[]`。

#### 核心流程

```
CLIIntegrationDefinition
    ↓ ToolFactory.create()
    ├── 健康检查（binary 是否存在）
    ├── 凭证解析
    ├── 遍历 commands[]
    │   ├── 生成 tool.name = `${integration.id}_${command.name}`
    │   ├── 生成 tool.description = command.description
    │   ├── 生成 tool.schema = command.inputSchema
    │   └── 生成 tool.execute = buildExecutor(integration, command)
    └── 返回 AgentTool[]
```

#### ToolFactory 接口

```typescript
interface ToolFactory {
  /** 从集成定义创建 AgentTool 数组 */
  create(
    definition: CLIIntegrationDefinition,
    options?: ToolFactoryOptions,
  ): Promise<AgentTool[]>;
}

interface ToolFactoryOptions {
  /** 凭证提供者 */
  credentialProvider?: CredentialProvider;
  /** 跳过健康检查 */
  skipHealthCheck?: boolean;
  /** 全局超时覆盖 */
  timeout?: number;
  /** 执行前 hook */
  beforeExecute?: (cmd: string[], context: ExecutionContext) => Promise<void>;
  /** 执行后 hook */
  afterExecute?: (result: ToolResult, context: ExecutionContext) => Promise<ToolResult>;
}
```

#### 命令构建器（CommandBuilder）

```typescript
// 将 inputSchema 参数 + CommandTemplate 组装为实际命令行
function buildCommand(
  binary: string,
  template: CommandTemplate,
  params: Record<string, unknown>,
  globalFlags?: string[],
): string[] {
  const args = [binary, ...template.subcommands];

  for (const mapping of template.args) {
    const value = params[mapping.param];
    if (value === undefined && mapping.omitIfEmpty !== false) continue;

    switch (mapping.type) {
      case 'flag-value':
        args.push(mapping.flag, String(value));
        break;
      case 'flag-repeated':
        for (const item of value as string[]) {
          args.push(mapping.flag, item);
        }
        break;
      case 'flag-boolean':
        if (value) args.push(mapping.flag);
        break;
      case 'positional':
        args.push(String(value));
        break;
    }
  }

  if (globalFlags) args.push(...globalFlags);
  if (template.globalFlags) args.push(...template.globalFlags);

  return args;
}
```

#### 输出解析器（OutputProcessor）

```typescript
function processOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  definition: OutputDefinition,
): ToolResult {
  // 1. 判断成功/失败
  const isError = exitCode !== (definition.successCondition?.exitCode ?? 0);

  // 2. 如果是错误，返回 stderr + stdout
  if (isError) {
    return { content: [{ type: 'text', text: stderr || stdout }], isError: true };
  }

  // 3. 执行解析管道
  let result = stdout;
  for (const parser of definition.parsers ?? [{ type: 'passthrough' }]) {
    result = applyParser(result, parser);
  }

  return { content: [{ type: 'text', text: result }], isError: false };
}
```

---

### 3.5 扩展机制 (Extension Mechanism)

**职责**：注册、发现、加载新的 CLI 集成。

#### IntegrationRegistry

```typescript
interface IntegrationRegistry {
  /** 注册一个集成定义 */
  register(definition: CLIIntegrationDefinition): void;
  /** 获取所有已注册集成 */
  list(): CLIIntegrationDefinition[];
  /** 按 ID 获取 */
  get(id: string): CLIIntegrationDefinition | undefined;
  /** 从目录自动发现并注册 */
  discoverFrom(dir: string): Promise<void>;
  /** 生成所有 AgentTool */
  createTools(options?: ToolFactoryOptions): Promise<AgentTool[]>;
}
```

#### 发现/加载流程

```
启动时：
1. 扫描内置集成目录：packages/cli/src/integrations/
   └── 每个子目录 = 一个集成（如 github/, feishu/）
   └── 每个目录导出 CLIIntegrationDefinition

2. 扫描用户自定义集成目录：~/.omni-agent/integrations/
   └── 支持 .ts/.js 文件或 YAML 定义

3. 扫描 npm 包（可选）：查找 package.json 中
   "omni-agent-integration" 关键字的已安装包

4. 合并配置：读取 ~/.omni-agent/config.yaml 中的集成启用/禁用设置

5. 过滤：只加载 enabled=true 的集成

6. 健康检查：验证 binary 可用性

7. 生成 AgentTool[]：通过 ToolFactory 批量生成
```

#### 目录结构约定

```
packages/cli/src/
├── tools/                    # 现有内置 tools（不变）
│   ├── bash.ts
│   ├── file-read.ts
│   └── ...
├── integrations/             # CLI 集成定义目录（新增）
│   ├── registry.ts           # IntegrationRegistry 实现
│   ├── factory.ts            # ToolFactory 实现
│   ├── credential.ts         # CredentialProvider 实现
│   ├── github/               # GitHub CLI 集成
│   │   └── index.ts          # 导出 CLIIntegrationDefinition
│   └── feishu/               # 飞书 CLI 集成
│       └── index.ts
└── index.ts                  # 入口（注册内置 tools + 集成 tools）
```

#### 第三方扩展 npm 包约定

```jsonc
// package.json of a third-party integration
{
  "name": "omni-agent-integration-jira",
  "keywords": ["omni-agent-integration"],
  "main": "./dist/index.js",
  "omniAgent": {
    "type": "cli-integration",
    "id": "jira"
  }
}
```

---

## 4. 与现有代码的衔接

### 4.1 AgentTool 接口兼容性

ToolFactory 生成的每个 tool 完全符合现有 `AgentTool` 接口：

```typescript
// 现有接口（不修改）
interface AgentTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  execute: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
}
```

生成的 tool 示例：
```typescript
{
  name: "gh_issue_create",
  description: "Create a new GitHub issue in a repository",
  schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Issue title" },
      body: { type: "string", description: "Issue body in markdown" },
      repo: { type: "string", description: "Repository in owner/repo format" },
      labels: { type: "array", items: { type: "string" } },
    },
    required: ["title", "repo"],
  },
  execute: async (params, signal) => { /* 自动生成的执行逻辑 */ },
}
```

### 4.2 tools/index.ts barrel 导出对接

现有：
```typescript
// packages/cli/src/tools/index.ts
export { bashTool } from "./bash";
export { fileReadTool } from "./file-read";
// ...
```

新增导出（不修改现有导出）：
```typescript
// 新增
export { loadIntegrationTools } from "../integrations/registry";
```

### 4.3 index.ts 注册集成

现有注册方式（L45）：
```typescript
tools: [bashTool, fileReadTool, fileEditTool, fileWriteTool, globTool, grepTool, webFetchTool, webSearchTool],
```

衔接方式：
```typescript
import { loadIntegrationTools } from "./integrations/registry";

// 启动时加载集成 tools
const integrationTools = await loadIntegrationTools(config);

const agentConfig: AgentConfig = {
  // ...
  tools: [
    // 内置 tools（不变）
    bashTool, fileReadTool, fileEditTool, fileWriteTool, globTool, grepTool, webFetchTool, webSearchTool,
    // 集成 tools（新增，动态加载）
    ...integrationTools,
  ],
  // ...
};
```

**要点**：
- 内置 tools 保持不变，不受影响
- 集成 tools 以 spread 方式追加，无侵入性
- `loadIntegrationTools` 负责发现、验证、生成所有集成 tools
- 若无任何集成启用，返回空数组，零影响

### 4.4 配置扩展

在现有 config 基础上扩展集成配置：

```yaml
# ~/.omni-agent/config.yaml
model: claude-opus-4-6
integrations:
  github:
    enabled: true
  feishu:
    enabled: true
    env:
      FEISHU_APP_ID: "cli_xxxx"
```

---

## 5. 扩展示例（设计走查）

### 5.1 GitHub CLI (gh) 集成走查

#### 集成定义

```typescript
// packages/cli/src/integrations/github/index.ts

const githubIntegration: CLIIntegrationDefinition = {
  id: "gh",
  displayName: "GitHub CLI",
  binary: "gh",
  health: {
    binary: "gh",
    versionCommand: "gh --version",
    minVersion: "2.0.0",
    authCheckCommand: "gh auth status",
  },
  auth: {
    scope: "github",
    type: "native",
    envVar: "GITHUB_TOKEN",
    checkCommand: "gh auth status",
    loginCommand: "gh auth login",
    required: false,  // 部分操作可匿名
  },
  commands: [
    // --- Issue 操作 ---
    {
      name: "issue_list",
      description: "List issues in a GitHub repository. Returns issue number, title, state, author, and URL.",
      inputSchema: {
        type: "object",
        properties: {
          repo: { type: "string", description: "Repository in owner/repo format. Uses current repo if omitted." },
          state: { type: "string", enum: ["open", "closed", "all"], description: "Filter by state" },
          label: { type: "array", items: { type: "string" }, description: "Filter by labels" },
          limit: { type: "number", description: "Max results (default 30)" },
          assignee: { type: "string", description: "Filter by assignee username" },
        },
        required: [],
      },
      command: {
        subcommands: ["issue", "list"],
        args: [
          { param: "repo", flag: "-R", type: "flag-value" },
          { param: "state", flag: "--state", type: "flag-value" },
          { param: "label", flag: "--label", type: "flag-repeated" },
          { param: "limit", flag: "--limit", type: "flag-value" },
          { param: "assignee", flag: "--assignee", type: "flag-value" },
        ],
      },
      output: {
        format: "json",
        formatFlag: "--json",
        jsonFields: ["number", "title", "state", "author", "url", "labels"],
        parsers: [{ type: "json" }],
      },
      timeout: 15000,
    },
    {
      name: "issue_create",
      description: "Create a new issue in a GitHub repository. Returns the URL of the created issue.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title" },
          body: { type: "string", description: "Issue body (markdown supported)" },
          repo: { type: "string", description: "Repository in owner/repo format" },
          labels: { type: "array", items: { type: "string" }, description: "Labels to add" },
          assignees: { type: "array", items: { type: "string" }, description: "Usernames to assign" },
        },
        required: ["title", "repo"],
      },
      command: {
        subcommands: ["issue", "create"],
        args: [
          { param: "title", flag: "--title", type: "flag-value" },
          { param: "body", flag: "--body", type: "flag-value" },
          { param: "repo", flag: "-R", type: "flag-value" },
          { param: "labels", flag: "--label", type: "flag-repeated" },
          { param: "assignees", flag: "--assignee", type: "flag-repeated" },
        ],
      },
      output: {
        format: "text",
        parsers: [{ type: "regex", pattern: "^(https://github.com/\\S+)", groups: ["url"] }],
      },
      timeout: 15000,
    },
    {
      name: "pr_create",
      description: "Create a pull request. Returns the URL of the created PR.",
      inputSchema: {
        type: "object",
        properties: {
          title: { type: "string", description: "PR title" },
          body: { type: "string", description: "PR description (markdown)" },
          base: { type: "string", description: "Base branch (default: repo default branch)" },
          head: { type: "string", description: "Head branch (default: current branch)" },
          repo: { type: "string", description: "Repository in owner/repo format" },
          draft: { type: "boolean", description: "Create as draft PR" },
          labels: { type: "array", items: { type: "string" } },
        },
        required: ["title"],
      },
      command: {
        subcommands: ["pr", "create"],
        args: [
          { param: "title", flag: "--title", type: "flag-value" },
          { param: "body", flag: "--body", type: "flag-value" },
          { param: "base", flag: "--base", type: "flag-value" },
          { param: "head", flag: "--head", type: "flag-value" },
          { param: "repo", flag: "-R", type: "flag-value" },
          { param: "draft", flag: "--draft", type: "flag-boolean" },
          { param: "labels", flag: "--label", type: "flag-repeated" },
        ],
      },
      output: {
        format: "text",
        parsers: [{ type: "regex", pattern: "^(https://github.com/\\S+)", groups: ["url"] }],
      },
      timeout: 30000,
    },
    // ... 更多命令: pr_list, pr_merge, repo_clone 等
  ],
};

export default githubIntegration;
```

#### 完整链路走查

```
用户对话："帮我在 owner/repo 创建一个 issue，标题是 Fix login bug"
    ↓
1. LLM 选择 tool: gh_issue_create
2. LLM 生成参数: { title: "Fix login bug", repo: "owner/repo" }
    ↓
3. ToolFactory 生成的 execute 函数被调用
    ↓
4. 认证检查:
   - CredentialProvider.resolve("github")
   - 尝试 env GITHUB_TOKEN → 尝试 keychain → 尝试 `gh auth status`
   - 若均失败 → 返回错误 "GitHub CLI not authenticated. Run: gh auth login"
    ↓
5. 命令构建:
   - binary: "gh"
   - subcommands: ["issue", "create"]
   - args: ["--title", "Fix login bug", "-R", "owner/repo"]
   - 最终命令: ["gh", "issue", "create", "--title", "Fix login bug", "-R", "owner/repo"]
    ↓
6. 执行:
   - spawn("gh", ["issue", "create", "--title", "Fix login bug", "-R", "owner/repo"])
   - 超时: 15000ms
   - 支持 AbortSignal 取消
    ↓
7. 输出解析:
   - stdout: "https://github.com/owner/repo/issues/42\n"
   - exitCode: 0 → 成功
   - 应用 regex parser: 提取 URL
   - 结果: "https://github.com/owner/repo/issues/42"
    ↓
8. 返回 ToolResult:
   { content: [{ type: "text", text: "https://github.com/owner/repo/issues/42" }], isError: false }
```

---

### 5.2 飞书 CLI 集成走查

#### 集成定义

```typescript
// packages/cli/src/integrations/feishu/index.ts

const feishuIntegration: CLIIntegrationDefinition = {
  id: "feishu",
  displayName: "Feishu/Lark CLI",
  binary: "feishu-cli",  // 假设的二进制名
  health: {
    binary: "feishu-cli",
    versionCommand: "feishu-cli --version",
    authCheckCommand: "feishu-cli auth status",
  },
  auth: {
    scope: "feishu",
    type: "token",
    envVar: "FEISHU_APP_TOKEN",
    checkCommand: "feishu-cli auth status",
    loginCommand: "feishu-cli auth login",
    required: true,
  },
  commands: [
    {
      name: "message_send",
      description: "Send a message to a Feishu chat or user. Supports text and markdown content.",
      inputSchema: {
        type: "object",
        properties: {
          chatId: { type: "string", description: "Target chat ID (starts with oc_)" },
          userId: { type: "string", description: "Target user open_id (alternative to chatId)" },
          content: { type: "string", description: "Message content (text or markdown)" },
          msgType: { type: "string", enum: ["text", "interactive", "markdown"], description: "Message type (default: text)" },
        },
        required: ["content"],
      },
      command: {
        subcommands: ["message", "send"],
        args: [
          { param: "chatId", flag: "--chat-id", type: "flag-value" },
          { param: "userId", flag: "--user-id", type: "flag-value" },
          { param: "content", flag: "--content", type: "flag-value" },
          { param: "msgType", flag: "--type", type: "flag-value" },
        ],
      },
      output: {
        format: "json",
        parsers: [{ type: "json", extract: "$.message_id" }],
      },
      timeout: 10000,
    },
    {
      name: "doc_get",
      description: "Get the content of a Feishu document by its token/URL.",
      inputSchema: {
        type: "object",
        properties: {
          docToken: { type: "string", description: "Document token or full URL" },
          format: { type: "string", enum: ["markdown", "text", "json"], description: "Output format (default: markdown)" },
        },
        required: ["docToken"],
      },
      command: {
        subcommands: ["doc", "get"],
        args: [
          { param: "docToken", flag: "--token", type: "flag-value" },
          { param: "format", flag: "--format", type: "flag-value" },
        ],
      },
      output: {
        format: "text",
        parsers: [{ type: "passthrough" }],
      },
      timeout: 20000,
    },
    {
      name: "doc_list",
      description: "List documents in a Feishu space/folder.",
      inputSchema: {
        type: "object",
        properties: {
          spaceId: { type: "string", description: "Space ID to list documents from" },
          folderId: { type: "string", description: "Folder token (for subfolder listing)" },
          limit: { type: "number", description: "Max results" },
        },
        required: [],
      },
      command: {
        subcommands: ["doc", "list"],
        args: [
          { param: "spaceId", flag: "--space", type: "flag-value" },
          { param: "folderId", flag: "--folder", type: "flag-value" },
          { param: "limit", flag: "--limit", type: "flag-value" },
        ],
        globalFlags: ["--json"],
      },
      output: {
        format: "json",
        parsers: [{ type: "json" }],
      },
      timeout: 15000,
    },
  ],
};

export default feishuIntegration;
```

#### 链路走查（发送消息）

```
用户对话："帮我给群 oc_123 发一条消息：部署完成"
    ↓
1. LLM 选择 tool: feishu_message_send
2. LLM 生成参数: { chatId: "oc_123", content: "部署完成" }
    ↓
3. 认证检查:
   - CredentialProvider.resolve("feishu")
   - 读取 env FEISHU_APP_TOKEN → 或 keychain → 或 `feishu-cli auth status`
   - 认证通过，将 token 注入环境变量
    ↓
4. 命令构建:
   - ["feishu-cli", "message", "send", "--chat-id", "oc_123", "--content", "部署完成"]
    ↓
5. 执行: spawn + 10s 超时
    ↓
6. 输出解析:
   - stdout: '{"message_id": "om_abc123", "status": "sent"}'
   - JSON 解析 → 提取 $.message_id → "om_abc123"
    ↓
7. 返回:
   { content: [{ type: "text", text: "om_abc123" }], isError: false }
```

---

### 5.3 新增集成的完整步骤（面向开发者）

假设要新增一个 **Jira CLI** 集成：

```
Step 1: 创建目录
  packages/cli/src/integrations/jira/index.ts

Step 2: 定义 CLIIntegrationDefinition
  - id: "jira"
  - binary: "jira"  (或 "atlassian-cli")
  - auth: scope "jira", envVar "JIRA_API_TOKEN"
  - commands: [issue_list, issue_create, issue_transition, ...]

Step 3: 导出
  export default jiraIntegration;

Step 4: (自动) IntegrationRegistry.discoverFrom() 扫描到新目录

Step 5: 用户配置启用
  # ~/.omni-agent/config.yaml
  integrations:
    jira:
      enabled: true

Step 6: 启动时自动加载，tools 自动注册
```

开发者仅需关注 Step 2（填写声明式定义），其余由框架自动处理。

---

## 6. 未解决问题 / 待确认项

### 6.1 需要进一步讨论的决策

| 问题 | 备选方案 | 影响 |
|------|----------|------|
| 是否支持远程 MCP server 桥接 | A: 仅本地 CLI / B: 兼容远程 MCP | 架构复杂度差异大 |
| 集成配置文件格式 | A: YAML / B: TypeScript / C: 两者都支持 | 开发体验 vs 类型安全 |
| CLI 二进制不存在时行为 | A: 静默跳过 / B: 启动警告 / C: 用户确认 | UX 决策 |
| 是否需要 tool 动态启用/禁用 | A: 仅启动时 / B: 运行时可切换 | 实现复杂度 |

### 6.2 技术风险

1. **Shell 转义安全**：命令模板插值可能导致注入攻击。需要严格的参数转义策略（使用 `spawn` 数组形式而非 shell string 可缓解）。

2. **CLI 输出格式不稳定**：外部 CLI 版本更新可能改变输出格式。缓解：优先使用 `--json` 等结构化输出 flag；Passthrough 作为兜底。

3. **认证 token 过期**：长时间运行的 session 中 token 可能过期。需要 token refresh 机制或执行前重新验证。

4. **并发执行安全**：多个 tool 同时调用同一 CLI 时可能冲突（如 git 操作）。可能需要 per-integration 执行锁。

### 6.3 后续迭代方向

- **Phase 1**：核心框架（ToolFactory + CredentialProvider + Registry）+ gh 集成作为首个示例
- **Phase 2**：添加更多集成（feishu、jira 等）+ 用户自定义集成目录
- **Phase 3**：MCP adapter 层 + npm 包分发 + 运行时安装命令
- **Phase 4**：YAML 声明式定义支持 + CLI-to-definition 生成器工具

### 6.4 待确认项

- [ ] 是否需要支持 Windows 环境（影响 spawn 和 keychain 策略）
- [ ] 用户自定义集成目录路径（`~/.omni-agent/integrations/` 还是项目级 `.omni-agent/integrations/`）
- [ ] 是否需要集成 marketplace / 集成共享机制
- [ ] 对 LLM context window 的影响：启用 10+ 集成时，tool descriptions 占用多少 token，是否需要动态精简
- [ ] 是否需要 dry-run 模式（只显示将要执行的命令，不实际执行）
- [ ] 错误重试策略（网络超时是否自动重试、重试次数、backoff）

---

## 附录：设计原则回顾

1. **可插拔**：新增集成只需添加一个定义文件，无需修改框架代码
2. **可扩展**：支持内置 → 用户自定义 → npm 包三级扩展
3. **不过度设计**：最小核心 + 可选扩展点，不引入不需要的复杂度
4. **与现有架构兼容**：生成标准 `AgentTool`，零侵入现有代码
5. **渐进增强**：从最简实现起步，按需添加复杂功能

---

## 7. 附录：长任务异步 + 事件回灌主循环 —— mini-agent sidecar 模式参考

> 本章节为可插拔 CLI 集成架构的**扩展参考**，不替换前述方案。提炼 mini-agent 已实现的 sidecar 模式，作为未来支持长任务异步执行的范式借鉴。

### 7.1 背景

前述架构（第 3–5 章）聚焦于「同步执行 CLI 命令并返回结果」的场景。然而实际使用中，部分集成操作天然是**长时间运行**的：

- `gh workflow run` 触发 CI 后需等待数分钟才有结果
- 飞书文档异步导出（发起请求 → 轮询/回调 → 下载产物）
- 大规模数据迁移、批量 API 调用等

这类任务如果阻塞 agent 主循环，会导致 LLM 推理链路空转等待。理想模式是：**异步启动 → 后台执行 → 完成后把结果回灌进 agent 主循环触发下一轮推理**。

mini-agent 项目已实现了一套完整的 sidecar 机制来解决这个问题，值得作为参考范式。

### 7.2 mini-agent sidecar 范式提炼

以下基于 mini-agent 项目（`packages/mini-agent/src/sidecar/`）的实际实现提炼关键设计。

#### 7.2.1 IPC 通道：Unix Domain Socket + JSON-line 协议

- Socket 路径按 sessionId 确定性生成：`/tmp/mini-${sessionId}.sock`（参考 `packages/mini-agent/src/sidecar/socket-path.ts` 的 `getSocketPath` 函数）
- 协议为 JSON-line：每条消息一行 JSON，以 `\n` 分隔
- 请求格式：`{ argv: string[], cwd?: string, env?: Record<string, string> }`
- 响应格式：流式返回 `{ stdout?, stderr? }` 数据帧，最终以 `{ exitCode: number }` 结束

#### 7.2.2 同二进制双角色 dispatch

一个 `mini` 二进制根据子命令名称决定走「主 CLI 流程」还是「sidecar IPC 客户端」：

- `packages/mini-agent/src/cli/dispatch.ts` 的 `selectMiniDispatchTarget` 函数检查命令名是否属于 sidecar 命令集（`session`、`job`）
- 属于 sidecar 命令 → 走 IPC 客户端连接 socket
- 否则 → 走正常 CLI 入口

这种设计让用户只需记住一个二进制名，无需区分「哪些命令走网络、哪些走本地」。

#### 7.2.3 服务端：SidecarRuntime

- `packages/mini-agent/src/sidecar/runtime.ts` 中的 `SidecarRuntime` 类在主 agent 进程内通过 `net.createServer` 监听 Unix socket
- 通过 `register(name, handler)` 注册命令处理器，支持运行时动态注册
- 每个连接解析首行 JSON 请求，dispatch 到对应 handler
- handler 通过 `ResponseWriter` 接口流式写回 stdout/stderr/exitCode

#### 7.2.4 客户端：IPC 连接与流式输出

- `packages/mini-agent/src/sidecar/client.ts` 的 `runSidecarClient` 函数通过 `net.createConnection` 连接 socket
- 从环境变量 `MINI_SESSION_ID` 获取 sessionId 以确定 socket 路径
- 流式接收服务端响应，将 stdout/stderr 分别写入对应的进程输出流
- 收到 `exitCode` 帧后以对应退出码结束进程

#### 7.2.5 后台 Job 管理

- `packages/agent-harness/src/processes/job-manager.ts` 中的 `JobManager` 管理后台任务生命周期
- 使用 `spawn(..., { detached: true })` 启动后台进程，使其脱离 agent 主进程生命周期
- 跟踪 job 状态（running/completed/failed）、PID、日志输出
- 通过事件机制（`JobManagerEvents`）通知 job 状态变更

#### 7.2.6 外部信号注入主循环

这是 sidecar 模式最关键的能力——**让外部进程把消息注入正在运行的 agent 会话**：

- `mini session send <text>` 命令通过 IPC 到达 sidecar 服务端
- 服务端调用 `controller.submit(text)` 将文本提交到 session 队列
- session 队列触发 agent loop 的下一轮推理（参考 `packages/mini-agent/src/sidecar/commands/session.ts` 的 `handleSend`）

这意味着一个后台 job 完成后，可以通过 `mini session send "任务 X 已完成，结果为 ..."` 把结果回灌进 agent，触发 LLM 继续推理。

#### 7.2.7 session 控制平面

外部进程不仅能注入消息，还能读取和修改 session 状态：

- `mini session status [--json]`：读取当前 model、think level、usage 等状态
- `mini session set-model <provider:modelId>`：运行时切换模型
- `mini session set-think <level>`：运行时调整思考深度

#### 7.2.8 子进程反向回调闭环

- `packages/mini-agent/src/agent.ts` 在启动 bash tool 子进程时，将 `MINI_SESSION_ID` 注入子进程环境变量
- 子进程内可直接使用 `mini session send` / `mini job run` 等命令，通过同一 socket path 反向调用 sidecar
- 形成「agent → bash tool → 子进程 → sidecar → agent」的完整闭环

### 7.3 与本架构的衔接建议

以下为讨论性建议，不涉及具体代码实现。

#### 适合放在「集成能力层」之下作为异步执行子层

当前架构的 ToolFactory 生成的 executor 是同步的（spawn → 等待 → 返回）。可以在同一层新增一个异步执行路径，与同步 CLI 调用并存：

- 命令定义层可新增 `executionMode: 'sync' | 'async-job'` 声明
- `sync` 走现有的 spawn + 等待 exitCode 路径
- `async-job` 走 sidecar/JobManager 路径：启动后台进程，立即返回 jobId，完成后通过事件回灌

#### 事件回灌模式

借鉴 mini-agent 的 on-exit 回调 + IPC 注入模式：

- 后台 job 完成时，JobManager 触发回调
- 回调通过类似 `controller.submit()` 的机制将结果注入 agent 主循环
- agent 收到注入消息后触发 LLM 下一轮推理，处理异步任务结果

#### socket-per-session 隔离

- 每个 agent session 使用独立的 socket 路径，避免多 agent 实例互相干扰
- socket 路径由 sessionId 确定性派生，客户端无需服务发现
- session 结束时清理 socket 文件

### 7.4 与本文方案的差异说明

| 维度 | mini-agent sidecar | agent-deck sidecar | 本文可插拔架构 |
|------|-------------------|-------------------|--------------|
| 核心定位 | 命令式控制平面 + 后台 job 调度器 | UI 渲染旁路（taskflow.render.json） | 同步 CLI 工具包装 + LLM tool 生成 |
| IPC 机制 | Unix socket + JSON-line | 文件系统 state push | 无（同进程调用） |
| 异步任务 | 原生支持（JobManager + detached spawn） | 不涉及 | 当前不支持，未来需求 |
| 事件回灌 | `session send` 注入 agent loop | 无（单向 push） | 当前不涉及 |
| UI 旁路 | 无 | render.json 驱动 UI 更新 | 无，也不需要 |

关键区分：

- mini-agent sidecar 是**纯命令式控制平面 + 后台 job 调度器**，不带 file-based state push（无 render.json 旁路）
- agent-deck 的 sidecar 才是 UI 渲染旁路（通过 taskflow.render.json 驱动前端更新）
- 我们的可插拔架构当前不需要 UI 旁路，但**长任务回灌**是真实的未来需求，mini-agent 的 sidecar 模式值得复用

### 7.5 未解决问题

1. **复用 vs 自研**：是否直接复用 mini-agent 的 sidecar 库（`@verdent-private/mini-agent` 包内的 sidecar 模块），还是 omni-agent 自研一份轻量实现？复用的好处是协议一致、维护成本低；自研的好处是可以针对 omni-agent 的需求裁剪。

2. **协议统一**：当前 sidecar 使用自定义 JSON-line 协议。是否应统一为 MCP-like 格式（JSON-RPC 2.0）？这样未来 sidecar 命令可以直接暴露为 MCP tools，但会增加协议开销。

3. **跨平台 socket**：Unix domain socket 在 Windows 上支持有限（需 Windows 10 1803+）。如果 omni-agent 需要支持 Windows，可能需要 named pipe 或 TCP localhost 作为降级方案。

4. **Job 生命周期与 session 生命周期的绑定**：session 结束时，正在运行的后台 job 应该如何处理？强制终止、等待完成、还是 orphan 后由下次 session 认领？

5. **回灌消息的优先级与排序**：多个后台 job 同时完成时，回灌消息的处理顺序是否需要优先级机制？是否需要防止回灌消息打断用户正在进行的交互？
