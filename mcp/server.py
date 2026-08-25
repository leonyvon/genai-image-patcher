"""MCP server for genai-image-patcher bridge.

Coding agents use these tools to drive the browser app: read state, upload
images, mark reference images, write prompts, trigger generation and retrieve
results. Requires the Node bridge (bridge/server.mjs) to be reachable; this
server attempts to spawn it from the repo if it is not running.
"""

import atexit
import base64
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

import httpx
from mcp.server.fastmcp import FastMCP

BRIDGE_URL = os.environ.get("GENAI_BRIDGE_URL", "http://127.0.0.1:3100")
REPO_ROOT = Path(__file__).resolve().parent.parent
BRIDGE_SCRIPT = REPO_ROOT / "bridge" / "server.mjs"

mcp = FastMCP("genai-bridge")
_bridge_proc: subprocess.Popen | None = None


def _ensure_bridge() -> bool:
    """Return True if the bridge is reachable, spawning it when needed."""
    try:
        return httpx.get(f"{BRIDGE_URL}/health", timeout=2, trust_env=False).status_code == 200
    except Exception:
        pass
    global _bridge_proc
    node = shutil.which("node")
    if not node or not BRIDGE_SCRIPT.is_file():
        return False
    try:
        _bridge_proc = subprocess.Popen(
            [node, str(BRIDGE_SCRIPT)],
            cwd=str(REPO_ROOT),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception:
        return False
    for _ in range(25):
        try:
            if httpx.get(f"{BRIDGE_URL}/health", timeout=1, trust_env=False).status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def _get() -> dict:
    r = httpx.get(f"{BRIDGE_URL}/state", timeout=10, trust_env=False)
    r.raise_for_status()
    return r.json()


def _cmd(action: str, params: dict | None = None) -> dict:
    try:
        r = httpx.post(
            f"{BRIDGE_URL}/command",
            json={"action": action, "params": params or {}},
            timeout=600,  # 需覆盖 generate 阻塞等待（最长 10 分钟）
            trust_env=False,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        return {"ok": False, "error": f"桥接命令失败: {e}"}


def _ok(data) -> str:
    return json.dumps(data, ensure_ascii=False)


def _err(msg: str) -> str:
    return f"Error: {msg}"


def _refs_sorted(state: dict) -> list[str]:
    """当前有效参考图 id，按 referenceOrder 升序。签名与门禁均基于此。"""
    refs = [(img.get("referenceOrder") or 0, img.get("id"))
            for img in state.get("images", []) if img.get("isReference")]
    refs.sort()
    return [i for _, i in refs]


@mcp.tool()
def get_status() -> str:
    """获取应用当前状态：连接状态、处理进度、图库图片列表（含选区与提示词）、配置摘要。"""
    if not _ensure_bridge():
        return _err(f"桥接服务不可达（{BRIDGE_URL}）。请先运行 npm run dev 启动应用。")
    try:
        return _ok(_get())
    except Exception as e:
        return _err(str(e))


@mcp.tool()
def upload_image(paths: list[str]) -> str:
    """上传本地图片到应用图库。paths 为本地文件路径列表。返回新增图片 id 列表。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    added: list[str] = []
    for p in paths:
        path = Path(p).expanduser()
        if not path.is_file():
            return _err(f"文件不存在: {p}")
        try:
            r = httpx.post(
                f"{BRIDGE_URL}/files?name={path.name}",
                content=path.read_bytes(),
                timeout=120,
                trust_env=False,
            )
            r.raise_for_status()
            fdata = r.json()
        except Exception as e:
            return _err(f"上传文件失败 {p}: {e}")
        res = _cmd("upload", {"files": [{"url": fdata["url"], "name": path.name}]})
        if not res.get("ok"):
            return _err(str(res.get("error")))
        added.extend((res.get("result") or {}).get("ids") or [])
    return _ok({"added": added})


@mcp.tool()
def select_image(image_id: str) -> str:
    """切换应用当前选中的图片（后续 generate(scope='single') 默认处理该图）。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("select_image", {"image_id": image_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def mark_reference(image_id: str) -> str:
    """把图库中的一张图片标记为 grsai 参考图（提示词从 [image 2] 开始引用）。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("mark_reference", {"image_id": image_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def unmark_reference(image_id: str) -> str:
    """取消图片的参考图标记。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("unmark_reference", {"image_id": image_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def set_prompt(prompt: str, image_id: str | None = None, region_id: str | None = None) -> str:
    """设置提示词。缺省=全局；给 image_id=该图片；给 image_id+region_id=该选区。注意：每次调用都是**整体覆盖**该作用域的完整提示词（含历史翻译缓存块），不是追加。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("set_prompt", {"prompt": prompt, "image_id": image_id, "region_id": region_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def set_region_full_redraw(image_id: str, region_id: str, enabled: bool) -> str:
    """设置某选区的“同尺寸完全重制”开关。enabled=true 时该选区生成不发送选区图，仅按选区尺寸文生图（仅 grsai 生效）。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("set_region_full_redraw", {"image_id": image_id, "region_id": region_id, "enabled": bool(enabled)})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def get_image(image_id: str, output_path: str) -> str:
    """把图库中任意一张原图（含参考图）保存为本地文件并返回路径——供目检参考图内容、判断是否仍适用于本次任务。注意：output_path 必须用独立/临时路径。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("get_image", {"image_id": image_id})
    if not res.get("ok"):
        return _err(str(res.get("error")))
    result = res.get("result") or {}
    b64 = result.get("base64")
    if not b64:
        return _err("未获得图片数据")
    try:
        out = Path(output_path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(b64))
    except Exception as e:
        return _err(f"写文件失败: {e}")
    return _ok({"path": str(out), "mime": result.get("mime", "image/png"), "kind": result.get("kind", "original")})


@mcp.tool()
def review_references(task_description: str, keep: list[str] | None = None, remove: list[str] | None = None, add: list[str] | None = None) -> str:
    """【generate 前置必调】校准参考图：声明本次任务的参考图集合。
    task_description=本次任务一句话描述；keep=保留的参考图 id；remove=删除的参考图 id；add=新增标记的参考图 id。
    keep+remove 必须恰好覆盖当前所有参考图（漏一张即报错）。校准后 generate 才放行；参考图有任何变动都需重新校准。
    校准为一次性：仅当 generate 实际开始生成后才被消耗，下次 generate 需重新校准；API 失败/未开始生成不消耗，可直接重试。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    keep = keep or []
    remove = remove or []
    add = add or []
    if not task_description or not task_description.strip():
        return _err("task_description 必填：一句话说明本次任务，用于与上次校准对比")
    try:
        state = _get()
    except Exception as e:
        return _err(str(e))
    current = _refs_sorted(state)
    cur_set, keep_set, remove_set = set(current), set(keep), set(remove)
    unhandled = cur_set - keep_set - remove_set
    if unhandled:
        return _err(f"参考图未全部决策，漏了 {len(unhandled)} 张: {sorted(unhandled)}。keep+remove 必须覆盖当前所有参考图: {current}")
    conflict = keep_set & remove_set
    if conflict:
        return _err(f"keep 与 remove 重叠: {sorted(conflict)}")
    # 应用删除
    for rid in remove:
        if rid in cur_set:
            res = _cmd("unmark_reference", {"image_id": rid})
            if not res.get("ok"):
                return _err(f"删除参考图失败 {rid}: {res.get('error')}")
    # 应用新增
    for aid in add:
        res = _cmd("mark_reference", {"image_id": aid})
        if not res.get("ok"):
            return _err(f"新增参考图失败 {aid}: {res.get('error')}")
    # 等待快照防抖稳定（~300ms）后取新签名
    time.sleep(0.6)
    try:
        state2 = _get()
    except Exception as e:
        return _err(str(e))
    sig = json.dumps(_refs_sorted(state2), ensure_ascii=False, separators=(",", ":"))  # 紧凑 JSON，与 bridge refSignature 的 JSON.stringify 一致
    res = _cmd("set_calibration", {"signature": sig, "task": task_description})
    if not res.get("ok"):
        return _err(f"记录校准失败: {res.get('error')}")
    final_refs = [(img.get("referenceOrder") or 0, img.get("id"))
                  for img in state2.get("images", []) if img.get("isReference")]
    final_refs.sort()
    return _ok({
        "calibrated": True,
        "task": task_description,
        "signature": sig,
        "references": [{"id": i, "referenceOrder": o, "imageIndex": o + 1} for o, i in final_refs],
    })


@mcp.tool()
def generate(scope: str = "single") -> str:
    """触发生成并**阻塞等待完成**。scope: 'single'（当前选中图）或 'all'（全部未跳过图）。
    正常完成返回 ok 且 result.processingState='DONE'；出错/被停止为 'IDLE'。单次调用最长等待 10 分钟。
    **参考图门禁**：若存在参考图且未先调用 review_references 校准（或校准后参考图有变动），本工具会直接报错，必须先校准。
    校准为一次性：每次实际开始生成后即被消耗，下次 generate 需重新校准；API 失败/未开始生成不消耗，可直接重试。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("generate", {"scope": scope})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def get_full_image(image_id: str, output_path: str) -> str:
    """把整图最终结果保存为本地文件并返回路径。标准区域模式返回"原图+补丁拼合"的最终结果；反向遮罩返回拼合整图。注意：output_path 必须用独立/临时路径，禁止设为上传的原图或源文件路径（会覆盖并永久丢失原图）。无结果时提示先 generate。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("get_full_image", {"image_id": image_id})
    if not res.get("ok"):
        return _err(str(res.get("error")))
    result = res.get("result") or {}
    b64 = result.get("base64")
    if not b64:
        return _err("未获得图片数据（可能尚无结果，请先 generate）")
    try:
        out = Path(output_path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(b64))
    except Exception as e:
        return _err(f"写文件失败: {e}")
    return _ok({"path": str(out), "mime": result.get("mime", "image/png"), "kind": result.get("kind", "full")})


@mcp.tool()
def get_region_patch(image_id: str, region_id: str, output_path: str) -> str:
    """把某个选区的补丁切片保存为本地文件并返回路径。注意：返回的是切片（kind:patch），不是整页，禁止覆盖原图路径；先落临时文件目检后再决定。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("get_region_patch", {"image_id": image_id, "region_id": region_id})
    if not res.get("ok"):
        return _err(str(res.get("error")))
    result = res.get("result") or {}
    b64 = result.get("base64")
    if not b64:
        return _err("未获得补丁数据（可能尚无结果，请先 generate）")
    try:
        out = Path(output_path).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(base64.b64decode(b64))
    except Exception as e:
        return _err(f"写文件失败: {e}")
    return _ok({"path": str(out), "mime": result.get("mime", "image/png"), "kind": result.get("kind", "patch")})


@mcp.tool()
def set_region_patch(image_id: str, region_id: str, file_path: str) -> str:
    """把本地生成的图片文件作为补丁替换到指定选区（codex 生成模式）。file_path 为本地图片绝对路径（codex 自行生成的图片）。
    应用侧按现有手动修补链路把该图设为选区补丁（status→completed、锚点对齐），之后 get_region_patch / get_full_image 立即可取。
    注意：只替换已有选区，不创建选区；与 generate 的参考图门禁无关，任意生成模式可用。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    path = Path(file_path).expanduser()
    if not path.is_file():
        return _err(f"文件不存在: {file_path}")
    try:
        r = httpx.post(
            f"{BRIDGE_URL}/files?name={path.name}",
            content=path.read_bytes(),
            timeout=120,
            trust_env=False,
        )
        r.raise_for_status()
        fdata = r.json()
    except Exception as e:
        return _err(f"上传文件失败 {file_path}: {e}")
    url = fdata.get("url")
    if not url:
        return _err(f"上传文件失败 {file_path}: 桥接未返回文件 URL")
    res = _cmd("set_region_patch", {"image_id": image_id, "region_id": region_id, "url": url})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


def main():
    atexit.register(lambda: _bridge_proc and _bridge_proc.terminate())
    mcp.run()


if __name__ == "__main__":
    main()
