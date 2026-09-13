# 视频转写与总结应用 V1 技术方案

## 1. 文档目标

本文档将《视频转写与总结应用产品需求文档》转化为可实施的 V1 技术方案，覆盖系统架构、模块边界、数据模型、任务状态机、接口、文件存储、安全、测试、部署和实施顺序。

本文档的设计前提如下：

- V1 为个人使用、单机部署的 Web 应用，不设计多租户和复杂权限体系。
- 一台机器只运行一个 Worker，视频获取、音频处理、转写和总结默认串行执行。
- 数据库保存业务事实和任务状态，文件系统保存体积较大的媒体文件。
- S2T 与语言模型通过可配置的 HTTP 接口调用，优先兼容 OpenAI 风格接口。
- B 站解析和下载通过可替换的适配器实现，V1 默认调用 `yt-dlp`，并允许配置 Cookie 文件引用。
- 应用默认只监听本机地址；若要暴露到局域网，必须显式启用访问令牌或置于带认证的反向代理之后。

## 2. 关键技术决策

| 领域 | V1 选择 | 选择理由 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite | 单页管理应用，无 SSR 需求，构建和部署简单 |
| UI 与状态 | React Router、TanStack Query、轻量组件库 | 服务端状态、轮询和失败重试处理清晰，不引入大型全局状态框架 |
| API | Node.js + TypeScript + Fastify | 与前端共享类型，文件流和 REST/SSE 支持成熟，运行开销低 |
| Worker | 独立 Node.js 进程 | 隔离长耗时任务，不阻塞 API；可复用同一领域层与数据访问层 |
| 数据库 | SQLite（WAL 模式）+ Prisma | 满足个人单机和单 Worker场景，零额外服务，迁移成本低 |
| 任务调度 | 数据库任务表 + 租约（lease） | 任务可恢复、可重试且无需 Redis；后续可替换为专用队列 |
| 媒体处理 | FFmpeg / FFprobe 子进程 | 行业通用，便于获得媒体元数据并生成统一音频 |
| B 站适配 | `yt-dlp` JSON 输出和下载命令 | 将平台变化隔离在适配器内，不把解析逻辑散落到业务层 |
| Excel 导出 | ExcelJS 流式生成 | 支持大文本、多个工作表和响应流 |
| 进度更新 | SSE + 页面失焦时低频轮询兜底 | 单向进度通知足够，复杂度低于 WebSocket |
| 部署 | Docker Compose 或本机进程 | 同时兼顾易用部署和 Windows 本机 FFmpeg/显卡工具链 |

### 2.1 V1 不引入的基础设施

- 不引入 Redis、RabbitMQ 或 Kafka。V1 单 Worker 并发不需要独立消息基础设施。
- 不将视频二进制保存进数据库，避免数据库膨胀和备份困难。
- 不把转写和总结放在 HTTP 请求生命周期内，避免刷新页面或请求超时导致任务丢失。
- 不在数据库中直接保存模型密钥或 Cookie 内容，只保存环境变量名或文件引用。

### 2.2 升级边界

当出现多用户、多节点 Worker 或需要并行处理多个长视频时，建议将 SQLite 升级为 PostgreSQL，并将任务执行迁移到 Redis/BullMQ 或工作流引擎。领域接口、阶段任务模型和文件存储接口保持不变，以控制迁移范围。

## 3. 总体架构

```text
┌──────────────────────┐
│ React Web            │
│ 列表 / 详情 / 设置   │
└──────────┬───────────┘
           │ REST + SSE
┌──────────▼───────────┐
│ Fastify API          │
│ 校验 / 查询 / 命令   │
│ 上传 / 导出 / 事件   │
└──────┬────────┬──────┘
       │        │
       │        └──────────────────────┐
       │                               │
┌──────▼──────────┐          ┌─────────▼─────────┐
│ SQLite          │          │ 本地文件存储      │
│ 业务数据/任务   │          │ raw/audio/temp    │
│ 日志/配置       │          │ cover/export      │
└──────▲──────────┘          └─────────▲─────────┘
       │                               │
┌──────┴──────────┐                    │
│ Worker          │────────────────────┘
│ 持久任务执行器  │
└───┬────┬────┬───┘
    │    │    │
 FFmpeg yt-dlp S2T/LLM HTTP API
```

### 3.1 进程职责

#### Web

- 展示视频列表、详情、任务进度、UP 主和系统设置。
- 上传本地视频、提交 B 站链接、发起重试或取消。
- 通过 SSE 接收状态变更；SSE 断开时按 10 秒间隔轮询活动任务。
- 不持有模型密钥，不直接访问媒体工具和第三方接口。

#### API

- 负责参数校验、幂等校验、数据库事务和文件上传流。
- 将用户命令转化为持久化阶段任务，不直接执行长耗时操作。
- 提供 Excel 流式导出和受控的媒体/封面访问。
- 发布数据库中的任务事件，供 SSE 客户端订阅。

#### Worker

- 轮询并领取可执行任务，定期续租。
- 执行 B 站元数据解析与下载、FFmpeg、S2T 和 LLM 调用。
- 记录每次执行的输入、结果、耗时、可重试错误和日志摘要。
- 每个阶段成功后，在同一事务内保存结果并创建下一阶段任务。
- 收到取消标记时终止可安全终止的子进程或远程请求。

## 4. 推荐代码组织

```text
videoassist/
├─ apps/
│  ├─ web/                    # React 页面与组件
│  ├─ api/                    # Fastify 路由、上传、SSE、导出
│  └─ worker/                 # 任务领取、阶段处理器、租约续期
├─ packages/
│  ├─ domain/                 # 实体、状态机、领域错误、用例
│  ├─ database/               # Prisma schema、迁移、Repository
│  ├─ contracts/              # API DTO、Zod schema、共享枚举
│  ├─ integrations/           # FFmpeg、Bilibili、S2T、LLM 适配器
│  ├─ storage/                # 文件存储接口及本地实现
│  └─ config/                 # 配置加载、校验和密钥引用解析
├─ data/                      # 运行数据，不提交 Git
├─ docs/
├─ compose.yaml
├─ pnpm-workspace.yaml
└─ package.json
```

领域层不能依赖 Fastify、Prisma、FFmpeg 或具体模型 SDK。外部能力均通过接口注入，以便测试和替换实现。

## 5. 核心领域模型

### 5.1 视频与来源

`videos` 是列表和详情页的聚合根，保存当前状态快照，但不承载大段文本。

| 字段 | 类型/约束 | 说明 |
| --- | --- | --- |
| `id` | UUID/ULID，主键 | 内部视频 ID |
| `source_type` | `LOCAL` / `BILIBILI` | 来源类型 |
| `bvid` | 可空字符串 | B 站唯一标识 |
| `original_url` | 可空字符串 | 规范化后的原始链接 |
| `local_original_name` | 可空字符串 | 上传时的原文件名，不作为磁盘路径 |
| `title` | 字符串 | 标题或本地文件名 |
| `creator_id` | 可空外键 | 关联 UP 主 |
| `published_at` | 可空时间 | B 站发布时间 |
| `duration_ms` | 可空整数 | 视频时长 |
| `cover_url` | 可空字符串 | 原封面地址 |
| `overall_status` | 枚举 | 当前总体状态快照 |
| `current_stage` | 可空阶段枚举 | 当前或最近失败阶段 |
| `latest_error_code` | 可空字符串 | 稳定错误码 |
| `latest_error_message` | 可空字符串 | 面向用户的脱敏错误摘要 |
| `created_at` / `updated_at` | 时间 | 审计时间 |

约束与索引：

- 唯一索引：`(source_type, bvid)`，其中 `bvid IS NOT NULL`，保证 BVID 去重。
- 索引：`overall_status`、`source_type`、`creator_id`、`published_at`、`created_at`。
- 本地上传在流式写入时计算 SHA-256，记录到 `source_hash`。V1 默认仅提示重复，不强制合并两个同内容、不同文件名的本地任务。

### 5.2 媒体文件

`artifacts` 记录文件事实，业务表不直接拼接绝对路径。

| 字段 | 说明 |
| --- | --- |
| `id`, `video_id` | 主键及关联视频 |
| `kind` | `SOURCE_VIDEO`、`AUDIO`、`COVER`、`TEMP` |
| `storage_key` | 相对数据根目录的路径键 |
| `size_bytes`, `sha256`, `mime_type` | 文件校验信息 |
| `retention` | `KEEP`、`DELETE_AFTER_TRANSCRIPT`、`TEMPORARY` |
| `created_at`, `deleted_at` | 生命周期时间 |

磁盘上的文件存在不代表阶段成功；只有文件原子移动完成并提交 `artifacts` 记录后，文件才可供后续阶段使用。

### 5.3 转写

- `transcripts`：`id`、`video_id`、`revision`、`full_text`、`language`、`provider`、`model`、`duration_ms`、`is_current`、`created_at`。
- `transcript_segments`：`transcript_id`、`sequence`、`start_ms`、`end_ms`、`text`。
- 同一视频可以有多个转写修订版；仅一个版本 `is_current = true`。
- 分段时间统一以原视频起点为零，音频分片的局部时间由 Worker 转为全局时间后写入。

### 5.4 总结与提示词

- `prompt_versions`：提示词名称、不可变正文、内容哈希、版本号、创建时间。
- `summaries`：`video_id`、`transcript_id`、`prompt_version_id`、`provider`、`model`、结构化 JSON、渲染文本、耗时、`is_current`、创建时间。
- 结构化 JSON 包含 `one_sentence`、`key_points[]`、`detailed_summary`、`keywords[]`。
- 重新生成总结创建新记录，不覆盖旧记录。详情页默认读取 `is_current = true` 的版本。

### 5.5 UP 主追踪

- `creators`：`uid` 唯一、昵称、主页链接、`latest_limit`、`auto_process`、启用状态、上次检查时间、最近错误。
- `creator_checks`：一次检查一条记录，保存开始/结束时间、发现数量、新增数量、状态和脱敏错误。
- 检查发现的视频仍通过统一的“导入 B 站视频”用例写入，依赖 BVID 唯一约束兜底去重。

### 5.6 任务与执行记录

`jobs` 表示待执行的阶段命令：

| 字段 | 说明 |
| --- | --- |
| `id`, `video_id` | 任务 ID 与视频 ID |
| `stage` | `FETCH`、`EXTRACT_AUDIO`、`TRANSCRIBE`、`SUMMARIZE` |
| `status` | `QUEUED`、`RUNNING`、`SUCCEEDED`、`FAILED`、`CANCELED` |
| `attempt` / `max_attempts` | 当前尝试次数和最大次数 |
| `available_at` | 可领取时间，用于退避重试 |
| `lease_owner`, `lease_expires_at` | Worker 租约 |
| `input_fingerprint` | 阶段输入指纹，用于幂等判断 |
| `cancel_requested_at` | 取消标记 |
| `last_error_code`, `last_error_message` | 最近一次脱敏错误 |
| `created_at`, `started_at`, `finished_at` | 生命周期时间 |

`stage_runs` 每次尝试一条：阶段、尝试序号、开始/结束时间、执行结果、退出码、错误分类、日志摘要、输入输出元数据。完整的工具原始输出写入受轮转限制的文件日志，数据库只存脱敏且截断后的摘要。

## 6. 状态机与幂等策略

### 6.1 总体状态

```text
WAITING
   │
   ▼
FETCHING ──► EXTRACTING_AUDIO ──► TRANSCRIBING ──► SUMMARIZING ──► COMPLETED
   │                │                   │                │
   └────────────────┴───────────────────┴────────────────┴──► FAILED
                                                               │
                                                               └── 重试原失败阶段
任一未完成状态 ──取消──► CANCELED
```

总体状态是当前阶段的展示快照，阶段成功事实以产物记录和成功的 `stage_runs` 为准。失败不会删除此前的成功产物。

### 6.2 阶段输入指纹

每个任务以规范化输入生成 SHA-256 指纹：

- `FETCH`：来源标识 + 下载器配置版本。
- `EXTRACT_AUDIO`：源文件 SHA-256 + 音频参数版本。
- `TRANSCRIBE`：音频 SHA-256 + provider/model/语言/切片参数。
- `SUMMARIZE`：当前转写 ID + provider/model + prompt version + 长文本参数。

若同阶段已有相同输入指纹的成功结果，Worker 直接复用结果并推进下一阶段。用户显式“重新执行”时，只有配置或输入变化才生成新结果；若希望强制执行，命令必须携带 `force=true` 并记录原因。

### 6.3 任务领取与恢复

1. Worker 在短事务内选择最早的 `QUEUED` 任务，或租约已过期的 `RUNNING` 任务。
2. 将任务更新为 `RUNNING`，写入 Worker ID 和租约到期时间，提交事务后执行外部操作。
3. 长任务每 30 秒续租，租约建议为 2 分钟。
4. Worker 崩溃后，其他实例只能在租约过期后重新领取任务。
5. 阶段结果先写临时文件，再原子重命名；数据库结果和任务成功状态在同一事务内提交。
6. 启动恢复器检查过期租约、缺失文件和“任务成功但产物不可读”的异常，并将其转为明确失败。

SQLite V1 限制 Worker 并发为 1。事务使用短写锁，不在数据库事务内等待 FFmpeg 或网络请求。

### 6.4 重试规则

- 网络超时、限流、第三方 5xx：指数退避自动重试，建议 1、5、20 分钟，最多 3 次。
- Cookie 失效、视频不可用、输入不合法、模型鉴权失败：不自动重试，提示用户修复配置后手动重试。
- FFmpeg 异常退出：默认不自动重试；保留退出码与末尾错误摘要。
- LLM 响应不符合结构：先在同一次尝试中要求模型修复一次；仍失败则标记阶段失败。
- 手动重试从失败阶段开始，已成功阶段不重复执行。

## 7. 处理流水线设计

### 7.1 本地上传

1. API 接收 `multipart/form-data`，限制扩展名和最大上传大小，并流式写入 `data/temp`。
2. 上传过程中计算 SHA-256，不将整个文件读入内存。
3. 使用 FFprobe 校验文件可读取并获得时长等元数据。
4. 在事务中创建视频记录、源文件产物和 `EXTRACT_AUDIO` 任务。
5. 将临时文件原子移动到视频目录；若事务失败则清理临时文件。

应额外运行定时清理器，删除超过 24 小时且不被 `artifacts` 引用的临时文件。

### 7.2 B 站链接导入与下载

1. API 只接受受支持的 B 站主机名，将短链接解析为最终规范 URL，并限制重定向目标仍属于允许域名。
2. Worker 通过 B 站适配器执行元数据解析，提取 BVID、标题、UP 主、发布时间、封面和时长。
3. 在事务中按 BVID 插入；命中唯一约束时返回已有视频，而不是新建重复任务。
4. 下载时只向 `yt-dlp` 传结构化的固定参数，禁止将用户输入拼接为 shell 命令。
5. 下载至临时文件，校验后原子移动并写入 `SOURCE_VIDEO` 产物。

短链接解析、外部封面抓取和下载都必须设置连接超时、总超时、最大文件大小与允许域名，防止 SSRF 和无限下载。

### 7.3 音频提取

推荐统一产物为 16 kHz、单声道 FLAC：

```text
ffmpeg -i <input> -vn -ac 1 -ar 16000 -c:a flac <temporary-output>
```

实际执行使用 `spawn(executable, args)`，不启用 shell。阶段记录 FFmpeg 版本、参数版本、输入输出哈希、退出码和耗时。若 S2T 接口存在单文件大小限制，转写阶段按配置把音频切成 10～20 分钟分片，而不重复提取整个音轨。

### 7.4 全文转写

定义统一的 `SpeechToTextProvider` 接口：

```ts
interface SpeechToTextProvider {
  transcribe(input: {
    audioPath: string;
    language?: string;
    responseFormat: 'segments';
  }): Promise<{
    language?: string;
    text: string;
    segments: Array<{ startMs: number; endMs: number; text: string }>;
  }>;
}
```

长音频按顺序分片处理，记录每片进度。各分片写入暂存结果，全部成功后才合并成新的当前转写版本；失败时保留已完成分片以支持续传。合并时加上分片时间偏移，规范空白字符，并避免把模型返回的提示性文本混入正文。

### 7.5 结构化总结

短文稿直接总结；超过配置阈值时采用 Map-Reduce：

1. 优先按转写段落和句子边界切片，使用模型 tokenizer 估算 token，保留安全余量。
2. Map 阶段提取每片的事实要点、术语和待合并信息。
3. Reduce 阶段仅使用各片结果生成全局结构化总结。
4. 使用 JSON Schema 约束输出，并由 Zod 二次校验。
5. 保存模型、参数、提示词版本、输入转写版本和切片统计。

总结提示词修改时创建新的 `prompt_versions`，不能原地修改旧版本。API 返回版本号，便于结果追溯和重新生成。

### 7.6 UP 主检查

- 手动“立即检查”创建一个 `CREATOR_CHECK` 类型的后台任务，避免 API 请求等待。
- 对同一 UP 主增加运行中唯一约束，防止用户连续点击造成并发检查。
- 只获取最新 N 条的基本信息，逐条调用统一导入用例。
- `auto_process=false` 时创建视频记录但不进入处理流水线，状态为 `DISCOVERED`；用户可在列表手动开始。
- V1 不创建定时器，但数据模型保留 `enabled` 和检查历史，以便后续增加定时调度。

## 8. REST API 设计

统一前缀为 `/api/v1`，错误格式为：

```json
{
  "error": {
    "code": "BILIBILI_COOKIE_EXPIRED",
    "message": "B站登录状态已失效，请更新 Cookie 配置后重试",
    "requestId": "01...",
    "details": {}
  }
}
```

`details` 不包含路径中的敏感目录、密钥、Cookie 或第三方原始响应。

### 8.1 视频与任务

| 方法与路径 | 用途 |
| --- | --- |
| `POST /videos/uploads` | 流式上传本地视频并创建任务 |
| `POST /videos/bilibili` | 提交 B 站链接；重复时返回已有记录 |
| `GET /videos` | 分页、搜索、来源/状态筛选与排序 |
| `GET /videos/:id` | 视频基础信息及阶段概览 |
| `GET /videos/:id/transcript` | 当前或指定版本文稿 |
| `GET /videos/:id/summary` | 当前或指定版本总结 |
| `GET /videos/:id/runs` | 执行历史和错误摘要 |
| `POST /videos/:id/actions/start` | 启动待处理的发现记录 |
| `POST /videos/:id/actions/retry` | 从失败阶段或指定阶段重试 |
| `POST /videos/:id/actions/cancel` | 请求取消当前任务 |
| `POST /videos/:id/actions/regenerate-summary` | 用当前配置生成新总结版本 |
| `GET /events` | SSE 任务状态事件 |
| `GET /exports/videos.xlsx` | 按查询条件流式导出 Excel |

列表使用游标分页，查询参数包括 `q`、`sourceType`、`status`、`creatorId`、`createdFrom`、`createdTo`、`cursor`、`limit`。筛选条件与导出接口复用同一查询对象，确保“所见即所得”。

### 8.2 UP 主

| 方法与路径 | 用途 |
| --- | --- |
| `POST /creators` | 通过 UID 或主页链接添加 |
| `GET /creators` | UP 主列表和最近检查结果 |
| `PATCH /creators/:id` | 修改 N、自动处理和启用状态 |
| `DELETE /creators/:id` | 停止追踪；不删除已导入视频 |
| `POST /creators/:id/actions/check` | 创建立即检查任务 |
| `GET /creators/:id/checks` | 检查历史 |

### 8.3 设置

| 方法与路径 | 用途 |
| --- | --- |
| `GET /settings` | 返回脱敏后的有效配置和来源 |
| `PUT /settings` | 保存非敏感配置与密钥引用 |
| `POST /settings/actions/test-ffmpeg` | 验证工具路径和版本 |
| `POST /settings/actions/test-s2t` | 以短样例测试 S2T 连接 |
| `POST /settings/actions/test-llm` | 测试模型连接和结构化输出 |
| `GET /prompt-versions` | 提示词版本列表 |
| `POST /prompt-versions` | 创建并启用新提示词版本 |

所有会创建任务的接口接受 `Idempotency-Key`。API 保存请求键和结果 24 小时，避免浏览器重试创建重复命令。

## 9. 文件存储设计

```text
data/
├─ db/videoassist.sqlite
├─ videos/<video-id>/
│  ├─ source/<safe-name>.<ext>
│  ├─ audio/audio-v<params-version>.flac
│  └─ cover/cover.<ext>
├─ temp/<random-id>.part
├─ logs/api-YYYY-MM-DD.log
├─ logs/worker-YYYY-MM-DD.log
└─ exports/                 # 可选短期缓存，默认响应结束即删除
```

- 数据库只保存 `storage_key`，运行时由存储层在配置的数据根目录下解析。
- 解析后的绝对路径必须仍位于数据根目录内，阻止 `../` 路径穿越。
- 文件名由应用生成，原始文件名仅作为元数据展示。
- 原视频保留策略只在后续阶段成功后执行；删除媒体时先更新数据库，再移动到回收目录，延迟清理。
- 备份最小集合为 SQLite 在线备份文件、`videos` 目录和运行配置；临时目录与日志不属于业务备份。

## 10. 配置与敏感信息

配置分三层，优先级从高到低为：环境变量、数据库中的非敏感设置、代码默认值。建议支持以下配置：

```text
APP_HOST, APP_PORT, DATA_DIR
FFMPEG_PATH, FFPROBE_PATH, YTDLP_PATH
S2T_BASE_URL, S2T_MODEL, S2T_API_KEY_REF
LLM_BASE_URL, LLM_MODEL, LLM_API_KEY_REF
BILIBILI_COOKIE_FILE_REF
UPLOAD_MAX_BYTES, DOWNLOAD_MAX_BYTES
AUDIO_CHUNK_MINUTES, SUMMARY_MAX_INPUT_TOKENS
```

`*_REF` 保存的是引用，例如 `env:OPENAI_API_KEY` 或 `file:C:/.../secret`，API 永远不返回解析后的值。设置页只展示“已配置/未配置”和引用类型。日志中对 `Authorization`、Cookie、查询密钥和常见密钥格式做统一脱敏。

## 11. Excel 导出

- `视频` 工作表一行一条视频，包含 PRD 指定的基础信息、状态、当前文稿和当前总结字段。
- `处理记录` 工作表可选，包含阶段、尝试次数、开始结束时间、耗时和脱敏错误，不包含原始工具日志。
- 超过 Excel 单元格 32,767 字符上限的文稿或详细总结进行安全截断，并增加 `文稿是否截断`、`总结是否截断` 列；完整内容仍以应用详情页或单独文本导出为准。
- 防止公式注入：以 `=`, `+`, `-`, `@` 开头的用户来源文本在写入单元格前加单引号。
- 使用流式 writer，避免一次性把全部视频和长文稿加载进内存。

## 12. 可观测性与错误处理

### 12.1 日志

- 结构化 JSON 日志，公共字段包括 `requestId`、`jobId`、`videoId`、`stage`、`attempt`。
- API 请求、Worker 阶段和外部调用分别计时。
- 子进程 stdout/stderr 限长采集，数据库只保留最后一段脱敏摘要。
- 日志按天或大小轮转，默认保留 14 天。

### 12.2 错误分类

错误码至少覆盖：

- `INVALID_VIDEO_FILE`
- `UNSUPPORTED_BILIBILI_URL`
- `BILIBILI_VIDEO_UNAVAILABLE`
- `BILIBILI_COOKIE_EXPIRED`
- `BILIBILI_RATE_LIMITED`
- `DOWNLOAD_FAILED`
- `FFPROBE_FAILED`
- `FFMPEG_FAILED`
- `S2T_AUTH_FAILED`
- `S2T_RATE_LIMITED`
- `S2T_RESPONSE_INVALID`
- `LLM_AUTH_FAILED`
- `LLM_CONTEXT_EXCEEDED`
- `LLM_RESPONSE_INVALID`
- `ARTIFACT_MISSING`
- `CONFIG_INVALID`

领域错误同时包含 `retryable`、用户消息和内部原因。前端只显示用户消息；内部原因进入脱敏日志。

### 12.3 健康检查

- `/health/live`：进程存活，不访问外部依赖。
- `/health/ready`：数据库可读写、数据目录可写。
- 设置页单独展示 FFmpeg、yt-dlp、S2T、LLM 的最近一次连接测试结果，不把第三方依赖放入容器就绪判断。

## 13. 安全与合规

- 默认绑定 `127.0.0.1`，不默认暴露公网。
- 局域网模式要求访问令牌；写操作使用同源策略和 CSRF 防护。
- 上传采用大小限制、MIME/扩展名初筛和 FFprobe 实际解析，不信任浏览器 MIME。
- 外部 URL 采用主机白名单、重定向复检、私网 IP 拒绝和响应大小限制。
- 所有子进程使用参数数组调用，不经过 shell；工具路径和输出目录由服务端配置。
- 不在日志、Excel、API 响应或前端状态中输出密钥与完整 Cookie。
- B 站适配器应限制请求频率，明确展示登录失效、限流和视频不可用，不尝试绕过访问控制。
- 用户应仅处理有权访问和使用的内容；原视频保留策略默认可配置。

## 14. 前端页面与交互

### 14.1 视频列表

- 筛选条件写入 URL，刷新后可恢复，也可直接复用于导出。
- 状态列同时显示总体状态和当前阶段进度，例如“转写中 · 2/6 分片”。
- 失败行显示短错误与“查看详情/重试”；重试按钮需二次确认阶段和将被复用的产物。
- 活动任务由 SSE 局部更新 TanStack Query 缓存，不整页刷新。

### 14.2 视频详情

- 顶部展示来源信息和当前状态。
- 阶段时间线展示每阶段耗时、尝试次数和失败摘要。
- 文稿与总结按需加载，长文本不跟随基础详情接口返回。
- 重新下载、提取、转写或总结时明确提示其下游结果会产生新版本或失效。

### 14.3 设置

- 分为工具、S2T、LLM、提示词、存储、B 站六组。
- 保存前由前端做格式校验，保存后可分别测试连接。
- 密钥字段只接收引用，不回显真实值。

## 15. 测试方案

### 15.1 单元测试

- 状态转换矩阵和不允许的阶段跳转。
- BVID/UID/URL 规范化与去重。
- 阶段输入指纹稳定性。
- 错误分类、重试退避和脱敏规则。
- 长文稿切片、分段时间偏移与总结 JSON 校验。
- Excel 公式注入和超长单元格处理。

### 15.2 集成测试

- 使用临时 SQLite 和临时数据目录测试上传、任务入队、结果提交。
- FFmpeg/yt-dlp/S2T/LLM 适配器通过伪可执行文件或 HTTP mock 覆盖成功、超时、限流和异常输出。
- 模拟 Worker 在外部调用后、数据库提交前崩溃，验证租约恢复和幂等复用。
- 验证相同 BVID 并发导入只有一条视频记录。

### 15.3 端到端测试

- 小型本地样例视频：上传 → 音频 → 转写 → 总结 → Excel。
- B 站适配器使用固定测试夹具完成 CI；真实 B 站冒烟测试只在本机按需运行，避免 CI 依赖平台状态。
- 修改提示词后重新生成总结，验证旧版本保留且新版本成为当前版本。
- 转写和总结分别注入一次失败，验证从失败阶段重试。
- 重启 API/Worker，验证活动任务与历史结果可恢复。

## 16. 部署与运行

### 16.1 Docker Compose

适用于使用远程 S2T/LLM 的环境：

- `api`：只开放 Web/API 端口并挂载数据卷。
- `worker`：挂载同一数据卷，镜像内包含固定版本 FFmpeg 和 yt-dlp。
- SQLite 位于本地磁盘卷，不使用不可靠的网络文件系统。

### 16.2 Windows 本机模式

适用于依赖本机 FFmpeg、代理、Cookie 文件或本地模型服务的环境：

- API 和 Worker 作为两个进程启动。
- 启动脚本先进行数据库迁移和配置校验，再启动服务。
- 启动失败时明确列出缺失的工具路径，不进入半可用状态。

### 16.3 数据库维护

- 使用 Prisma migration 管理 schema，生产启动仅执行已提交迁移。
- 每日或手动使用 SQLite 在线备份 API 生成一致性备份，不能在数据库写入时直接复制主文件。
- 定期执行临时文件清理、日志轮转和孤立产物检查。

## 17. 实施计划

### 阶段 1：工程骨架与持久任务

- 建立 pnpm monorepo、Web/API/Worker 和共享包。
- 建立数据库迁移、视频/任务/执行记录模型。
- 实现租约、恢复、取消、错误码和 SSE。
- 交付一个可由模拟处理器跑通的状态机。

### 阶段 2：本地视频闭环

- 流式上传、FFprobe、FFmpeg 音频提取。
- 接入 S2T、分片续传、带时间段落。
- 接入 LLM、结构化输出和长文稿 Map-Reduce。
- 完成列表、详情、失败重试和版本展示。

### 阶段 3：B 站单视频

- B 站 URL 规范化、元数据解析、BVID 去重。
- 下载器、Cookie 引用、限流和错误提示。
- 覆盖重新下载及下游产物失效策略。

### 阶段 4：结果管理与导出

- 完成筛选、搜索、SSE 进度和复制操作。
- Excel 流式导出、长单元格与公式注入处理。
- 设置页、连接测试、提示词版本管理。

### 阶段 5：UP 主追踪与收尾

- 添加、编辑、删除 UP 主和手动检查。
- 最新 N 条获取、去重和自动处理选项。
- 完成安全测试、崩溃恢复测试、备份说明和验收回归。

## 18. PRD 验收标准映射

| PRD 验收项 | 技术落点 |
| --- | --- |
| 本地视频生成文稿和总结 | 上传流 + `EXTRACT_AUDIO/TRANSCRIBE/SUMMARIZE` 流水线 |
| B 站链接完成处理 | B 站适配器 + `FETCH` 阶段 + 统一后续流水线 |
| 相同 BVID 不重复 | 数据库部分唯一索引 + 导入事务 |
| UP 主最新 N 条 | `creators`、`creator_checks` 和统一导入用例 |
| 列表查看当前状态 | `videos` 状态快照 + SSE 事件 |
| 详情查看文稿、总结、错误 | 独立详情接口 + 版本表 + `stage_runs` |
| 失败后重试 | 持久任务、阶段产物和输入指纹 |
| 筛选结果导出 Excel | 列表与导出共用查询对象 + ExcelJS 流式 writer |
| 新提示词重新总结 | 不可变 `prompt_versions` + 新总结版本 |

## 19. 首版需要确认但不阻塞开发的产品参数

以下参数已有建议默认值，可以在开发过程中通过配置调整：

| 参数 | 建议默认值 |
| --- | --- |
| 单文件上传上限 | 4 GiB |
| Worker 并发 | 1 |
| 音频格式 | 16 kHz 单声道 FLAC |
| S2T 分片长度 | 15 分钟 |
| 自动重试次数 | 3 次 |
| UP 主最新视频数量 | 5 |
| 原视频保留 | 本地上传保留；B 站视频在转写成功后可删除 |
| 日志保留 | 14 天 |
| 默认监听地址 | `127.0.0.1` |

## 20. 结论

本方案以“单机简单部署、阶段可恢复、结果可追溯”为核心。SQLite、数据库租约和独立 Worker 足以支撑个人使用的 V1，同时通过适配器、领域层和阶段输入指纹为后续替换 PostgreSQL、专业任务队列、本地模型或其他视频平台保留清晰边界。
