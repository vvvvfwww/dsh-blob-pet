// dsh-blob-pet 宿主隔离测试：假 cordis ctx 起插件，验证 GUI 路由 + sidecar + SSE + token 栅栏
const fs = require('fs')
const http = require('http')
const path = require('path')

process.env.BLOB_PET_TEST_PORT = '39217'

function get(url, headers) {
  return new Promise((res) => {
    http.get(url, { headers: headers || {} }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => res({ code: r.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: r.headers }))
    }).on('error', (e) => res({ code: 0, body: String(e.message) }))
  })
}
function onceData(req, ms) {
  return new Promise((res) => {
    http.get(req.url, (r) => {
      let buf = ''
      const timer = setTimeout(() => { r.destroy(); res({ code: r.statusCode, body: buf }) }, ms)
      r.on('data', (c) => { buf += c })
      r.on('end', () => { clearTimeout(timer); res({ code: r.statusCode, body: buf }) })
    })
  })
}

;(async () => {
  const cfgPath = path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'blob-pet.json')
  // 备份 live 宿主的 rendezvous，测完原样还回去（别把正在跑的 sidecar 的 port/token 擦了）
  const backup = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath) : null
  // 预设 cfg：钉测试端口；关掉自动开窗（别真拉起原生窗）；开 GUI 注入以测通道
  fs.writeFileSync(cfgPath, JSON.stringify({ port: 39217, petWindow: false, gui: true }))
  // 外观文件走临时路径，别把用户真实外观写坏
  process.env.BLOB_PET_LOOK_FILE = path.join(require('os').tmpdir(), 'blob-pet-look-test-' + process.pid + '.json')
  try { fs.unlinkSync(process.env.BLOB_PET_LOOK_FILE) } catch {}
  const mod = (await import('file:///' + path.resolve('lib/index.js').replace(/\\/g, '/'))).default
  // ——— 假 ctx ———
  const handlers = {}
  const registered = []
  const sseClients = []
  const ctx = {
    webServer: {
      port: 1,
      register: (r) => { registered.push(r); return () => {} },
      tapIndex: (fn) => { handlers.tapIndex = fn; return () => {} },
    },
    connection: { requestRejection: () => false },
    get: (k) => (k === 'connection' ? ctx.connection : null),
    on: (name, fn) => { (handlers[name] = handlers[name] || []).push(fn); return () => {} },
    effect: (fn) => { const d = fn(); ctx._cleanup = d && typeof d === 'function' ? d : null; return () => {} },
  }
  mod.apply(ctx)

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  await sleep(400) // 等 sidecar listen

  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
  console.log('rendezvous: port', cfg.port, 'token len', (cfg.token || '').length, 'version', cfg.version)
  if (cfg.port !== 39217) { console.error('FAIL: wrong port'); process.exit(1) }

  // GUI 路由（假 requestRejection=false 直接放行）
  const fire = async (p, req) => {
    const r = registered.find((x) => x.kind === 'exact' ? x.path === p : p.startsWith(x.path))
    if (!r) return { code: -1 }
    const res = { writes: [], writeHead(c) { this.code = c }, setHeader() {}, end(x) { this.done = true; if (x) this.writes.push(String(x)) }, write(x) { this.writes.push(String(x)) } }
    await r.handler(req || { url: p, on() {} }, res)
    return { code: res.code, body: res.writes.join('') }
  }
  const bundle = await fire('/blob-pet/pet.js')
  console.log('GUI pet.js:', bundle.code, bundle.body.length, 'bytes, boot flag:', /__BLOB_PET_BOOT__/.test(bundle.body))
  const gr = await fire('/blob-pet/grok/math.js')
  console.log('GUI grok/math.js:', gr.code, gr.body.length)
  const gal = await fire('/blob-pet/gallery')
  console.log('GUI gallery:', gal.code, gal.body.length)
  // 外观同步：GET 读；POST 写文件 + 套到宿主内引擎
  const lookGet = await fire('/blob-pet/look')
  console.log('GUI look GET:', lookGet.code, lookGet.body.slice(0, 80))
  const postLook = async (obj) => {
    const r = registered.find((x) => x.kind === 'exact' && x.path === '/blob-pet/look')
    if (!r) return { code: -1 }
    const evs = {}
    const req = {
      url: '/blob-pet/look', method: 'POST',
      on(ev, fn) { (evs[ev] = evs[ev] || []).push(fn); return req },
      destroy() {},
    }
    const res = { writes: [], writeHead(c) { this.code = c }, setHeader() {}, end(x) { if (x) this.writes.push(String(x)) }, write(x) { this.writes.push(String(x)) } }
    const done = r.handler(req, res)
    await new Promise((r2) => setTimeout(r2, 0))
    ;(evs.data || []).forEach((f) => f(Buffer.from(JSON.stringify(obj))))
    ;(evs.end || []).forEach((f) => f())
    await done
    return { code: res.code, body: res.writes.join('') }
  }
  const lookPost = await postLook({ size: 132, shape: 'egg', grad: true, ink: { from: '#061021', to: '#4f7fc4', angle: 0 } })
  let lookFile = {}
  try { lookFile = JSON.parse(fs.readFileSync(process.env.BLOB_PET_LOOK_FILE || path.join(process.env.USERPROFILE || process.env.HOME, '.dsh', 'blob-pet-look.json'), 'utf8')) } catch {}
  console.log('GUI look POST:', lookPost.code, '| file shape:', lookFile.shape, 'size:', lookFile.size, '| ink:', lookFile.ink && lookFile.ink.from)
  const injectHtml = handlers.tapIndex('<html><body></body></html>')
  console.log('tapIndex injects:', injectHtml.includes('/blob-pet/pet.js'))

  // sidecar（团子本体已原生窗；pet.js/launcher 路由应移除，gallery/grok/events/state 保留）
  const base = 'http://127.0.0.1:39217'
  const sBun = await get(base + '/pet.js')
  const sLaunch = await get(base + '/')
  console.log('SB pet.js removed:', sBun.code === 404, '| SB launcher html:', sLaunch.code)
  if (sBun.code !== 404) { console.error('FAIL: sidecar 应只留 gallery/grok/events/state/standalone'); process.exit(1) }
  const sGal = await get(base + '/gallery')
  console.log('SB gallery:', sGal.code)
  const sGrok = await get(base + '/grok/character.js')
  console.log('SB grok:', sGrok.code, sGrok.body.length)
  const st = await get(base + '/state')
  console.log('SB state:', st.code, st.body)
  const bad = await get(base + '/events')
  console.log('SB events 无token:', bad.code, bad.body.trim())

  // /cmd 通用交互通道：拖动 / 放下 / 眼光跟随 / 深浅色 / 摸头 / 表演
  const cmd = (q) => get(base + '/cmd?k=' + cfg.token + '&' + q)
  const badCmd = await get(base + '/cmd?c=pet')
  console.log('SB /cmd 无token:', badCmd.code)
  const seq = [
    ['c=dragging', 'dragging'],
    ['c=drag-end', 'bouncing'],
    ['c=pet', 'happy'],
    ['c=show', 'playful'],
  ]
  for (const [q, want] of seq) {
    const r = await cmd(q)
    const s = JSON.parse((await get(base + '/state')).body)
    console.log(`SB /cmd ${q}:`, r.code, '→ state', s.engineState, s.engineState === want ? 'OK' : `WANT ${want}`)
    if (r.code !== 200 || s.engineState !== want) { console.error('FAIL /cmd', q); process.exit(1) }
  }
  const rPtr = await cmd('c=pointer&nx=0.5&ny=-0.4')
  const rSch = await cmd('c=scheme&v=dark')
  console.log('SB /cmd pointer/scheme:', rPtr.code, rSch.code)

  // sidecar /events 已移除（0.6.1）：团子窗走 /frames，独立窗 SSE 随之删除
  const sEvents = await get(base + '/events?k=' + cfg.token)
  console.log('SB sidecar /events removed:', sEvents.code === 404)
  if (sEvents.code !== 404) { console.error('FAIL: sidecar /events 应 404（已随独立窗移除）'); process.exit(1) }

  const st2 = await get(base + '/state')
  console.log('SB state running:', JSON.parse(st2.body).running === false)

  // 退出清理：跑 dispose，端口应关闭
  ctx._cleanup()
  await sleep(300)
  const after = await get(base + '/state')
  console.log('after dispose, sidecar closed:', after.code === 0 || after.code === 'ECONNREFUSED' || String(after.body).includes('refused') || after.code === 0 && !after.body)
  // 还原本机 live 宿主的 rendezvous（备份值）
  if (backup) { fs.writeFileSync(cfgPath, backup); console.log('live cfg restored') }
  console.log('DONE')
  process.exit(0)
})().catch((e) => { console.error('CRASH', e); process.exit(1) })
