# Search path contract paid validation — 2026-09-18

## Scope and result

用户同意的小规模验证：现有火山 Provider / ARK_AGENT_PLAN_API_KEY，grep、glob 各 3 次；单次最多 2048 输出 tokens、90 秒、无重试、无工具执行。未启动完整 benchmark。

| 目标 | 请求数 | 实际目标调用 | 参数结果                                  |
| ---- | ------ | ------------ | ----------------------------------------- |
| grep | 3      | 5            | 5/5 合法；3 个显式 path，2 个省略可选路径 |
| glob | 3      | 0            | 三次均选择 Bash，参数验证 inconclusive    |

六次 HTTP 200，正常 toolUse 结束，原始参数与 SDK 解析一致，未发生超时或输出截断。请求模型 glm-5.2，响应标记 glm-5.3。生成的 Bash 和搜索调用均未执行。

## Inputs and interpretation

使用历史 grep/Sphinx-11510 与 glob/Sphinx-7590 首次错误前的完整快照。保留原始任务、系统提示、历史消息和工具集；将 grep 的 search_path、glob 的 dir_path 改为 path，并断言两项工具 schema/说明等于当前生产定义。旧 glob 快照中 strict=true 在诊断脚本转换为当前 inputConstraint=prefer；生产代码未增加旧协议兼容。每组 3 次出站请求哈希一致，分别从固定输入独立开始，不继承诊断响应。

没有追加强制工具选择或搜索指令，因此模型可能改变动作。glob 历史快照处于任务开头，本次模型只选择 Bash，导致未获得参数级观测；这是验证覆盖不足，不是 glob 失败或成功。后续验证应显式给出 glob 文件发现任务，并以确实生成目标工具为有效样本；本轮未追加请求。

grep 结果支持改名后的契约在该历史上下文可用，与此前改名小样本结果一致。不过本轮两种路径字段同时更新、没有同期旧版对照，且有两次省略路径，不能据此量化因果收益或声明整题通过率提高。

## Diagnostic script correction

第一批本地尝试全部在网络调用之前失败：glob 的旧 strict 声明被当前运行时拒绝；grep 的请求对象含 undefined 缓存字段，序列化后消失，错误的深比较断言阻止出站。通过禁用网络的离线复现定位，修正为比较 JSON 序列化结果并转换旧声明；首批没有 Provider 请求，不占实际六次请求。首批 Harness 进程虽为 exitCode=0，但保存的错误表明业务诊断失败，未将其视为成功证据。第二批有完整 HTTP 请求标识及原始响应。

## Evidence and usage

产物位于 gitignored 的 benchmark/artifacts/search-path-contract-validation-2026-09-18/ 和同名 -attempt2/。包含快照、探针、Harness preflight/run、请求 payload、脱敏原始工具参数及 analysis.json。首批和第二批均保留，未覆盖失败证据。

六次实际用量：prompt_tokens=40587（含 cached_tokens=28800）、completion_tokens=835、total_tokens=41422。计费价格未知，未推算金额。126 个产物文件扫描未发现该凭据值；三个正式 Harness run 均 exitCode=0、cleanupState=completed。

## Glob 补充验证：明确文件发现动作

用户要求补齐后，新增恰好 3 次独立请求，继续使用同一历史 glob 快照和当前改名后的 schema。每次只追加相同指令：

> Next, use the glob tool to find all Python files recursively within /testbed/sphinx. Generate the file discovery tool call now; do not repeat repository exploration or use Bash.

没有提示 path/dir_path 等参数名，没有 tool_choice。每次最多 2048 输出 tokens、90 秒、无重试、无工具执行。三次实际出站 payload 哈希一致，每次从原始快照独立开始；没有上一轮诊断响应进入下一轮。继续经当前 ModelRuntime、既有 Provider、SDK 和 Harness preflight/run 执行。

**3/3 请求都只生成一个 glob，3/3 参数通过当前 schema 校验。** 三次参数均为 `{"pattern":"sphinx/**/*.py"}`，省略可选 path。快照明确 cwd=/testbed，因此该模式符合所要求的 /testbed/sphinx 范围；此为参数语义核查，并未在容器中实际执行查找。

所有 HTTP 200、正常 toolUse 结束，原始 JSON 与 SDK 解析深比较一致；请求模型 glm-5.2，响应模型 glm-5.3。三个 Harness run 均 exitCode=0、cleanupState=completed。没有生成 Bash 或旧 dir_path 字段。

覆盖边界：已补齐此前“没有实际生成 glob”的缺口；证明当前完整工具定义在明确任务下能够生成合法调用。三次都省略 path，不能声称验证了显式 path 的稳定性，更不能把本次无旧版对照的结果用作改名因果收益或 benchmark 通过率证明。后续若专门评估显式路径行为，需要独立场景设计；本轮未追加请求、未执行完整 benchmark、未改生产代码。

本轮 usage：prompt_tokens=15375（含 cached_tokens=15296）、completion_tokens=168、total_tokens=15543；计费金额未知。证据在 gitignored benchmark/artifacts/glob-directed-validation-2026-09-18/，含原始快照、探针、三份请求响应和 Harness 记录、analysis.json。扫描 60 个原产物文件未发现凭据值。
