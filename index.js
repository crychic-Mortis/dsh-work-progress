/**
 * dsh-work-progress — 宿主半端
 * ============================================================================
 * 这个插件的主体在浏览器半端（client.js）：它用 session 作用域的标准 Hook
 * 读取「是否在跑 / 正在生成什么 / 正在调什么工具」，渲染顶部悬浮的转圈进度条。
 *
 * 宿主半端只做两件事：
 *   1. 提供 Cordis 入口，让插件作为普通 bundle 被加载；
 *   2. 暴露一个只读健康检查端点，方便安装后确认宿主半端已生效：
 *        GET /work-progress/api/health
 *      → { ok, version, clientComposed, clientOnline, runningSessions }
 *   另有 POST /work-progress/api/hello 供浏览器半端自报，用于确认 UI 已挂载。
 *   不读会话内容、不写任何文件、不注册任何面向模型的工具。
 * ============================================================================
 */

/** Cordis 插件名（与 package.json 的 name 一致）。 */
export const name = 'dsh-work-progress'

/** 插件版本（同时用于 health 输出）。 */
export const version = '1.0.0'

/** HTTP 路由前缀。 */
const ROUTE_PREFIX = '/work-progress'

/** 浏览器半端的自报状态（仅进程内、仅用于健康检查）。 */
const runtime = {
  helloCount: 0,
  lastHelloAt: null,
  clientVersion: null,
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 统计当前有多少个会话正在跑（只数数量，不暴露会话内容）。 */
function countRunning(ctx) {
  let running = 0
  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) {
      if (agent?.status !== 'idle') running += 1
    }
  } catch {
    /* agents 服务缺席时保留 0 */
  }
  return running
}

/** 只读 HTTP 路由。 */
export function createHandler(ctx) {
  return function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')

    // 浏览器半端加载后自报一次，用于确认「UI 真的挂上了」。
    if (url.pathname === `${ROUTE_PREFIX}/api/hello`) {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'method not allowed' })
        return
      }
      runtime.helloCount += 1
      runtime.lastHelloAt = Date.now()
      runtime.clientVersion = url.searchParams.get('v') ?? null
      sendJson(res, 200, { ok: true, plugin: name })
      return
    }

    if (url.pathname === `${ROUTE_PREFIX}/api/health`) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'method not allowed' })
        return
      }
      let clientComposed = false
      try {
        clientComposed = ctx.get('clientModules')?.clientPath?.(name) !== undefined
      } catch {
        /* 客户端模块服务缺席（TUI / headless）时忽略 */
      }
      sendJson(res, 200, {
        ok: true,
        plugin: name,
        version,
        clientComposed,
        clientOnline: runtime.helloCount > 0,
        helloCount: runtime.helloCount,
        lastHelloAt: runtime.lastHelloAt,
        clientVersion: runtime.clientVersion,
        runningSessions: countRunning(ctx),
      })
      return
    }
    sendJson(res, 404, { ok: false, code: 'NOT_FOUND', error: 'not found' })
  }
}

/** 安装 HTTP 路由，返回 webServer 的 disposer。 */
export function installApi(webCtx) {
  return webCtx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: createHandler(webCtx),
  })
}

/** 插件入口：只挂一个只读健康检查端点。 */
export function apply(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => installApi(webCtx), 'dsh-work-progress: http api')
  })
}
