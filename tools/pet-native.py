"""dsh-blob-pet 原生桌宠窗（PySide6）——不是浏览器，不是 web。

链路：
  DSH 插件宿主 --SSE--> 本脚本 --stdin--> node 渲染桥（跑 grok-icon-study 引擎）
  渲染桥 --stdout 帧{svg,label,state}--> 本脚本 --QSvgRenderer--> 透明无边框小窗

生命周期：
  - 启动读 ~/.dsh/blob-pet.json 的 port/token；SSE 连 /events。
  - --parent-pid 指定的进程（DSH 宿主）消失 → 自杀（插件退出时也会 taskkill 本进程）。
  - SSE 连续失败超过 6 次（DSH 没在跑）→ 退出。
  - 拖窗=移动；点一下=摸头（发 {"cmd":"pet"} 给桥）；双击=隐藏到下次启动。

仅供本机个人学习使用；形象数据归 xAI/原权利人。
"""
import argparse
import ctypes
import json
import os
import queue
import socket
import subprocess
import sys
import threading
import time
import urllib.request

from PySide6.QtCore import Qt, QTimer, QByteArray, QPoint
from PySide6.QtGui import QColor, QFont, QPainter, QPen
from PySide6.QtSvg import QSvgRenderer
from PySide6.QtWidgets import QApplication, QWidget

STILL_ACTIVE = 259


def dsh_home():
    return os.environ.get("DSH_HOME") or os.path.join(os.path.expanduser("~"), ".dsh")


def parent_alive(pid: int) -> bool:
    if pid <= 0:
        return True
    if os.name == "nt":
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == STILL_ACTIVE
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


class Bridge(threading.Thread):
    """node 渲染桥子进程：喂事件/命令，收帧。"""

    def __init__(self, root, frames: queue.Queue, stderr_sink):
        super().__init__(daemon=True)
        self.root = root
        self.frames = frames
        self.err = stderr_sink
        self.proc = None
        self.alive = True
        self.gen = 0

    def run(self):
        gen = self.gen
        node = shutil_which_node()
        script = os.path.join(self.root, "tools", "render-bridge.cjs")
        try:
            self.proc = subprocess.Popen(
                [node, script],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                cwd=self.root, text=False,
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
        except Exception as e:  # noqa: BLE001
            self.err(f"渲染桥启动失败: {e}")
            if self.gen == gen:
                self.alive = False
            return
        threading.Thread(target=self._pump_err, daemon=True).start()
        buf = b""
        while self.alive and self.gen == gen:
            try:
                chunk = self.proc.stdout.readline()
            except Exception:  # noqa: BLE001
                break
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    self.frames.put(json.loads(line.decode("utf-8")))
                except Exception:  # noqa: BLE001
                    pass
        if self.gen == gen:
            self.alive = False

    def _pump_err(self):
        try:
            for raw in iter(self.proc.stderr.readline, b""):
                self.err("bridge: " + raw.decode("utf-8", "replace").strip())
        except Exception:  # noqa: BLE001
            pass

    def send(self, obj: dict):
        if not self.alive or not self.proc or not self.proc.stdin:
            return
        try:
            self.proc.stdin.write((json.dumps(obj) + "\n").encode("utf-8"))
            self.proc.stdin.flush()
        except Exception:  # noqa: BLE001
            pass  # 桥正在被重拉，下一帧自然恢复；不置 alive（看门狗负责）

    def restart(self):
        """看门狗调用：杀掉僵死桥重拉一个。"""
        self.gen += 1
        try:
            if self.proc:
                self.proc.kill()
        except Exception:  # noqa: BLE001
            pass
        self.alive = True
        threading.Thread(target=self.run, daemon=True).start()

    def kill(self):
        self.alive = False
        try:
            if self.proc:
                self.proc.kill()
        except Exception:  # noqa: BLE001
            pass


def shutil_which_node():
    import shutil
    for cand in (shutil.which("node"), r"D:\ai\node.exe",
                 os.path.join(dsh_home(), "dsh-runtimes", "node", "node.exe")):
        if cand and os.path.exists(cand):
            return cand
    return "node"


class Sse(threading.Thread):
    """连 sidecar 取帧：inhost 模式走 /frames(ndjson)，回退模式走 /events(SSE)+本地桥。"""

    def __init__(self, port, token, events: queue.Queue, on_state, inhost=True):
        super().__init__(daemon=True)
        self.port = port
        self.token = token
        self.events = events
        self.on_state = on_state
        self.inhost = inhost
        self.alive = True
        self.fails = 0

    def _poll_frames(self):
        """inhost 模式：每次新建一个短连接从 /frames 读一帧就关。
        极简、无长连接状态、无缓冲——urllib chunked 长连接卡死是画面冻住的根源。
        代价是每秒 ~60 次建连，本机回环可忽略。"""
        self.on_state("connected")
        url = f"http://127.0.0.1:{self.port}/frames?k={self.token}"
        fails = 0
        self._log_pet(f"POLL start url={url[:60]} port={self.port} inhost={self.inhost}")
        time.sleep(0.8)   # 让宿主 sidecar 就绪（启动瞬间猛敲会把建连排队压垮）
        while self.alive:
            t0 = time.monotonic()
            try:
                with urllib.request.urlopen(url, timeout=3) as r:
                    line = r.readline()          # 只读第一帧
                if line.strip():
                    self.events.put(json.loads(line.decode("utf-8")))
                    if fails == 0 and getattr(self, "_first_ok", False) is False:
                        self._first_ok = True
                        self._log_pet("POLL first frame OK")
                fails = 0
            except Exception as e:  # noqa: BLE001
                fails += 1
                if fails <= 3:
                    self._log_pet(f"POLL fail#{fails} {type(e).__name__}: {str(e)[:60]}")
                if fails > 20:
                    self.on_state("dead")
                    return
                # 失败指数退避（0.2s→2s 上限），避免失败时疯狂重试压垮宿主
                time.sleep(min(2.0, 0.2 * (1.5 ** min(fails, 8))))
                continue
            dt = time.monotonic() - t0
            # 25fps：短连接方案下 60fps 会把 sidecar 压垮（实测 10/s 稳、60/s 卡死）
            if dt < 0.04:
                time.sleep(0.04 - dt)

    def run(self):
        if self.inhost:
            self._poll_frames()
            return
        url = f"http://127.0.0.1:{self.port}/events?k={self.token}"
        while self.alive:
            try:
                req = urllib.request.Request(url, headers={"Accept": "application/x-ndjson" if self.inhost else "text/event-stream"})
                resp = urllib.request.urlopen(req, timeout=30)
                self.fails = 0
                self.on_state("connected")
                buf = b""
                # 块读 + 行缓冲：逐字节 read(1) 跟不上 60fps（每帧 ~2.3KB，秒流量 140KB），
                # 会积压几十秒旧帧 → 画面永远滞后于引擎（历史事故：点了没反应）。
                while self.alive:
                    chunk = resp.read(8192)
                    if not chunk:
                        break
                    buf += chunk
                    while b"\n" in buf:
                        line, buf = buf.split(b"\n", 1)
                        if not line.strip():
                            continue
                        if self.inhost:
                            try:
                                self.events.put(json.loads(line.decode("utf-8")))
                            except Exception:  # noqa: BLE001
                                pass
                        elif line.startswith(b"data: "):
                            try:
                                self.events.put(json.loads(line[6:].decode("utf-8")))
                            except Exception:  # noqa: BLE001
                                pass
                    # 缓冲无限增长说明对端不是我们要的行格式，防内存爆
                    if len(buf) > 1 << 20:
                        buf = b""
            except Exception:  # noqa: BLE001
                self.fails += 1
                if self.fails > 6:
                    self.on_state("dead")
                    return
                time.sleep(min(15, 2 ** self.fails))

    def pet(self, cmd="pet"):
        """摸头/表演：inhost 走 GET /pet；回退模式直接发 stdin 桥。"""
        try:
            if self.inhost:
                url = f"http://127.0.0.1:{self.port}/pet?k={self.token}&cmd={cmd}"
                with urllib.request.urlopen(url, timeout=3) as r:
                    self._log_pet(f"pet OK {r.status} {cmd}")
            else:
                self.on_state(("bridge-cmd", cmd))
        except Exception as e:  # noqa: BLE001
            self._log_pet(f"pet FAIL {type(e).__name__}: {e}")

    def cmd(self, name, quiet=True, **params):
        """通用交互指令（拖动/跟随/配色）。失败不打扰用户，下一轮自然恢复。"""
        if not self.inhost:
            self.on_state(("bridge-cmd", name))
            return
        q = "&".join([f"c={name}"] + [f"{k}={v}" for k, v in params.items()])
        url = f"http://127.0.0.1:{self.port}/cmd?k={self.token}&{q}"
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                r.read(1)
        except Exception as e:  # noqa: BLE001
            if not quiet:
                self._log_pet(f"cmd {name} FAIL {type(e).__name__}: {e}")
    def _log_pet(self, msg):
        try:
            with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pet-input.log"), "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        except Exception:  # noqa: BLE001
            pass


VIEW_FILE = "blob-pet-view.json"
SVG_AR = 384 / 349  # 扩边后 viewBox 的高宽比
LABEL_PAD = 56      # 顶部气泡区


class PetWindow(QWidget):
    def __init__(self, bridge, frames: queue.Queue, port: int):
        super().__init__()
        self.bridge = bridge
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

    def _sync_scheme(self):
        if not self.sse_ref:
            return
        try:
            import winreg
            k = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                               r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
            light, _ = winreg.QueryValueEx(k, "AppsUseLightTheme")
            winreg.CloseKey(k)
            s = "light" if light else "dark"
        except Exception:  # noqa: BLE001
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
        except Exception:  # noqa: BLE001
            return
        if self._last_ptr and (gp - self._last_ptr).manhattanLength() < 3:
            return
        self._last_ptr = gp
        r = self.rect().adjusted(12, LABEL_PAD, -12, -4)
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
        except Exception:  # noqa: BLE001
            return 170

    def _save_size(self):
        try:
            with open(os.path.join(dsh_home(), VIEW_FILE), "w", encoding="utf-8") as f:
                json.dump({"botPx": self.bot_px}, f)
        except Exception:  # noqa: BLE001
            pass

    def _apply_size(self, first=False):
        w = self.bot_px + 24
        h = int(round(self.bot_px * SVG_AR)) + LABEL_PAD
        self.resize(w, h)
        if first:
            from PySide6.QtGui import QGuiApplication
            scr = QGuiApplication.primaryScreen().availableGeometry()
            self.move(scr.right() - w - 40, scr.bottom() - h - 60)
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

    def drain_frames(self):
        latest = None
        dropped = 0
        try:
            while True:
                latest = self.frames.get_nowait()
                dropped += 1
        except queue.Empty:
            pass
        if latest is None:
            self._empty = getattr(self, "_empty", 0) + 1
            now = time.monotonic()
            if now - getattr(self, "_hb_empty", 0) > 2.0:
                self._hb_empty = now
                self._log(f"drain alive, empty={self._empty} qsize={self.frames.qsize()} inhost={getattr(self,'inhost',None)}")
            # 看门狗只对「本地桥」模式有意义。inhost 模式下 bridge 从未启动，
            # 它的 alive 是初始 True —— 旧代码会误判"桥卡死"并 restart()，
            # 凭空拉起一套 node 桥，窗从此收桥的帧（永远 idle），彻底脱离宿主引擎。
            if (not getattr(self, "inhost", False)) and time.monotonic() - self.last_frame_at > 5 and self.bridge.alive:
                self.last_frame_at = time.monotonic()
                self.bridge.restart()
            return
        self.last_frame_at = time.monotonic()
        self.frame_count = getattr(self, "frame_count", 0) + 1
        self.q_count = getattr(self, "q_count", 0) + 1
        try:
            self.renderer = QSvgRenderer(QByteArray(latest["svg"].encode("utf-8")))
        except Exception as e:  # noqa: BLE001
            self._log(f"renderer EXC {e}")
            return
        if not self.renderer.isValid():
            self._log(f"renderer INVALID frame#{self.frame_count}")
        self.label = latest.get("label") or ""
        if self.label:
            self.label_until = time.monotonic() + 5
            self._log(f"LABEL {self.label!r} state={latest.get('state')}")
        self.update()
        # 每秒记一次心跳，证明帧真的进到窗里了
        now = time.monotonic()
        if now - getattr(self, "_hb", 0) > 1.0:
            self._hb = now
            self._log(f"frames={self.frame_count} state={latest.get('state')} valid={self.renderer.isValid()} label={self.label!r}")

    def paintEvent(self, _ev):  # noqa: N802
        p = QPainter(self)
        p.setRenderHint(QPainter.Antialiasing)
        drawn = False
        # 本地弹跳：点击后 220ms 内轻微缩放，保证"点了必有反应"
        bt = getattr(self, "bounce_t0", 0)
        age = time.monotonic() - bt if bt else 99
        if age < 0.22:
            import math
            k = math.sin(age / 0.22 * math.pi)  # 0→1→0
            scale = 1.0 + 0.14 * k
            p.translate(self.width() / 2, self.height() / 2)
            p.scale(scale, scale)
            p.translate(-self.width() / 2, -self.height() / 2)
        if self.renderer and self.renderer.isValid():
            r = self.rect().adjusted(12, LABEL_PAD, -12, -4)
            self.renderer.render(p, r)
            drawn = True
        self._paints = getattr(self, "_paints", 0) + 1
        if self._paints % 120 == 1:
            self._log(f"paint#{self._paints} drawn={drawn} size={self.width()}x{self.height()}")
        if self.label and time.monotonic() < self.label_until:
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
        # 滚轮缩放
        dy = ev.angle().y()
        if dy > 0:
            self.set_bot_px(self.bot_px * 1.12)
        elif dy < 0:
            self.set_bot_px(self.bot_px / 1.12)

    # —— 交互：拖动 = 挪窗；轻点 = 摸头 ——
    def _log(self, msg):
        try:
            with open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pet-input.log"), "a", encoding="utf-8") as f:
                f.write(f"{time.strftime('%H:%M:%S')} {msg}\n")
        except Exception:  # noqa: BLE001
            pass

    def mousePressEvent(self, ev):  # noqa: N802
        self.press_at = ev.globalPosition().toPoint()
        self.drag_off = self.press_at - self.frameGeometry().topLeft()
        self.moved = False
        self.press_t0 = time.monotonic()
        self._log(f"press at {self.press_at.x()},{self.press_at.y()} btn={ev.button()}")

    def mouseMoveEvent(self, ev):  # noqa: N802
        if self.press_at:
            gp = ev.globalPosition().toPoint()
            # 位移 12px 且按住 >200ms 才算拖拽：普通手点抖动 5~10px 不该误判成拖
            if (gp - self.press_at).manhattanLength() > 12 and (time.monotonic() - self.press_t0) > 0.2:
                if not self.moved:
                    self._log(f"drag begin {gp.x()},{gp.y()}")
                    # 与页面版一致：拖动显示他的 dragging 态（3→15→0 眼）
                    self.sse_ref.cmd("dragging")
                self.moved = True
                self.move(gp - self.drag_off)

    def mouseReleaseEvent(self, ev):  # noqa: N802
        self._log(f"release moved={self.moved}")
        if self.press_at and not self.moved:
            # 本地即时反馈：先让窗自己动起来（0 延迟），再发网络命令。
            # 即使宿主/引擎那边有任何问题，用户也一定能看到"点了有反应"。
            self._bounce()
            self.sse_ref.pet("pet")
            self._log("pet command sent")
        elif self.moved:
            self.sse_ref.cmd("drag-end")   # 放下：ball overlay 弹跳一下
        self.press_at = None

    def _bounce(self):
        """本地弹跳反馈：缩放窗内绘制区域，60ms 内起落。"""
        self.bounce_t0 = time.monotonic()
        if not getattr(self, "_bounce_timer", None):
            self._bounce_timer = QTimer(self)
            self._bounce_timer.timeout.connect(self.update)
        self._bounce_timer.start(16)
        QTimer.singleShot(220, self._bounce_end)

    def _bounce_end(self):
        try:
            self._bounce_timer.stop()
        except Exception:  # noqa: BLE001
            pass
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
                os.startfile(f"http://127.0.0.1:{self.port}/gallery?k={load_cfg().get('token','')}")
            except Exception:  # noqa: BLE001
                pass
        elif act is a_show:
            self.setVisible(not self.isVisible())
        elif act is a_quit:
            QApplication.quit()


def load_cfg():
    try:
        with open(os.path.join(dsh_home(), "blob-pet.json"), encoding="utf-8") as f:
            return json.load(f)
    except Exception:  # noqa: BLE001
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
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    if not acquire_single_instance():
        sys.exit(0)  # 已有实例，安静退出

    cfg = load_cfg()
    if not cfg or "port" not in cfg or "token" not in cfg:
        sys.exit("blob-pet.json 无 port/token —— DSH 没在跑")

    # 唯一真源 = 宿主内引擎。启动时反复问 /state 直到宿主就绪（插件 spawn 可能早于 sidecar listen）。
    # 绝不回退到"窗自己起一套 node 桥"——两套引擎会让点击与画面各走一条路（历史事故）。
    # 独立窗模式（--bridge）已于 0.6.1 移除。
    inhost = False
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(
                    f"http://127.0.0.1:{cfg['port']}/state", timeout=2) as _r:
                if json.load(_r).get("inHost"):
                    inhost = True
                    break
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.5)
    if not inhost:
        sys.exit("宿主 sidecar 未就绪（/state 无 inHost）—— 请重启 DSH 后由插件自动开窗")

    ev_q: queue.Queue = queue.Queue()
    frame_q: queue.Queue = queue.Queue()

    err_sink = lambda m: sys.stderr.write(m + "\n")
    bridge = Bridge(root, frame_q, err_sink)  # 仅供 native-smoke 无头渲染使用

    app = QApplication(sys.argv)
    win = PetWindow(bridge, frame_q, cfg["port"])
    win.inhost = inhost   # 看门狗靠它判断是否允许 restart 桥

    state = {"sse": "connecting"}

    def on_sse_state(s):
        if isinstance(s, tuple):  # ("bridge-cmd", cmd) —— 回退模式的摸头
            bridge.send({"cmd": s[1]})
            return
        state["sse"] = s

    sse = Sse(cfg["port"], cfg["token"], ev_q, on_sse_state, inhost=inhost)
    sse.start()
    win.sse_ref = sse

    def pump():
        if inhost:
            # inhost 模式：Sse 轮询拿到的「帧」放在 ev_q，这里转给 frame_q 供渲染。
            # （历史 bug：Sse 把帧放进 ev_q，而窗口只读 frame_q，pump 又是 pass ——
            #   帧永远卡在 ev_q 里，画面定格。这是"点了没反应"的最后一层。）
            try:
                while True:
                    item = ev_q.get_nowait()
                    frame_q.put(item)
            except queue.Empty:
                pass
        else:
            # 回退模式：SSE 事件 → 桥
            try:
                while True:
                    ev = ev_q.get_nowait()
                    bridge.send({"ev": ev})
            except queue.Empty:
                pass
        if state["sse"] == "dead" or (not inhost and not bridge.alive):
            app.quit()
        if args.parent_pid and not parent_alive(args.parent_pid):
            app.quit()

    pump_t = QTimer()
    pump_t.timeout.connect(pump)
    pump_t.start(50)

    win.show()
    rc = app.exec()
    bridge.kill()
    sse.alive = False
    sys.exit(rc)


if __name__ == "__main__":
    main()
