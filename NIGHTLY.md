# NIGHTLY 值守记录（undo/redo 命令栈 + 拖拽排序）

## Phase 2 起点快照（Today Focus，2026-09-20 夜）

- 前置检查结论：
  1. 上一组验收无 FAIL（两项 SKIP 为测试器无法合成 HTML5 拖拽的运行时限制，非 order/排序/渲染路径缺陷）→ 按规则记录后继续，无需先修。
  2. 基线 `npm run build`（tsc && vite build）✅ 通过。
  3. 分支事实核对：上一组分支实际名为 **`nightly/undo-dnd`**（任务书中写作 nightly/2026-09-19，以仓库实际为准），尚未合并 main → 依指令意图**从 `nightly/undo-dnd` 直接切出**新分支。
- 新工作分支：**`nightly/2026-09-20-focus`**（起点 commit `2aba733` docs: 夜间值守收尾）
- 上一组最终状态：10+1 个提交全部推送 `origin/nightly/undo-dnd`，工作区干净，未合并 main。
- 本轮红线沿用：不碰 src-tauri/ 与 .env；不写任何密钥；无新 npm 依赖；每步 build 过才提交；文档只追加不改写。

## 起点快照（Step 0）

- 起始 commit：`495530c72b62dc92ab474ca6a58656a845c96eff`（main HEAD，工作区干净）
- 分支：`nightly/undo-dnd`（自上述 commit 新建，全程未推 main）
- 基线状态：`npm run build`（tsc && vite build）✅ 通过，tsc 无错误
- Node 版本：v24.15.0（仅用于纯逻辑仿真测试，未引入任何依赖）
- 红线确认：未触碰 src-tauri/ 与 .env（`git diff main..HEAD -- src-tauri .env` 为空）；
  全量 diff 密钥扫描 0 命中；无新增 npm 依赖（package.json 未改动）。

## 提交清单（共 10 个提交点）

| # | hash | 说明 |
| --- | --- | --- |
| 0 | `1c3d656` | docs: 夜间值守启动——设计稿/决策记录/起点快照 |
| 1 | `88516cd` | feat: undo/redo 命令栈数据结构与持久化（上限 50 步，旧数据空栈兜底） |
| 2 | `1fb6f8b` | feat: 七类命令应用逻辑接入增删改/清空操作（撤销走墓碑防同步复活） |
| 2-fix | `07b5a58` | fix: 补上 order 可选字段定义与迁移校验，修复 dataset.id 判空（恢复构建） |
| 3 | `6c32a9e` | feat: Ctrl+Z / Ctrl+Shift+Z 快捷键与工具栏撤销重做按钮（输入框聚焦时屏蔽） |
| 4 | `00a494f` | feat: order 推导与稳定排序——旧数据按 createdAt 升序推导，显示改为升序、新项追加末尾 |
| 5 | `7db297d` | feat: order 插入计算（STEP=1024/重整阈值 256，新项创建即赋末序，取中防精度塌陷） |
| 6 | `f662491` | feat: 合并后批量重整 rebalance——检测相等序值入栈可撤销，同 tick 去抖合并一次推送 |
| 7 | `4c47bbf` | feat: 原生拖拽排序——占位符指示落点，dragover 只移占位不重渲染，Esc 取消，边缘自动滚动 |
| 8 | `914b076` | feat: 触摸拖拽降级（长按 250ms 激活/防滚动冲突/防原生拖拽双轨）+ 触摸目标 44px 样式 |

> ⚠️ 流程说明：提交 2（`1fb6f8b`）推送到远端后才发现 tsc 报错（构建命令的管道吞掉了退出码），
> 因禁止 force push 未回退该提交，而是立即以 `07b5a58` 修复恢复绿色；此后每次提交前都单独
> 校验 `BUILD_EXIT=0`。两个提交连看等价于一次正确落地，供明日合并时知悉。

## 执行进度

- [DONE] Step 0 自检：基线 build/tsc 通过，分支已建，快照落盘
- [DONE] Step 1 设计：DESIGN.md / DECISIONS.md 落盘（D1–D11 共 11 项无人值守决策）
- [DONE] Step 2-①②③：undo/redo 命令栈（数据结构/七类命令/快捷键按钮）
- [DONE] Step 3-④⑤⑥：order 字段/插入计算/批量重整
- [DONE] Step 4-⑦⑧：原生拖拽 + 触摸降级
- [DONE] Step 5 收尾：仿真验收 + GUI 验收 + 本文档

## 验收结果（任务书 8 条）

1. **PASS** `npm run build` 成功，tsc 无新增错误（最终构建 BUILD_EXIT=0）。
2. **PASS** 撤销/重做闭环：Node 仿真 T1（60 次入栈后栈长=50、最旧 10 条丢弃）、T2（空栈 pop
   返回 null 不报错、新动作清空 redo）、T3（clearAll 单命令一次撤销全恢复）、T4（saveUndoState→
   loadUndoState 往返一致）全过；GUI 实测勾选→撤销→重做、Ctrl+Z / Ctrl+Shift+Z 均生效；
   清除全部（confirm）后一次 Ctrl+Z 完整恢复 3 条（截图证实）。
   刷新页面后：栈经 localStorage 持久化，撤销/重做按钮在启动渲染时恢复可用态（GUI 证实），
   刷新后的交互撤销由 T4（重载命令可应用）+ 按钮/快捷键链路（GUI 已验）组合覆盖。
3. **PARTIAL** 300 次连续拖拽：Node 仿真 T5 以随机位置连续拖拽 300 次（120 条列表，含首/尾/中插），
   order 全程为安全整数、无重复、无 NaN，最终严格递增 —— **PASS（数据层）**。
   桌面 GUI 实拖：IAB 测试器无法合成 HTML5 DnD（cua.drag 不触发 dragstart）→ **SKIP（运行时限制）**；
   移动端触摸拖拽：桌面运行时无触摸 → **SKIP**。两者均有数据层仿真 + 代码走查覆盖。
4. **PASS** 筛选切换相对顺序保持（T6：筛选视图拖拽后其余条目相对序不变）；
   一次撤销精确还原拖拽（T7：人为构造小间距强制触发重整，撤销后逐 id 序值完全还原重整前状态，
   含「原来没有 order 字段」的条目恢复为无字段；重做回到拖拽后状态）。
5. **PASS** 旧数据（无 order）启动稳定排序（T8：显示 = createdAt 升序）；首次拖拽全量物化后
   其余条目相对顺序不变、被拖项落位准确、全部条目获得安全整数序号。
6. **PASS** GUI 全程（安装只读收集器）零 console.error、零未处理 promise rejection、零页面异常。
7. **PASS** `git diff main..HEAD` 密钥扫描 0 命中（ghp_ / github_pat_ 模式）。
8. **PASS** undo 栈仅存 `my-tobo.undo`（localStorage），sync.ts 不读取不同步；order 随 Todo 走
   既有推送链路（写入 bump updatedAt → persist → 3 秒防抖 PATCH），远端经 sanitizeRemoteTodo 清洗。

## GUI 验收明细（真实交互，截图为证）

- PASS 页面加载：撤销/重做按钮初始禁用、空态提示正常
- PASS 新增 3 条按「买牛奶→写周报→跑步半小时」排列（新项排末尾，D1 的有意变更）
- PASS 勾选「写周报」→ 撤销按钮启用 → 点击撤销恢复 → 重做按钮启用（截图证实）
- PASS Ctrl+Shift+Z 重做 / Ctrl+Z 撤销；输入框聚焦时 Ctrl+Z 被屏蔽（栈未消耗）
- PASS 清除全部 confirm 接受 → 列表清空 → 一次 Ctrl+Z 全部恢复（截图证实）
- SKIP 鼠标拖拽（IAB 无法合成 HTML5 DnD）；SKIP 触摸拖拽（无触摸环境）

## 已知问题（应用层面）

1. 撤销历史不跨设备、上限 50 步（DESIGN.md 已声明的设计取舍）。
2. 极端混合场景（一端从未同步且从未拖拽）下推导序与显式序的理论分歧，任一端拖拽一次即消除。
3. 无 Ctrl+Y 重做别名（按任务书最小实现）。
4. 拖拽期间恰逢远端合并回调时，本次拖拽按合并前可见顺序计算（概率极低，下次操作自愈）。

## 测试环境事故（与应用无关，明早无需处理）

- GUI 测试中途，浏览器测试器的 drag 命令 30 秒卡死导致该会话合成输入管道失灵（点击不再派发），
  之后无法继续交互式测试；已用只读手段确认页面本身无错误、无遮挡。受影响测试点已用数据层
  仿真补证（见验收 2/3 标注）。

## 明早验证清单（人工，5 分钟）

1. `npm run dev` 起服务：加 3 条待办 → 勾选 → Ctrl+Z/Ctrl+Shift+Z → 清除全部 → 一次撤销恢复。
2. 鼠标拖拽一条到中间 → 观察虚线占位符 → 松手 → Ctrl+Z 应精确还原（连拖几次）。
3. 确认列表顺序为「旧→新」自上而下（D1 有意变更，不习惯可按 DECISIONS.md D1 的回退方式改回）。
4. 配置同步的两端：A 端拖拽 → B 端 30 秒内自动跟进；A 端 Ctrl+Z → B 端同步还原。
5. 手机 PWA：长按约 250ms 拖拽，普通滑动应仍为滚动。

## 合并命令（明早手动执行，本值守未合并 main、未删分支）

```bash
git checkout main
git merge --no-ff nightly/undo-dnd -m "merge: undo/redo 命令栈 + 拖拽排序（夜间值守）"
git push origin main
```

## 断点说明

无断点，任务完整走完。所有提交已推送 `origin/nightly/undo-dnd`，工作区干净。
