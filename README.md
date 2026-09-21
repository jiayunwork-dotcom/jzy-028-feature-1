# CA-CFAR HTTP 服务

单元平均恒虚警（Cell-Averaging CFAR）检测服务：输入一条非负幅度距离线，
从左到右滑过每个被测单元（CUT），跳过紧邻 CUT 的保护单元，取两侧参考
单元的平均幅度乘以阈值因子 α 作为本单元门槛，CUT 幅度严格压过阈值即报目标。

- 阈值因子（指数 / 瑞利包络背景）：`α = N · (Pfa^(-1/N) − 1)`，`N = 2 × 每侧参考单元数`
- 边缘 CUT 任一侧参考凑不齐 → 标记 `invalid`、不检出、阈值为 `null`（绝不补零）
- 窗几何（保护单元数、每侧参考数、Pfa）可登记为具名窗规（启动载入内存，
  运行期可追加，不落库），也可在请求里直接内联给出
- 技术栈：Node.js 20 + NestJS，单容器 `node:20-slim`

## 构建与运行

```bash
npm install
npm run build
npm start            # 监听 0.0.0.0:3000

# 或镜像
docker build -t cacfar .
docker run --rm -p 3000:3000 cacfar
```

启动时预置两条窗规：`standard`（guard=2, ref/侧=8, Pfa=1e-3）、
`stringent`（guard=2, ref/侧=8, Pfa=1e-6）。

## API

### `POST /detect` —— 一趟滑窗检测

具名窗规：

```bash
curl -s -X POST localhost:3000/detect -H 'content-type: application/json' -d '{
  "amplitudes": [0.2, 0.5, 0.4, 0.3, 0.6, 12.0, 0.4, 0.5, 0.3, 0.2],
  "profileName": "standard"
}'
```

内联几何：

```bash
curl -s -X POST localhost:3000/detect -H 'content-type: application/json' -d '{
  "amplitudes": [0.2, 0.5, 0.4, 0.3, 12.0, 0.4, 0.5, 0.3],
  "guardCells": 1,
  "referenceCellsPerSide": 2,
  "pfa": 0.001
}'
```

响应：

```json
{
  "thresholds": [null, null, null, 2.91, 2.91, null, null, null],
  "detections": [false, false, false, false, true, false, false, false],
  "invalid": [true, true, true, false, false, true, true, true],
  "alpha": 5.83,
  "n": 4
}
```

### `POST /profiles` —— 追加具名窗规

```json
{ "name": "wide", "guardCells": 2, "referenceCellsPerSide": 16, "pfa": 0.0001 }
```

### `GET /profiles` —— 列出全部窗规

## 持续检测（流式会话）

雷达实际按扫描周期/脉冲一批批吐数据，不必先攒整条距离线。会话接口允许
声明一次窗几何后分批追加：每批只返回**因这批数据而状态发生变化**的单元，
服务内部只保留末尾 `2×(guardCells+每侧参考数)` 个幅度（与批次数、总线长
无关），不重扫历史。

- 一个单元右侧参考未到齐时先返回 `final:false` 的暂定无效（无阈值、不补零）；
- 后续批次把窗口补齐后，它会以 `retroactive:true, final:true` 被**追溯重判一次**，
  且只重判这一个单元；
- 一旦 `final:true` 落定，之后任何追加都不会再动它；
- 无论怎么切批（每批一个点也行），最终每个单元的阈值/检出/无效与 `POST /detect`
  完全一致。

### `POST /sessions` —— 开检测会话

请求体与 `/detect` 的窗几何声明相同（`profileName` 或内联几何二选一），返回
`sessionId` 与初始视图。

### `POST /sessions/:id/append` —— 追加一批幅度

```json
{ "amplitudes": [0.2, 0.5, 0.4] }
```

响应：

```json
{
  "sessionId": "...",
  "events": [
    { "index": 7, "state": "settled", "threshold": 2.91, "detection": false, "final": true, "retroactive": false },
    { "index": 8, "state": "invalid", "threshold": null, "detection": false, "final": false, "retroactive": false }
  ],
  "finalized": [7],
  "session": {
    "state": "open", "geometry": { "guardCells": 1, "referenceCellsPerSide": 2, "pfa": 0.001 },
    "alpha": 5.83, "n": 4,
    "totalCells": 9, "retainedCells": 6, "retainedLimit": 6,
    "pendingCells": 3, "finalizedCells": 3
  }
}
```

事件字段：

| 字段 | 含义 |
| --- | --- |
| `index` | 全局距离单元下标（按追加顺序从 0 编号） |
| `state` | `settled`（正式判决，带阈值）或 `invalid`（参考不齐，阈值恒为 `null`） |
| `final` | `false`=暂定（右侧参考未到齐，以后会被追溯）；`true`=落定，此后不再改写 |
| `retroactive` | `true`=本事件在追溯改写该单元早先给出的暂定无效 |

### `GET /sessions/:id/results/:index` —— 查某单元最新判决

仍在末尾保留窗口内返回当前记录（`kind:"result"`）；已随历史裁剪的单元返回
`kind:"forgotten"`（其正式结果早已在 append 事件流中交付）；下标还没追加到
返回 `kind:"future"`。

### `GET /sessions/:id` —— 会话视图

含窗几何、α/N、累计单元数、`retainedCells`/`retainedLimit`、暂定与落定计数，
可直接用于验证内存占用只随窗几何变化。

### `DELETE /sessions/:id` —— 显式关闭

右边缘仍暂定的单元按一趟式右边缘语义落定为终态无效（`retroactive:true`，随
响应返回），随后释放该会话全部保留历史。关闭后再追加/查询返回 410。

闲置会话由 TTL 自动回收（`SESSION_IDLE_TTL_MS`，默认 300000；0 表示不过期），
过期后追加同样返回 410；并发会话数受 `SESSION_MAX`（默认 1000）限制，超限
开会话返回 409。

## 校验规则（失败均为 4xx）

- `amplitudes` 必须是有限数字数组，幅度不可为负
- `guardCells` 为非负整数；`referenceCellsPerSide` 为整数且 ≥ 1（窗长为 0 直接拒绝）
- `pfa` 必须落在开区间 `(0, 1)`
- `profileName` 与内联几何二选一；点到未登记窗规返回 404
- 会话：不存在的 `sessionId` 返回 404；已关闭/已过期会话继续追加返回 410；
  非法窗几何开会话返回 400；并发会话超上限返回 409

## 测试

```bash
npm test
```

锁住的性质：α 随 Pfa/N 变化且符合钉死公式；强目标检出；保护单元/CUT 不进入
参考均值；边缘参考不足标无效而非补零；Pfa 降一个数量级则 α 升高、检出变少；
均匀指数噪声上经验虚警落入钉死波动带；负幅度、Pfa 越界、每侧参考为 0、
未知窗规一律拒绝。
