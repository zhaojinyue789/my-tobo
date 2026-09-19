# Changelog

## [0.1.0] - 2026-09-19

### 🐛 Bug 修复

- **同步窗口数据竞态（I-1）**：修复慢网环境下同步进行中新增/修改的待办被旧快照覆盖丢失的问题。
  - 同步写回前重读本地状态（localChanged 标记），合并差异
  - 期间的用户改动防抖 3 秒后自动补推
  - 测试方法：Network 面板限速 Slow 3G → 点击同步 → 立即新增一条待办 → 验证不消失（TEST_CASES.md 场景 A）
- **网络挂起卡死（I-2）**：Gist 请求加入 15 秒超时（AbortController），断网/代理挂起时不再永久停留"同步中…"，轮询循环可恢复。
  - 测试方法：Network 面板切 Offline → 点击同步 → 15 秒内出现超时提示、按钮恢复（TEST_CASES.md 场景 B）
- **远端脏数据（I-5）**：Gist 返回条目逐字段校验，脏数据丢弃并打印 error 日志，防止污染渲染与本地存储；下轮同步自动清理 Gist 中的脏条目。
  - 测试方法：网页上改坏 Gist JSON → 应用不白屏、脏条目被丢弃（TEST_CASES.md 场景 C）
- **存储写入失败无反馈（I-3）**：localStorage 写入统一 try-catch，配额超限时顶栏提示"存储空间已满，请清理旧待办"，恢复后自动隐藏。
- **Gist ID 容错（I-10）**：粘贴完整 Gist 页面地址（含查询参数/锚点）自动提取末尾 ID 入库。

### 🔒 安全改进

- **Token 隔离存储（P1）**：GitHub Token 从 localStorage 迁移至 Tauri Store（`app_data_dir/my-tobo.json`）。
  - 与网页存储隔离，清浏览器数据不丢失，关窗/重启后 Token 不丢失、无需重复输入
  - 浏览器 / PWA 端自动回退 localStorage；旧版混存配置启动时自动迁移
  - 注意：Store 为明文 JSON 落盘（**非加密**）；如需加密保管，后续可迁系统钥匙串 / stronghold
  - 测试方法：关闭应用 → 重新打开 → Token 自动保留

### ⚡ 性能优化

- **ETag 条件请求（P2）**：Gist GET 请求加入 `If-None-Match` 头，本地缓存上次响应。
  - 远端未变化时返回 304 直接复用缓存，不产生响应体，对 GitHub API 配额友好
  - 测试方法：连续同步两次 → Network 面板观察第一次 200、其后远端未变更时 304

### 📝 文档

- 新增 README（运行/构建/Token 配置与安全说明）与 TEST_CASES.md（同步核心逻辑人工回归用例）。

### 🛠 技术栈

- Tauri 2（Rust 壳）+ 原生 TypeScript 前端（无 UI 框架）+ Vite 单文件产物
- 新增依赖：`@tauri-apps/plugin-store`（JS + Rust 双端官方插件）
