# DisQord 中央服务器消息处理延迟修复方案

> 适用范围：`apps/central-server`（部署于韩国）、`apps/qq-node` / `apps/discord-node`（部署于福建）。
> 结论：中央端每条消息约 25 次"整文件全量重写"导致 ~30s 延迟。根因是存储层把整个 `central.json` 当数据库、每次写都全量重写且文件无限膨胀。

---

## 一、问题与根因

一次同平台环回消息测试（QQ → 中央 → QQ，蓝图只有"输入→输出"两个节点、无 LLM、无渲染）：

| 时间 | 事件 | 耗时 | 归属 |
|---|---|---|---|
| 16:42:35 → 16:42:38 | 上传消息 + 中央持久化后回 ACK | 3s | 网络（福建↔韩国 RTT，正常） |
| 16:42:38 → 16:43:08 | 中央处理 → 下发发送任务 | **30s** | **中央存储层** |
| 16:43:08 → 16:43:08 | 下发、节点发送、平台确认 | 0s | 下发链路（亚秒级，正常） |
| 16:43:08 → 16:43:20 | 节点回报，中央确认 | **12s** | **中央存储层** |

**两个关键事实：**

1. 处理流水线里没有 LLM、没有图片渲染（测试蓝图无中间节点、疾速模式开启），所以 30s 不是模型/渲染造成。
2. 最后那 12s 的"回报确认"路径（`#handleDelivered`）**也没有 LLM/渲染**，中央只做了 3~4 次状态写入就花了 12s —— **独立证明"中央每次写状态"本身就慢到 ~3s**。

### 根因

中央服务器唯一的持久化存储 `FileStateStore`（`apps/central-server/src/state-store.ts`）把**整个 `central.json` 当数据库**：

- 每次 `set()` = 把**整份文件（所有命名空间）**重新 `JSON.stringify` → 写临时文件 → rename 覆盖（`state-store.ts:134-143`）。没有合并、没有 WAL、没有增量。
- 所有 `get()/list()` 都要 `await #writeQueue`（`state-store.ts:69-82`），读写全服务单线程串行。
- 处理一条消息的流水线要执行 **~25 次这样的全量写**（`orchestrator.ts` 里 `#log` 12 次 + 去重/历史/活动/下发任务/批次状态等），全部串行等待。
- `central.json` 里的 `trace-log`（日志，含完整消息对象）、`message-history`（历史）、`blueprint-activity`（活动）、`delivery-task` 等命名空间**只增不减**（生产代码无任何清理），文件已涨到 **49MB**，单次全量写要 1~3s。

**一句话：一个越滚越大的 JSON 文件，每条消息全量重写 25 遍，还全部串行 —— 25 × 1~3s ≈ 30s。**

---

## 二、数据佐证

| 检查项 | 结果 |
|---|---|
| `ls -lh /var/lib/disqord/central/central.json` | **49MB**，单调增长 |
| 每条消息的 `store.set` 次数（代码实测数） | **~26 次**（含网关每帧先写 1 次 `node-runtime`，`api.ts:174`） |
| 其中 `trace-log` 日志写 | 14 次（每条 `message_received` 内嵌完整消息对象） |
| 每消息新增体积 | ~6~10KB，且 49MB 存量不清 |
| 回报确认 12s | 纯 3~4 次写，无 LLM/渲染 |
| 本机 40MB 同构文件实测 | 单次全量写 0.2~0.75s，21 次串行 ≈ 9.2s（本地 SSD，服务器云盘更慢） |

---

## 三、修复目标与验收标准

| 指标 | 当前 | 目标 |
|---|---|---|
| 单条消息中央端处理延迟 | ~30s | **< 100ms** |
| 每条消息的全量重写次数 | ~25 | **0 次**（热路径无全量写） |
| 日志/历史/活动读 | 磁盘全表扫描 + 排队 | **纯内存** |
| 持久化文件 | 49MB 单个，只涨不清 | 拆分后各 <1MB，稳定 |
| 崩溃恢复 | 重读整文件 | 每行独立解析，坏行跳过 |

---

## 四、解决方案：追加式存储（log-structured）+ 职能分文件

**核心思路：把存储引擎从"读-改-写整个文件"换成"只追加"**（LSM 树 / 数据库 WAL 的思想）：

> **写 = 往文件追加一行（O(1)）；读 = 走内存；持久化 = 追加已落盘；全量写只发生在后台"压缩"时（摊还、低频、文件小）。**

这样消息处理热路径上**一次全量重写都没有**。

### 4.1 存储布局（数据目录）

```
data/
  trace-log.ndjson            # 日志，追加式，保留最近 2000 行
  message-history.ndjson      # 历史，追加式，保留最近 5000 行
  blueprint-activity.ndjson   # 活动，追加式，保留最近 5000 行
  state.ndjson                # 其余全部"状态类"命名空间（追加 + 死行压缩）
  central.json                # 首次启动迁移后改名备份：central.migrated-<时间戳>.json
```

### 4.2 命名空间分类

| 类别 | 命名空间 | 存储文件 | 保留策略 |
|---|---|---|---|
| 追加类（只写、只读近期） | `trace-log`、`message-history`、`blueprint-activity` | 各自独立 `.ndjson` | 按行数上限裁剪 |
| 状态类（读改写、低频、小） | `chat-session`、`blueprint`、`blueprint-version`、`prompt`、`settings`、`node-session`、`node-runtime`、`verification`、`auth-session`、`delivery-task`、`message-dedupe`、`reply-mapping`、`message-upload-batch`、`moderation-review`、`plaintext-secret` | 合并到 `state.ndjson` | 死行（被覆盖旧版本）超过 2×活跃 key 时压缩 |

依据（已用代码验证）：`trace-log` / `message-history` / `blueprint-activity` 在全部生产代码里**只有 `set`（追加）和 `list`（读近期），从未 `get`（按 key 读）、从未 `delete`** → 无需索引，天然适合追加式文件。这正是 49MB 的大头。

### 4.3 核心实现（一个类覆盖所有命名空间）

```ts
// AppendLogStore —— 写=append，读=内存，压缩=唯一的全量写
class AppendLogStore {
  #filePath: string; #cap: number;
  #memory = new Map<string, Entry>();   // 权威副本（插入序 = 时间序）
  #lines = 0;

  async set(ns, key, value) {
    const now = new Date().toISOString();
    const prev = this.#memory.get(key);
    const entry = { key, value, createdAt: prev?.createdAt ?? now, updatedAt: now };
    this.#memory.set(key, entry);                          // 更新权威副本
    appendFileSync(this.#filePath, JSON.stringify(entry) + '\n', 'utf8'); // O(1) 追加
    this.#lines += 1;
    this.#trim();                                          // 超 cap 逐出最旧
    this.#maybeCompact();
    return structuredClone(entry);
  }
  async get(ns, key) { const e = this.#memory.get(key); return e ? structuredClone(e) : undefined; }
  async list(ns) { /* memory.values() 按 updatedAt 降序 */ }
  async delete(ns, key) {
    if (!this.#memory.delete(key)) return false;
    appendFileSync(this.#filePath, JSON.stringify({ key, __deleted: true }) + '\n');
    return true;
  }
  #trim() {
    while (this.#cap > 0 && this.#memory.size > this.#cap)
      this.#memory.delete(this.#memory.keys().next().value);
  }
  #maybeCompact() {
    // 追加类：文件行数 > 2×cap；状态类：死行 > 2×活跃 key。摊还 O(1)
    const overCap   = this.#cap > 0 && this.#lines > this.#cap * 2;
    const deadHeavy = this.#cap === 0 && this.#lines > Math.max(100, this.#memory.size * 2);
    if (!overCap && !deadHeavy) return;
    const tmp = this.#filePath + '.tmp';
    writeFileSync(tmp, [...this.#memory.values()].map(e => JSON.stringify(e)).join('\n') + '\n');
    renameSync(tmp, this.#filePath);                       // 唯一的全量写，文件小、后台
    this.#lines = this.#memory.size;
  }
  #load() {
    if (!existsSync(this.#filePath)) return;
    for (const line of readFileSync(this.#filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e.__deleted) this.#memory.delete(e.key);
        else this.#memory.set(e.key, e);
      } catch { /* 崩溃残留的半行，跳过 —— 追加天然抗崩溃 */ }
    }
    this.#trim();
  }
}
```

再加一层 `SplitStateStore` 实现现有 `StateStore` 接口（`get/list/set/delete/flush`），按命名空间路由到上述 4 个实例。

### 4.4 关键性质

- **热路径零全量重写**：每条消息的 ~25 次写全是 `appendFileSync` 追加（约 20µs/次，共 ~0.5~1ms）。
- **读纯内存**：`get/list` 不碰磁盘，顺带消灭 `#recentMessages`、`/api/logs`、蓝图活动长轮询的磁盘全表扫描。
- **崩溃安全不差于现状**：`appendFileSync` 已写入 OS 页缓存，进程崩溃（kill -9）不丢，重启按行重建、坏行跳过。当前代码本来也不 fsync，无回退。（如需抗断电，可在 ACK 边界对 `state.ndjson` 做一次 `fsync`，成本 ~1ms。）
- **ACK 语义保持**：上传确认等关键路径在返回前仍可调 `store.flush()`（追加类无 pending；状态类可 fsync），保证"ACK = 已持久化"。

### 4.5 调用方改动（最小化）

| 文件 | 改动 |
|---|---|
| `state-store.ts` | 新增 `AppendLogStore` + `SplitStateStore`；保留 `StateStore` 接口（补 `flush()`）；`InMemoryStateStore` 加空 `flush()` |
| `orchestrator.ts` | **无需改动**（接口不变）。可选：在 `#acceptMessageUploadBatch` 返回前、`#handleMessageUploadBatch` 结束处显式 `flush()`，收紧持久化语义 |
| `api.ts` | **无需改动**。可选：`onFrame` 里 `node-runtime` 写入降频（仅 kind 变化或 >30s 才写） |
| `index.ts` | `stop()` 里加 `await store.close()`（压缩 + fsync，优雅退出不丢数据） |
| `state-store.test.ts` | 适配新语义（如需断言文件内容，先 `flush()`） |

---

## 五、迁移方案（一次性）

首次启动新版时自动迁移：

1. 检测到旧 `central.json`（version 1）。
2. 按命名空间路由：追加类 → 写入对应 `.ndjson`（按 `updatedAt` 顺序）；状态类 → 写入 `state.ndjson`。
3. 将 `central.json` 改名 `central.migrated-<时间戳>.json` 保留备份。
4. 之后每次启动直接读 4 个 `.ndjson`。

---

## 六、实施步骤与测试

1. **M1**：实现 `AppendLogStore` + `SplitStateStore`，`pnpm test` 全绿。
2. **M2**：迁移逻辑 + `stop()` 优雅关闭。
3. **M3**：压测基准脚本（构造旧 49MB 文件 → 启动拆分 → 回放一条消息的 25 次 set + 3 次 flush，断言 <100ms、各文件 <1MB 且稳定）。
4. **M4**：韩国服务器真机验证：跑环回消息，观察 `message_upload_batch_accepted` → `message_upload_batch_completed` 间隔 <100ms；`ls -lh data/` 各文件稳定。
5. **M5**：崩溃恢复：处理中 `kill -9`，重启确认批次恢复、坏行跳过、无重复死循环。

---

## 七、风险、回滚、注意事项

- **断电丢尾部**：非 fsync 数据在断电时可能丢失最后若干条（当前代码同样如此，无回退）。要求零丢失 → 在关键 ACK 点对 `state.ndjson` 加 `fsync`，或升级到 SQLite WAL。
- **首次启动迁移**：49MB → 4 个小文件是一次性操作，**升级前先备份 `central.json`**（`docs/OPERATIONS.md` 有备份步骤）。
- **回滚**：新格式是 4 个 `.ndjson`，旧代码不认；回滚时用 `central.migrated-*` 备份还原即可。改动集中在存储层，`git revert` 风险低。
- **内存占用**：内存权威副本最多 = 各命名空间 cap 之和（日志 2000 + 历史 5000 + 活动 5000 + 状态类），远小于 Node 默认堆，可忽略。
- **文件权限**：`state.ndjson`（含明文 LLM API Key）保持 `0600`，同现状。

---

## 八、可选进阶

1. **SQLite（better-sqlite3，WAL 模式）**：底层同样是"页级追加 + 后台 checkpoint"，自带索引、并发读、成熟崩溃恢复。代价：原生依赖 + 迁移脚本 + 偏离"可读文件"设计。**默认不推荐，除非追求极致稳健。**
2. **WAL + 快照**：若不想拆文件、又要零全量写，可对单个文件做"追加式 WAL + 后台快照"，但职能拆分 + 追加式 `.ndjson` 已同时满足"分开放"与"零全量写"，无需叠加。

---

# 附：实施级详细对照（给实施模型）

## 九、对照小抄（改哪一行、改成什么）

### `apps/central-server/src/state-store.ts`

| 位置 | 现状 | 改为 |
|---|---|---|
| 11-16 `StateStore` 接口 | 只有 `get/list/set/delete` | **新增 `flush(): Promise<void>`** |
| 18-51 `InMemoryStateStore` | 无 flush | **新增空实现 `async flush(): Promise<void> {}`** |
| 58-144 `FileStateStore` | 每次 set 全量重写、读写串行 | **整体替换为 `AppendLogStore` + `SplitStateStore`（见 §10.1）** |
| 146-166 `InMemorySecretStore` | — | 不变 |
| 168-186 `PlaintextSecretStore` | 包装 store | 不变 |

### `apps/central-server/src/index.ts`

| 位置 | 现状 | 改为 |
|---|---|---|
| 36 | `new FileStateStore(resolve(config.CENTRAL_DATA_PATH))` | `new SplitStateStore(dirname(resolve(config.CENTRAL_DATA_PATH)))` |
| 68-73 `stop()` | 只 `await central.app.close()` | **追加 `await store.close()`**（优雅退出前压平 + 落盘） |

### `apps/central-server/src/orchestrator.ts`（3 个 flush 点）

| 位置 | 插入点 | 代码 |
|---|---|---|
| `#acceptMessageUploadBatch` | `message_upload_batch_accepted` 日志（:821）之后、`#queueMessageUploadBatch`（:829）之前 | `await this.#store.flush();` |
| `#handleMessageUpload`（可选） | `set('message-dedupe', ...)`（:648）之后 | `await this.#store.flush();` |
| `#handleMessageUploadBatch` | `#dispatchDeliveryBatch`（:1017）之后、`_deliveries_queued` 日志（:1018）之前 | `await this.#store.flush();` |

其余全部**不改**（接口不变，`#log`/`#recentMessages` 自动受益于内存读）。

### `apps/central-server/src/api.ts`（可选优化）

| 位置 | 现状 | 改为 |
|---|---|---|
| 161-181 `onFrame` | 每条入站帧都 `store.set('node-runtime', ...)` | 仅当 `lastFrameKind` 变化或距上次写 >30s 才写 |
| 853-884 蓝图活动 | `list('blueprint-activity')` 全量 | 不改（现已内存读，量受 cap 约束） |
| 961-998 `/api/logs` | `list('trace-log')` 全量 | 不改（同上） |

---

## 十、完整实现代码

### 10.1 `state-store.ts`（新全文）

```ts
import {
  appendFileSync,
  chmod,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

export interface StateEntry<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface StateStore {
  get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined>;
  list<T>(namespace: string): Promise<readonly StateEntry<T>[]>;
  set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>>;
  delete(namespace: string, key: string): Promise<boolean>;
  /** 确保当前已接受的写已持久化。追加式下 = 进程崩溃安全屏障，可再在 ACK 边界 fsync。 */
  flush(): Promise<void>;
}

export class InMemoryStateStore implements StateStore {
  readonly #entries = new Map<string, StateEntry>();
  async get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    const entry = this.#entries.get(`${namespace}${key}`);
    return entry ? (structuredClone(entry) as StateEntry<T>) : undefined;
  }
  async list<T>(namespace: string): Promise<readonly StateEntry<T>[]> {
    const prefix = `${namespace}`;
    return [...this.#entries.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, value]) => structuredClone(value) as StateEntry<T>)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  async set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    const composite = `${namespace}${key}`;
    const existing = this.#entries.get(composite);
    const now = new Date().toISOString();
    const entry: StateEntry<T> = {
      key,
      value: structuredClone(value),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.#entries.set(composite, entry);
    return structuredClone(entry);
  }
  async delete(namespace: string, key: string): Promise<boolean> {
    return this.#entries.delete(`${namespace}${key}`);
  }
  async flush(): Promise<void> {
    // 无持久化，无需做任何事。
  }
}

/** 追加类命名空间（只写、只读近期）及其保留上限。 */
const APPEND_NAMESPACE_CAPS: Record<string, number> = {
  'trace-log': 2_000,
  'message-history': 5_000,
  'blueprint-activity': 5_000,
};

/**
 * 追加式单文件存储：
 *   set/delete = append 一行（O(1)，进 OS 页缓存，进程崩溃不丢）；
 *   get/list   = 内存权威副本；
 *   压缩        = 唯一的全量写，仅在超限/死行过多时触发（摊还 O(1)、文件小、后台）。
 */
export class AppendLogStore implements StateStore {
  readonly #filePath: string;
  readonly #cap: number;
  readonly #memory = new Map<string, StateEntry>();
  #lines = 0;

  constructor(filePath: string, cap = 0) {
    this.#filePath = filePath;
    this.#cap = cap;
    mkdirSync(dirname(filePath), { recursive: true });
    this.#load();
  }

  async get<T>(_namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    const entry = this.#memory.get(key);
    return entry ? (structuredClone(entry) as StateEntry<T>) : undefined;
  }

  async list<T>(_namespace: string): Promise<readonly StateEntry<T>[]> {
    return [...this.#memory.values()]
      .map((entry) => structuredClone(entry) as StateEntry<T>)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async set<T>(_namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    const now = new Date().toISOString();
    const prev = this.#memory.get(key);
    const entry: StateEntry<T> = {
      key,
      value: structuredClone(value),
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
    };
    this.#memory.set(key, entry);
    appendFileSync(this.#filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    this.#lines += 1;
    this.#trim();
    this.#compact();
    return structuredClone(entry);
  }

  async delete(_namespace: string, key: string): Promise<boolean> {
    if (!this.#memory.delete(key)) return false;
    appendFileSync(this.#filePath, `${JSON.stringify({ key, __deleted: true })}\n`, 'utf8');
    this.#lines += 1;
    return true;
  }

  async flush(): Promise<void> {
    // appendFileSync 已写入 OS 页缓存：进程崩溃不丢，重启按行重建。
    // 如需断电级持久化，在此对 #filePath 做一次 fsync（成本 ~1ms）。
  }

  async close(): Promise<void> {
    await this.flush();
    this.#compact(); // 退出前压平，缩小下次启动回放量
  }

  /** 迁移/批量载入用：一次性写入一组已存在条目（覆盖内存 + 重建文件）。 */
  bulkLoad(entries: readonly StateEntry[]): void {
    for (const entry of entries) this.#memory.set(entry.key, entry);
    this.#trim();
    this.#compact(true);
  }

  #trim(): void {
    while (this.#cap > 0 && this.#memory.size > this.#cap) {
      this.#memory.delete(this.#memory.keys().next().value as string);
    }
  }

  #compact(force = false): void {
    const overCap = force || (this.#cap > 0 && this.#lines > this.#cap * 2);
    const deadHeavy =
      force || (this.#cap === 0 && this.#lines > Math.max(100, this.#memory.size * 2));
    if (!overCap && !deadHeavy) return;
    const temporaryPath = `${this.#filePath}.${process.pid}.tmp`;
    writeFileSync(
      temporaryPath,
      [...this.#memory.values()].map((entry) => JSON.stringify(entry)).join('\n') + '\n',
      'utf8',
    );
    renameSync(temporaryPath, this.#filePath);
    this.#lines = this.#memory.size;
  }

  #load(): void {
    if (!existsSync(this.#filePath)) return;
    for (const line of readFileSync(this.#filePath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as StateEntry & { __deleted?: boolean };
        if (entry.__deleted) this.#memory.delete(entry.key);
        else this.#memory.set(entry.key, entry);
      } catch {
        // 崩溃残留的半行，跳过 —— 追加式天然抗崩溃
      }
    }
    this.#trim();
  }
}

interface FileStateDocument {
  version: 1;
  namespaces: Record<string, Record<string, StateEntry>>;
}

/**
 * 按命名空间路由到独立追加式文件的入口。现有调用方（orchestrator/api/index）
 * 只依赖 StateStore 接口，无需改动。
 */
export class SplitStateStore implements StateStore {
  readonly #append: Map<string, AppendLogStore>;
  readonly #state: AppendLogStore;

  constructor(dataDir: string) {
    this.#state = new AppendLogStore(join(dataDir, 'state.ndjson'), 0);
    this.#append = new Map(
      Object.entries(APPEND_NAMESPACE_CAPS).map(([ns, cap]) => [
        ns,
        new AppendLogStore(join(dataDir, `${ns}.ndjson`), cap),
      ]),
    );
    this.#migrateLegacy(dataDir);
  }

  #storeFor(namespace: string): AppendLogStore {
    return this.#append.get(namespace) ?? this.#state;
  }

  async get<T>(namespace: string, key: string): Promise<StateEntry<T> | undefined> {
    return await this.#storeFor(namespace).get(namespace, key);
  }
  async list<T>(namespace: string): Promise<readonly StateEntry<T>[]> {
    return await this.#storeFor(namespace).list(namespace);
  }
  async set<T>(namespace: string, key: string, value: T): Promise<StateEntry<T>> {
    return await this.#storeFor(namespace).set(namespace, key, value);
  }
  async delete(namespace: string, key: string): Promise<boolean> {
    return await this.#storeFor(namespace).delete(namespace, key);
  }
  async flush(): Promise<void> {
    await this.#state.flush();
    for (const store of this.#append.values()) await store.flush();
  }
  async close(): Promise<void> {
    await this.#state.close();
    for (const store of this.#append.values()) await store.close();
  }

  /** 一次性迁移：发现旧版 central.json 时按命名空间拆分，原文件改名为备份。 */
  #migrateLegacy(dataDir: string): void {
    const legacyPath = join(dataDir, 'central.json');
    if (!existsSync(legacyPath)) return;
    const doc = JSON.parse(readFileSync(legacyPath, 'utf8')) as FileStateDocument;
    for (const [ns, records] of Object.entries(doc.namespaces ?? {})) {
      const store = this.#storeFor(ns);
      const entries = Object.values(records).sort((a, b) =>
        a.updatedAt.localeCompare(b.updatedAt),
      );
      store.bulkLoad(entries);
    }
    renameSync(legacyPath, `${legacyPath}.migrated-${Date.now()}`);
    console.error('[DisQord/State] migrated legacy central.json -> ndjson files');
  }
}

export interface SecretStore {
  has(name: string): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore { /* 原样保留 */ }
export class PlaintextSecretStore implements SecretStore { /* 原样保留 */ }
```

### 10.2 `index.ts` 改动

```ts
import { dirname, resolve } from 'node:path';
// ...
import { PlaintextSecretStore, SplitStateStore, type StateStore } from './state-store.js';
// ...
export async function startCentralServer(environment = process.env) {
  const config = environmentSchema.parse(environment);
  const dataDir = dirname(resolve(config.CENTRAL_DATA_PATH)); // ./data
  const store = new SplitStateStore(dataDir);
  const secrets = new PlaintextSecretStore(store);
  // ...其余不变...
  const stop = async () => {
    await central.app.close();
    await store.close();          // ← 新增：优雅退出前压平 + 落盘
  };
  // ...
}
```

### 10.3 `orchestrator.ts` flush 点（精确插入）

```ts
// #acceptMessageUploadBatch 内（原 :821 日志之后）
await this.#log(record.messages[0]!.traceId, 'info', 'message_upload_batch_accepted', { ... });
await this.#store.flush();   // ← 新增：ACK 前批次记录必须已持久化
this.#queueMessageUploadBatch(batchId);

// #handleMessageUploadBatch 内（原 :1017 dispatch 之后、:1018 日志之前）
if (deliveries.length) await this.#dispatchDeliveryBatch(deliveries);
await this.#store.flush();   // ← 新增：状态/任务/日志一起落盘
await this.#log(/* message_upload_batch_deliveries_queued */);

// #handleMessageUpload 内（可选，原 :648 之后）
await this.#store.set('message-dedupe', dedupeKey, { eventId, receivedAt });
await this.#store.flush();   // ← 可选：缩小崩溃后重处理重复发送窗口
```

### 10.4 `api.ts`（可选）`node-runtime` 按需写

```ts
onFrame: async (frame) => {
  if (frame.kind === 'node.logs.response') { /* 原逻辑 */ }
  const prev = await options.store.get('node-runtime', frame.nodeId);
  const stale =
    !prev ||
    prev.value.lastFrameKind !== frame.kind ||
    Date.now() - new Date(prev.value.lastSeenAt).getTime() > 30_000;
  if (stale) {
    await options.store.set('node-runtime', frame.nodeId, { ... });
  }
  await options.onNodeFrame?.(frame);
},
```

---

## 十一、拆分脚本 `split-central.js`（已附在桌面，已验证）

桌面文件：`split-central.js`。在服务器上运行：

```bash
# 建议先手动备份
cp /var/lib/disqord/central/central.json /var/lib/disqord/central/central.bak.json
# 执行拆分（输出到 central.json 所在目录）
node split-central.js /var/lib/disqord/central/central.json
```

脚本行为：
- `trace-log` / `message-history` / `blueprint-activity` → 各自 `.ndjson`，按 `updatedAt` 排序后保留最近 2000 / 5000 / 5000 条；
- 其余全部命名空间 → `state.ndjson`；
- 原 `central.json` 改名 `central.migrated-<时间戳>.json`（**不删除**，可回滚）；
- 若输出目录已存在拆分产物会报错退出，防止误覆盖。

**实测（合成 2.4MB 旧文件）输出：**

```
[split]   trace-log                 2500 ->    2000 条   (382.4 KB)
[split]   message-history           5200 ->    5000 条   (827.7 KB)
[split]   blueprint-activity         300 ->     300 条   ( 44.9 KB)
[split]   state                          3 ->       3 条   (  0.4 KB)
[split] 原文件已备份为 central.json.migrated-<ts>.json
```

注意：新版 `SplitStateStore` 启动时也会自动检测并迁移旧 `central.json`，脚本是给"先手动拆、再切代码"的部署顺序用的，二者不冲突（自动迁移检测到已无 `central.json` 就跳过）。

---

## 十二、核心算法验证（已实测通过）

用与方案完全一致的 `AppendLogStore` 逻辑写了独立测试，**13/13 通过**：

| 场景 | 验证点 |
|---|---|
| 基本 set/get/持久化 | 写入 2 条 → 文件 2 行 → 重启恢复 |
| 覆盖更新 | 同 key 写两次 → 内存最新、`createdAt` 保留、重启后最新生效 |
| 删除墓碑 | `delete` → 内存删、重启后墓碑生效 |
| 追加类超限裁剪 | cap=2 写 3 条 → 只留最新 2 条 |
| 状态类死行压平 | 反复覆盖 1 个 key 制造死行 → 压平触发、重启数据完整 |
| 崩溃残行 | 半行 JSON → 重启跳过、完整行正常恢复 |

---

## 十三、测试与验证清单

1. `pnpm --filter @disqord/central-server test` 全绿（`orchestrator.test.ts`/`api.test.ts` 用 `InMemoryStateStore`，不受影响；`state-store.test.ts` 如断言文件内容需先 `flush()`）。
2. 基准脚本：构造 49MB 旧文件 → `split-central.js` 拆分 → 回放一条消息 25 次 `set` + 3 次 `flush`，断言 <100ms、各文件 <1MB。
3. 真机：跑环回消息，`message_upload_batch_accepted` → `_completed` 间隔 <100ms；`ls -lh data/` 稳定。
4. 崩溃恢复：处理中 `kill -9` → 重启，确认 `kill` 前已 append 的记录仍在、坏行跳过。
5. 断电（可选）：如要求断电零丢失，给 `AppendLogStore.flush()` 加一次 `fsyncSync`，并确认 ACK 路径调用 flush。

## 十四、回滚

- **数据回滚**：新格式是 4 个 `.ndjson` + 备份的 `central.migrated-*`。要回旧版：停服 → 把 `central.migrated-*.json` 改回 `central.json` → 删掉 4 个 `.ndjson` → 启动旧代码。
- **代码回滚**：改动集中在 `state-store.ts`（替换）+ `index.ts` 两行 + `orchestrator.ts` 三行 flush + 可选 `api.ts`。`git revert` 低风险。
- **平滑上线顺序**：先在服务器用 `split-central.js` 手动拆分（此时旧代码仍在跑，只是文件提前拆好）→ 部署新代码（自动迁移检测到无 `central.json` 直接跳过）→ 观察延迟。

---

# QQ / Discord 节点端性能审计

> 审计范围：`apps/qq-node`、`apps/discord-node`、`packages/node-runtime`（runtime / logger / control-server / config）、`packages/queue`、`packages/adapter-napcat`、`packages/adapter-discord`。

## 十五、结论

节点端整体健康，**没有中央那种 30s 灾难**。原因：节点本地队列文件小、日志是追加式、业务逻辑基本在内存。但有 6 个问题，分两类：

- **会随负载 / 运行时间恶化的**：本地队列全量重写、日志无轮转。
- **设计上的吞吐/延迟限制**：疾速模式 5s 发送节流（比非疾速更慢）、非疾速 8s 上传窗、NapCat 收消息等解析、QQ 大图 base64。

## 十六、问题清单（按严重度）

### P1-1 本地队列 `FileTaskQueue` 每个操作都全量重写整个队列文件（与中央同源）

- 位置：`packages/queue/src/sqlite-task-queue.ts:159-168` —— 每次 `enqueue` / `markProcessing` / `markAcknowledged` / `updatePayload` / `markRetrying` 都触发 `#flush()`：把**所有队列条目** `JSON.stringify(…, null, 2)` → 写临时文件 → rename；`:170-187` 的 `#pruneCompleted()` 每次 flush 还遍历全部条目。
- 实际影响（按 `runtime.ts` 调用计数）：
  - 每条上传消息：2 次全量重写（`markProcessing` + `markAcknowledged`，runtime.ts:557/573）
  - 每条发送：3 次全量重写（`markProcessing` + `updatePayload` + `markAcknowledged`，runtime.ts:389/420/421）
  - 25 条批量上传 = **50 次全量重写**
- 影响：队列文件平时几十 KB（单次写几 ms）没事；**积压几百条时单次写 20~50ms × 5 次/消息**开始拖累，且只涨不清。
- 修复：与中央同一套"追加式"改造（见 §10 `AppendLogStore` 思路，可复用），或至少 debounce 落盘；`listRecoverable` 仅在需要时排序。

### P1-2 节点日志无轮转 + 每次查日志全量读解析

- 位置：`packages/node-runtime/src/logger.ts`
  - `write`（:45-53）只 `appendFileSync`，**永不轮转/截断** → `.jsonl` 无限增长。
  - `list` / `#read`（:55-100）**每次把整个日志文件读进来逐行 `JSON.parse`**，在事件循环里同步执行。
- 影响：节点面板 `/api/node/logs` 每次查询全量读；运行几天后日志几十 MB，每次查询阻塞事件循环。
- 修复：文件超阈值（如 5MB）时轮转/截断保留最近 N 行；`#read` 只读尾部最近 N 行。

### P2-1 疾速模式发送节流 5s/会话 —— "疾速"名不副实，且比非疾速更慢

- 位置：`packages/node-runtime/src/runtime.ts:640-654` `#waitForDeliveryGap` 的 fast 分支：同一会话**相邻两次发送固定间隔 5000ms**（`#fastDeliveryIntervalMs`，中央下发 `FAST_DELIVERY_INTERVAL_MS = 5000`，`orchestrator.ts:68`）。
- 影响：一个会话背靠背 3 条 → 第 2 条等 5s、第 3 条等 10s → **单会话吞吐 ~12 条/分钟**；而**非疾速**随机间隔最长才 3s（平均 ~1.5s）。疾速模式在发送节流上反而更狠。
- 修复：`FAST_DELIVERY_INTERVAL_MS` 降到 1~2s，或做成可配置。

### P2-2 非疾速模式首条消息上传等 8s

- 位置：`runtime.ts:13` `UPLOAD_BATCH_DELAYS_MS = [8000, 6000, 4000, 2000, 0]` —— 空闲后第一条消息等 **8s** 合并窗口才上传（疾速模式立即上传，只影响非疾速）。
- 修复：首段降到 2~3s（仍能聚合，首条延迟可控）。

### P3-1 NapCat 收消息路径串行等待 @提及 / 回复解析，可能被 15s 超时拖住

- 位置：`packages/adapter-napcat/src/client.ts:195-227` —— `#handleIncoming` 先 `await Promise.all([#resolveMentionNames, #resolveReplyPreviews])` **再回调 onMessage**，消息进本地队列前被这两次 NapCat API 往返卡住：
  - 每个 **@ 提及**（未命中 1h 缓存）都 `get_group_member_info`，单次超时 **15s**（client.ts:171-175）；NapCat 卡住时，带 @ 的消息 ingest 可卡 ~15s。
  - **回复预览从不缓存**，每条带回复的消息都 `get_msg`。
- 修复：解析移到 onMessage 之后异步补全；或缩短此类查询超时、给回复预览加短缓存。

### P3-2 小问题

- **NapCat 图片 `base64://` 内嵌整个 PNG**（client.ts:151-161）：~1MB 卡片 → ~1.4MB base64 走 WebSocket，大卡片可能超限/慢；QQ 侧可考虑限幅。Discord 用 `AttachmentBuilder`，无此问题。
- **若干 Map 无清理**：`#lastDeliveryAt` / `#nextFastDeliveryAt`（按会话）、NapCat `#memberNameCache`（按群×人，1h TTL 但过期条目不主动删）——量级受会话数/提及人数约束，暂不严重。
- **Discord 适配器配置健康**：`cacheWithLimits` + `sweepers` 均开启（`adapter-discord/src/client.ts:40-52`），无问题。

## 十七、节点端优先级表

| 级别 | 项目 | 一句话 | 文件 |
|---|---|---|---|
| P1 | 队列全量重写 | 与中央同源，用同一套追加式改造顺手修 | `queue/sqlite-task-queue.ts` |
| P1 | 日志无轮转 | 加轮转 + 只读尾部 | `node-runtime/logger.ts` |
| P2 | 疾速模式 5s 节流 | 降速或可配置 | `runtime.ts` / `orchestrator.ts:68` |
| P2 | 非疾速 8s 上传窗 | 首段降到 2~3s | `runtime.ts:13` |
| P3 | NapCat 解析阻塞 | 移到 onMessage 之后 / 短缓存 | `adapter-napcat/client.ts` |
| P3 | base64 大图 | QQ 侧限幅 | `adapter-napcat/client.ts` |
