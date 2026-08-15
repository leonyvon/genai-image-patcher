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
            timeout=180,
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
    """设置提示词。缺省=全局提示词；给 image_id=该图片提示词；给 image_id+region_id=该选区提示词。"""
    if not _ensure_bridge():
        return _err("桥接服务不可达")
    res = _cmd("set_prompt", {"prompt": prompt, "image_id": image_id, "region_id": region_id})
    return _ok(res) if res.get("ok") else _err(str(res.get("error")))


@mcp.tool()
def generate(scope: str = "single") -> str:
    """触发生成。scope: 'single'（当前选中图）或 'all'（全部未跳过图）。立即返回，轮询 get_status 的 processingState 直到 IDLE。"""
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


def main():
    atexit.register(lambda: _bridge_proc and _bridge_proc.terminate())
    mcp.run()


if __name__ == "__main__":
    main()
