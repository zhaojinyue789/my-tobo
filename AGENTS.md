# my-tobo 项目工作约定

## 改动自动同步 GitHub（用户长期要求）

- 每完成一批改动并验证（`npm run build` 通过）后，立即 `git add -A` 提交并推送到 `origin/main`，不要等用户催促。
- 提交信息用中文 conventional commits（`feat:` / `fix:` / `docs:` / `chore:`），一行概括本批改动。
- 提交前用 `git diff` 快速自查：不得包含 Token / 密钥（`ghp_`、`github_pat_` 等开头的字符串或 token/secret 赋值）；发现则只提交安全文件，并在回复中说明跳过了哪些。
- 推送失败（网络 / 权限）时保留本地提交、向用户说明原因，不要反复重试，禁止 force push。
- 用户明确要求「先不要同步」时，跳过本次推送。
