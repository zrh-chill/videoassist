# 实施进度

更新时间：2026-09-13

## 阶段 1：工程骨架与持久任务 — 已完成

已交付 pnpm 工作区、React Web、Fastify API、独立 Worker、SQLite WAL/Prisma、持久任务与事件、租约恢复、取消、退避、幂等及模拟处理器。原 index.html 保留为设计参考，页面往返已恢复渐隐/渐入效果。

## 阶段 2：本地视频闭环 — 已完成

- [x] Artifact、Transcript/Segment、Summary、PromptVersion、Checkpoint 模型与增量迁移。
- [x] 流式上传、大小/扩展名限制、FFprobe 内容校验、SHA-256 与原子移动。
- [x] FFmpeg 16kHz 单声道 FLAC 提取，按时长及模型上传容量限制分片。
- [x] 使用现有 .env 真实调用 SenseVoice；分片检查点支持失败续传与全局时间偏移。
- [x] 使用现有 .env 真实调用 Qwen，加载指定系统提示词，JSON 校验及一次格式修复。
- [x] 长文稿令牌估算、Map-Reduce、Map 检查点复用。
- [x] 文稿/总结版本保留、提示词不可变版本绑定与重新总结。
- [x] 本地/B 站导入入口、来源筛选、结果阅读、版本选择、复制和失败重试。
- [x] 媒体缺失/哈希改变时在模型调用前明确失败。
- [x] 更新运行说明和环境变量示例，实际 .env 未修改、未提交。

当前 SenseVoice 仅返回全文；文稿采用分片时间范围并明确标注 CHUNK 精度，不伪造逐句时间戳。

## 提前接入的阶段 3 能力

根据用户提供的测试链接接入：

- [x] https 标准 BV 链接规范化，移除追踪参数，拒绝伪造主机与凭据 URL。
- [x] yt-dlp 元数据和视频下载，FFmpeg 合并、超时、容量监控和取消子进程。
- [x] Cookie 文件引用及稳定错误分类。
- [x] BVID 唯一约束及事务去重。

阶段 3 尚需补齐短链接解析、多分 P 支持范围、重新下载与完整下游产物失效策略。当前只支持标准链接的第一分 P，不将阶段 3 标记为全部完成。

## 真实视频验收

- 视频：https://www.bilibili.com/video/BV17xo9BsEnx/
- 标题：【城】开源 Agent 之王 Hermes，到底厉害在哪？
- 任务 ID：a90eb4a8-85c2-40bd-b319-a0149eddd000
- 四阶段均真实完成，未使用模拟处理器替代模型。
- 转写模型：FunAudioLLM/SenseVoiceSmall，全文 5,965 字符，1 个分片时间范围。
- 总结模型：qwen3.7-flash，渲染总结 2,759 字符，包含四个结构化字段。
- 再次带不同追踪参数导入，返回同一任务且 duplicate=true。
- 重启后文稿、总结、执行记录完整保留。

## 自动化与页面验收

- pnpm test：23 项通过，包含原持久任务测试以及新增真实 FFmpeg/本机模型 HTTP 桩测试。
- 已验证：真实上传闭环、BVID 并发去重、无效/超限文件拒绝、分片首次成功后第二片失败仅补调失败片、时间偏移、旧总结/提示词版本保留、模型错误脱敏与一次修复、长文稿 Map-Reduce。
- pnpm build：Prisma 客户端生成、严格类型检查和 Vite 正式构建通过。
- Windows WAL 重启问题修复后，单独回归真实迁移测试通过；最终严格类型检查通过。
- pnpm dev：客户端生成 → 两次已提交迁移 → Web/API/Worker 启动成功。
- Edge + Playwright，1440×1000 桌面及 390×844 窄屏：导入真实链接 → 打开既有完成任务 → 阅读/复制总结 → 阅读/复制文稿 → 选择版本 → 刷新 → 来源筛选 → 本地上传入口。
- 无页面运行错误、无框架错误覆盖层、窄屏无横向溢出。Browser 技能未提供，使用已安装 Playwright 与系统 Edge。
- 截图保存在本次任务的 visualizations 目录：phase2-summary.png、phase2-mobile.png。

## 本次解决的运行问题

Prisma 在 Windows 对已有 WAL 数据库执行迁移时出现锁冲突。迁移前使用单连接正常检查点并暂时切换回滚日志，服务初始化再启用 WAL。新增模拟写入后直接退出进程的重启测试，验证业务数据保留；未删除数据库或锁文件。

## 后续工作

- 阶段 3 收尾：短链接、重新下载与下游失效策略。
- 阶段 4：Excel 导出、设置与连接测试、提示词管理界面。
- 阶段 5：UP 主追踪、手动检查、备份、临时文件清理、日志轮转及完整 V1 验收。

当前保留所有原视频和音频；在线备份、自动清理尚未实现。外部调用完成但本地检查点提交前崩溃时仍可能产生重复模型调用。

## 接口依据

- SenseVoice 请求/响应：https://docs.siliconflow.cn/docs/api/audio-transcriptions-post
- Qwen 结构化输出：https://docs.modelstudio.console.alibabacloud.com/zh/model-studio/qwen-structured-output
- 采用 JSON Object 模式兼容当前 Qwen 模型，再进行本地严格字段校验。
