# DSH provider quota

[English](README.en.md) · 中文

DeepSeek Harness 的提供方共享限流插件，带原生 GUI 设置入口。所有模型共享滚动 RPM、输入与输出合计 TPM、7 天 token 额度；跨进程串行请求并持久记账。官方 `dsh-llm-retry` 负责恢复，本插件不会在同一 waterfall 中重复调用 `next()`。

## 安装

需要 Node.js 24.9+ 和兼容的 DSH 0.2.2。将本仓库上传 GitHub 后，在 DSH 的“插件 → 添加插件”输入仓库 URL，或用 DSH 的命令安装：

```sh
dsh plugin --profile web add github:Fulisike/dsh-provider-quota
```

插件代码已经是可运行的 JavaScript，无需构建。安装后重启 DSH 并刷新页面，在“设置 → 提供方限流”选择已经配置的提供方，调整参数并点击“保存并应用”。新安装默认不限制任何提供方；第一次保存会启用所选提供方的共享额度。界面支持中英文，字段变更走 DSH 原生配置表单，保留密钥和其他提供方设置。

从源码安装也可以：

```sh
git clone https://github.com/YOUR_NAME/dsh-provider-quota.git
cd dsh-provider-quota
npm install --omit=dev --ignore-scripts
dsh plugin --profile web add .
```

源码版 DSH 从 DSH 仓库根目录运行 `pnpm dsh plugin --profile web add /absolute/path/to/dsh-provider-quota`；GitHub 安装命令也可在该目录用 `pnpm dsh` 执行。Desktop 通过自己的插件管理器安装；不要用普通 npm CLI 修改保留的 desktop profile。

## 超过 30 万 token 时

单分钟额度包含输入和输出。`LOCAL_REQUEST_TOO_LARGE` 表示本地预计的一次调用已经超限，还没有发送；多等一分钟不能缩小这次调用。页面中的“输入 token”累计值也不等于单次请求大小。

插件默认在上下文压力达到 180000 token 时调用 DSH 的官方压缩服务，不必等模型的更大上下文窗口用满。摘要输出上限由 bundle 的 `compaction-basic` 配置设为 8192 token，避免摘要请求本身预留过多输出。主请求默认最大输出 16384 token；每次还留 4096 token 的请求余量。已配置的提供方遇到本地超大请求时，每步最多再尝试一次官方压缩恢复，不会无限重试。

对于已经很长的会话，安装后在原会话中继续即可触发提前压缩，也可以先用 `/compact`。若单个用户输入、工具结果或固定提示本身太大，官方服务可能找不到可压缩范围；此时需要拆分输入或开新会话，不会偷偷截断历史。摘要属于模型请求，同样计入共享额度。

## GUI 可调字段

| 参数 | 默认值 |
| --- | --- |
| 滚动 60 秒请求数 | 10 |
| 滚动 60 秒 token 总数 | 300000 |
| 滚动 7 天 token 总数 | 1000000000 |
| 最短发送间隔 | 7000 ms |
| 主请求最大输出 | 16384 token |
| 提前压缩阈值 | 180000 token |
| 单次额外余量 | 4096 token |
| 初始输入估计系数 | 1.25 |
| 窗口边缘余量 | 250 ms |
| 文件锁检查间隔 | 500 ms |
| 429 共享冷却下限 | 60000 ms |

连接区可以编辑所选 `llm-pi-ai` 提供方的流空闲超时、SDK 请求超时、最大重试次数、初始与最大退避及抖动比例。首次未配置时页面提供 15 分钟空闲超时、30 分钟 SDK 超时和 12 次有界重试的建议值；保存时使用 normal 策略，沿用既有重试错误码，不启用无界重试。限流与连接设置属于两个配置项，分别校验和保存；后者失败会明确提示前者是否已经保存。

限流参数保存后在线生效，正在发送的请求保留其已捕获的参数。更换提供方前先保存或放弃当前修改。高级配置仍可写入 profile 的 `cordis.patch.yml`；不要同时启用其他限流插件。

## 存储与限制

计数默认存放在 `$DSH_HOME/storages/provider-quota`，默认 home 为 `~/.dsh`；也可在 `provider-quota.config.stateDirectory` 配置绝对目录。代码和仓库不包含密钥、会话或个人用量。使用同一统计目录的进程共享文件锁，每个提供方最多一条请求在途，跨进程不保证 FIFO。

发送前保存输入估计与输出预留，结算时使用实际 usage；缓存读写计入输入，reasoning 不会重复相加。缺少 usage 的尝试保留预留，可能高估；输入估计会根据实际 usage 向上校准。token 窗口保守地从结算时起算，RPM 从发送时起算。计数损坏会阻止调用，崩溃留下的预留不会被当作零消耗。

本地计数无法覆盖其他客户端、其他机器或安装前未记录的用量，也无法完全复现提供方 tokenizer 和限流口径；仍可能遇到 429。周额度不足时停止并显示最早释放部分额度的时间。排队可取消，卸载会等待在途请求结算。关闭插件不会删除账本。

## 开发与验证

```sh
npm install --ignore-scripts
npm test
npm pack --dry-run
```

端到端测试需要本地 DSH 源码及已经构建的产物；通过 `DSH_SOURCE_ROOT` 指定仓库目录，再运行 `npm run test:integration`。测试只请求本机模拟 HTTP 服务，验证 429 恢复、失败尝试、日志与实际输出上限，不调用真实 API。GUI 通过 DSH 的 slots、locale、configForms 和认证 connection 注册，不增加独立应用入口。

许可证：MIT。
