# grsai 全局参考图功能设计

日期：2026-08-15
状态：待实现

## 背景与目标

当前 grsai（gpt-image-2）路径下，生成请求只发送选区切片一张图（`images: [slice]`）。用户希望在改图时能额外提供任意数量的参考图，并在提示词中通过 `[image 2]`、`[image 3]`… 引用它们（`[image 1]` 固定为选区切片本身）。grsai 接口原生支持多参考图（"Multiple images are combined for multi-reference edits"），本功能是对其接口层面的扩展，不改变其他 provider 行为。

## 需求决策记录（已与用户确认）

| 决策点 | 结论 |
|---|---|
| 作用范围 | **全局**：一套参考图，附加到所有 grsai 生成请求 |
| 索引约定 | `[image 1]` = 选区切片；`[image 2]`+ = 参考图（按标记顺序） |
| 生效 provider | **仅 grsai**，Gemini / OpenAI 路径不碰 |
| 存储策略 | 方案 A：压缩后持久化到 `AppConfig` / localStorage，刷新不丢 |
| 管理入口 | 图库缩略图"参考图"开关（主入口）+ SettingsPanel grsai 区块参考图列表（刷新后仍可管理） |
| 参考图是否参与处理 | **自动排除**：标记为参考图的图片不参与选区生成，只作参考发送 |

## 数据模型

- `types.ts`：`AppConfig` 新增字段

  ```ts
  /** grsai 全局参考图（压缩后的 base64 data URL 数组）。请求时作为 images[1..n] 发送。 */
  grsaiReferenceImages: string[];
  ```

- `hooks/useConfig.ts`：
  - `DEFAULT_CONFIG` 增加 `grsaiReferenceImages: []`
  - 迁移保障：旧配置缺少该字段时补 `[]`

## 请求构造（services/aiService.ts）

- `generateGrsaiImage` 签名增加可选参数：`referenceImages?: string[]`
- `generateRegionEdit` 的 grsai 分支调用时传入 `config.grsaiReferenceImages`
- 请求体 `images` 数组：

  ```ts
  images: [dataUrl, ...referenceImages]  // dataUrl = 选区切片，参考图按顺序在后
  ```

- `aspectRatio` 仍由选区切片尺寸推导，不受参考图影响
- 无参考图时行为与现状完全一致

## UI 设计

### 图库（主入口）

- `UploadedImage` 新增会话级标志 `isReference?: boolean`（仅内存，不持久化——持久化载体是 config 里的压缩副本）
- 每个缩略图新增"参考图"开关（星标/书签图标，样式沿用现有 skip/delete 图标按钮模式）
- 标记时（`isReference = true`）：将图片压缩（最长边 1024，目标 ~200KB，复用 `compressImageToTargetSize`）后追加写入 `config.grsaiReferenceImages`，并持久化；取消标记时按压缩后 base64 内容匹配从配置中移除
- 标记后缩略图左上角显示索引角标 `[image 2]` / `[image 3]`…（按标记顺序）
- 标记为参考图的图片**自动排除出处理队列**：不参与批量/单选生成（处理逻辑中 `isReference` 与 `isSkipped` 同样跳过），且**不进入 ZIP 下载**（避免把参考图当结果导出）

### SettingsPanel grsai 区块

- 显示当前参考图列表（缩略图 + 索引角标 + 每张删除按钮）
- 作用：页面刷新后图库清空，参考图仍可通过此处查看与删除
- 与图库读写同一个 `config.grsaiReferenceImages`，实时同步

## 边界情况与错误处理

- 参考图压缩或转 base64 失败 → 跳过该张并 `console.warn`，不阻塞整个请求
- 空参考图列表 → 请求退化为单图，行为不变
- 参考图不参与 `aspectRatio` 推导、不参与 square fill / 遮罩逻辑

## 不做的事（YAGNI）

- 参考图拖拽排序（删除重加即可）
- 参考图按选区/按图片差异化挂载（用户已确认全局）
- 参考图在 Gemini/OpenAI 路径的兼容处理

## 验证方式

- `npx tsc --noEmit` 与 `npm run build` 通过
- 手动验证：
  1. 图库上传多图，标记其中两张为参考图，观察角标与自动排除
  2. grsai 生成，F12 控制台 `[grsai-debug] request` 确认 `images` 数组长度 = 1 + 参考图数，顺序正确
  3. 提示词中引用 `[image 2]` / `[image 3]`，确认模型按参考图出图
  4. 刷新页面，确认参考图仍在（SettingsPanel 可见、可删）
  5. 无参考图时生成行为与改动前一致
