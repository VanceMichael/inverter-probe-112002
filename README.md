# 换接线后的光储测点接收

这里提供独立来源的本地合成记录，与实际单位、个人和线上业务无关。

## 本地运行

使用 Node.js 22.23.4。只使用 Node.js 自带的运行库。

- `npm test`：合成来源接口测试 + 入站流水线领域测试（16 项）。
- `npm start`：启动来源，默认监听 `127.0.0.1:4100`，可用环境变量 `PORT` 调整。
- `npm run demo`：在进程内启动来源并推进全部 4 个回放阶段，打印归属、失效、覆盖与补票结果。

## 来源接口资料

| GET 路由 | 来源约定 |
| --- | --- |
| `/source/archive` | 导出时刻与发生时刻分别是 exported、measured。原样值 unit 单独声明，累计数值按现场倍数解释。 |
| `/source/live` | 数组 seq 按柜递增，本地序号空洞不能证明从未测到。origin 声明重放身份。 |
| `/source/wiring` | 安装间隔左闭右开；direction 是该物理侧别的计量符号。cutover.base 为拆、装底数及连续证明。 |

查询参数 `offset` 是从零开始的页偏移，`limit` 默认 3，取值 1 至 100。响应中的 `records` 含 `record` 来源记录键、`availableFrom` 首次出现的回放阶段、`kind` 记录类型、`payload` 业务字段。来源记录键与业务身份分别定义。`next` 为下一页偏移，末页为 `null`。回放阶段中的记录按到达顺序可查。

控制员通过 `POST /control?stage=2` 切换到第 2 阶段，服务会保留更早已可查的记录。每次换阶段后按根路径返回的 `stage` 确认切换成功。

## 接收侧模块（`lib/`）

| 模块 | 职责 |
| --- | --- |
| `time.mjs` | “HH:MM”与当日分钟数互转；接线区间统一左闭右开 `[start, end)`。 |
| `source-client.mjs` | 分页领取两种采集柜的历史与实时推送；按 `record` 键幂等，重放页与重复推送不产生第二条入站记录。 |
| `wiring-registry.mjs` | 接线修订登记（按 revision 演进、按区间生效）、发生时刻归属解析、换接拼接判定。 |
| `station-store.mjs` | 入站记录、释出痕迹、覆盖台账、保存期底数与物理测点连续段。 |
| `energy.mjs` | 累计量解释与电量窗口；换接边界阻断、倒退增量作废。 |
| `pipeline.mjs` | 编排：接线先于样本处理、重放归并、修订失效与重释出、挂起恢复。 |
| `consumer.mjs` | 实时消费者视图：确认覆盖区间、失效订阅、只含缺失时段的补票。 |

## 归属与计量纪律

1. **三层身份分开**：入站身份（来源记录键、柜、通道、sample、seq）、物理样本（sample）、物理测点（point）。同一通道号在不同柜里没有共通意义。
2. **重放不双算**：带 `origin` 的重放记录只挂为正本的入站别名（`replay-alias`），不产生新读数；归属按样本**发生时刻**适用的接线属性，而不是接收时刻或柜内重放起点。
3. **留痕完整**：每条释出保留入站身份、现场时刻 `measured`、导出/接收时刻、原始单位与累计值、计量方向、质量码与接线依据（含 revision）。修订只追加痕迹，旧痕迹标 `withdrawn` 并注明原因。
4. **接线修订**：新修订在其声明区间内推翻旧依据；受影响样本先发 `invalidated`（带接线事件、区间、新旧依据与样本名），再按新依据 `rereleased`。修订可使连续性暂时倒退。
5. **挂起与恢复**：无适用接线的读数保持 `suspended`；补登记接线后可转 `released`（事件 `unblocked`），同站未搬迁通道的服务不受影响。
6. **累计量禁拼**：仅当 cutover 声明 `continuous=true` 且拆、装底数均非空时，才允许按两侧倍率平移拼接（`cross-cutover`）。否则边界记 `blockedBoundaries`，差值不得当发电量，也不得用相邻柜读数填齐；原始累计倒退的增量进 `invalidIncrements`。
7. **覆盖不等于完整**：覆盖段分为 `covered`、`suspended`、`explicit-empty`（现场校验表确认无测量）、`pending`（保存期内暂时无法补齐）、`unrecoverable`（早于来源保存期底数）。只要存在 pending/suspended/unrecoverable，覆盖就不是完整；seq 空洞不产生显式空档。
8. **按需补取**：`backfillTicket` 只列保存期内的 pending 时段，检修员只补缺失点位与时段，不必重取全站。
