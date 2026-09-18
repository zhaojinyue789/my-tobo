# my-tobo

极简双端待办应用：原生 TypeScript（无 UI 框架）+ Vite 构建的单文件前端，Tauri 2.x 桌面壳。待办数据存本地 localStorage，可通过 GitHub 私密 Gist 在手机与电脑之间同步（30 秒自动轮询 + 冲突按最后修改时间合并，删除用 30 天墓碑防止复活）。

## 本地运行

```bash
npm install
npm run tauri dev   # 桌面端（Tauri 壳）
npm run dev         # 仅前端，浏览器 / 手机 PWA 调试
```

## 同步配置（可选）

1. 打开应用右上角 ⚙「同步设置」。
2. 点击「点此创建 Token」，在 GitHub 创建**仅勾选 `gist` 权限**的 Token（最小权限原则）。
3. 粘贴 Token；没有 Gist 就点「创建新私密 Gist」，已有则填 Gist ID（直接粘贴完整 Gist 页面地址也可以，会自动提取 ID）。
4. 另一端（手机 PWA 或电脑）填入相同 Token 与 Gist ID 即可双端同步。

> ⚠️ **Token 安全**：Token 等同于你 GitHub 账号在 gist 范围内的操作权限，请勿泄露给他人，泄漏后立即到 GitHub 后台吊销。当前版本 Token 明文保存在本机 localStorage 中，请勿在不可信设备或共用电脑上配置同步。

## 构建单文件

```bash
npm run build
```

产物为 `dist/index.html` 单文件（JS/CSS 已内联），可直接双击离线使用（file:// 协议），也可部署到任意静态空间作为手机端 PWA。
