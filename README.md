# 帧语 FrameNote

依据 docs/videoassist_bilibili_v1_technical_design.md 的实施计划开发。当前交付**阶段 1：工程骨架与持久任务**。

原始 index.html 保留为视觉 demo。可运行应用位于 apps/web，已沿用其浅色网格、深色侧栏和荧光绿视觉语言。

## 当前能力

- pnpm 工作区：React + TypeScript + Vite Web、Fastify API、独立 Worker。
- SQLite WAL + Prisma 已提交迁移，持久保存视频、阶段任务、执行历史、结果、请求幂等记录和 SSE 事件。
- 四阶段模拟流水线：获取视频 → 提取音频 → 转写 → 总结。
- 单 Worker 全局租约、阶段租约、过期恢复、旧进程提交隔离、结果指纹复用。
- 排队/运行中取消、手动重试、可重试错误的退避调度、崩溃次数上限。
- 任务列表、URL 搜索筛选、游标分页、详情、执行记录及 SSE 重放；10 秒轮询兜底。
- 只允许本机监听，同源校验，未知异常不会原样返回第三方响应或密钥。

**当前没有真实上传、FFmpeg、S2T、LLM、B 站下载、Excel、UP 主追踪和设置编辑。** 模拟任务使用 SIMULATION 来源，结果明确标注，不混入未来真实视频数据。

## Windows 启动

需要 Node.js 22.12+ 和 pnpm 11.19.0。在项目根目录执行：

```powershell
pnpm install
pnpm db:generate
$env:ENABLE_SIMULATION='true'
pnpm dev
```

- Web：http://127.0.0.1:5173
- API：http://127.0.0.1:3001
- pnpm dev 先应用迁移，再启动 Web/API/Worker；Ctrl+C 结束进程组。
- 也可将 ENABLE_SIMULATION=true 加到已有 .env。不要用示例文件覆盖已有模型密钥。
- 不设置 ENABLE_SIMULATION 时，模拟创建接口关闭，Worker 明确报错并退出。
- MOCK_STAGE_MS 默认 1500 毫秒，可调大观察运行中取消。
- .env 已加入忽略列表，现有 S2T_API_URL/S2T_MODEL 和 write_API_URL/write_MODEL 变量名已兼容加载。真实请求及密钥引用解析在阶段 2 接入。
- 第一阶段尚不支持局域网访问，APP_HOST 只接受本机地址。

## 构建与单独运行

```powershell
pnpm build
pnpm db:migrate
$env:ENABLE_SIMULATION='true'
pnpm start:api
# 另开终端，同样设置 ENABLE_SIMULATION=true
pnpm start:worker
```

构建后的前端由 API 同源提供，可直接访问 http://127.0.0.1:3001。开发时可分别执行 pnpm dev:api、pnpm dev:worker 和 pnpm dev:web。

Windows 下执行 pnpm build 或 pnpm db:generate 前，应先停止正在运行的 API/Worker，以免 Prisma 引擎 DLL 被占用。仅构建前端可在服务运行时执行 pnpm --filter @videoassist/web build。

## 验证

```powershell
pnpm test
pnpm build
```

测试使用操作系统临时目录中的独立 SQLite 数据库，不读取或调用模型密钥，不修改实际业务数据库。覆盖完整状态链路、指纹、幂等冲突、双 Worker 互斥、崩溃恢复、续租、过期提交、取消竞态、重试、缓存复用、API 参数与同源保护及 SSE 游标重放。

页面验证：创建正常模拟任务观察四阶段完成；创建“全文转写首次失败”任务，详情确认失败后重试，应保留获取/音频的首次成功记录，只增加转写与总结记录。运行中取消应停止处理且不生成下游结果。

## 数据与恢复

默认数据目录为 data，数据库为 data/db/videoassist.sqlite。迁移由 Prisma migrate deploy 应用，禁止以 db push 替代生产迁移。启动迁移命令会自动创建目录。

全局租约与任务租约均为 2 分钟。当前模拟处理每秒续租并检查取消标记；真实长阶段可进一步分离 30 秒续租与取消检查。进程终止后，运行任务保持租约，过期后由下一 Worker 恢复；对应旧执行记录标记 INTERRUPTED。每个任务最多自动尝试 3 次，手动重试增加新的尝试预算，保留历史。

阶段输出和成功状态、下游任务、事件在同一数据库事务中提交。Worker 不在事务中等待外部处理。恢复后相同输入指纹可复用已保存结果；未来模型调用在外部完成但本地未提交时仍可能重复计费，需在后续适配层增加分片检查点或供应商幂等支持。

当前未实现备份命令、日志轮转、事件清理和真实媒体完整性恢复检查，这些随后续实施阶段补充。运行时不要单独复制正在写入的 SQLite 主文件；临时备份可在正常停止所有进程后保存整个 data 目录，在线备份能力待后续实现。

## 目录边界

- apps/web：页面、查询缓存与事件订阅。
- apps/api：请求校验、命令入口、事件流与健康检查。
- apps/worker：串行执行、取消检查与租约维护。
- packages/contracts：共享 DTO、输入校验及枚举。
- packages/domain：阶段顺序、指纹、错误分类与处理器接口，不依赖 Web/数据库/媒体框架。
- packages/database：Prisma、短事务、任务仓储。
- packages/integrations：模拟处理器；后续添加 FFmpeg、B 站与模型适配器。
- packages/storage：受限路径和本地目录。
- packages/config：服务端配置加载，不返回或打包密钥。

下一阶段按技术方案实现本地视频真实闭环，复用本阶段任务机制。
