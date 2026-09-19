# NIGHTLY 值守记录（undo/redo 命令栈 + 拖拽排序）

## 起点快照（Step 0）

- 起始 commit：`495530c72b62dc92ab474ca6a58656a845c96eff`（main HEAD，工作区干净）
- 分支：`nightly/undo-dnd`（自上述 commit 新建，全程不推 main）
- 基线状态：`npm run build`（tsc && vite build）✅ 通过，tsc 无错误
- Node 版本：v24.15.0（用于纯逻辑仿真测试，不引入任何依赖）
- 已知问题：无。源码已全量审阅（main/todo/ui/sync/notify/style.css）。
- 红线确认：不碰 src-tauri/ 与 .env；不写任何 Token/Gist 地址；无新 npm 依赖。

## 执行进度（每个提交点一行）

- [DONE] Step 0 自检：基线 build/tsc 通过，分支已建，快照落盘
- [DONE] Step 1 设计：DESIGN.md / DECISIONS.md 落盘（docs 提交）
- （后续逐行补充）

## 改动清单（收尾时填写 commit hash）

| 提交 | hash | 说明 |
| --- | --- | --- |
| （待填） | | |

## 验收结果（收尾时逐条标记 PASS/FAIL/SKIP）

1. npm run build 成功、tsc 无新增错误：待验
2. 撤销/重做闭环、超栈丢弃、空栈安全、清除全部一次恢复、刷新后栈仍在：待验
3. 桌面/移动可拖、300 次连续拖拽 order 整数/无重复/无 NaN：待验
4. 筛选切换相对顺序保持、一次撤销精确还原拖拽（含重整前顺序）：待验
5. 旧数据（无 order）稳定排序、首次拖拽写入不乱序：待验
6. 无 console.error、无未处理 rejection：待验
7. grep 自查无 token/ghp_/gist 残留：待验
8. undo 栈不同步 Gist、order 走既有推送链路：待验

## 明早验证清单（人工）

1. `git merge nightly/undo-dnd` 前先跑 `npm run dev` 手感确认
2. 桌面浏览器拖拽 + Ctrl+Z / Ctrl+Shift+Z
3. 手机 PWA 长按拖拽（长按约 250ms 激活，防止误触滚动）
4. 双端同步：一端拖拽、另一端刷新看顺序；一端撤销、另一端看结果
5. 旧数据（升级前列表）打开确认顺序为「旧→新」自上而下（有意变更，见 DECISIONS.md D1）

## 合并命令（明早手动执行，本值守不合并）

```bash
git checkout main
git merge --no-ff nightly/undo-dnd -m "merge: undo/redo 命令栈 + 拖拽排序（夜间值守）"
git push origin main
```

## 已知问题 / 断点（收尾时填写）

（待填）
