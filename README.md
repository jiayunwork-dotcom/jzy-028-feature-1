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
未知窗规一律拒绝。
