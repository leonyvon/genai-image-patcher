import { Region } from '../types';
import { loadImage, cropRegion, urlToBase64 } from './imageUtils';

export const DEFAULT_IOPAINT_URL = 'http://127.0.0.1:8080';

export interface IopaintRemoveResult {
  /** 选区补丁 object URL（从 IOPaint 整图结果按选区切出，全分辨率）。调用方负责释放。 */
  patchUrl: string;
}

const canvasToDataURL = (canvas: HTMLCanvasElement): Promise<string> =>
  new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('canvas.toBlob returned null'));
          return;
        }
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      },
      'image/png'
    );
  });

/**
 * 发送整图 + 任意形状 mask 到 IOPaint，返回整图结果 object URL（原尺寸）。
 * mask 语义：白色 = 要重绘/移除区域（与 LaMa 约定一致）。
 * 契约已用探测脚本验证：POST {serverUrl}/api/v1/inpaint，body JSON {image, mask}（dataURL 均可，
 * 服务端自动剥前缀），返回二进制 PNG（原尺寸）。调用方负责释放返回的 URL。
 */
export async function inpaintWithMask(
  originalUrl: string,
  maskDataUrl: string,
  serverUrl: string = DEFAULT_IOPAINT_URL
): Promise<string> {
  const imageDataUrl = await urlToBase64(originalUrl);

  let res: Response;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, '')}/api/v1/inpaint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl, mask: maskDataUrl }),
    });
  } catch (e) {
    throw new Error(`IOPaint 服务不可达（${serverUrl}），请确认已启动（iopaint start --model=anime-lama）`);
  }
  if (!res.ok) {
    throw new Error(`IOPaint error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }

  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * 用 IOPaint（LaMa 等擦除模型）移除/重绘选区内容。
 * - 输入：整图 originalUrl（全分辨率，保质量）+ 选区矩形 mask（白=要重绘区域，LaMa 语义）
 * - 输出：从返回的整图结果中按选区切出补丁 URL（与现有 AI 补丁管线一致，锚点=选区坐标）
 *
 * 契约已用探测脚本验证：POST {serverUrl}/api/v1/inpaint，body JSON {image, mask}（dataURL 均可，
 * 服务端自动剥前缀），返回二进制 PNG（原尺寸）。
 */
export async function removeRegionWithIopaint(
  originalUrl: string,
  region: Region,
  serverUrl: string = DEFAULT_IOPAINT_URL
): Promise<IopaintRemoveResult> {
  const imgEl = await loadImage(originalUrl);
  const w = imgEl.naturalWidth;
  const h = imgEl.naturalHeight;

  // mask：整图尺寸，全黑底 + 选区矩形白色（白 = 要重绘/移除）
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  if (!mctx) throw new Error('Could not get canvas context');
  mctx.fillStyle = '#000000';
  mctx.fillRect(0, 0, w, h);
  mctx.fillStyle = '#FFFFFF';
  const rx = (region.x / 100) * w;
  const ry = (region.y / 100) * h;
  const rw = (region.width / 100) * w;
  const rh = (region.height / 100) * h;
  mctx.fillRect(rx, ry, rw, rh);

  const maskDataUrl = await canvasToDataURL(maskCanvas);
  const resultUrl = await inpaintWithMask(originalUrl, maskDataUrl, serverUrl);
  try {
    const resultImg = await loadImage(resultUrl);
    const patchUrl = await cropRegion(resultImg, region);
    return { patchUrl };
  } finally {
    URL.revokeObjectURL(resultUrl);
  }
}
