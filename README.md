# dsh-irmia-devkit

原生 TypeScript 实现的 Irmia DevKit 精选工具包，适配 DeepSeek Harness `dsh-v0.2.1-rc.2` / `dsh-v0.2.1-rc.3`。生产环境不依赖 Python，也不启动 MCP/Python 桥接。

## 默认工具

插件默认注册 10 个工具：`safe_edit`、`multi_edit`、`safe_rollback`、`syntax_check`、`http_get`、`http_post`、`code_index`、`code_explore`、`code_diff_impact` 和 `db_query`。本次不注册 `code_pack`，也不复制 MCP 的全部 60 个工具；普通文件操作、Git、命令执行和简单网页抓取继续使用 DSH 原生工具。

## 安装与兼容

包是 DSH bundle，peer 依赖为 DSH `0.2.1-rc.2 || 0.2.1-rc.3`；Node 要求 `^22.19.0 || >=24.0.0`。通过 DSH 插件管理器安装，不手动编辑官方 preset：

```sh
dsh plugin --profile <profile> add dsh-irmia-devkit
```

启用后重启或等待当前 profile 的正常 HMR 应用。本仓库不会自动安装到用户当前 profile。

## 安全边界

相对路径以调用 Agent 的 `session.header.cwd` 为基准。文件修改通过 `ctx.fs`、版本检查、观察策略和当前 sandbox policy；受限模式拒绝写入时不降级到宿主 `fs`。备份写入固定插件状态目录，不接受模型传入的任意备份路径。备份保存原始字节哈希，恢复前检查目标仍是本批次版本；恢复冲突保留人工修改并报告失败。

`safe_edit` 支持精确替换、发生次数消歧、行号前缀、缩进容错、`insert_at_line` 和 `delete_lines`。`new` 为空表示删除匹配内容。`multi_edit` 先准备和检查所有文件，再逐文件提交；它提供失败补偿，不宣称跨文件瞬时事务。

HTTP 默认拒绝私网、环回、链路本地、保留、CGNAT、映射地址和未指定地址；实际 socket 使用已验证的 DNS 地址，不继承环境代理。GET 才允许有限重试，POST 不重试。二进制响应返回提示，不推荐本插件不存在的下载工具。

代码索引只允许当前文件 provider 的会话工作区，索引库位于插件状态目录。`code_index` 在 `read-only` 下拒绝，`code_explore`/`status`/`impact` 只读已有库。索引使用真实语法树提取符号、导入和调用/继承引用，再按文件作用域与导入唯一解析成边；同名但无法唯一确认的引用保持未解析，实例方法调用不做类型推断。`code_explore` 支持 `kind:` 过滤、分词 FTS 和 `起点 → 终点` 的调用链查询；`code_diff_impact` 返回真实最短反向层数和受影响文件。索引是静态近似，动态调用可能未被发现。

索引记录每个文件的 provider 版本：查询发现版本变化时只报告 `index_stale` 并提示 `code_index(incremental=true)`，不会静默改写索引。增量更新会清除已删除、超限或不再可解析文件的旧记录；扫描因 `indexMaxFiles` 被截断时不清库，避免误删未看到的文件。语法有错的文件仍会写入已识别的符号，数量由 `files_with_parse_errors` 单独报告。

## 配置

主要配置包括 `stateDir`、备份保留数量和大小、编辑/HTTP/索引/数据库上限、工具组 `enabledGroups`。`pythonPath` 已移除；配置中继续使用它会在加载时失败，而不是静默退回 Python。部署变化的限制由 Config 校验，不通过工具参数关闭安全检查。

## 开发与验证

```sh
pnpm install --ignore-scripts
pnpm run build
pnpm test
```

测试使用独立临时目录和真实 rc2 文件服务/Loader 组合；不会使用用户 profile。固定 grammar 和 runtime 位于 `assets/`，`assets/manifest.json` 记录 SHA256。第三方许可见 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)，升级差异见 [UPGRADE.md](UPGRADE.md)。

## 来源与许可

核心行为以 `Kalospacer/irmia_devkit_mcp` v2.7.3 和 `irmia2026/irmia_devkit_open` 为行为参考；本实现保留原作者与 AGPL-3.0 许可，并用独立 TypeScript/WASM/Node rc2 机制承接。
