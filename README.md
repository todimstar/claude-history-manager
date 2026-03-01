# Claude History Manager

> 2025-02-28 晚，实在受不了 Claude Code 对话历史无法管理、无法删除，怒而开写。
> 2025-03-01 上午 v1.0 发布。下午，Claude VSCode 插件 2.1.63 更新，官方加了删除功能。
>
> 被截胡了，但没完全被截胡 —— 官方只给了个"删除按钮"，这里是一整套对话历史管理方案。

Claude Code 对话历史可视化管理工具。查看、搜索、安全删除、恢复你的 Claude Code 对话数据。

## 为什么还需要这个？

| 能力 | Claude 插件 2.1.63 | 本项目 |
|------|:------------------:|:------:|
| 删除对话 | ✅ | ✅ |
| 软删除 + 回收站 | ❌ | ✅ |
| 误删恢复 | ❌ | ✅ |
| 全局搜索对话内容 | ❌ | ✅ |
| 磁盘占用可视化 | ❌ | ✅ |
| 孤立文件检测清理 | ❌ | ✅ |
| 批量删除 | ❌ | ✅ |
| 子代理 / debug / file-history 一并管理 | ❌ | ✅ |

**一句话：** 官方给了个删除按钮，这里给的是回收站 + 文件管理器 + 磁盘清理大师。

## 功能

- **仪表盘** — 磁盘占用统计、项目概览、空间分布可视化
- **对话浏览** — 按项目查看会话列表，展开查看完整消息流
- **全局搜索** — 跨项目搜索对话关键词，高亮显示匹配
- **安全删除** — 软删除移至回收站，支持恢复；彻底删除不可逆
- **批量操作** — 多选会话批量删除
- **回收站** — 查看已删除会话、恢复到原位、清空回收站
- **孤立文件清理** — 自动检测已失效的 debug 日志和文件历史，安全清理释放空间
- **文件管理器集成** — 一键在系统文件管理器中打开对应目录

## 快速开始

```bash
git clone https://github.com/your-username/claude-history-manager.git
cd claude-history-manager
npm install
npm start
```

浏览器打开 `http://localhost:3456`。

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CHM_PORT` | `3456` | 服务端口 |
| `CHM_HOST` | `0.0.0.0` | 监听地址 |
| `CHM_CLAUDE_DIR` | `~/.claude` | Claude 数据目录 |

## 技术栈

- **后端**: Node.js + Express（唯一依赖）
- **前端**: Vue 3 (CDN) + 原生 CSS
- **零构建**: 没有 Webpack、没有 Vite、没有 TypeScript —— 开箱即用

## 数据安全

删除是高危操作，本项目做了多层防护：

**路径安全（三层防线）**
1. Session ID 严格 UUID 校验 — 从根源防止路径遍历
2. 项目名白名单字符校验 — 只允许 `[a-zA-Z0-9._-]`
3. 路径边界检查 — 所有解析后的路径必须在 `~/.claude/` 内

**软删除机制**
- 删除 = 移动到 `~/.claude/trash/`，不是真删
- 完整保存：对话 JSONL + 子代理 + debug 日志 + 文件历史
- `meta.json` 记录所有恢复信息（原项目、删除时间、history.jsonl 条目）
- 恢复 = 原封不动移回原位，byte 级无损

**原子操作**
- `history.jsonl` 修改采用临时文件 + 重命名策略，防止并发写入损坏

## 测试

```bash
node test/delete-safety.test.js
```

34 项测试覆盖：输入校验、软删除、恢复完整性、彻底删除、批量操作、回收站、孤立文件、边界条件、API 一致性。

## API

### 项目与会话

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/projects` | 项目列表 |
| GET | `/api/sessions?project=xxx` | 会话列表 |
| GET | `/api/session/:id?project=xxx` | 会话详情 |
| DELETE | `/api/session/:id?project=xxx` | 软删除（移至回收站） |
| POST | `/api/sessions/batch-delete` | 批量软删除 |

### 搜索与统计

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/search?q=keyword` | 全局搜索 |
| GET | `/api/stats` | 磁盘占用统计 |

### 回收站

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/trash` | 列出回收站 |
| POST | `/api/trash/:id/restore` | 恢复会话 |
| DELETE | `/api/trash/:id` | 彻底删除 |
| POST | `/api/trash/purge` | 清空回收站 |

### 孤立文件

| 方法 | 路由 | 说明 |
|------|------|------|
| GET | `/api/orphans/debug` | 检测孤立 debug |
| GET | `/api/orphans/file-history` | 检测孤立文件历史 |
| DELETE | `/api/orphans/debug/:sid` | 删除孤立 debug |
| DELETE | `/api/orphans/file-history/:sid` | 删除孤立文件历史 |
| POST | `/api/cleanup/debug` | 批量清理 debug |
| POST | `/api/cleanup/file-history` | 批量清理文件历史 |

## 项目结构

```
claude-history-manager/
├── server.js          # 后端 API（Express）
├── public/
│   ├── index.html     # 页面模板 + Vue 组件
│   ├── app.js         # Vue 3 应用逻辑
│   └── style.css      # Tokyonight 深色主题
├── test/
│   └── delete-safety.test.js  # 删除安全测试
└── package.json
```

## 回收站数据结构

```
~/.claude/trash/
└── <sessionId>/
    ├── meta.json              # 恢复元数据
    ├── conversation.jsonl     # 对话记录
    ├── subagents/             # 子代理（如有）
    ├── debug.txt              # 调试日志（如有）
    └── file-history/          # 文件版本历史（如有）
```

## License

MIT
