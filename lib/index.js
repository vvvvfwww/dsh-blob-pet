/**
 * dsh-blob-pet — 宿主侧。
 *
 * 三件事：
 *   1. 引擎：grok-icon-study 引擎跑在宿主进程内（tools/engine-core.cjs，node:vm
 *      沙箱，单实例），sidecar HTTP（仅 127.0.0.1，token 栅栏）对外供 /frames 帧流、
 *      /pet 摸头表演、/cmd 拖拽交互、/gallery 图鉴、/state 状态。
 *   2. 原生窗：插件启动时拉起 PySide6 原生窗（tools/pet-native.py），经 /frames
 *      取帧渲染，是纯显示端。DSH 开 = 团子窗自动开；DSH 退出 = dispose 里收窗。
 *   3. GUI 注入：默认关（避免双份团子）；~/.dsh/blob-pet.json 写 {"gui": true} 可开。
 *      自动开团子窗可用 {"petWindow": false} 关。
 *
 * 引擎数据（web/grok/）提取自 xAI Grok 应用包，仅个人学习使用，勿再分发。
 */
import fs from 'node:fs'
import os from 'node:os'
import http from 'node:http'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WEB_DIR = path.join(ROOT, 'web')
const GROK_DIR = path.join(WEB_DIR, 'grok')
const ENGINE_ORDER = ['geometry-data.js', 'math.js', 'tables.js', 'pose.js', 'tricks.js', 'fx.js', 'eyes.js', 'character.js']
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const CONFIG_FILE = path.join(DSH_HOME, 'blob-pet.json')
const WINDOW_FILE = process.env.BLOB_PET_WINDOW_FILE || path.join(DSH_HOME, 'blob-pet-window.json')
const VERSION = '0.6.1'

const TOOL_LABELS = {
  bash: '跑命令', ops_bash: '跑命令', read: '读文件', write: '写文件', edit: '改代码',
  glob: '找文件', grep: '搜代码', ops_grep: '搜代码', ops_glob: '找文件', ops_read_files: '读文件',
  web_search: '上网查', web_fetch: '读网页', todo_write: '排计划',
  subagent: '派分身', subagent_fork: '派分身', workflow: '编排分身',
  ask_user_question: '等你回话', present: '交付文件',
  agent_teams_create: '组队', agent_teams_add_member: '招队员', agent_teams_approve: '团队开工',
  agent_teams_status: '看团队', agent_teams_send_message: '团队喊话',
  create_goal: '立目标', update_goal: '对目标', get_goal: '查目标',
  schedule_create: '定闹钟', schedule_edit: '调闹钟', plugin_manager: '装插件',
  compress: '整理记忆', decompress: '翻旧账', skill: '翻技能书',
  ops_discover_tools: '找工具', load_workspace_dependencies: '载依赖',
}

export default {
  name: 'dsh-blob-pet',
  inject: ['webServer', 'connection'],
  apply(ctx) {
    const disposers = []
    const clients = new Set()    // GUI 页的 SSE

    // ————— 配置（~/.dsh/blob-pet.json；字段缺失走默认） —————
    function readCfg() {
      try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) } catch { return {} }
    }
    function writeRendezvous(port, token) {
      const prev = readCfg()
      const next = { ...prev, version: VERSION, port, token, guiPort: (ctx.webServer && ctx.webServer.port) || null, updatedAt: Date.now() }
      try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), { mode: 0o600 }) } catch {}
      return next
    }

    // ————— 1. GUI 注入（默认关：桌宠活在独立窗，避免页面里再冒出一个） —————
    const guiOn = () => readCfg().gui === true
    disposers.push(
      ctx.webServer.tapIndex((html) => {
        if (!guiOn() || html.indexOf('/blob-pet/pet.js') !== -1) return html
        const tag = `<script defer src="/blob-pet/pet.js?v=${VERSION}"></script>`
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }),
    )
    try {
      if (ctx && typeof ctx.on === 'function') {
        ctx.on('webserver/index-inject', (table) => {
          try {
            if (!Array.isArray(table) || !guiOn()) return
            for (const row of table) {
              if (!row) continue
              if (row.kind === 'script-src' && row.src === '/blob-pet/pet.js') return
              if (row.kind === 'script' && typeof row.text === 'string' && row.text.includes('/blob-pet/pet.js')) return
            }
            table.push({
              kind: 'script', placement: 'body',
              text: '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
                'var s=document.createElement("script");s.src="/blob-pet/pet.js?v=' + VERSION + '";' +
                's.onerror=function(){};d.appendChild(s)}catch(e){}})()',
            })
          } catch {}
        })
      }
    } catch {}

    // ————— DSH 路由信任栅栏 —————
    function rejected(req, res) {
      try {
        const conn = ctx.get('connection') || ctx.connection
        if (!conn || typeof conn.requestRejection !== 'function') return false
        const code = conn.requestRejection(req)
        if (code === undefined || code === null || code === false) return false
        res.statusCode = typeof code === 'number' ? code : 403
        res.end()
        return true
      } catch { return false }
    }
    function route(kind, pathname, handler) {
      disposers.push(
        ctx.webServer.register({
          kind, path: pathname,
          handler: async (req, res) => {
            if (rejected(req, res)) return
            try { await handler(req, res) } catch (err) {
              try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('blob-pet: ' + err.message) } catch {}
            }
          },
        }),
      )
    }

    // ————— 引擎 bundle（共享给 GUI 与 sidecar） —————
    const hot = new Map()
    function bundleDoc(base) {
      const parts = ENGINE_ORDER.map((f) => path.join(GROK_DIR, f)).concat(path.join(WEB_DIR, 'pet.js'))
      const sig = parts.map((p) => fs.statSync(p).mtimeMs).join(',')
      let text = hot.get('doc')
      if (!hot.get('sig') || hot.get('sig') !== sig) {
        text = parts.map((p) => fs.readFileSync(p, 'utf8')).join('\n;\n')
        text = `/* dsh-blob-pet ${VERSION} = grok-icon-study engine (unmodified, study-only) + shell */\n${text}`
        hot.set('sig', sig); hot.set('doc', text)
      }
      const boot = `\n;window.__BLOB_PET_BOOT__=${JSON.stringify({ version: VERSION, base })};\n`
      return text + boot
    }
    function jsHead(res, bytes) {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': String(bytes) })
    }

    route('exact', '/blob-pet/pet.js', (req, res) => {
      const doc = bundleDoc('/blob-pet', false)
      jsHead(res, Buffer.byteLength(doc)); res.end(doc)
    })
    route('prefix', '/blob-pet/grok', (req, res) => {
      const rel = decodeURIComponent(String(req.url || '').split('?')[0].replace(/^\/blob-pet\/grok\/?/, ''))
      if (!/^[\w.-]+\.js$/.test(rel)) { res.writeHead(403).end(); return }
      let buf
      try { buf = fs.readFileSync(path.join(GROK_DIR, rel)) } catch { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(buf)
    })
    route('exact', '/blob-pet/gallery', (req, res) => {
      let html
      try { html = fs.readFileSync(path.join(WEB_DIR, 'gallery.html'), 'utf8') } catch { res.writeHead(404).end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(html)
    })

    // ————— 2. 事件桥（GUI + 原生窗共享；同时喂宿主内引擎） —————
    let seq = 0
    function broadcast(p) {
      try { getEngine().ev(p) } catch {}  // 引擎在宿主内：事件直达
      if (!clients.size) return
      const frame = `id: ${++seq}\ndata: ${JSON.stringify(p)}\n\n`
      for (const res of clients) { try { res.write(frame) } catch { clients.delete(res) } }
    }
    function sseOpen(req, res, set) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      })
      res.write(`data: ${JSON.stringify({ t: 'hello', status: running ? 'running' : 'idle' })}\n\n`)
      set.add(res)
      const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { clearInterval(ping); set.delete(res) } }, 15000)
      const cleanup = () => { clearInterval(ping); set.delete(res) }
      req.on('close', cleanup); req.on('error', cleanup); res.on('error', cleanup)
    }

    let primarySessionId = null
    let lastSessionId = null
    let running = false
    const pending = new Map()

    let lastDeltaAt = 0
    disposers.push(
      ctx.on('agent/assistant-stream', (payload) => {
        try {
          const p = payload || {}
          const agent = p.agent, frame = p.frame
          if (!agent || !frame || !agent.session) return
          if (primarySessionId && agent.session.id !== primarySessionId) return
          if (frame.type === 'start') { broadcast({ t: 'attempt-start' }); return }
          if (frame.type !== 'chunk' || !frame.chunk) return
          const now = Date.now()
          if (now - lastDeltaAt < 400) return
          const c = frame.chunk
          if (c.type === 'reasoning-delta' && c.text) { lastDeltaAt = now; broadcast({ t: 'delta', kind: 'reasoning' }) }
          else if (c.type === 'text-delta' && c.text) { lastDeltaAt = now; broadcast({ t: 'delta', kind: 'text' }) }
        } catch {}
      }),
    )

    disposers.push(
      ctx.on('session/event', (session, event) => {
        try {
          const sessionId = (session && session.id) || 'default'
          lastSessionId = sessionId
          const type = event && event.type
          const d = (event && event.data) || {}

          if (type === 'user/message' && d.source && d.source.kind === 'user') {
            primarySessionId = sessionId
            broadcast({ t: 'user' })
            return
          }
          if (sessionId !== primarySessionId && primarySessionId) return

          if (type === 'turn/start') { running = true; broadcast({ t: 'turn-start', turn: d.turn }); return }
          if (type === 'tool/call') {
            pending.set(String(d.callId), d.name)
            broadcast({ t: 'tool', name: d.name, label: TOOL_LABELS[d.name] || d.name })
            return
          }
          if (type === 'tool/result') {
            const cid = d.message && d.message.content && d.message.content[0] && d.message.content[0].toolCallId
            const name = pending.get(String(cid || '')) || ''
            pending.delete(String(cid || ''))
            broadcast({ t: 'tool-end', name, error: !!d.error })
            return
          }
          if (type === 'turn/end') { running = false; broadcast({ t: 'turn-end', reason: d.reason }); return }
          if (type === 'assistant/attempt') { broadcast({ t: 'attempt-failed' }); return }
          if (type === 'approval/asked') { broadcast({ t: 'approval', state: 'asked' }); return }
          if (type === 'approval/decided') { broadcast({ t: 'approval', state: 'decided' }); return }
        } catch {}
      }),
    )
    disposers.push(
      ctx.on('session/disposed', (session) => {
        const id = session && session.id
        if (!id) return
        if (primarySessionId === id) { primarySessionId = null; running = false }
        if (lastSessionId === id) lastSessionId = null
      }),
    )

    route('exact', '/blob-pet/events', (req, res) => sseOpen(req, res, clients))
    route('exact', '/blob-pet/state', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true, version: VERSION, running, guiClients: clients.size }))
    })

    // ————— 3. 原生桌宠窗 sidecar（仅 127.0.0.1；/events 要 ?k=token） —————
    // 引擎在宿主进程内跑（tools/engine-core.cjs，vm 沙箱），团子窗不再需要 node 子进程：
    //   /frames  NDJSON 帧流（60fps，团子窗直读渲染）
    //   /events  SSE 事件流（备用/图鉴用）
    const TOKEN = randomBytes(16).toString('hex')
    let engine = null
    let engineId = randomBytes(4).toString('hex')
    let engineMtime = 0
    let frameClients = new Set() // /frames NDJSON 订阅
    function getEngine() {
      // 按 engine-core.cjs 的 mtime 热重载：宿主进程常驻，require 缓存旧模块曾导致
      // 修好的引擎逻辑不生效（历史事故：改了 armIdle 但宿主还是旧引擎 → 点击无反应）。
      try {
        const f = path.join(ROOT, 'tools', 'engine-core.cjs')
        const mt = fs.statSync(f).mtimeMs
        if (engine && mt !== engineMtime) {
          try { engine = null } catch {}
          engineId = randomBytes(4).toString('hex')
        }
        if (!engine) {
          const { createEngine } = require(f)
          engine = createEngine(ROOT)
          engineMtime = mt
        }
      } catch (err) {
        if (!engine) {
          const { createEngine } = require(path.join(ROOT, 'tools', 'engine-core.cjs'))
          engine = createEngine(ROOT)
        }
      }
      return engine
    }
    let engineTimer = null
    let lastFrame = null
    function ensureEngineLoop() {
      if (engineTimer) return
      getEngine()
      engineTimer = setInterval(() => {
        if (!frameClients.size) return  // 没订阅者时引擎停摆（省 CPU）
        // 每次 tick 只推进一次引擎，所有订阅者共享同一帧（旧实现每个连接都推进，
        // 多客户端会互相偷跑状态机 —— 点了没反应的真凶之一）
        lastFrame = engine.frame()
        const line = JSON.stringify(lastFrame) + '\n'
        for (const res of frameClients) {
          try { res.write(line) } catch { frameClients.delete(res) }
        }
      }, 16)
    }
    const testPort = Number(process.env.BLOB_PET_TEST_PORT || 0)
    const pinPort = Number(readCfg().port || 0)
    const wantPort = testPort || pinPort  // 0 = 临时端口（launcher 读文件即可）

    const sidecar = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        const p = u.pathname
        if (p === '/gallery') {
          const html = fs.readFileSync(path.join(WEB_DIR, 'gallery.html'), 'utf8')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          return res.end(html)
        }
        // 浏览器 --app 独立小窗已移除（0.6.1）：团子只走内嵌 PySide 原生窗
        if (p.startsWith('/grok/')) {
          const rel = decodeURIComponent(p.replace(/^\/grok\/?/, ''))
          if (!/^[\w.-]+\.js$/.test(rel)) { res.writeHead(403).end(); return }
          try {
            const buf = fs.readFileSync(path.join(GROK_DIR, rel))
            res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
            return res.end(buf)
          } catch { res.writeHead(404).end(); return }
        }
        // 单帧拉取（最可靠：一次请求一帧，无流式状态）
        if (p === '/frame') {
          if (u.searchParams.get('k') !== TOKEN) { res.writeHead(403).end(); return }
          let body
          try {
            body = JSON.stringify(getEngine().frame())
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end(String(err)); return
          }
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          return res.end(body)
        }
        if (p === '/frames') {
          if (u.searchParams.get('k') !== TOKEN) { res.writeHead(403, { 'Content-Type': 'text/plain' }); return res.end('bad token') }
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
          // 立刻给一帧「缓存帧」，不推进引擎（否则每个新连接都偷跑一次状态机）
          if (lastFrame) { try { res.write(JSON.stringify(lastFrame) + '\n') } catch {} }
          frameClients.add(res)
          ensureEngineLoop()
          const cleanup = () => { frameClients.delete(res) }
          req.on('close', cleanup); req.on('error', cleanup); res.on('error', cleanup)
          return
        }
        // sidecar /events（独立窗 SSE 订阅）已随浏览器窗移除；团子窗与图鉴走 /frames
        if (p === '/pet') {  // 摸头/表演（团子窗转发）
          if (u.searchParams.get('k') !== TOKEN) { res.writeHead(403).end(); return }
          getEngine().cmd({ cmd: u.searchParams.get('cmd') === 'show' ? 'show' : 'pet' })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end('{"ok":true}')
        }
        // 通用交互指令：pet / show / dragging / drag-end / pointer / scheme
        if (p === '/cmd') {
          if (u.searchParams.get('k') !== TOKEN) { res.writeHead(403).end(); return }
          const c = { cmd: u.searchParams.get('c') || '' }
          const nx = u.searchParams.get('nx'), ny = u.searchParams.get('ny')
          if (nx !== null && ny !== null) { c.nx = Number(nx); c.ny = Number(ny) }
          const val = u.searchParams.get('v')
          if (val !== null) c.value = val
          try { getEngine().cmd(c) } catch (err) { res.writeHead(500).end(String(err)); return }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          return res.end('{"ok":true}')
        }
        if (p === '/state') {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
          return res.end(JSON.stringify({
            ok: true, version: VERSION, running,
            frameClients: frameClients.size,
            inHost: true,
            engineId: engineId,
            engineState: engine ? engine.state : null,
            pid: process.pid,
          }))
        }
        res.writeHead(404).end()
      } catch (err) {
        try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('blob-pet sidecar: ' + err.message) } catch {}
      }
    })
    function listenAt(port, tries) {
      sidecar.once('error', (err) => {
        if (err.code === 'EADDRINUSE' && tries > 0) listenAt(port + 1, tries - 1)
        else console.warn('[blob-pet] sidecar 启动失败：', err.message)
      })
      sidecar.once('listening', () => {
        const rp = sidecar.address() && sidecar.address().port
        writeRendezvous(rp, TOKEN)
        if (readCfg().petWindow !== false) spawnPetWindow(rp)
      })
      sidecar.listen(port, '127.0.0.1')
    }
    listenAt(testPort || pinPort, (testPort || pinPort) ? 8 : 0)

    // ————— 3.5 原生桌宠窗：PySide6 透明小窗（非浏览器）；退出时只收自己开的那个 —————
    function findPythonw() {
      const la = process.env.LOCALAPPDATA || ''
      const cands = [
        process.env.BLOB_PET_PYTHON,
        path.join(la, 'Programs', 'Python', 'Python313', 'pythonw.exe'),
        path.join(la, 'Programs', 'Python', 'Python312', 'pythonw.exe'),
      ].filter(Boolean)
      for (const c of cands) { try { if (fs.existsSync(c)) return c } catch {} }
      // PATH 兜底
      try {
        const out = execSync('where pythonw', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
        const first = out.split(/\r?\n/)[0]
        if (first && fs.existsSync(first.trim())) return first.trim()
      } catch {}
      return null
    }
    function spawnPetWindow(port) {
      closeOurWindow() // 上一世残留窗先收掉（DSH 重启场景），保持单窗
      const py = findPythonw()
      if (!py) { console.warn('[blob-pet] 没找到 pythonw(PySide6)，原生窗不可用'); return }
      const script = path.join(ROOT, 'tools', 'pet-native.py')
      let child
      try {
        child = spawn(py, [script, '--parent-pid', String(process.pid)], {
          detached: true, stdio: 'ignore', cwd: ROOT,
          windowsHide: true,
          env: { ...process.env, BLOB_PET_INHOST: '1' }, // 告诉窗：引擎在宿主内，连 /frames
        })
      } catch (err) { console.warn('[blob-pet] 原生窗启动失败：', err.message); return }
      child.unref()
      try { fs.writeFileSync(WINDOW_FILE, JSON.stringify({ pid: child.pid, at: Date.now() })) } catch {}
    }
    function closeOurWindow() {
      try {
        const w = JSON.parse(fs.readFileSync(WINDOW_FILE, 'utf8'))
        if (!w.pid) return
        fs.rmSync(WINDOW_FILE, { force: true })
        if (process.platform === 'win32') {
          // 同步探测（异步版会在宿主立刻退出时来不及发 taskkill —— 曾因此叠出双窗）
          try {
            const out = execSync('tasklist /FI "PID eq ' + w.pid + '" /FO CSV /NH', { stdio: ['ignore', 'pipe', 'ignore'] }).toString()
            if (/python/i.test(out)) execSync('taskkill /pid ' + w.pid + ' /T /F', { stdio: 'ignore' })
          } catch {}
        } else {
          try { process.kill(w.pid) } catch {}
        }
      } catch {}
    }

    ctx.effect(() => () => {
      closeOurWindow()
      try { if (engineTimer) clearInterval(engineTimer) } catch {}
      engine = null
      for (const d of disposers) { try { d() } catch {} }
      for (const res of clients) { try { res.end() } catch {} }
      clients.clear()
      try { sidecar.close() } catch {}
      // 端口/token 随进程失效：只擦这两项，保留用户手写配置（gui:false 等）
      try {
        const prev = readCfg()
        delete prev.port; delete prev.token; delete prev.guiPort; delete prev.updatedAt
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(prev, null, 2), { mode: 0o600 })
      } catch {}
    })

    try { console.log(`[blob-pet] 已挂载：/blob-pet/* + sidecar(127.0.0.1)`) } catch {}
  },
}
