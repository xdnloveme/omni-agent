# 11510 工具契约与范围错误核查

核查范围：最近一次付费运行中的 12 次参数/范围拒绝；不包含另两次命令非零退出。本轮没有付费请求，没有修改产品代码。

## 结论

不能把 12 次拒绝全部归为模型填错参数。存在批次失败归因误导、静态分析过粗和范围说明不完整；同时，也有明确的模型契约遵循错误。本核查不改变题目最终失败的直接原因：提交把被包含文件的 docname 传成主文档，独立评分未通过。

## 逐项证据

时间相对本次 Trace 起点，seq 指 tool.result 事件。

| 秒 / seq        | 调用与现象                                                          | 核查结论                                                                                                                                          |
| --------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 6.869 / 141     | `ls /testbed && git log --oneline -5` 被要求提供写入范围            | 静态语义将 git 整体视为 unknown，不能描述 git log 的行为。属于分析保守性，不足以称模型漏填；不能将全部 git 命令直接放行                           |
| 6.894 / 142     | `glob(pattern=...)` 得到同一写入范围错误                            | 合法只读 glob 被同批 Bash 失败连带拦截，且错误文本指向它不支持的 sandbox_scope。明确的批次反馈归因问题                                            |
| 13.865 / 260    | grep 使用 output_type、path                                         | 请求快照只有 search_path，additionalProperties=false；反馈明确列出两个非法字段。模型契约遵循错误                                                  |
| 15.705 / 272    | grep 删除 output_type，仍保留 path                                  | 已得到具体反馈但只修正一半，属于模型恢复不完整                                                                                                    |
| 17.624 / 299    | grep 添加 search_path，却仍保留 path                                | 反馈继续点名 path；19.371 秒删除 path 后调用成功，未发现 schema 遗漏                                                                              |
| 327.177 / 7996  | mkdir 与写文件命令，声明尚不存在的 /tmp/repro 为 read/write subtree | write_paths 已写明 existing directory；read_paths 共用的 scope schema 未说明同一前提。当前拒绝符合契约，但反馈未标出具体违规字段/路径             |
| 583.316 / 14363 | `cd /testbed && grep ...`，write_paths=[]                           | 回放显示只有 cd 为 pathAccess=unknown，grep/head/echo 均为 read；由目录切换触发未知文件写入是分析语义不足                                         |
| 688.059 / 16496 | 直接进入 /tmp/repro 再运行构建                                      | 327 秒那次被拒绝，目录仍未创建；不是“复现已成功后重跑”。模型未正确追踪上次未执行的效果                                                            |
| 695.304 / 16565 | 改 read scope 为 /tmp，但 write subtree 仍为不存在的 /tmp/repro     | 收到 existing directory 提示后仍未修正写范围；700.967 秒 read/write 改为已有 /tmp 后执行成功                                                      |
| 823.533 / 18764 | diff + 不带写选项的 sed + /dev/null 重定向被要求写范围              | sed 被按命令名整体视为 write，存在语义过粗；sed 的其他写出方式也需分析，不能只检查是否有 -i                                                       |
| 901.189 / 19801 | head/grep/echo，带 `2>/dev/null`，仍判未知写入                      | 命令事实均为 read；重定向分析将 > 判为 write，路径分析又忽略已识别的特殊目标，随后因缺少写入目标生成 mutation uncertainty。属于分析事实传递不一致 |
| 915.173 / 19964 | write subtree=/tmp 合法，但 read subtree 含尚不存在的 /tmp/std-out2 | 说明缺口最清楚的一次：read_paths 的 scope 没有 existing directory 描述；报错没有指出是 read_paths 中哪个路径。下一次移除该 read scope 后恢复      |

## 实际模型输入与源码

检查 `model.request.captured` 中的工具定义，不仅是当前源码：

- grep 明确提供 `search_path` 和 `additionalProperties:false`，没有 `path` / `output_type`。
- Bash 的 write_paths 明确说明 subtree 对应已有目录；read_paths 只有数组结构，共享的 path/scope schema 只有类型和枚举，没有描述已有目录约束。
- Bash 已解释管道退出码和 head/tail 会提前丢失输出，故不能把命令过滤行为简单归因为“没有提示”。这不在本轮 12 次拒绝的修复范围。

源码归属：

- `agents/coding/src/instructions/scope-gate.ts:53`：任一 ready call 的 mutation=unbounded 就返回批次级 failed，没有具体调用身份。
- `packages/core/src/agent/loop/toolBatchPhase.ts:113`：该 policyResult 套到批次内所有 ready call；每个收到相同错误。这解释了 glob 的误导性反馈。保留批次阻断可能合理，不能据此直接改成其他调用继续执行。
- `packages/tools/src/shell/security/semantics/command-semantics.ts:207`：按可执行名分类，git/cd 为 unknown、sed 为 write。
- `packages/tools/src/shell/security/analysis/analyze-shell-program.ts:608` 与 `analyzers/path-analyzer.ts:163`：重定向 write 与特殊目标过滤之间的事实不一致。
- `packages/tools/src/shell/bash.ts:79`：read/write scope 的描述不对称。
- `packages/tools/src/security/path/filesystem-scope-policy.ts:33`：拒绝信息未保留 path/access 等定位信息。

已比对本次构建的 omni-source.tar：scope-gate、toolBatchPhase、command-semantics、analyze-shell-access、path-analyzer 与当前源码一致。免费探针调用唯一 analyzeShellCommand 入口回放 4 条 Bash 命令，均重现上述 mutation uncertainty；没有执行命令本身。探针运行于宿主，使用 Linux hostRuntime 描述；结果证明静态分类，不代表重跑 Linux 容器整个权限生命周期。

## 建议顺序与边界

1. **先修批次失败的准确归因。** 原因属于哪个调用、哪些调用仅因批次被阻断，应能明确区分；保留现有执行顺序、规则加载及权限策略。不是让 glob 接受 sandbox_scope。
2. **收敛静态分析的操作语义和 mutation 事实。** 优先已证实的 cd 和特殊输出重定向；在现有 ShellProgram 分析管线修正，不在调用方加命令字符串特判。git/sed 需覆盖配置、选项和嵌套执行风险后再定范围，不新增宽泛白名单。
3. **统一范围契约和错误定位。** read/write 共用字段说明已有目录约束，反馈指出具体路径、字段和失败条件；不自动扩权限，不替模型改输入，不新增另一套 scope 校验。
4. **grep 暂不改。** 当前 schema 和反馈足够明确，不添加 path 别名，不因为三次错误重复堆提示。

收益的可信度：准确归因和错误定位有直接证据；减少分析误报有免费回放支持，但具体修复仍需守住安全语义。不能据此估算通过率提升或宣称会修复本题 docname 语义遗漏。

证据：`benchmark/artifacts/verified-11510-2026-09-18/{paid-timeline,tool-results}.json`、原始 replay，以及 `benchmark/artifacts/tool-contract-audit-11510/{probe.mts,shell-analysis.json}`，均为 gitignored 分析产物。

## 补充：grep 连续错误的上游影响核查

进一步检查 58 次模型请求快照，grep 工具定义只有一个版本、没有重名工具；前三次纠错请求均保留对应的完整错误文本。首次错误之前的任务消息未提供 search_path/output_type 等替代契约；现有证据未发现旧示例指示 grep 使用 path。不能由此排除模型训练先验或参数命名习惯的影响。

连续错误轨迹：先生成 path+output_type，删除 output_type，再添加 search_path 但保留 path，最后删除 path 后成功。错误调用与错误反馈均进入下一轮历史，这是正常对话记录；可能产生对旧参数的锚定，但没有对照实验，不能认定为因果，也不应删除历史来掩盖错误。

发现一个确切的配置差异：**grep（同 glob）未声明 inputConstraint 意图**。本次所有 grep 约束报告均为 intent=unspecified、outcome=disabled、reason=not_requested。此前笼统说“Provider unknown 所以 grep 未启用严格约束”不准确；unknown 是 Provider 的事实，但 grep 直接关闭原因是不请求。即使支持能力被确认，当前定义也不会自动启用。是否给所有适用工具统一声明意图，需要在工具契约边界决策；不能直接把远端支持状态改为 supported。

免费 Provider 回放：用三份真实纠错上下文，经过当前 ModelRuntime → compatible openai-completions → SDK 序列化；fetch 被本地确定性响应替代，没有网络、模型或凭据调用。三次检查均确认：

- grep parameters 与请求快照的 schema 完全相同，search_path 和 additionalProperties=false 保留。
- wire strict=false；工具名称没有重复。
- 即使历史调用有 path，新的模拟响应只返回正确参数时，解析结果不会残留旧 path。

临时探针首次误将 onPayload 数组 push 的返回值传回 SDK，造成探针响应失败；修正为 void 后以上三例通过。该问题只在诊断脚本，不在产品调用配置。

这一回放排除了当前本地转换路径在该受控条件下漏 schema 或合并旧参数的猜测，**不是历史 HTTP 请求抓包，也不能排除远端 Provider 的转换或约束行为**。本次实际历史日志没有原始 SSE 参数片段，不能把“看见 tool.call.started 参数错误”绝对等同于“远端原始参数已经错误”。

可改进方向更准确地表述为：

1. 当前校验消息指出非法字段，却没有就地给出合法字段集合；可以评估由同一 schema 自动生成有界纠错信息，不增加 grep 专属 path→search_path 映射。不保证有收益，因为第三次调用已使用 search_path，仍保留 path。
2. 核对工具生成约束意图声明是否一致；已有 unknown 支持状态必须保留，后续按真实 Provider 验证结果启用。
3. 命名习惯、历史锚定和远端处理仍是待验证假设，不能仅靠猜测重命名公共参数、加兼容别名或叠加 prompt。

证据：`benchmark/artifacts/tool-contract-audit-11510/provider-probe.mts` / `provider-probe.json`。本轮只做诊断，没有修改产品实现，没有发起付费验证。

## 根因收敛：声明差异不是已证实原因

复核旧计划 `docs/plans/provider-tool-constraints.md:149`、193、231：grep/glob/skill_read 保持未声明是既定迁移范围，不是本轮遗漏。旧 R5 真实试跑只证明接口接受 strict 字段，未保留可用的工具参数验证证据，不能认证强制约束支持。

使用真实 grep schema 对 resolveToolConstraints 做六组免费反事实检查，结果：

| Provider 能力  | 意图        | 结果                                  |
| -------------- | ----------- | ------------------------------------- |
| unknown        | unspecified | disabled / not_requested              |
| unknown        | prefer      | disabled / capability_unknown         |
| unknown        | require     | rejected / capability_unknown         |
| 假设 supported | unspecified | disabled / not_requested              |
| 假设 supported | prefer      | disabled / schema_optional_properties |
| 假设 supported | require     | rejected / schema_optional_properties |

因此“补一个 prefer 就能解决”已被排除；“缺少约束声明导致连续错误”没有成立的因果证据。schema_optional_properties 是本地保守适配策略的判断，不是对该远端 Provider 能力的实测结论；不能为了强行启用而删掉字段或改变工具参数语义。

最强事实链仍是：schema 稳定且提供 search_path → 生成 path/output_type → 校验反馈完整进入下一轮 → 逐步修正时保留旧 path → 最后删除旧字段成功。当前定位到**工具参数生成/纠错环节未正确完成字段替换**。本地协议回放不残留参数，未发现本地系统注入错误工具契约；历史原始 HTTP/SSE 响应未留存，因此不把模型或 Provider 内部机制说成 100% 已定位。

错误反馈只列非法字段、旧调用锚定、名称与训练习惯的差异都是待验证影响因素，不是已证实根因。继续区分需要通过正式 Provider 入口做受控对照：固定这三份失败后的上下文和 schema，对比原反馈与从同一 schema 生成的通用纠错反馈，采集脱敏的出站 schema 与入站原始 arguments，再比较本地解析后参数，重复观察。当时尚未获得新增付费对照授权；后续已获授权并执行，见文末结果。

本轮只检查、免费执行决策矩阵并更新证据；没有修改生产代码或直接开启严格约束。矩阵保存在 gitignored `benchmark/artifacts/tool-contract-audit-11510/constraint-matrix.json`。

## 进一步排除 prefer 迁移回归

补查迁移前的 2026-09-16 foundation 真实 Trace：seq 98 的 grep 输入使用 path，seq 100 明确拒绝；seq 123 又使用 path，seq 124 再次拒绝；seq 147 改 search_path 后成功。这个连续纠错问题早于 2026-09-17 的 prefer 迁移。历史文件位于 `benchmark/artifacts/verified-medium2-foundation-2026-09-16/paid/20260916T103640Z-838a9fad8367/django__django-11885__A9Kj8r4/agent/omni/state/traces/coding/b2a61348-6d64-4ee1-8689-52f145dea652/641f8ddc-c941-43e0-96bb-dac09f6cad3e/replay.jsonl`。

另以当前失败前和三轮恢复的 4 份真实请求快照，固定消息投影、SDK 和未知能力设置，对照 HEAD 的旧工具映射（仅 name/description/parameters）与当前工具映射（额外 constrainedSampling=false）。通过实际 openai-completions SDK 序列化并本地替换 fetch，共 8 个免费模拟请求：4 对完整 payload 深比较全部相同，grep strict 均为 false。结果保存在 `before-after-wire.json`，脚本 `before-after-wire.mts`。这是隔离工具映射变量的对照，不是完整旧版本 Agent 重跑。

因此目前可把 prefer 映射变化基本排除为本问题的直接原因，也没有发现工具参数本地合并残留。尚不能把“旧参数锚定”“错误反馈未就地重述可用字段”“远端 Provider 处理”排出因果链。下一步已向用户提出最多 6 次真实短请求的诊断方案：固定失败上下文和模型，原始反馈与 schema 自动生成纠错反馈各 3 次，输出上限 2048 tokens/次、90 秒/次、无自动重试、工具不执行；记录脱敏原始入站参数与解析后参数。只有得到这一新增付费范围的授权后才执行，不能把模拟回放当作真实生成因果证据。

## 已授权的 6 次真实 Provider 诊断

用户先批准最多 6 次请求，再明确批准将既有公开 Sphinx 失败上下文（含系统提示、工具 schema、历史调用与错误反馈）发送到当前火山 Provider `ark.cn-beijing.volces.com`，使用现有凭据认证。实际仅发送 6 次 HTTP 请求，无重试、无工具执行、未重跑 benchmark。每次输出上限 2048 tokens、超时 90 秒。

设计：固定首次错误之后的同一份模型请求快照（第 4 个 model.request.captured），保留完整工具集和历史；原始错误反馈 3 次，追加从当前 schema 自动生成的允许字段、必填字段和移除非法字段说明 3 次。三对请求交替顺序，均独立从同一上下文开始。追加说明没有 grep 专属参数替换规则。每组出站 payload 的 SHA256 在三次重复中一致，grep schema 保持 search_path、additionalProperties=false、strict=false。

| 对照轮次 | 原始反馈          | schema 派生明确反馈 | 原始响应与本地解析 |
| -------- | ----------------- | ------------------- | ------------------ |
| 1        | 失败：path        | 失败：path          | 两次一致           |
| 2        | 成功：search_path | 成功：search_path   | 两次一致           |
| 3        | 失败：path        | 失败：path          | 两次一致           |

所有请求 HTTP 200，以 tool_calls 正常结束，均返回一个 grep 调用；没有超时、输出截断或解析失败。这里的“成功”仅表示生成参数通过实际 ToolInputValidator，不表示工具执行或题目通过。错误参数直接存在于入站 SSE function.arguments 中，本地解析未增加、删除或改写字段。

**结论：此次可复现的问题在远端参数生成/纠错环节，本地 schema 传输和响应解析没有表现出错误；结合迁移前已有相同错误、旧新映射的出站等价对照，没有证据支持 prefer 改坏了该行为。** 原始反馈与强化反馈均为 1/3 正确，当前样本没有证明增加提示有收益，因此不据此修改产品提示、重命名公共字段或添加兼容别名。

归因边界：原始 HTTP 响应只能定位到远端服务返回边界，不能继续区分模型本体与 Provider 内部处理。训练参数习惯、历史错误调用锚定仍为假设；本实验未分别消融这些因素。每组仅 3 次、串行执行且存在 Provider 缓存，不足以估计稳定错误率或证明两种反馈严格等效。冻结上下文中的历史时间信息也保留，两组一致但不代表自然续跑。

配置选择的模型 ID 为 glm-5.2，六次响应 model 字段均为 glm-5.3；这是观测到的标识差异，不能未经 Provider 说明断定真实后端版本或认定其为错误原因。原始 usage 合计 prompt_tokens=52,176（含 cached_tokens=51,008）、completion_tokens=210、total_tokens=52,386。部分返回的 reasoning_tokens 大于 completion_tokens，故保留原值，不推算额外总量。运行时 cost=0 只是缺少可用计费价格，不代表免费；实际金额未核实。

证据目录：`benchmark/artifacts/grep-paid-diagnosis-2026-09-18/`，包括 probe.mts、harness.mjs、pair-1/2/3.json、preflight/run 结果及 Harness 日志。三个 Harness 进程均 exitCode=0、cleanupState=completed。目录受 gitignore 保护；凭据仅用于认证，不写入诊断结果。生产实现未修改。

## Provider 内部处理边界复核

本轮仅检查源码、配置、现有请求与响应证据，并查询公开文档；未新增付费请求，未改产品代码。

实际链路为 omni.providers.json 的 volcengine-agent-plan/default → toVendorPlugin → compatibleConnection(openai-completions) → ModelRuntime → pi-ai SDK → https://ark.cn-beijing.volces.com/api/plan/v3。不是内置 createVolcengineVendorPlugin 的 /api/v3 + deploymentId 路径。当前通用连接没有 compat 配置覆盖，也没有本地 glm-5.2 → glm-5.3 别名映射。

- 本地请求：ModelRuntime 采用所选模型 ID；SDK buildParams 使用 model.id。工具定义保留 parameters，grep strict=false。系统提示按 system role 发送。
- 历史消息：本次失败上下文的三个 assistant 消息均保留 model=glm-5.2、responseModel=glm-5.3、provider=volcengine-agent-plan、api=openai-completions，thinkingSignature=reasoning_content。SDK 的同模型判断用请求 model ID，因此不会仅因 responseModel 不同而将这些历史推理块改成普通正文；其序列化保留 reasoning_content 字段。这是源码及历史元数据核查，不证明远端如何利用该字段。
- 推理控制：本地未显式设置 reasoning effort；当前兼容规则没有注入 thinking=disabled。远端返回推理用量，但仅凭用量无法确定实际推理档位。
- 响应：SDK 对原始参数片段按工具索引拼接并解析 JSON；已有六次实际原始/解析参数一致，未发现字段名转换。本地记录 responseModel，不将远端返回模型标识替换回请求标识。

远端可见差异：配置选择 glm-5.2，六次原始 SSE 响应均为 glm-5.3。这可能是远端路由/别名/版本标识策略，尚没有官方证据确认具体机制；不能据此断定错误由版本切换导致。部分 usage 的 reasoning_tokens 大于 completion_tokens，也应由 Provider 解释计数口径；与 path 字段错误无已证实因果关系。

公开官方文档检索未取得可核实的该版本路由说明（相关 Agent Plan 页面未能成功读取）。不采用社区转述作为已证实事实。服务端模板、schema 转换、模型原始输出和输出后处理不可见，因此当前只能定位到远端服务返回边界，不能继续断言一定是模型本体而非 Provider 内部处理。

若需继续定位服务端，最直接的证据是通过已保留的 x-request-id 请 Provider 核查：实际路由版本、模型接收的工具 schema、原始生成参数与对外 arguments 是否一致。尚未向任何外部人员发送材料。更换渠道对照只能提供额外证据，因模型版本和推理设置可能不同，仍不能自动等同于同模型消融。

## 首次错误生成调查：先于纠错的系统性契约偏差

本轮读取首次错误前的完整第 3 个请求快照，并扫描 artifacts/verified-* 下可读取、包含 grep 调用的历史 replay，按 runId 去重。只做本地日志分析，不执行工具业务、不增加付费模型请求。证据和复现脚本为 `tool-contract-audit-11510/first-grep-audit.json` 与 `first-grep-audit.py`。

### 新证据

- 共找到 14 个不同 run 的首次 grep 调用，14 个都有之前最近的请求快照；当时的 grep schema 哈希完全一致，属性为 regex/search_path/glob/ignore_case/max_results，additionalProperties=false。
- 其中 13 个首次调用含非法 path；另 1 个使用合法 search_path。一例额外生成 output_type，一例额外生成 pattern。此为已有运行的便利样本，含同题多次重跑、不同版本和上下文，不能当作独立同分布样本或稳定错误率。
- 当前 Sphinx-11510 的首次错误是 seq 259，生成 `{glob:"*.py",output_type:"content",path:"/testbed/sphinx",regex:"source-read"}`。之前只有 bash/glob 共四次调用，没有 grep 调用或 grep 纠错历史，因此“先前错误 grep 参数锚定”不能解释此次首次错误。
- 首次错误之前的系统提示、非推理可见消息及所有工具定义中，output_type 出现次数为 0；没有找到让 grep 使用 path 的本地指令或示例。这不是从已提供的 grep 契约中复制出的参数。
- 路径参数实际分布是 file_read/edit/write 的 file_path、glob 的 dir_path、grep 的 search_path，以及 Bash sandbox_scope 内的 path。没有其他工具以顶层 path 作为输入；此前“其他工具普遍使用 path”的猜测不符合本次工具集。此前成功 Bash 调用确实含嵌套 path，但不能据此判定它造成混淆。
- grep 的 schema 对 search_path 有明确语义说明，但工具 description 仅描述何时搜索、返回什么和如何继续读取，没有提及 search_path，也没有完整调用示例。这是事实上的表达特点，不等于 schema 不完整或已证明的引导缺陷。

### 归因与优先级修正

已确认问题不仅是纠错失败，而是跨多次运行的**首次工具调用契约遵循偏差**。模型返回了当前工具定义之外的字段；仅用错误历史解释根因不成立，先前 6 次纠错实验也没有回答首次生成为何错。

当前优先假设是生成端把当前工具契约与既有参数习惯混合使用；输入同时保留正确 regex/glob、又增加未声明 path/output_type 与该假设相容。但训练先验、工具命名联想、多个工具间的干扰，以及 Provider 内部工具模板仍不能从日志分开，不能把假设写成已证实最终根因。

Agent 初始引导是否可改善，需要对首次生成单独做对照：以第 3 个请求为基线，不包含任何错误 grep 历史；先比较原始定义和在工具定义边界加强 schema 派生契约表达，再单独比较完整上下文与去除此前调用历史的上下文。每次仅变一个因素，观察第一次参数生成，不执行返回工具。消融只用于诊断，不能以删掉生产历史消息或改变公共参数作为默认修复。新增真实请求需要另行明确数量与预算，本轮未执行。

如果实验显示契约表达有稳定收益，职责应在工具定义/统一 schema 表达边界，而不是 benchmark、Provider 字段替换或 grep 特例纠错。当前不添加参数别名、不重命名公共接口、不宣称增加示例一定有效。

## 首次调用真实对照：加强契约表达未观察到改善

用户另行批准最多 6 次首次调用诊断。本轮恰好发出 6 次请求，无重试、无工具执行，每次限制 2048 输出 tokens 和 90 秒。使用现有火山配置与凭据，冻结第 3 个请求（首次 grep 之前）完整系统提示、历史消息及工具集。

实验仅改变 grep.description：原始说明，对比追加从当前 schema 自动生成的属性名、类型、必填性、属性描述以及不接受其他字段的说明。未改 schema、参数名、模型、错误反馈或历史消息，也未加入针对 path 的别名或替换规则。三个对照对的请求顺序为 original/explicit、explicit/original、original/explicit。

六份出站消息哈希一致；将 grep.description 归一为固定占位符后，六份完整出站请求哈希一致。因此，本次只有工具说明这个变量发生变化。两组各自的实际请求也完全一致。出站 model=glm-5.2，入站 responseModel=glm-5.3。

| 轮次 | 原始说明                           | schema 派生强化说明       |
| ---- | ---------------------------------- | ------------------------- |
| 1    | path，非法                         | path，非法                |
| 2    | 两个 grep 均用 path，非法          | search_path，合法         |
| 3    | 省略可选搜索路径，合法（使用 cwd） | 两个 grep 均用 path，非法 |

按请求计两组均 1/3 生成合法 grep 参数；按工具调用计每组均 1/4 合法。每个请求都生成了 grep，故不存在未调用被错误计为通过。所谓合法只表示参数校验通过；没有执行搜索，不表示任务解决。样本量很小，不能证明两组统计等效、排除所有提示设计，或估计稳定错误概率。

本轮八个 grep 原始 arguments 均为有效 JSON，逐调用和本地解析深比较一致。所有六个 HTTP 请求均 200、tool_calls 正常结束，没有超时或长度截止。结论是：**明确在首次调用前重述 schema 契约，仍无法可靠阻止 path；当前未找到“缺少初始字段说明是主因”的支持证据。** 这削弱了该简单假设，但不等于证明模型本体一定有缺陷；远端模板、工具先验以及上下文作用仍未隔离。

补充反证：此前成功的 medium3 与本次失败 run 的系统提示哈希一致；14 个历史 run 的 grep.description 哈希全部一致，历史 assistant 均记录 glm-5.2/glm-5.3。因此未发现“某次工具说明或系统提示改坏”能单独解释这些差异；历史任务和上下文不同，不能代替随机化因果对照。

独立发现：第 1 对 explicit 响应还同时返回一个 Bash 调用，其原始 JSON 缺少最终闭合花括号，SDK 的 parseStreamingJson/partial-json 仍产出对象。这造成探针请求级 rawParsedEqual=false；不能误报为 grep 参数被转换。逐工具复核确认该响应中的 grep 原始参数与解析一致。当前 SDK 确有不完整 JSON 容错语义，但没有把 search_path 改成 path。此为单独的输出协议完整性观察，本轮不将其作为本问题根因，也未自动执行该 Bash 调用。

用量（Provider 原始值）：prompt_tokens=51,027（含缓存44,288）、completion_tokens=1,579、total_tokens=52,606。未取得计费价格，不能把本地 cost=0 当免费。三个 Harness run 均正常完成并清理。

证据目录：`benchmark/artifacts/grep-first-call-diagnosis-2026-09-18/`，包括 probe.mts、harness.mjs、六次请求/响应摘要 pair-1/2/3.json、analysis.json 逐工具核对、Harness preflight/run 记录。目录受 gitignore 保护。没有修改产品实现。

## 首次调用字段名对照：search_path 与 path

用户在明确提出改名对照后要求“验证一下”。实际执行 6 次请求，原名与改名各 3 次；继续复用同一首次错误前上下文、火山配置与凭据，每次最多 2048 输出 tokens/90 秒，无重试、不执行生成工具。仅在 gitignored 探针的实验组将 grep.schema.properties 的 search_path 改名为 path；属性位置、描述、类型、可选性、其他参数、工具说明、历史消息和模型配置全部不变。未修改生产工具或引入别名。

六份出站 payload 归一化路径属性名后哈希完全一致，消息哈希一致；每组自身完整请求哈希一致。所有原始工具参数都是有效 JSON，与本地解析深比较一致。6 次 HTTP 均 200、tool_calls 正常结束，没有超时或长度截止。

| 轮次 | 原名 search_path       | 改名 path                   |
| ---- | ---------------------- | --------------------------- |
| 1    | 合法，省略可选搜索路径 | 合法，两个 grep 均使用 path |
| 2    | 非法，生成 path        | 合法，使用 path             |
| 3    | 非法，生成 path        | 合法，使用 path             |

请求级：原名 1/3 合法，改名 3/3 合法；grep 调用级：原名 1/3 合法，改名 4/4 合法。原名唯一合法调用省略路径，依照原契约默认使用 cwd；不能说它生成了正确 search_path。每次请求均包含 grep，未将没有生成该工具的响应计为成功。

**这是字段命名影响契约匹配的直接小样本对照证据。** 原名条件下仍生成 path，而采用 path 契约时当前样本全部合法；相比之前只加强说明的 1/3 对 1/3，此次改名表现出可观察收益。但两组生成本身都倾向 path，不能声称改名使模型更会遵守任意 schema；更准确的是契约与当前生成偏好对齐，减少了拒绝。

本轮仅三次重复、单个冻结上下文和单一 Provider，不能宣称统计上确认稳定改善、所有模型最优或整题通过率提高，也无法确定这种偏好源自训练还是远端模板。原名组 1/3 对改名组 3/3 不足以把隐含机理定为已证实最终根因。可将其视为有证据的优化候选，再决定跨上下文验证及统一公共契约变更。

原始 usage 合计：prompt_tokens=50655（包含 cached_tokens=44224）、completion_tokens=1753、total_tokens=52408。实际金额未取得价格信息，未以 cost=0 当免费。

证据：benchmark/artifacts/grep-path-name-diagnosis-2026-09-18/ 下 probe.mts、harness.mjs、pair-1/2/3.json、analysis.json 及 Harness 记录。诊断产物受 gitignore 保护，生产代码未变。

## 移除前序交互对照：因工具选择变化而无法判定参数归因

自动审批最初拒绝新增敏感上下文出站，未执行命令；用户随后明确授权新 6 次请求的数据范围、目标 Provider 和限制。实际执行恰好 6 次，每次最多 2048 输出 tokens/90 秒，无重试、无工具执行。

固定原始 search_path schema、工具集、系统提示、任务及运行事实。原组使用首次 grep 前的第 3 个请求；实验组仅删除其中 assistant/toolResult 交互消息，保留全部 user 消息。六份出站请求去除 assistant/tool 消息后哈希一致，保留的 user 消息哈希一致，确认没有改动工具定义或其他请求控制参数。

| 轮次 | 保留历史                    | 移除历史               |
| ---- | --------------------------- | ---------------------- |
| 1    | grep 生成非法 path          | 只生成 Bash，无 grep   |
| 2    | grep 生成非法 line_col_mode | 只生成 Bash，无 grep   |
| 3    | 两个 grep 均生成非法 path   | 生成两个 Bash，无 grep |

全部 HTTP 200，以 tool_calls 正常结束。**本轮对“历史是否引发 grep 参数错误”的结论是 inconclusive，而不是移除历史后成功。** 清除前序交互改变了模型所处任务阶段和下一步动作，实验组没有发生待考察的 grep 参数生成。不得将 0 次 grep 错误当成 3 次成功，也不得据此宣称 Bash 历史里的 path 是根因。

这是本轮实验设计的局限，不能归咎于模型没有按试验者未给出的要求调用 grep。此次可以观察到历史影响工具选择，但没有得到参数级因果对照。若继续，需要两组共同约束相同的 grep 生成动作（例如同一 tool_choice，先核实实际 Provider 协议能力），并保持该共同约束一致，再改变历史；不能将所有 Bash/glob 删除后的差异直接归因于一个嵌套字段。该后续试验尚未执行，未追加请求。

新的原组错误 line_col_mode 也提示问题不止路径名；仅把 search_path 改名不能自动解决所有额外字段生成问题。原有改名试验的 3/3 合法结果仍只适用于其小样本。

原始 usage 合计 prompt_tokens=47451（含缓存47168）、completion_tokens=515、total_tokens=47966；金额未知。证据目录：benchmark/artifacts/grep-history-diagnosis-2026-09-18/，包含 probe.mts、harness.mjs、pair-1/2/3.json、analysis.json 和 Harness 审计。生产代码未改，生成工具未执行。

## 指定 grep 的历史对照：接口未遵守 tool_choice，2 次后停止

用户明确授权最多 6 次新的指定 grep 对照；自动审批最初拒绝后的确认范围包括火山目的地、凭据使用和系统提示/schema/历史上下文。实际仅执行 2 次，因指定工具行为未成立而提前停止，剩余 4 次未使用。

复用原始 search_path 契约及前序实验上下文，两组共同在诊断脚本的 SDK onPayload 中设定 `tool_choice={"type":"function","function":{"name":"grep"}}`。这是实验的共同控制条件，不是生产功能修改。fetch 边界进一步解析实际 HTTP body 并断言该字段存在且完全相同。原组保留前序交互，实验组移除 assistant/toolResult 历史；除此之外出站归一化哈希一致。

- 保留历史：HTTP 200，原始响应返回两个 grep，均只有 glob/search_path，遗漏必填 regex，实际校验失败。
- 移除历史：HTTP 200，原始响应返回 Bash，未返回 grep；其 arguments 是 ls/git 命令。所有原始参数与本地解析一致，生成工具均未执行。

**确定的新事实：该火山 Agent Plan 请求在收到明确 named tool_choice 后，仍返回另一种工具。** 这说明本次接口行为不能作为强制同工具对照的可靠控制条件。HTTP 200 只证明请求被接受，不证明该选项得到支持或正确执行；可能是该模型/端点忽略或未实现此选项，也可能是远端处理问题，不能仅凭两次响应区分。

此证据让 Provider 协议遵循成为有实测支持的独立疑点，但不证明 Provider 曾把 search_path 改写成 path；没有服务端原始生成/模板证据，不能据此将所有参数错误归给 Provider。历史对 grep 参数的因果影响仍为 inconclusive。不可继续报告参数对照成功，也不追加变更实验绕过预先约定的停止条件。

原始 usage 合计 prompt_tokens=15817、completion_tokens=316、total_tokens=16133。实际金额未知。证据目录 benchmark/artifacts/grep-forced-history-diagnosis-2026-09-18/ 的 pair-1.json（含 requestId、实际发出的 tool_choice 和原始参数）、analysis.json、探针及 Harness 记录。生产代码未改。

## 免费协议复核：指定工具能力尚未得到模型级支持承诺

本轮只检查现有代码、诊断记录和公开官方资料，没有新增模型调用。

1. Z.AI 当前官方 Chat Completion 文档的 tool_choice 仅列 enum 值 auto，没有声明 named/required 可用。来源：https://docs.z.ai/api-reference/llm/chat-completion 。该页面同时提及 GLM-5.3 等当前模型，因此不能将 OpenAI 风格工具选择能力直接套用到 GLM。注意：这是原厂 API 约束，不是火山 Agent Plan 的正式能力声明，不能反过来直接断言火山一定不支持。
2. 火山官方 Python SDK 的 completion_create_params.py 确实接受并说明 `{"type":"function","function":{"name":"..."}}`，证明诊断传入的格式不是拼写错误。但通用 SDK 覆盖多个模型，类型支持不等于特定套餐端点/模型实现支持。来源：https://raw.githubusercontent.com/volcengine/volcengine-python-sdk/master/volcenginesdkarkruntime/types/chat/completion_create_params.py 。火山 Agent Plan 和 API 文档页面本轮仍未成功读取，未取得其 GLM named tool_choice 支持矩阵；社区文章与第三方转录不作为最终依据。
3. 本地核查：生产 ModelRuntime 并未设置 toolChoice；只有上一轮诊断通过 SDK 已有 onPayload 钩子添加该字段。fetch 边界读取真实 body 并断言指定 grep，所以实验字段未在本地被丢弃。该对照失败不是原始 benchmark 的生产 tool_choice 配置回归。
4. 推理设置：当前 ModelRuntime 未显式发送 reasoning effort；SDK 对此 Provider 未按 Z.AI 专属端点规则注入 thinking=disabled，历史 reasoning_content 经本地映射保留。原厂文档说明 thinking 默认 enabled、clear_thinking 默认 true；这是原厂行为说明，不能在没有火山文档或服务端日志时认定火山采用相同默认值。仅凭请求中包含历史 reasoning_content，也不能断言远端一定将它纳入生成上下文。

修正归因：之前将“指定 grep 却返回 Bash”列为 Provider 故障方向，证据仍不足。准确结论为**本次实验依赖未经该模型/端点确认的能力，且实际未得到强制工具行为**。本地传参格式正确，服务端是否支持这一模式未知；不能把 HTTP 200 当成功支持，也不能据此给原始 grep 参数错误归责。

当前根因边界保持：本地没有生成/改写错误 path；当前冻结上下文下 path 改名组出现小样本收益；此前 Bash/glob 历史对首次 grep 参数生成的因果作用仍未分离。下一轮若需要实验，应使用双方一致的明确搜索指令引导同一动作，以真实产生 grep 的响应为有效观测；未产生 grep 必须标为无效样本，不偷换成成功。单靠提示仍无强制保证，不能在结果前承诺一定建立有效对照；不再依赖未知支持状态的 named tool_choice。该建议未执行，生产代码未改。

## 明确搜索指令下的历史对照：两组均出现契约错误

用户明确批准 6 次新增请求。使用原 search_path schema、完整工具集与同一模型设置；两组共同追加同一条 user 消息，包含此前成功工具结果的文本（仓库事实）及明确指令：用 grep 在 /testbed/sphinx 搜索 source-read，不重复探索。未提示参数名，未设置 tool_choice。原组保留历史 assistant/toolResult 消息，实验组移除这些消息；其他 user 消息、系统提示及工具定义保留。工具名由明确指令选择，而非依赖未知协议能力。

六份请求去除历史 assistant/tool 消息后的完整出站哈希相同，保留 user 消息和共同指令哈希相同。每次实际均生成 grep，无无效观测；全部 HTTP 200、tool_calls 正常结束。七个 grep 原始 JSON 参数与本地解析一致，未执行任何工具。

| 轮次 | 保留历史                                             | 移除历史                                             |
| ---- | ---------------------------------------------------- | ---------------------------------------------------- |
| 1    | regex/search_path 正确，但增加非法 `line nausexture` | search_path 正确，遗漏 regex、增加 line_number       |
| 2    | search_path 正确，遗漏 regex                         | search_path 正确，遗漏 regex、增加 line_numbers      |
| 3    | search_path 正确，遗漏 regex、增加 line_number       | 两个 grep 都有 regex/search_path，但增加 line_format |

完整参数请求级合法率均 0/3；调用级分别 0/3、0/4。七个调用均使用 search_path，没有生成 path。`line nausexture` 是原始响应中的实际字段名，不是报告笔误或本地解析产物。

结论：在双方共享明确搜索指令的条件下，移除前序 Bash/glob 交互没有消除工具参数违约。前序交互不是产生这类契约错误的必要条件；不能把问题全归因于 Bash 内嵌 path。但由于本轮双方都没有出现 path，不能估计移除历史对原 path 错误发生率的因果影响，也不能断言历史毫无作用。共同追加指令改变了此前自然调用上下文；原组仍保留历史结果的重复呈现，属于该整体历史变量的一部分，不是对嵌套字段的独立消融。

与前面结果合并，只能确定当前远端模型服务对完整工具 schema 的遵循随上下文不稳定：补充说明没有稳定改善，path 命名对照的小样本改善不能概括所有参数错误，清除前序交互也不是完整解决办法。没有证据证明本地错误命名、错误历史或某条 prompt 是唯一根因；模型内部生成与 Provider 服务端模板仍无法分离。

本轮输出用量原始值：prompt_tokens=50049（含缓存48896）、completion_tokens=364、total_tokens=50413；计费金额未知。证据目录 benchmark/artifacts/grep-directed-history-diagnosis-2026-09-18/，含探针、pair-1/2/3.json、analysis.json 和 Harness 审计。生产代码未改。

## 最小新上下文诊断：当前 schema 六次全部合法

用户明确批准 6 次新的最小案例请求。继续使用现有火山配置，仅发送 system `You are a helpful assistant.`、一条 user 文本块 `Use the grep tool to search for source-read within /testbed/sphinx.` 和原始 grep 定义。没有 Omni 系统提示、其他工具、题目全文、历史消息、tool_choice。每次最多 2048 输出 tokens/90 秒，无重试，工具不执行。

六份完整出站 payload 哈希一致，每次独立从同一干净输入开始。schema 和描述保持原样，SDK onPayload 中断言仅两个消息、一个工具。所有请求 HTTP 200，tool_calls 正常结束，原始参数与本地解析一致。**6/6 次生成完整合法参数，均明确填写 regex=source-read 与 search_path=/testbed/sphinx；其中两次还设置合法 max_results=50。** 并非依靠省略路径通过校验。请求 glm-5.2，响应仍标记 glm-5.3。

这证明当前模型服务在此最小场景能够正确理解原始工具契约，削弱“search_path 本身不可用”的解释。结合复杂输入下的错误，系统提示、工具集或任务材料成为下一步定位因素。但本轮同时简化多个变量，不能把收益独立归因于其中一项，更不能认定跨轮历史污染；同一简单案例六次成功也不是任意任务可靠性的保证。此前已检查的 17 个真实 run 首次请求对应 17 个不同 Session，均无 assistant/toolResult 历史，未发现跨轮继承历史。

若继续，应固定最小任务指令，每轮只加回一个因素，例如完整工具集或 Omni 系统提示；先不改名、不加别名。后续实验未执行。

原始 usage：prompt_tokens=2910（含缓存0）、completion_tokens=290、total_tokens=3200，计费金额未知。证据目录 benchmark/artifacts/grep-minimal-diagnosis-2026-09-18/，含 probe.mts、六次完整出站 payload 与原始参数、analysis.json、Harness 审计。三个进程 exitCode=0、cleanupState=completed；59 个原产物扫描无凭据。汇总校验最初误按字符串检查 SDK user content，实际是合法文本块数组，修正断言后输入检查通过；未因此重发请求或改变模型结果。生产代码未改。

## 历史 benchmark 全程回溯：首次错误与恢复后复发

本轮仅离线读取原始 replay 和 model.request.captured，未新增付费调用、未改生产代码。沿用 first-grep-audit.json 中去重后的 14 个 run，逐条统计完整运行中的 grep tool.call.started。统计口径为额外参数名或缺少 regex；不是重新执行全部 schema 校验，也不代表工具执行结果。

- 共 149 次 grep 调用，其中 32 次存在上述契约错误，31 次含非法 path。14 个 run 中 13 个首次 grep 含 path；全部 run 后续均出现合法字段组合。
- 27 次错误发生在该 run 首次合法 grep 之前，5 次发生在之后。后者包括 4 次 path 复发，以及 Sphinx-10323 seq=11411 的额外 exclude。不能将全部错误概括成首次调用引导不足，也不能将 149 次视为相互独立样本。
- 成功的 Django-12325（verified-medium3）与失败的 Sphinx-8548（verified-medium4）首次 grep 前，完整 systemPrompt 和 tools 对象分别完全相同。排序 JSON SHA-256 前 12 位分别为 6db64da95729、c65a5cf6de0e；这与旧报告按原字符串计算的系统提示哈希口径不同。前者首次及后续共 3 次均合法，后者首次 path 错误、随后 4 次合法。不存在一份静态定义必然导致失败的解释；任务、历史、生成随机性等仍未单独隔离。

| run                                 | 再次生成非法 path 的 seq | 当次请求实际保留的先前 grep 调用 | 其中正确使用 search_path 且无 path |
| ----------------------------------- | ------------------------ | -------------------------------- | ---------------------------------- |
| verified-hard1-prompt-v2-2026-09-15 | 19095                    | 24                               | 23                                 |
| verified-medium1-2026-09-16         | 10686                    | 12                               | 10                                 |
| verified-medium2-2026-09-16         | 4108                     | 4                                | 1                                  |
| verified-medium2-2026-09-16         | 4415                     | 6                                | 2                                  |

以上数量直接读取每个错误前最近的 model.request.captured，而非仅在完整 trace 中找到旧调用。因此这四次复发不能归因为本地请求未携带正确历史。服务端是否使用全部历史，仍无内部可见性。

定位结论：重复现象是不同干净 run 中反复出现的首次契约错误，并包含同一 run 内已正确使用后的复发；并非 benchmark 把上一题错误对话一直带到下一题的已有证据。当前模型服务在复杂任务输入下的契约遵循不稳定是已观察到的故障机制，训练偏好、服务端模板或特定输入干扰仍是未证实的诱因。最小案例 6/6 正确与完整上下文出错只能支持继续隔离输入因素，不能直接认定 Agent 某条提示错误或 LLM 内部唯一根因。

此前原始响应对照证明诊断样本中的非法参数已来自服务端，不是本地解析改名；历史快照证明 schema 正确可见。历史全部运行没有同等级原始 HTTP 抓取，不能将诊断样本的传输排查扩张为逐条历史传输证明。参数错误与最终补丁评测失败必须分别归因；本轮不声称这 32 次错误导致整题失败。
