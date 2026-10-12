#!/usr/bin/env python3
"""服务端 TTS：把单词转成 WAV，让 Web / App / 小程序三端都用同一套发音。

    python scripts/tts-server.py

只监听 127.0.0.1，用 Kokoro-82M（Apache-2.0）离线合成，结果落盘缓存，
同一个词只合成一次。模型放在 models/，用 `npm run fetch:tts` 下载。

    GET /health           -> {"ok":true,...}
    GET /tts/<word>       -> audio/wav
"""
import json
import os
import re
import sys
import threading
import time
import unicodedata
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "models"
CACHE = ROOT / "tts-cache"
MODEL = MODELS / "kokoro-v1.0.onnx"
VOICES = MODELS / "voices-v1.0.bin"

HOST = os.environ.get("TTS_HOST", "127.0.0.1")
PORT = int(os.environ.get("TTS_PORT", "8791"))
# af_* = 美式女声，am_* = 美式男声；可用环境变量换
VOICE = os.environ.get("KOKORO_VOICE", "af_heart")
SAMPLE_RATE = 24000

# 词表里只有 `state-of-the-art`、`don't` 这类词，用白名单就够
SAFE_WORD = re.compile(r"^[A-Za-z][A-Za-z'-]*$")

_kokoro = None
_load_error = None
_lock = threading.Lock()


def load_kokoro():
    """常驻加载，只做一次 —— 每次请求都重新加载模型会慢好几秒。"""
    global _kokoro, _load_error
    if _kokoro is not None or _load_error is not None:
        return _kokoro
    if not MODEL.exists() or not VOICES.exists():
        _load_error = (
            f"缺少模型：{MODEL.name} / {VOICES.name}\n"
            "  运行 `npm run fetch:tts` 下载（约 337 MB，一次性）。"
        )
        return None
    try:
        from kokoro_onnx import Kokoro

        t0 = time.time()
        _kokoro = Kokoro(str(MODEL), str(VOICES))
        print(f"[tts] 模型加载完成，用时 {time.time() - t0:.1f}s，音色 {VOICE}", flush=True)
        return _kokoro
    except Exception as e:  # noqa: BLE001 - 启动失败要如实回报给调用方
        _load_error = f"{type(e).__name__}: {e}"
        print(f"[tts] 模型加载失败：{_load_error}", flush=True)
        return None


def cache_path(word: str) -> Path:
    key = unicodedata.normalize("NFKC", word).lower()
    return CACHE / f"{key}-{VOICE}.wav"


def write_wav(path: Path, samples: np.ndarray, sample_rate: int) -> None:
    """自己写 16-bit PCM，省掉 soundfile 这个依赖。"""
    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)


def synthesize(word: str) -> Path:
    dest = cache_path(word)
    if dest.exists() and dest.stat().st_size > 44:
        return dest

    kokoro = load_kokoro()
    if kokoro is None:
        raise RuntimeError(_load_error or "model not loaded")

    with _lock:
        if dest.exists() and dest.stat().st_size > 44:
            return dest
        t0 = time.time()
        samples, rate = kokoro.create(word, voice=VOICE)
        tmp = dest.with_suffix(".tmp")
        write_wav(tmp, samples, int(rate) if rate else SAMPLE_RATE)
        tmp.replace(dest)
        print(f"[tts] 合成 {word} ({time.time() - t0:.2f}s)", flush=True)
    return dest


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # 静音默认访问日志，只保留我们自己的打印
        pass

    def _json(self, code: int, payload: dict) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def _error(self, code: int, message: str) -> None:
        body = message.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 - http.server 的命名约定
        path = unquote(self.path.split("?", 1)[0])

        if path == "/health":
            self._json(200, {"ok": True, "ready": _kokoro is not None, "voice": VOICE,
                             "error": _load_error})
            return

        if not path.startswith("/tts/"):
            self._error(404, "not found")
            return

        word = path[len("/tts/"):].strip()
        if not SAFE_WORD.match(word):
            self._error(400, "invalid word")
            return
        if _load_error is not None and _kokoro is None:
            self._error(503, _load_error)
            return

        try:
            dest = synthesize(word)
        except Exception as e:  # noqa: BLE001
            print(f"[tts] 合成失败 {word}: {e}", flush=True)
            self._error(500, str(e))
            return

        data = dest.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(data)))
        # 内容由「词 + 音色」决定，不会变，可以放心让浏览器长缓存
        self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    CACHE.mkdir(parents=True, exist_ok=True)
    MODELS.mkdir(parents=True, exist_ok=True)

    print(f"[tts] 监听 http://{HOST}:{PORT}  音色 {VOICE}", flush=True)
    threading.Thread(target=load_kokoro, daemon=True).start()

    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
