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

## 持续检测会话（分批追加、增量判决）

雷达按扫描周期/脉冲分批出数时，不必每趟都把历史整条重扫：先开一个会话
声明窗几何，再分批追加幅度。每批只返回**因本批到达而变得可以下判的单元**；
右侧参考窗尚未凑齐的单元先标无效（`final: false`），后续批次把窗口补齐后
会被**追溯性重判**（且每批只重判受影响的那些单元）；一旦落定（`final: true`）
判决即冻结，后续追加绝不改写。任意批次切分（哪怕每批 1 点）的最终结果与
把整条线一次性送入 `POST /detect` 逐位一致。

### `POST /sessions` —— 开会话（201）

窗几何声明与 `/detect` 同一套二选一：`{ "profileName": "standard" }` 或
`{ "guardCells": 1, "referenceCellsPerSide": 2, "pfa": 0.001 }`。
返回 `sessionId`、本会话的 `alpha`/`n` 等。

### `POST /sessions/:id/append` —— 追加一批幅度

```bash
curl -s -X POST localhost:3000/sessions/$SID/append -H 'content-type: application/json' -d '{
  "amplitudes": [0.4, 0.5, 12.0, 0.3]
}'
```

响应只含本批影响的单元：

- `finalized`：因本批到达而落定的单元（含对之前待定单元的追溯重判），
  每个单元带 `index / threshold / detection / invalid / final / revision`；
- `pending`：本批新到、右窗未齐而暂标无效的单元；
- `received / finalizedCount / pendingCount / retainedAmplitudes`：进度与
  当前保留的末尾历史量。

### `GET /sessions/:id` —— 会话状态

几何、追加进度、`retainedAmplitudes`（保留的原始幅度个数，上界
`2×(guardCells+referenceCellsPerSide)`，只随窗几何变化，不随批次数增长）。

### `GET /sessions/:id/cells/:index` —— 查询某个单元的最新判决

`final: false` 表示右窗未齐、判决仍可能反悔；`revision` 记录该单元被
判定的次数（标无效 1 次，窗口补齐后追溯重判第 2 次，落定后冻结）。

### `DELETE /sessions/:id` —— 显式关闭并释放内存

会话内存管理：

- 服务内部只保留判定"窗口边界还没到齐的单元"所需的末尾一段原始数据，
  已落定单元之前的原始幅度即追加即弃；
- 显式 `DELETE` 立即释放会话占有的全部缓冲；
- 超过 `CFAR_SESSION_TTL_MS`（默认 10 分钟）未追加的闲置会话由后台清扫
  自动回收（周期 `CFAR_SESSION_SWEEP_MS`，默认 60 秒），防止忘记关闭的
  客户端耗光内存；
- 已关闭/已过期的会话再访问返回 **410 Gone**，从未存在过的返回 **404**。

多会话可并存：各自的几何、追加进度、保留历史互不干扰。

## 校验规则（失败均为 4xx）

- `amplitudes` 必须是有限数字数组，幅度不可为负
- `guardCells` 为非负整数；`referenceCellsPerSide` 为整数且 ≥ 1（窗长为 0 直接拒绝）
- `pfa` 必须落在开区间 `(0, 1)`
- `profileName` 与内联几何二选一；点到未登记窗规返回 404

## 测试

```bash
npm test
```

锁住的性质：α 随 Pfa/N 变化且符合钉死公式；强目标检出；保护单元/CUT 不进入
参考均值；边缘参考不足标无效而非补零；Pfa 降一个数量级则 α 升高、检出变少；
均匀指数噪声上经验虚警落入钉死波动带；负幅度、Pfa 越界、每侧参考为 0、
未知窗规一律拒绝。持续检测会话：任意批次切分与一次性整条送入结果逐位一致；
右窗未齐先标无效、补齐后追溯重判且每批只重判受影响单元；落定判决冻结不改写；
保留历史量不随批次数增长、只随窗几何变化；多会话互不干扰；关闭/过期会话
拒绝继续追加。
