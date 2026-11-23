# 女魔导士 v76 定版记录

本次固定用户认可的 v76，并将完整的女角色资源及其运行时依赖纳入版本控制。正式入口为 `apps/omni-game/resources/characters/financial-analysis.tres`。Agent ID、金融分析能力和 Session 协议不随角色美术改变。

## 当前采用内容

- 女角色保留现有 32 帧 idle、24 帧 walk、47 帧 climb、工作及两床/沙发资源，跳跃采用 33 帧 v76。
- jump 的 F0、F28—F32 与正式 idle 第一帧使用相同纹理；既有 idle 仍有披风和眨眼循环。
- 动态帧整条统一按 672/640 恢复像素密度，去除输入留白；没有逐帧缩放或身体形变。空中只作整帧根点平移，实际位移仍由 PartnerActor 负责。
- 女性固定世界倍率 0.34、步速 128 px/s；跳跃准备 0.12 秒、落地恢复 0.24 秒，运动阶段由真实速度和接触状态驱动。起落、顶点、下落、接触界线为 9/13/16/20。
- CharacterPresentation 持有角色移动与家具外观配置；PartnerActor 仍是物理位置唯一所有者，PartnerAnimator 只消费运动状态。
- 修正两个图形测试的模拟点击：完整发送按下/释放后才等待下一帧，防止桌面鼠标移动插入并取消按钮按压。仍走真实 Viewport 输入分发，不直接调用 UI 业务信号。

## 固定来源与验收证据

| 文件                                     | 含义                                       |
| ---------------------------------------- | ------------------------------------------ |
| [source-v76.webm](source-v76.webm)       | 用户认可的完整 v76 来源，未重新生成        |
| [idle-reference.png](idle-reference.png) | 正式透明 idle 母版                         |
| [gameplay.mp4](gameplay.mp4)             | 24 场景实际运动/渲染录像，76.17 秒、60 fps |
| [chapters.json](chapters.json)           | 录像每个场景的起止时间                     |
| [manifest.json](manifest.json)           | 来源与生产文件 SHA-256，以及确定性导出参数 |

录像来自提交 `b8c59793` 中加载正式资源的 MageWalkLab（旧录屏工具现已移除），使用真实 WorkshopWorld、PartnerActor、PartnerAnimator；24 场景之间重置位置，每段内部保留完整动作。正式 Main 通过独立图形回归验证。验收时源工作区存在未随本次提交发布的选角背景/排版精修；本 PR 保留基础分支的选角视觉，只提交人物资源尺寸配置和测试修复。

## 验证

覆盖普通/聚焦、左/右、原地跳、移动跳、短按与连续跳、落地立即走、吊桥、平台边缘支撑和走落下一层。

```bash
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run verify:game --visual
```

`verify:game` 已接入 `CharacterMotionHarness`，自动复验两名角色的跳跃、攀爬衔接和 idle。历史完整录像保留；不再维护逐帧录屏、临时报告和旧截图实验入口。
本次已完成的源工作区检查：24 组跳跃行为通过；完整游戏图形回归、类型检查及 122 文件 / 780 项测试通过。独立 PR 工作区复验结果记录于 PR 描述；不将源工作区结果冒充不同提交内容的验证。

## 保留限制

- F17、F19、F23 附近在聚焦下仍可辨认插值软边，不宣称逐帧手绘质量；本次保留已认可素材。
- 审核工具持续保持 2.15 倍聚焦跨平台下落时，镜头平滑跟踪会滞后，足部短暂出画；完整录像约 55.5 秒、74.6 秒可见。左侧地图边缘还有前景遮挡和裁切，不能把受遮挡姿势记为完整轮廓通过。
- 正式 Main 的对话聚焦禁用移动，持续聚焦跳跃属于审核压力路径。这些镜头/边界事项单独保留，不继续扩大本次跳跃迭代，也不据此宣布所有镜头无条件通过。

## 清理与回退

源工作区删除 5840 个可重建的录屏/解码帧与重复选角截图，约 2.95 GiB。保留完整录像、关键截图、v20/v69/v73/v76 原片、生产资源；历史实验不批量纳入 Git。本目录包含本次 review 所需的自足证据，不依赖随机端口或临时目录。

旧版女角色的三份未引用定义及三张录像衍生对照图、旧清理流水摘要，已在 PR 清理时移出当前目录；均可从提交 `8d8e3b8b` 恢复。完整原片、实机录像、章节索引与正式 idle 保留，落地和聚焦出画可直接按章节及上文时间点复核。

若需回退跳跃，先从 `8d8e3b8b` 恢复 `rose-mage-animations.tres`、`rose-mage-animation-set.tres` 和 `rose-mage-locomotion.tres`（原路径及散列见 manifest 的 `archived_resources`），再将 `financial-analysis.tres` 的两条资源引用从 `rose-mage-animation-set-v76.tres`、`rose-mage-locomotion-v76.tres` 改回恢复的 `rose-mage-animation-set.tres` 和 movement 目录的 `rose-mage-locomotion.tres`。不覆盖用户的其他文件修改。
