# 升级说明

## 0.2.0

- 运行时从 Python runner 改为原生 TypeScript/ESM，旧 `pythonPath` 配置不再被接受。
- 默认工具由旧版 9 个移植工具扩展为 10 个，新增 `syntax_check`；工具组和参数由 rc2 Config 管理。
- `safe_edit`、`multi_edit` 和 `safe_rollback` 使用 DSH `ctx.fs`、session cwd、版本观察和 sandbox policy。跨文件操作是逐文件提交与补偿恢复，不是瞬时跨文件事务。
- 索引库从旧项目 `.codegraph` 派生位置迁移到插件状态目录；索引必须显式建立，查询不会自动创建库。旧 Python 代码图数据库不会自动迁移。
- HTTP 使用固定 DNS 地址、无环境代理和新的缓存身份；正文转换器、边界与错误字段可能与 Python/MCP 版本不同。
- 只读 SQLite 结果对超安全范围整数和 BLOB 使用结构化 JSON 表示；只接受 SELECT 和查询型 PRAGMA。
- 固定 grammar/runtime WASM 随包发布，安装不执行 Python 或运行时下载 parser 资产。

升级前删除旧 `pythonPath` 配置；如需要旧索引，保留原目录并在新插件中重新执行 `code_index`。
