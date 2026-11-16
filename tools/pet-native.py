"""dsh-blob-pet 原生桌宠窗（PySide6）——不是浏览器，不是 web。

链路：
  DSH 插件宿主内引擎 --HTTP /frames（ndjson）--> 本脚本 --QSvgRenderer--> 透明无边框小窗

生命周期：
  - 启动读 ~/.dsh/blob-pet.json 的 port/token；先探测 /state 确认宿主 sidecar 就绪。
  - 轮询 /frames 永不放弃：连续失败上报 dead（窗先藏起来），恢复后上报 live（窗再显示）。
  - --parent-pid 指定的进程（DSH 宿主）消失 → 自杀（插件退出时也会 taskkill 本进程）。
  - 拖窗=移动；点一下=摸头（GET /pet）；双击=表演。
"""
import argparse
import ctypes
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.request

from PySide6.QtCore import Qt, QTimer, QByteArray
from PySide6.QtGui import QColor, QFont, QPainter, QPen, QRegion
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import QApplication, QWidget

STILL_ACTIVE = 259

LOG_MAX_BYTES = 256 * 1024   # 诊断日志上限，超了保留尾部（插件目录可能不可写，也不该无限长）
HEARTBEAT_SEC = 10.0         # 心跳日志间隔（曾经每秒一条 + 无轮转，长跑会撑爆日志）
FRAME_Q_MAX = 90             # 帧队列上限（25fps ≈ 3.6s 缓冲）
EVENT_Q_MAX = 200            # 事件队列上限


def dsh_home():
    return os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")


def pet_log_path():
    """日志放 DSH_HOME，不放插件安装目录——只读安装位置会让写日志静默失败。"""
    return os.path.join(dsh_home(), "blob-pet-input.log")


def _rotate_log(path: str) -> None:
    """超过上限就把文件换成尾部一半：先写临时文件再原子替换，进程被 taskkill 也写不坏。"""
    try:
        if os.path.getsize(path) <= LOG_MAX_BYTES:
            return
    except OSError:
        return
    keep = LOG_MAX_BYTES // 2
    try:
        with open(path, "rb") as f:
            f.seek(-keep, os.SEEK_END)
            tail = f.read()
        cut = tail.find(b"\n")
        if cut >= 0:
            tail = tail[cut + 1:]          # 别留半行
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(tail)
        os.replace(tmp, path)
    except OSError:
        pass                                # 轮转失败不该影响界面


def pet_log(msg: str) -> None:
    """诊断日志。目录不可写时静默跳过（绝不因为日志把窗搞崩）。"""
    path = pet_log_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
    except OSError:
        return
    _rotate_log(path)
    try:
        with open(path, "a", encoding="utf-8") as f:
            f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
    except OSError:
        pass


def redact_token(token: str) -> str:
    """token 一律只留前 4 位——整串落日志等于把栅栏钥匙写进明文文件。"""
    t = token or ""
    return f"{t[:4]}…" if t else ""


def parent_alive(pid: int) -> bool:
    """--parent-pid 指的宿主进程还在吗？

    必须用 ctypes 探测：os.waitpid/os.kill 只能管子进程或 POSIX，Windows 上判断
    "别人的进程"只能 OpenProcess + WaitForSingleObject/GetExitCodeProcess。
    探测**失败一律按活着处理**——一次权限/句柄抖动不该把用户的窗关掉。
    """
    if pid <= 0:
        return True
    if os.name != "nt":
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except OSError:
            return True                     # 权限不足等 → 按活着
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    h = k.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
    if not h:
        # 87 = ERROR_INVALID_PARAMETER：pid 确实不存在；其它错误（权限不足）按活着处理
        return ctypes.get_last_error() != 87
    try:
        if k.WaitForSingleObject(h, 0) == 0:    # WAIT_OBJECT_0：进程已退出
            return False
        code = ctypes.c_ulong()
        if not k.GetExitCodeProcess(h, ctypes.byref(code)):
            return True
        return code.value == STILL_ACTIVE
    except Exception as e:  # noqa: BLE001
        pet_log(f"parent_alive {pid} probe EXC {type(e).__name__}: {str(e)[:60]}")
        return True
    finally:
        k.CloseHandle(h)


def put_latest(q: queue.Queue, item) -> None:
    """有界队列入队：满了丢**最旧**的，绝不丢刚到的这一条。

    主线程被模态菜单/os.startfile 卡住时生产端仍 25/s 入队；无界队列会一路吃内存。
    """
    for _ in range(4):
        try:
            q.put_nowait(item)
            return
        except queue.Full:
            try:
                q.get_nowait()             # 丢最旧
            except queue.Empty:
                pass                       # 消费者刚取走，下一轮重试
    try:
        q.put_nowait(item)
    except queue.Full:                      # 4 轮都没挤进去（异常极端）
        pet_log(f"queue full, drop frame (qsize={q.qsize()} max={q.maxsize})")


def svg_aspect_ratio(svg_text: str):
    """从帧 SVG 里解析真实 viewBox 高宽比；解析不出返回 None（调用方保留旧值）。

    引擎按 "vx-45 vy-70 vw+90 vh+95" 扩边（当前是 -60 -85 349 354），
    写死常量必然随引擎调参过期 → 窗口高度/眼睛跟随比例一起歪。
    """
    if not svg_text:
        return None
    m = re.search(r'viewBox\s*=\s*["\']([^"\']+)["\']', svg_text)
    if not m:
        return None
    parts = [p for p in re.split(r"[\s,]+", m.group(1).strip()) if p]
    if len(parts) != 4:
        return None
    try:
        w, h = float(parts[2]), float(parts[3])
    except ValueError:
        return None
    if w <= 0 or h <= 0:
        return None
    return h / w


class Sse(threading.Thread):
    """连 sidecar 取帧：轮询 /frames(ndjson)，一次短连接只读一帧。

    只有这一条路径：引擎永远跑在宿主进程内，本窗不再拉起自己的 node 桥
    （两套引擎会让点击与画面各走一条路 —— 历史事故）。
    """

    BACKOFF_MAX = 15.0   # 失败退避上限（宿主重启要几十秒，2s 就放弃等于窗自杀）
    DEAD_AFTER = 20      # 连续失败超过这个数 → 上报 dead（窗隐藏），但仍继续重试

    def __init__(self, port, token, events: queue.Queue, on_state):
        super().__init__(daemon=True)
        self.port = port
        self.token = token
        self.events = events
        self.on_state = on_state
        self.alive = True
        self.fails = 0

    def _poll_frames(self):
        """每次新建一个短连接从 /frames 读一帧就关。

        极简、无长连接状态、无缓冲——urllib chunked 长连接卡死是画面冻住的根源。
        代价是每秒 ~60 次建连，本机回环可忽略。

        循环**永不 return**：sidecar 抖一下不该让窗永久消失。连续失败 >DEAD_AFTER
        上报 dead 让主循环把窗藏起来，之后继续重试；成功时上报 live 再显示。
        """
        self.on_state("connected")
        url = f"http://127.0.0.1:{self.port}/frames?k={self.token}"
        fails = 0
        dead = False
        # 日志只打 origin+path，token 只留前 4 位（曾经前 60 字符恰好把 token 写进日志）
        pet_log(f"POLL start http://127.0.0.1:{self.port}/frames k={redact_token(self.token)}")
        time.sleep(0.8)   # 让宿主 sidecar 就绪（启动瞬间猛敲会把建连排队压垮）
        while self.alive:
            t0 = time.monotonic()
            try:
                with urllib.request.urlopen(url, timeout=3) as r:
                    line = r.readline()          # 只读第一帧
                if line.strip():
                    frame = None
                    try:
                        frame = json.loads(line.decode("utf-8"))
                    except Exception as e:  # noqa: BLE001
                        pet_log(f"POLL bad frame {type(e).__name__}: {str(e)[:60]}")
                    if frame is not None:
                        put_latest(self.events, frame)
                        if getattr(self, "_first_ok", False) is False:
                            self._first_ok = True
                            pet_log("POLL first frame OK")
                        if dead:
                            dead = False
                            self.on_state("live")
                            pet_log("POLL recovered → live")
                fails = 0
                self.fails = 0
            except Exception as e:  # noqa: BLE001
                fails += 1
                self.fails = fails
                if fails <= 3:
                    pet_log(f"POLL fail#{fails} {type(e).__name__}: {str(e)[:60]}")
                if fails > self.DEAD_AFTER and not dead:
                    dead = True
                    self.on_state("dead")       # 只影响显隐，不再退出轮询
                    pet_log(f"POLL dead after {fails} fails, keep retrying (窗隐藏)")
                # 失败指数退避（0.2s→15s 上限），避免失败时疯狂重试压垮宿主
                time.sleep(min(self.BACKOFF_MAX, 0.2 * (1.5 ** min(fails, 20))))
                continue
            dt = time.monotonic() - t0
            # 25fps：短连接方案下 60fps 会把 sidecar 压垮（实测 10/s 稳、60/s 卡死）
            if dt < 0.04:
                time.sleep(0.04 - dt)

    def run(self):
        self._poll_frames()

    def pet(self, cmd="pet"):
        """摸头/表演：GET /pet。"""
        try:
            url = f"http://127.0.0.1:{self.port}/pet?k={self.token}&cmd={cmd}"
            with urllib.request.urlopen(url, timeout=3) as r:
                pet_log(f"pet OK {r.status} {cmd}")
        except Exception as e:  # noqa: BLE001
            pet_log(f"pet FAIL {type(e).__name__}: {str(e)[:80]}")

    def cmd(self, name, quiet=True, **params):
        """通用交互指令（拖动/跟随/配色）。失败不打扰用户，下一轮自然恢复。

        quiet=True 的调用是 10Hz 的 pointer/拖拽态，失败不记日志（否则日志被刷爆）；
        其它调用（scheme 等）失败要留痕。
        """
        q = "&".join([f"c={name}"] + [f"{k}={v}" for k, v in params.items()])
        url = f"http://127.0.0.1:{self.port}/cmd?k={self.token}&{q}"
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                r.read(1)
        except Exception as e:  # noqa: BLE001
            if not quiet:
                pet_log(f"cmd {name} FAIL {type(e).__name__}: {str(e)[:80]}")


VIEW_FILE = "blob-pet-view.json"
SVG_AR_DEFAULT = 354 / 349  # 引擎扩边后的 viewBox（-60 -85 349 354）；首帧起按真实 viewBox 校正
LABEL_PAD = 56      # 顶部气泡区
BODY_PAD_X = 12     # 角色绘制区左右内缩
BODY_PAD_BOTTOM = 4  # 角色绘制区底部内缩
MASK_MARGIN = 6     # mask 比绘制区略放一点，别把描边/抗锯齿裁掉
BUBBLE_MS_DEFAULT = 5000  # 帧里没给 labelMs 时的气泡时长
BOUNCE_SEC = 0.22   # 点击后的本地弹跳时长（弹跳期间 mask 需要整窗，否则角色被裁）


class PetWindow(QWidget):
    def __init__(self, frames: queue.Queue, port: int):
        super().__init__()
        self.frames = frames
        self.port = port
        self.setWindowFlags(Qt.FramelessWindowHint | Qt.WindowStaysOnTopHint | Qt.Tool)
        self.setAttribute(Qt.WA_TranslucentBackground)
        self.renderer = None
        self.label = ""
        self.label_until = 0.0
        self.press_at = None
        self.moved = False
        self.last_frame_at = time.monotonic()
        self.svg_ar = SVG_AR_DEFAULT
        self.user_hidden = False   # 右键"显示/隐藏"的意愿：主循环不得覆盖
        self._mask_key = None
        # 尺寸（可调，持久化）
        self.bot_px = self._load_size()
        self._apply_size(first=True)
        self.timer = QTimer(self)
        self.timer.timeout.connect(self.drain_frames)
        self.timer.start(16)
        self.sse_ref = None  # main() 里接上（摸头用）
        # 眼睛跟随光标：与页面版 followPointer 一致，10Hz 把全局光标换算成窗内归一坐标
        self._ptr_timer = QTimer(self)
        self._ptr_timer.timeout.connect(self._track_pointer)
        self._ptr_timer.start(100)
        self._last_ptr = None
        # 深浅色跟随系统（页面版用 prefers-color-scheme，桌面窗用注册表同项）
        self._scheme_timer = QTimer(self)
        self._scheme_timer.timeout.connect(self._sync_scheme)
        self._scheme_timer.start(3000)
        # 气泡到期/拖拽结束时没有事件触发，靠这个低频定时器把 mask 收回去
        self._mask_timer = QTimer(self)
        self._mask_timer.timeout.connect(self._update_mask)
        self._mask_timer.start(250)

    def _sync_scheme(self):
        if not self.sse_ref:
            return
        try:
            import winreg
            # with 保证 QueryValueEx 抛异常时也会 CloseKey（曾每 3 秒泄漏一个句柄）
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                                r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize") as k:
                light, _ = winreg.QueryValueEx(k, "AppsUseLightTheme")
            s = "light" if light else "dark"
            self._scheme_fail = False
        except Exception as e:  # noqa: BLE001
            # 每 3 秒一次，只在首次失败时记日志（非 Windows 上 import 就会失败）
            if not getattr(self, "_scheme_fail", False):
                self._scheme_fail = True
                pet_log(f"scheme probe FAIL {type(e).__name__}: {str(e)[:80]}")
            s = "light"
        if s != getattr(self, "_scheme", None):
            self._scheme = s
            self.sse_ref.cmd("scheme", v=s)

    def _track_pointer(self):
        if not self.sse_ref:
            return
        try:
            from PySide6.QtGui import QCursor
            gp = QCursor.pos()
        except Exception as e:  # noqa: BLE001
            if not getattr(self, "_ptr_fail", False):
                self._ptr_fail = True
                pet_log(f"cursor pos FAIL {type(e).__name__}: {str(e)[:60]}")
            return
        if self._last_ptr and (gp - self._last_ptr).manhattanLength() < 3:
            return
        self._last_ptr = gp
        r = self._body_rect()
        cx = self.mapToGlobal(r.center()).x()
        cy = self.mapToGlobal(r.center()).y()
        nx = (gp.x() - cx) / max(1.0, r.width() / 2)
        ny = (gp.y() - cy) / max(1.0, r.height() / 2)
        self.sse_ref.cmd("pointer", nx=f"{max(-1.6, min(1.6, nx)):.2f}", ny=f"{max(-1.6, min(1.6, ny)):.2f}")

    def _load_size(self):
        try:
            with open(os.path.join(dsh_home(), VIEW_FILE), encoding="utf-8") as f:
                px = int(json.load(f).get("botPx", 170))
                return max(90, min(420, px))
        except Exception as e:  # noqa: BLE001
            if not isinstance(e, FileNotFoundError):
                pet_log(f"load size FAIL {type(e).__name__}: {str(e)[:60]}")
            return 170

    def _save_size(self):
        try:
            with open(os.path.join(dsh_home(), VIEW_FILE), "w", encoding="utf-8") as f:
                json.dump({"botPx": self.bot_px}, f)
        except Exception as e:  # noqa: BLE001
            pet_log(f"save size FAIL {type(e).__name__}: {str(e)[:60]}")

    def _body_rect(self):
        """角色本体绘制区：渲染与 mask 共用同一块矩形，避免两边口径漂移。"""
        return self.rect().adjusted(BODY_PAD_X, LABEL_PAD, -BODY_PAD_X, -BODY_PAD_BOTTOM)

    def _bubbling(self):
        return bool(self.label) and time.monotonic() < self.label_until

    def _update_mask(self):
        """透明区域不该吃点击。

        原本没有任何 mask：顶部 56px 气泡带 + 左右各 12px 的透明像素都在吞下层窗口的
        点击。现在无气泡/不拖拽/不在弹跳时，mask 只罩角色本体（留 MASK_MARGIN 边距）；
        有气泡、正在拖拽、正在弹跳时覆盖整窗 —— mask 同时裁剪绘制，收太紧会把气泡
        或放大后的角色切掉。
        """
        full = self._bubbling() or self.press_at is not None
        if not full:
            full = time.monotonic() - getattr(self, "bounce_t0", 0) < BOUNCE_SEC + 0.1
        if full:
            key = ("full", self.width(), self.height())
        else:
            key = ("body", self.bot_px, self.width(), self.height())
        if key == self._mask_key:      # 状态没变就别反复 setMask
            return
        self._mask_key = key
        if full:
            self.clearMask()           # 空 mask 会让窗整个消失，清掉才是"覆盖整窗"
            return
        r = self._body_rect().adjusted(-MASK_MARGIN, -MASK_MARGIN, MASK_MARGIN, MASK_MARGIN)
        self.setMask(QRegion(r))

    def _apply_size(self, first=False):
        w = self.bot_px + 2 * BODY_PAD_X
        h = int(round(self.bot_px * self.svg_ar)) + LABEL_PAD
        self.resize(w, h)
        if first:
            from PySide6.QtGui import QGuiApplication
            scr = QGuiApplication.primaryScreen().availableGeometry()
            self.move(scr.right() - w - 40, scr.bottom() - h - 60)
        self._update_mask()
        self.update()

    def set_bot_px(self, px):
        px = max(90, min(420, int(px)))
        if px == self.bot_px:
            return
        # 右下角锚定缩放：位置观感稳定
        old = self.geometry()
        self.bot_px = px
        self._apply_size()
        g = self.geometry()
        self.move(old.right() - g.width(), old.bottom() - g.height())
        self._save_size()

    def resizeEvent(self, ev):  # noqa: N802
        super().resizeEvent(ev)
        self._update_mask()

    def drain_frames(self):
        latest = None
        try:
            while True:
                latest = self.frames.get_nowait()
        except queue.Empty:
            pass
        if latest is None:
            self._empty = getattr(self, "_empty", 0) + 1
            now = time.monotonic()
            if now - getattr(self, "_hb_empty", 0) > HEARTBEAT_SEC:
                self._hb_empty = now
                pet_log(f"drain alive, empty={self._empty} qsize={self.frames.qsize()}")
            return
        self.last_frame_at = time.monotonic()
        self.frame_count = getattr(self, "frame_count", 0) + 1
        svg_text = latest.get("svg") or ""
        # 真实宽高比来自每帧 viewBox（引擎改扩边参数时窗自己跟上）
        ar = svg_aspect_ratio(svg_text)
        if ar and abs(ar - self.svg_ar) > 0.002:
            old = self.geometry()
            self.svg_ar = ar
            self._apply_size()
            g = self.geometry()
            self.move(old.right() - g.width(), old.bottom() - g.height())   # 右下角锚定
            pet_log(f"SVG_AR → {ar:.4f}")
        try:
            self.renderer = QSvgRenderer(QByteArray(svg_text.encode("utf-8")))
        except Exception as e:  # noqa: BLE001
            pet_log(f"renderer EXC {type(e).__name__}: {str(e)[:80]}")
            return
        if not self.renderer.isValid():
            pet_log(f"renderer INVALID frame#{self.frame_count}")
        self.label = latest.get("label") or ""
        if self.label:
            ms = latest.get("labelMs") or BUBBLE_MS_DEFAULT   # 引擎给剩余毫秒，没有就是 0
            try:
                self.label_until = time.monotonic() + max(0.2, float(ms) / 1000.0)
            except (TypeError, ValueError):
                ms = BUBBLE_MS_DEFAULT
                self.label_until = time.monotonic() + BUBBLE_MS_DEFAULT / 1000.0
            else:
                pet_log(f"LABEL {self.label!r} ms={ms} state={latest.get('state')}")
        self._update_mask()
        self.update()
        # 每 HEARTBEAT_SEC 记一次心跳，证明帧真的进到窗里了
        now = time.monotonic()
        if now - getattr(self, "_hb", 0) > HEARTBEAT_SEC:
            self._hb = now
            pet_log(f"frames={self.frame_count} state={latest.get('state')} "
                    f"valid={self.renderer.isValid()} label={self.label!r} ar={self.svg_ar:.4f}")

    def paintEvent(self, _ev):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        drawn = False
        # 本地弹跳：点击后 220ms 内轻微缩放，保证"点了必有反应"
        bt = getattr(self, "bounce_t0", 0)
        age = time.monotonic() - bt if bt else 99
        if age < BOUNCE_SEC:
            import math
            k = math.sin(age / BOUNCE_SEC * math.pi)  # 0→1→0
            scale = 1.0 + 0.14 * k
            p.translate(self.width() / 2, self.height() / 2)
            p.scale(scale, scale)
            p.translate(-self.width() / 2, -self.height() / 2)
        if self.renderer and self.renderer.isValid():
            self.renderer.render(p, self._body_rect())
            drawn = True
        self._paints = getattr(self, "_paints", 0) + 1
        if self._paints % 120 == 1:
            pet_log(f"paint#{self._paints} drawn={drawn} size={self.width()}x{self.height()}")
        if self._bubbling():
            f = QFont()
            f.setPointSize(max(8, round(self.bot_px / 17)))
            f.setBold(True)
            p.setFont(f)
            fm = p.fontMetrics()
            tw = fm.horizontalAdvance(self.label) + 18
            th = fm.height() + 10
            bx = (self.width() - tw) // 2
            by = 6
            dark = QColor(23, 24, 28)
            p.setPen(Qt.NoPen)
            p.setBrush(QColor(255, 255, 255, 235))
            p.drawRoundedRect(bx, by, tw, th, 10, 10)
            p.setPen(QPen(dark))
            p.drawText(bx, by, tw, th, Qt.AlignCenter, self.label)
        p.end()

    def wheelEvent(self, ev):  # noqa: N802
        # 滚轮缩放。PySide6 6.12 的 QWheelEvent 没有 angle()（Qt5 的残影），
        # 只有 angleDelta()/pixelDelta()；触摸板常常只给 pixelDelta。
        dy = ev.angleDelta().y()
        if dy == 0:
            dy = ev.pixelDelta().y()
        if dy > 0:
            self.set_bot_px(self.bot_px * 1.12)
        elif dy < 0:
            self.set_bot_px(self.bot_px / 1.12)

    # —— 交互：拖动 = 挪窗；轻点 = 摸头 ——
    def mousePressEvent(self, ev):  # noqa: N802
        self.press_at = ev.globalPosition().toPoint()
        self.drag_off = self.press_at - self.frameGeometry().topLeft()
        self.moved = False
        self.press_t0 = time.monotonic()
        self._update_mask()   # 拖拽期间整窗可点，别在透明带上掉事件
        pet_log(f"press at {self.press_at.x()},{self.press_at.y()} btn={ev.button()}")

    def mouseMoveEvent(self, ev):  # noqa: N802
        if self.press_at:
            gp = ev.globalPosition().toPoint()
            # 位移 12px 且按住 >200ms 才算拖拽：普通手点抖动 5~10px 不该误判成拖
            if (gp - self.press_at).manhattanLength() > 12 and (time.monotonic() - self.press_t0) > 0.2:
                if not self.moved:
                    pet_log(f"drag begin {gp.x()},{gp.y()}")
                    # 与页面版一致：拖动显示他的 dragging 态（3→15→0 眼）
                    self.sse_ref.cmd("dragging")
                self.moved = True
                self.move(gp - self.drag_off)

    def mouseReleaseEvent(self, ev):  # noqa: N802
        pet_log(f"release moved={self.moved}")
        if self.press_at and not self.moved:
            # 本地即时反馈：先让窗自己动起来（0 延迟），再发网络命令。
            # 即使宿主/引擎那边有任何问题，用户也一定能看到"点了有反应"。
            self._bounce()
            self.sse_ref.pet("pet")
            pet_log("pet command sent")
        elif self.moved:
            self.sse_ref.cmd("drag-end")   # 放下：ball overlay 弹跳一下
        self.press_at = None
        self._update_mask()

    def _bounce(self):
        """本地弹跳反馈：缩放窗内绘制区域，60ms 内起落。"""
        self.bounce_t0 = time.monotonic()
        if not getattr(self, "_bounce_timer", None):
            self._bounce_timer = QTimer(self)
            self._bounce_timer.timeout.connect(self.update)
        self._bounce_timer.start(16)
        self._update_mask()   # 放大后的角色会超出本体矩形，先放开 mask
        QTimer.singleShot(220, self._bounce_end)

    def _bounce_end(self):
        try:
            self._bounce_timer.stop()
        except Exception as e:  # noqa: BLE001
            pet_log(f"bounce stop FAIL {type(e).__name__}: {str(e)[:60]}")
        self._update_mask()
        self.update()

    def mouseDoubleClickEvent(self, ev):  # noqa: N802
        # 双击表演（弹跳+转圈+粒子），窗永远留在屏上
        self.sse_ref.pet("show")

    def contextMenuEvent(self, ev):  # noqa: N802
        from PySide6.QtWidgets import QMenu
        m = QMenu(self)
        a_gallery = m.addAction("动作图鉴（39 态）")
        m.addSeparator()
        m.addAction("小 120", lambda: self.set_bot_px(120))
        m.addAction("中 170", lambda: self.set_bot_px(170))
        m.addAction("大 240", lambda: self.set_bot_px(240))
        m.addAction("特大 320", lambda: self.set_bot_px(320))
        m.addSeparator()
        a_show = m.addAction("显示/隐藏")
        a_quit = m.addAction("退出团子")
        act = m.exec(ev.globalPos())
        if act is a_gallery:
            try:
                os.startfile(f"http://127.0.0.1:{self.port}/gallery?k={(load_cfg() or {}).get('token', '')}")
            except Exception as e:  # noqa: BLE001
                pet_log(f"gallery open FAIL {type(e).__name__}: {str(e)[:80]}")
        elif act is a_show:
            vis = not self.isVisible()
            self.user_hidden = not vis      # 手动隐藏就别被 live 状态又弹出来
            self.setVisible(vis)
            self._update_mask()
        elif act is a_quit:
            QApplication.quit()


def load_cfg():
    try:
        with open(os.path.join(dsh_home(), "blob-pet.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:  # noqa: BLE001
        pet_log(f"load cfg FAIL {type(e).__name__}: {str(e)[:60]}")
        return None


def acquire_single_instance():
    """全局命名互斥体：已有团子窗在跑就退出，杜绝叠窗。返回 handle（进程退出自动释放）。"""
    if os.name != "nt":
        return True
    k = ctypes.windll.kernel32
    k.CreateMutexW(None, False, "Local\\dsh-blob-pet-window")
    if k.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        return False
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parent-pid", type=int, default=0)
    args = ap.parse_args()

    if not acquire_single_instance():
        sys.exit(0)  # 已有实例，安静退出

    cfg = load_cfg()
    if not cfg or "port" not in cfg or "token" not in cfg:
        sys.exit("blob-pet.json 无 port/token —— DSH 没在跑")

    # 唯一真源 = 宿主内引擎。启动时反复问 /state 直到宿主就绪（插件 spawn 可能早于 sidecar listen）。
    # 历史事故：窗内自带 node 引擎会让点击与画面各走一条路；那条路径本轮已整段删除，别加回来。
    ready = False
    deadline = time.monotonic() + 15
    probes = 0
    while time.monotonic() < deadline:
        try:
            # 注意：/state **有意免 token**（sidecar 只回 ok/version/running/inHost，
            # 不含帧也不含命令），本窗就靠它做就绪探测 —— 带上 ?k= 反而会 403。别"顺手"加鉴权。
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{cfg['port']}/state", timeout=2) as _r:
                if json.load(_r).get("inHost"):
                    ready = True
                    break
        except Exception as e:  # noqa: BLE001
            probes += 1
            if probes <= 3:
                pet_log(f"state probe#{probes} {type(e).__name__}: {str(e)[:60]}")
        time.sleep(0.5)
    if not ready:
        sys.exit("宿主 sidecar 未就绪（/state 无 inHost）—— 请重启 DSH 后由插件自动开窗")

    # 两个队列都必须有界：主线程被模态菜单/os.startfile 卡死时生产端仍 25/s 入队
    ev_q: queue.Queue = queue.Queue(maxsize=EVENT_Q_MAX)
    frame_q: queue.Queue = queue.Queue(maxsize=FRAME_Q_MAX)

    app = QApplication(sys.argv)
    win = PetWindow(frame_q, cfg["port"])

    state = {"sse": "connecting"}

    def on_sse_state(s):
        state["sse"] = s

    sse = Sse(cfg["port"], cfg["token"], ev_q, on_sse_state)
    sse.start()
    win.sse_ref = sse

    last_probe = {"t": 0.0}   # 父进程存活探测节流（1s 一次）

    def pump():
        # 帧桥：Sse 轮询拿到的「帧」放在 ev_q，这里转给 frame_q 供渲染。
        # （历史 bug：Sse 把帧放进 ev_q，而窗口只读 frame_q，pump 又是 pass ——
        #   帧永远卡在 ev_q 里，画面定格。这是"点了没反应"的最后一层。）
        try:
            while True:
                put_latest(frame_q, ev_q.get_nowait())
        except queue.Empty:
            pass

        # sidecar 抖了只藏窗，不退出：轮询自己在重试，恢复后 live 再显示。
        if state["sse"] == "dead":
            if win.isVisible():
                pet_log("sidecar dead → hide window (keep retrying)")
                win.hide()
        elif state["sse"] in ("connected", "live"):
            if not win.user_hidden and not win.isVisible():
                win.show()

        # 只有"明确给了 --parent-pid 且该进程确实没了"才退出（探测失败按活着处理）
        # 1s 探一次就够：每帧 20Hz 开句柄纯属浪费
        if args.parent_pid and time.monotonic() - last_probe["t"] >= 1.0:
            last_probe["t"] = time.monotonic()
            if not parent_alive(args.parent_pid):
                pet_log(f"parent pid {args.parent_pid} gone → quit")
                app.quit()

    pump_t = QTimer()
    pump_t.timeout.connect(pump)
    pump_t.start(50)

    win.show()
    rc = app.exec()
    sse.alive = False
    sys.exit(rc)


if __name__ == "__main__":
    main()
