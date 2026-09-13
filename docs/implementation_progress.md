# 实施进度

更新时间：2026-09-13

## 阶段 1：工程骨架与持久任务 — 已完成

对照技术方案第 17 节：

- [x] pnpm monorepo、React Web、Fastify API、独立 Worker 和共享包。
- [x] SQLite WAL、Prisma 初始迁移，视频/阶段任务/执行记录/结果/事件模型。
- [x] 全局单 Worker 租约与任务租约、续租、过期恢复和旧进程提交隔离。
- [x] 排队和运行中取消、错误分类、退避、手动重试与幂等命令。
- [x] 数据库持久 SSE 事件、Last-Event-ID 重放、后台页面轮询兜底。
- [x] 可由模拟处理器跑通的完整四阶段状态机。
- [x] 连接真实 API 的列表、详情、筛选、执行历史和恢复操作。
- [x] 保留原始 index.html 作为设计参考；模拟结果明确标识。

本阶段使用 StageResult 保存模拟输出事实，不提前创建尚无真实内容的文稿/总结版本。模型配置只做服务端加载及旧变量名兼容，不发起模型调用。第一阶段只允许本机访问，局域网鉴权随后续阶段完善。

## 已完成验证

- pnpm test：15 项通过，无失败，包括临时 SQLite、真实首次迁移、幂等冲突、双 Worker、租约过期、旧提交隔离、取消、重试、结果复用、API 校验和 SSE 游标重放。
- pnpm build：首次完整构建通过。最后的前端修改通过严格类型检查与单独前端构建。
- pnpm dev：迁移 → API/Worker/Web 三进程启动成功。
- Edge + Playwright：1440×1000 桌面、390×844 窄屏；未提供 Browser 插件，使用现有 Playwright 与系统 Edge。
- 页面标题正确、非空白、无框架错误覆盖层、控制台 error/warning 均为零。
- 创建模拟任务 → 转写首次失败 → 确认重试 → 完成；获取视频与提取音频各执行 1 次，转写执行 2 次，共保存 5 条执行记录。
- 刷新后结果保留；搜索更新 URL 并显示空态；运行中取消得到 CANCELED。
- 窄屏详情无横向溢出；API 端口可托管构建后的页面。
- 原 .env 未修改、未被 Git 跟踪；工作区无未提交修改。

## 验证中解决的问题

- 按 pnpm 11 的 allowBuilds 配置允许必要的 Prisma/esbuild 安装脚本。
- Prisma 首次创建 SQLite 的空引擎错误：迁移进程默认设置 RUST_LOG=info，并增加真实首次迁移测试。参考：https://github.com/prisma/prisma/issues/29355
- 补充内嵌站点图标，消除 favicon 404。
- 更正排队任务取消后仍提示等待 Worker 的文案。
- Windows API/Worker 运行期间 Prisma DLL 被占用，完整构建前需停止这些进程，已写入 README。

## 后续阶段

阶段 2 尚未开始：

1. 增加 artifact、transcript/segment、summary 和 prompt version 迁移。
2. 流式上传、文件大小/格式限制、FFprobe 校验、原子保存与音频提取。
3. 使用现有 .env 接入真实 S2T、音频分片检查点与时间偏移。
4. 使用 docs/ai_summary_system_prompt.md 接入 LLM、严格结构输出和长文稿 Map-Reduce。
5. 补充文稿、总结版本展示与真实单视频闭环测试。
6. 增加文件事实完整性恢复检查；真实提供商错误分类和日志脱敏。

阶段 3 至阶段 5 按原计划推进 B 站下载去重、结果与 Excel 导出、设置与提示词管理、UP 主追踪、安全回归、备份和清理。不将当前模拟功能标记为完整 V1 验收通过。
