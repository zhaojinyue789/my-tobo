# DESIGN：undo/redo 命令栈 + 拖拽排序（夜间值守设计稿）

> 约束回顾：不引入依赖/框架；不改 v2 既有字段语义；新字段末尾可选带默认值 + 迁移兜底；
> 撤销/重做必须覆盖拖拽；每步 build 通过才提交。取舍细节见 DECISIONS.md。

## 1. 新增数据与存储

### 1.1 新增字段：`Todo.order?: number`

- 追加在 `Todo` 接口**末尾**、可选；语义：**显式排序序号，升序 = 界面自上而下**。
- 旧数据无该字段 → 不回填，显示时按 `createdAt` 稳定推导（见 1.3）。
- 校验/迁移函数（todo.ts）：
  - `normalizeOrder(value: unknown): number | undefined` —— 仅接受安全整数（`Number.isSafeInteger`）；
    非整数 / NaN / ±Infinity / 越界（超出安全整数范围）一律视为缺失，走推导分支。
  - 既有 `migrate(item)` 增加一行 `order: normalizeOrder(item.order)`（幂等，非法值清空）。
  - sync.ts `sanitizeRemoteTodo` 同样用 `normalizeOrder` 清洗远端值（远端无该字段 → undefined，兼容旧客户端）。
- Gist payload 版本号保持 `version: 2`（可选字段追加不破坏 v2 契约）。

### 1.2 新增 localStorage key：`my-tobo.undo`

- 结构：`{ v: 1, undo: Command[], redo: Command[] }`；**仅本地，永不上传 Gist**。
- 与主数据（`my-tobo.todos`）完全独立；命令仅以 id 引用条目，不内嵌可变状态
  （create 的 payload 内嵌初始 Todo 快照属不可变历史，不参与同步）。
- 迁移函数签名（undo.ts）：`loadUndoState(): UndoState` —— 旧数据无此 key / JSON 损坏 / 结构非法
  → 返回 `{ undo: [], redo: [] }` 空栈兜底，绝不抛错；逐条校验命令结构，非法条目剔除。
  `saveUndoState(state): boolean` —— 写失败（配额等）返回 false，栈保留在内存（本次会话仍可撤销），console.warn 一次。
- 上限：`UNDO_LIMIT = 50` 步；超出丢弃**最旧**（undo 与 redo 各自独立裁剪）。

### 1.3 排序推导（防精度塌陷核心）

- 常量：`ORDER_STEP = 1024`、`REBALANCE_THRESHOLD = 256`（todo.ts 导出）。
- **推导序**：缺 `order` 的条目，其有效序值 =「全量列表按 `createdAt` 升序（id 升序决胜）的名次 + 1」× STEP。
  推导值与显式值同刻度（都是 STEP 的整数倍或其间中点），可安全混比。
- **比较函数**（`sortTodos`）：主键 `order ?? 推导值` 升序；相等比 `createdAt` 升序；再相等比 id。全序确定，列表不闪烁。
- **落点决策：order 存主数据（Todo 字段）而非独立索引表**。理由：验收要求 order 走既有推送链路，
  独立表需改造 Gist payload 结构与合并逻辑，风险大；字段随条目走 LWW，天然双端一致。
- 与筛选的关系：`sortTodos` 先于 `applyFilter`（render 里 `applyFilter(sortTodos(todos), view)`），
  筛选只裁剪不重排 → 「筛选/分类切换后相对顺序保持」天然成立。

## 2. 命令类型清单（undo.ts，7 类）

命令统一形状 `{ type, payload, inverse }`，JSON 可序列化；应用方一律**纯函数**返回新数组；
所有应用（forward / inverse）都会把受影响条目的 `updatedAt` bump 为当前时间（保证 LWW 同步，见 D4）；
`null` 在 changes/restores 中表示「清除该字段」（JSON 无 undefined 的替换记法）。

| type | payload（重做/正向） | inverse（撤销） | 说明 |
| --- | --- | --- | --- |
| `create` | `{ todo: Todo }`（初始快照） | `{ id }` | 撤销 = 打墓碑而非物理删除（防同步复活，D3）；重做 = 若缺失则按快照恢复，若墓碑则复活 |
| `update` | `{ id, changes }` | `{ id, changes: 旧值 }` | changes ⊆ {text, completed, category, dueDate}；toggle/改分类/改日期各记一条 |
| `delete` | `{ id }` | `{ id, deletedAt: 旧值|null }` | 正向 = markDeleted（fresh 时间戳）；撤销恢复墓碑前状态 |
| `undelete` | `{ id }` | `{ id, deletedAt, updatedAt }` | 预留命令（当前无 UI 触发），正向 = 去墓碑 |
| `clearAll` | `{ targets: [{id}] }` | `{ restores: [{id, deletedAt: null}] }` | **清除全部 / 清除已完成均记为单条命令**（D5）；targets 仅含操作时的现存条目 |
| `reorder` | `{ id, writes: [{id, order}] }` | `{ restores: [{id, order: number|null}] }` | 一次拖拽 = 一条命令；writes 覆盖本次全部 order 写入（含首次物化与内联重整） |
| `rebalance` | `{ writes: [{id, order}] }` | `{ restores: [{id, order: number|null}] }` | 独立重整命令（合并后检测到重复序值时调度） |

- `restores.order = null` 表示该条目拖拽前**没有** order 字段，撤销时移除该字段（精确还原）。
- 命令引用的 id 在应用时可能已不存在（30 天墓碑清理、远端删除）→ 静默跳过，不报错（D7）。

## 3. order 的写入时机与插入计算

- **懒写入**：加载/合并绝不回填 order。两类写入时机：
  1. **新建条目**：创建时即赋 `order = 末项有效序值 + STEP`；空表从 `STEP` 起（新项默认排末尾，D1）。
  2. **首次拖拽**：执行「物化」——给全部现存（未删）条目按当前有效顺序写入显式序号 `(名次+1)×STEP`；
     此后所有现存条目都有显式值，新条目创建时也赋显式值 → 混合窗口基本消除（D2）。
- **插入取值**（在可见列表、剔除被拖项后的插入位 `targetIndex`）：
  - 顶部：`首项序值 − STEP`；底部：`末项序值 + STEP`；中部：`floor((前项 + 后项) / 2)`。
  - 中部若 `后项 − 前项 < REBALANCE_THRESHOLD(256)`，或计算出的新序值与任何其他现存条目序值相等 → 触发**内联重整**。
- **批量重整 rebalance**：全部现存条目按当前有效顺序重编号为 `(名次+1)×STEP`（相对顺序不变）；
  拖拽引发的重整**并入同一条 reorder 命令**（一次撤销还原重整前顺序）；独立触发的重整记为 `rebalance` 命令。
- **触发调度**：同步合并后检测到现存条目存在相等有效序值（`hasDuplicateOrders`）→ 调度重整，
  `queueMicrotask` 合并同一 tick 内的多次触发（防抖，一 tick 至多一次）。
- **合并为一次推送**：无论物化+移动+重整产生多少写入，都汇聚进同一条命令、一次 `persist()`，
  由既有 3 秒防抖链路单次 PATCH 推送。

## 4. 拖拽交互

### 4.1 主干：原生 HTML5 Drag & Drop（桌面）

- 事件委托绑定在 `#todo-list`：`dragstart`（记录 id、`effectAllowed=move`、源项加 `.dragging` 半透明浮起）、
  `dragover`（`preventDefault` 允许放置；计算插入位并**只移动占位节点**，不重渲染列表；位次未变时零 DOM 操作）。
- 占位符：独立 `li.drag-placeholder`（高度 = 被拖项高度，虚线框），直观显示落点。
- `dragend`/`drop`：按占位符位置计算 `targetIndex`，与原位相同 → 仅清理；不同 → `planReorder` 生成命令入栈 + `persist()`。
- `dragstart` 目标为 `select/input/button` 时 `preventDefault`（控件交互优先，不误起拖拽）。
- 拖拽期间屏蔽 `render()` 重建（防同步回调打断）；Esc 取消拖拽。
- **性能**：dragover 仅 O(N) 找插入位 + 单节点移动，无渲染；500 条下无可感知卡顿。

### 4.2 降级：touch 模拟（移动端）

- 理由：移动浏览器普遍不触发原生 DnD 事件；touch 三事件模拟是唯一可靠路径。
- 范围：**仅拖拽起滑与跟手逻辑降级**，落点计算/命令生成/占位符与桌面完全复用同一套代码。
- 手势：**长按 ≈250ms 激活**（激活前 `touchmove` 视为滚动意图，取消激活计时）；激活后 `touchmove`
  `preventDefault` 跟手移占位符，`touchend` 提交。控件（select/input/button）上的触摸永不激活拖拽。
- 边缘自动滚动：拖拽期间 rAF 循环，指针距视口上下边 <48px 时逐帧 `scrollBy`（鼠标与触摸共用）。
- 触摸目标：`(pointer: coarse)` 下 `.todo-item` min-height 44px，勾选/删除按钮放大，行内禁用文字选中/长按呼出。

## 5. 跨端不对称取舍（写入设计，后果明示）

- **undo 栈仅本地、不同步 Gist**：
  - 后果 1：两端的撤销历史互不相通，A 端的撤销不会在 B 端出现。
  - 后果 2：两端可各自撤销「同一段历史」，命令按 id 操作 + LWW 裁决，先应用者胜，不产生数据损坏，
    但可能出现「B 端撤销了一条 A 端已经撤销过（并同步）的操作」→ 幂等跳过或产生一次等价改写。
  - 后果 3：命令引用的条目若已被对端删除/清理，应用时静默跳过。
  - 理由：命令流同步需要双向命令日志与去重协议，超出本夜范围且高风险；本地栈已满足验收 2/4/8。
- **order 走 LWW**：
  - order 写入必 bump `updatedAt`，随条目整体参与「最后写入胜出」。
  - 后果 1：两端同时拖拽 → 时间晚的一端胜出，早的一端的手工排序可能被覆盖（不丢条目，只丢排序）。
  - 后果 2：两端并发「新建」可能得到相等序值 → 比较函数以 createdAt 决胜不闪烁，合并后触发一次 rebalance 归一。
- **撤销/重做即数据变更**：每次应用都 bump `updatedAt` 并走 `persist()` → 3 秒防抖推送，
  撤销结果会同步到另一端（这是特性而非缺陷：两端看到一致的撤销效果）。

## 6. 未决项

| # | 问题 | 保守选择（已按此实现） | 备选 |
| --- | --- | --- | --- |
| U1 | 新项位置：任务书要求「排末尾」，与现状「最新在顶」冲突 | 按任务书：升序显示、新项在末尾 | 保持最新在顶（推导与新项取 `首项−STEP`） |
| U2 | 首次拖拽写入范围 | 全量物化现存条目（一次性写入，混合窗口最小化） | 仅写被拖项（写入最小，混合窗口长期存在） |
| U3 | 清除已完成是否入栈 | 记为单条 clearAll 型命令 | 不入栈（撤销盲区） |

## 7. 已知局限（≥5 条）

1. 撤销历史不跨设备；每端最多 50 步，更早操作不可撤销。
2. 命令引用的条目被 30 天墓碑清理或远端物理删除后，相关撤销/重做静默跳过（不报错也不还原）。
3. 大列表 + 频繁重整时命令栈 JSON 可观（500 条 rebalance ≈ 数十 KB/条 × 50 条上限）；
   localStorage 配额写失败时栈退化为会话内存态，刷新即失。
4. 拖拽进行中恰逢远端合并回调时，本次拖拽按合并前的可见顺序计算落点（概率极低，下次操作自愈）。
5. 极端场景下（一端从未联网同步且从未拖拽）推导序值与对端显式序值的理论混合比较，两端显示顺序可能短暂分歧；
   任一端完成一次拖拽（全量物化）后消除。
6. 触摸拖拽需长按激活，短触滑动仍为页面滚动（防误触的取舍）。
7. 无 Ctrl+Y 重做别名（按任务书仅 Ctrl+Z / Ctrl+Shift+Z / Cmd 变体）。
8. 撤销/重做会刷新受影响条目的 `updatedAt`（LWW 需要），时间戳非历史精确值；`notified` 等设备本地状态不参与命令。
