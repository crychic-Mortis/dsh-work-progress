/**
 * dsh-work-progress — 浏览器半端
 * ============================================================================
 * 在当前会话的输入框上方显示一条「工作进度」：转圈 + 完成百分比 + 进度条 + 当前阶段。
 *
 * 数据全部来自 session 作用域的标准 Hook：
 *   · useSession(s => s.running)          —— 当前会话是否在跑
 *   · useChat(s => s.legacy.partial)      —— 正在流式生成的助手块
 *   · useChat(s => s.legacy.runningCalls) —— 正在执行中的工具调用
 *   · useProjection('sessionStats')       —— 已完成步骤数
 *   · useProjection('todos')              —— todo 清单（真实完成百分比）
 *   · useSessionStatus(...)               —— 是否在等待用户确认（可选）
 *
 * 挂在 conversation.input.dock（输入框上方的列表 slot）：不遮挡聊天内容，
 * 只在对话页出现，空闲时完全不占高度。
 * ============================================================================
 */

window.__ModuleLoader__.load({
  id: 'dsh-work-progress',
  factory: (require) => {
    const React = require('react')
    const NS = 'dsh-work-progress'
    const h = React.createElement

    // ── 工具函数 ───────────────────────────────────────────────────────────
    /** 0:07 / 1:42 / 1:02:03。 */
    function formatClock(ms) {
      const total = Math.max(0, Math.floor(Number(ms) / 1000) || 0)
      const seconds = total % 60
      const minutes = Math.floor(total / 60) % 60
      const hours = Math.floor(total / 3600)
      const pad = (n) => String(n).padStart(2, '0')
      return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
    }

    /** 1.2k / 23.4k / 1.1m。 */
    function formatCount(n) {
      const value = Number(n) || 0
      if (value < 1000) return String(value)
      if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`
      return `${(value / 1_000_000).toFixed(1)}m`
    }

    /** 统计 partial 里正文 / 思考的字符数（流式期间唯一可信的实时量）。 */
    function countStreamChars(blocks) {
      let text = 0
      let reasoning = 0
      if (!Array.isArray(blocks)) return { text, reasoning }
      for (const block of blocks) {
        if (block === null || typeof block !== 'object') continue
        const length = typeof block.text === 'string' ? block.text.length : 0
        if (block.kind === 'text') text += length
        else if (block.kind === 'reasoning') reasoning += length
      }
      return { text, reasoning }
    }

    // ── 工具名 → 人话 ──────────────────────────────────────────────────────
    const TOOL_LABELS = {
      bash: '执行命令',
      pwsh: '执行命令',
      ops_bash: '执行命令',
      shell: '执行命令',
      terminal: '执行命令',
      read_file: '读取文件',
      ops_read_files: '读取文件',
      ops_inspect_local_file: '查看文件',
      write: '写入文件',
      edit: '修改文件',
      ops_grep: '搜索代码',
      grep: '搜索代码',
      glob: '查找文件',
      ops_glob: '查找文件',
      web_search: '搜索网页',
      web_fetch: '抓取网页',
      argo_search: '搜索资料',
      argo_fetch: '抓取网页',
      todo_write: '更新待办',
      dtodo: '查看待办',
      subagent: '启动子任务',
      subagent_fork: '启动子任务',
      list_agents: '查看子任务',
      send_message: '给子任务发消息',
      memory: '写入记忆',
      skill: '加载技能',
      skill_manage: '管理技能',
      present: '整理交付物',
      ask_user_question: '等待你选择',
      exit_plan_mode: '提交计划',
      wide_research: '深度调研',
      create_goal: '创建目标',
      update_goal: '更新目标',
    }

    function toolLabel(name) {
      const raw = typeof name === 'string' ? name.trim() : ''
      if (raw === '') return '调用工具'
      const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw
      return TOOL_LABELS[raw] ?? TOOL_LABELS[bare] ?? '调用工具'
    }

    /** 从 runningCalls 里取第一个可读的工具名。 */
    function activeToolName(calls) {
      if (!Array.isArray(calls) || calls.length === 0) return ''
      for (const call of calls) {
        if (call === null || typeof call !== 'object') continue
        if (typeof call.name === 'string' && call.name.trim() !== '') return call.name
        if (call.kind === 'tool-call' && typeof call.call?.name === 'string') return call.call.name
      }
      return ''
    }

    /** 当前进行中的步骤号：优先 partial.step，其次 runningCalls[].step。 */
    function activeStep(partial, calls, stats) {
      let step = 0
      if (partial !== null && typeof partial === 'object' && Number.isFinite(partial.step)) step = partial.step + 1
      if (step === 0 && Array.isArray(calls)) {
        for (const call of calls) {
          if (call !== null && typeof call === 'object' && Number.isFinite(call.step)) {
            step = call.step + 1
            break
          }
        }
      }
      if (step === 0 && stats !== null && typeof stats === 'object' && Number.isFinite(stats.steps)) step = stats.steps + 1
      return step
    }

    /**
     * 没有 todo 清单时的估算进度：按本轮步数做一条递减增长曲线，
     * 再叠加一点「随时间缓慢爬升」的量，让数字持续往上走而不是跳。
     * 只用于视觉参考，UI 上会带「≈」并标注为估算；有 todo 时永远用真实完成比例。
     */
    function estimatePercent(step, elapsedMs) {
      const current = Math.max(1, Number(step) || 1)
      const base = 8 + 84 * (current / (current + 6))
      const creep = Math.min(12, (Math.max(0, Number(elapsedMs) || 0) / 1000) * 0.6)
      return Math.min(94, Math.round(base + creep))
    }

    // ── 样式（只注入一次） ────────────────────────────────────────────────
    const CSS = `
.dwp-dock{--dwp-side:var(--dsh-composer-side-clearance,16px);--dwp-inset:var(--dsh-composer-dock-inset,8px);box-sizing:border-box;width:calc(100% - 2 * var(--dwp-side) - 4 * var(--dwp-inset));max-width:calc(var(--dsh-composer-card-max-width,952px) - 4 * var(--dwp-inset));margin:0 auto;pointer-events:none;font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);-webkit-font-smoothing:antialiased}
.dwp-card{pointer-events:auto;position:relative;display:flex;align-items:center;gap:10px;padding:8px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.09));background:var(--dsw-alias-bg-layer-1,#fff);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1,#fff) 88%,transparent);box-shadow:var(--dsw-elevation-soft,0 2px 10px rgba(15,23,42,.08));color:var(--dsw-alias-label-primary,#111);overflow:hidden;animation:dwp-in .22s cubic-bezier(.2,.9,.3,1.1)}
.dwp-card::before{content:"";position:absolute;inset:0 0 auto 0;height:1px;background:linear-gradient(90deg,transparent,var(--dwp-accent,#4d6bfe),transparent);opacity:.5}
.dwp-card[data-phase=waiting]{--dwp-accent:var(--dsw-alias-state-warn-primary,#f59e0b)}
.dwp-card[data-phase=done]{--dwp-accent:var(--dsw-alias-state-success-primary,#16a34a)}
.dwp-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:6px}
.dwp-head{display:flex;align-items:center;gap:8px;min-width:0}
.dwp-phase{min-width:0;font-size:12.5px;line-height:1.3;font-weight:600;letter-spacing:.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:linear-gradient(100deg,var(--dsw-alias-label-primary,#111) 0%,var(--dsw-alias-label-primary,#111) 42%,var(--dsw-alias-label-shimmer,#8fa4ff) 50%,var(--dsw-alias-label-primary,#111) 58%,var(--dsw-alias-label-primary,#111) 100%);background-size:220% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:dwp-shimmer 2.4s linear infinite}
.dwp-card[data-phase=waiting] .dwp-phase,.dwp-card[data-phase=done] .dwp-phase{animation:none;background:none;-webkit-text-fill-color:currentColor}
.dwp-chip{flex:none;max-width:150px;padding:1px 5px;border-radius:5px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.09));background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.035));color:var(--dsw-alias-label-secondary,#5b6472);font:10px/1.35 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwp-todo{flex:1;min-width:0;font-size:10.5px;line-height:1.2;color:var(--dsw-alias-label-tertiary,#8a909c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dwp-todo:not(:empty)::before{content:"·";margin-right:6px;opacity:.55}
.dwp-meta{flex:none;display:flex;align-items:center;gap:6px;font-size:10.5px;line-height:1.2;color:var(--dsw-alias-label-tertiary,#8a909c);font-variant-numeric:tabular-nums;white-space:nowrap}
.dwp-meta b{font-weight:600;color:var(--dsw-alias-label-secondary,#5b6472)}
.dwp-time{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.02em}
.dwp-sep{width:3px;height:3px;border-radius:50%;background:currentColor;opacity:.4;flex:none}
.dwp-pct{flex:none;padding:2px 6px;border-radius:6px;border:1px solid color-mix(in srgb,var(--dwp-accent,#4d6bfe) 28%,transparent);background:color-mix(in srgb,var(--dwp-accent,#4d6bfe) 10%,transparent);color:var(--dwp-accent,#4d6bfe);font:600 11px/1.2 ui-monospace,SFMono-Regular,Consolas,monospace;font-variant-numeric:tabular-nums;letter-spacing:.01em}
.dwp-pct[data-estimate=true]{color:var(--dsw-alias-label-tertiary,#8a909c);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.09));background:var(--dsw-alias-bg-layer-2,rgba(0,0,0,.035))}
.dwp-bar{position:relative;height:3px;border-radius:999px;overflow:hidden;background:color-mix(in srgb,var(--dwp-accent,#4d6bfe) 13%,transparent)}
.dwp-bar-fill{position:absolute;top:0;bottom:0;left:0;width:0;border-radius:999px;background:linear-gradient(90deg,color-mix(in srgb,var(--dwp-accent,#4d6bfe) 70%,transparent),var(--dwp-accent,#4d6bfe));transition:width .5s cubic-bezier(.4,0,.2,1)}
.dwp-card[data-mode=estimate] .dwp-bar::after{content:"";position:absolute;top:0;bottom:0;left:0;width:38%;border-radius:999px;background:linear-gradient(90deg,transparent,color-mix(in srgb,var(--dwp-accent,#4d6bfe) 45%,transparent),transparent);animation:dwp-sweep 1.8s cubic-bezier(.45,.05,.55,.95) infinite}
.dwp-card[data-phase=done] .dwp-bar-fill{background:var(--dwp-accent,#16a34a)}
.dwp-spin{position:relative;width:24px;height:24px;flex:none;border-radius:50%;display:grid;place-items:center}
.dwp-ring{position:absolute;inset:0;border-radius:50%;background:conic-gradient(from 0turn,transparent 0turn,transparent .12turn,var(--dwp-accent,#4d6bfe) .62turn,var(--dwp-accent,#4d6bfe) .8turn,transparent .98turn);-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));animation:dwp-rotate 1.05s linear infinite}
.dwp-card[data-phase=waiting] .dwp-ring{animation-duration:2.4s}
.dwp-core{width:6px;height:6px;border-radius:50%;background:var(--dwp-accent,#4d6bfe);box-shadow:0 0 7px var(--dwp-accent,#4d6bfe);animation:dwp-pulse 1.5s ease-in-out infinite}
.dwp-card[data-phase=done] .dwp-ring{animation:none;background:var(--dwp-accent,#16a34a)}
.dwp-card[data-phase=done] .dwp-core{display:none}
.dwp-check{width:9px;height:5px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg) translate(.5px,-1.5px);animation:dwp-check-in .28s ease-out}
@keyframes dwp-rotate{to{transform:rotate(1turn)}}
@keyframes dwp-sweep{0%{transform:translateX(-115%)}100%{transform:translateX(255%)}}
@keyframes dwp-shimmer{0%{background-position:120% 0}100%{background-position:-120% 0}}
@keyframes dwp-pulse{0%,100%{transform:scale(.82);opacity:.65}50%{transform:scale(1.08);opacity:1}}
@keyframes dwp-in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
@keyframes dwp-check-in{from{opacity:0;transform:rotate(-45deg) translate(.5px,-1.5px) scale(.5)}to{opacity:1;transform:rotate(-45deg) translate(.5px,-1.5px) scale(1)}}
@media (max-width:720px){.dwp-chars,.dwp-todo{display:none}}
@media (prefers-reduced-motion:reduce){.dwp-ring{animation:none;background:conic-gradient(var(--dwp-accent,#4d6bfe) .75turn,transparent 0)}.dwp-core,.dwp-phase,.dwp-check,.dwp-card{animation:none!important}.dwp-card[data-mode=estimate] .dwp-bar::after{display:none}.dwp-phase{background:none;-webkit-text-fill-color:currentColor}}
`

    function installStyles() {
      const existing = document.querySelector(`style[data-${NS}]`)
      if (existing !== null) return () => {}
      const style = document.createElement('style')
      style.setAttribute(`data-${NS}`, '')
      style.textContent = CSS
      document.head.appendChild(style)
      return () => {
        style.remove()
      }
    }

    // ── 组件 ──────────────────────────────────────────────────────────────
    const noopHook = () => undefined

    function WorkProgressDock(props) {
      const useSession = typeof props.useSession === 'function' ? props.useSession : noopHook
      const useChat = typeof props.useChat === 'function' ? props.useChat : noopHook
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : noopHook
      const useSessionStatus = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : noopHook
      const { sessionId } = props

      const running = useSession((s) => (s !== null && typeof s === 'object' ? s.running === true : false)) === true
      const partial = useChat((s) => (s !== null && typeof s === 'object' ? s.legacy?.partial ?? null : null))
      const runningCalls = useChat((s) => (s !== null && typeof s === 'object' ? s.legacy?.runningCalls ?? null : null))
      const stats = useProjection('sessionStats')
      const todos = useProjection('todos')
      const pending = useSessionStatus((snapshot) => {
        if (snapshot === null || typeof snapshot !== 'object' || typeof snapshot.get !== 'function' || sessionId === undefined) return undefined
        return snapshot.get(sessionId)?.pendingInteraction
      })

      const [done, setDone] = React.useState(false)
      const [elapsed, setElapsed] = React.useState(0)
      const wasRunning = React.useRef(false)

      const turnStart = useChat((s) => {
        if (s === null || typeof s !== 'object') return undefined
        const timeline = s.timeline
        const order = Array.isArray(timeline?.turnOrder) ? timeline.turnOrder : []
        const last = order.length > 0 ? order[order.length - 1] : undefined
        if (last === undefined) return undefined
        const turn = timeline.turns?.get?.(last)
        const time = turn?.start?.time
        return typeof time === 'number' ? time : undefined
      })

      // 同一轮里百分比只增不减：步骤号取历史最大值，百分比再取历史最大值；
      // 换轮（turnStart 变化）时一起归零，避免上一轮的 100% 带到下一轮。
      const turnKey = typeof turnStart === 'number' ? turnStart : 0
      const stepTrack = React.useRef({ key: turnKey, max: 0 })
      const percentTrack = React.useRef({ key: turnKey, max: 0 })
      // 本轮真正开始的时间：比 timeline 的 turnStart 更早/更晚都能兜住，
      // 避免新一轮第一帧用上一轮的 elapsed 把估算百分比抬高。
      const runStartRef = React.useRef(0)
      const runFlagRef = React.useRef(false)
      if (running && !runFlagRef.current) {
        runFlagRef.current = true
        runStartRef.current = Date.now()
      }
      if (!running) runFlagRef.current = false
      const estimateElapsed = Math.max(0, Date.now() - Math.max(runStartRef.current, typeof turnStart === 'number' ? turnStart : 0))

      // 运行中：500ms 刷新一次计时；结束：保留最后读数给「完成」态。
      React.useEffect(() => {
        if (!running) return undefined
        const start = typeof turnStart === 'number' ? turnStart : Date.now()
        const tick = () => setElapsed(Math.max(0, Date.now() - start))
        tick()
        const timer = window.setInterval(tick, 500)
        return () => window.clearInterval(timer)
      }, [running, turnStart])

      // 收尾：显示 2.6s 的「完成」态再隐藏。
      React.useEffect(() => {
        if (running) {
          wasRunning.current = true
          setDone(false)
          return undefined
        }
        if (!wasRunning.current) return undefined
        wasRunning.current = false
        setDone(true)
        // 本轮已结束：清空「只增不减」记录，下一轮从低值重新开始。
        stepTrack.current = { key: turnKey, max: 0 }
        percentTrack.current = { key: turnKey, max: 0 }
        const timer = window.setTimeout(() => setDone(false), 2600)
        return () => window.clearTimeout(timer)
      }, [running])

      const visible = running || done
      if (!visible) return null

      const stream = countStreamChars(partial?.blocks)
      const hasStream = stream.text > 0 || stream.reasoning > 0
      const toolName = activeToolName(runningCalls)
      const toolCount = Array.isArray(runningCalls) ? runningCalls.length : 0
      const step = activeStep(partial, runningCalls, stats)
      const todoList = Array.isArray(todos) ? todos : []
      const totalTodos = todoList.length
      const completedTodos = todoList.reduce((count, item) => count + (item?.status === 'completed' ? 1 : 0), 0)
      const activeTodo = todoList.find((item) => item?.status === 'in_progress') ?? null
      const hasTodos = totalTodos > 0
      const rawTurnStep = (partial !== null && typeof partial === 'object' && Number.isFinite(partial.step) ? partial.step + 1 : 0)
        || (Array.isArray(runningCalls) && runningCalls.find((call) => Number.isFinite(call?.step))?.step + 1)
        || 1
      if (stepTrack.current.key !== turnKey) stepTrack.current = { key: turnKey, max: 0 }
      stepTrack.current.max = Math.max(stepTrack.current.max, rawTurnStep)
      const turnStep = stepTrack.current.max

      let phase = 'thinking'
      if (done) phase = 'done'
      else if (pending !== undefined && pending !== null) phase = 'waiting'
      else if (toolCount > 0) phase = 'tool'
      else if (hasStream && stream.text > 0) phase = 'writing'

      let phaseText = '正在思考'
      if (phase === 'done') phaseText = '本轮已完成'
      else if (phase === 'waiting') phaseText = '等待你的确认'
      else if (phase === 'tool') phaseText = toolCount > 1 ? `正在并行执行 ${toolCount} 个工具` : `正在${toolLabel(toolName)}`
      else if (phase === 'writing') phaseText = '正在生成回复'

      // 有 todo 清单 → 真实完成比例；没有 → 按步数估算（带「≈」）。
      let percent = 100
      let estimate = false
      if (!done) {
        if (hasTodos) percent = Math.min(99, Math.round((completedTodos / totalTodos) * 100))
        else {
          estimate = true
          percent = estimatePercent(turnStep, estimateElapsed)
        }
        // 同一轮只增不减：即使中间步骤号/阶段回退，百分比也保持历史最高值。
        if (percentTrack.current.key !== turnKey) percentTrack.current = { key: turnKey, max: 0 }
        percentTrack.current.max = Math.max(percentTrack.current.max, percent)
        percent = percentTrack.current.max
      }
      const percentText = estimate ? `≈${percent}%` : `${percent}%`
      const todoTitle = !done && activeTodo !== null && typeof activeTodo.content === 'string' ? activeTodo.content : ''

      const startedAtLabel = formatClock(elapsed)
      const chars = stream.text > 0 ? stream.text : stream.reasoning
      const ariaLabel = phase === 'done'
        ? `已完成，用时 ${startedAtLabel}`
        : `${phaseText}，进度 ${percentText}，已用时 ${startedAtLabel}`

      const metaItems = []
      if (done) {
        metaItems.push(h('span', { key: 'time', className: 'dwp-time' }, `用时 ${startedAtLabel}`))
      } else {
        if (hasTodos) metaItems.push(h('span', { key: 'step' }, h('b', null, `${completedTodos}/${totalTodos} 项`)))
        else if (step > 0) metaItems.push(h('span', { key: 'step' }, h('b', null, `第 ${step} 步`)))
        metaItems.push(h('span', { key: 'time', className: 'dwp-time' }, startedAtLabel))
        if (chars > 0) metaItems.push(h('span', { key: 'chars', className: 'dwp-chars' }, `${formatCount(chars)} 字`))
      }
      const meta = []
      metaItems.forEach((item, index) => {
        if (index > 0) meta.push(h('span', { key: `sep-${index}`, className: 'dwp-sep', 'aria-hidden': true }))
        meta.push(item)
      })

      return h(
        'div',
        { className: 'dwp-dock' },
        h(
          'div',
          {
            className: 'dwp-card',
            role: 'status',
            'aria-live': 'off',
            'aria-label': ariaLabel,
            'aria-busy': running,
            'data-phase': phase,
            'data-mode': done ? 'done' : hasTodos ? 'todo' : 'estimate',
          },
          h(
            'span',
            { className: 'dwp-spin', 'aria-hidden': true },
            h('span', { className: 'dwp-ring' }),
            phase === 'done' ? h('span', { className: 'dwp-check' }) : h('span', { className: 'dwp-core' }),
          ),
          h(
            'div',
            { className: 'dwp-main' },
            h(
              'div',
              { className: 'dwp-head' },
              h('span', { className: 'dwp-phase' }, phaseText),
              phase === 'tool' && toolName !== '' ? h('span', { className: 'dwp-chip' }, toolName) : null,
              h('span', { className: 'dwp-todo', title: todoTitle === '' ? undefined : todoTitle }, todoTitle),
              meta.length > 0 ? h('span', { className: 'dwp-meta' }, meta) : null,
              h(
                'span',
                {
                  className: 'dwp-pct',
                  'data-estimate': estimate ? 'true' : 'false',
                  title: estimate ? '没有 todo 清单，百分比按本轮步数估算' : done ? '本轮完成' : 'todo 清单完成比例',
                },
                percentText,
              ),
            ),
            h('div', { className: 'dwp-bar', 'aria-hidden': true }, h('span', { className: 'dwp-bar-fill', style: { width: `${percent}%` } })),
          ),
        ),
      )
    }

    // ── Cordis 客户端插件入口 ─────────────────────────────────────────────
    const inject = ['slots']

    function apply(ctx) {
      ctx.effect(() => installStyles(), 'dsh-work-progress: styles')
      // 自报一次：健康检查里能确认浏览器半端真的挂上了（不参与任何业务逻辑）。
      try {
        void fetch('/work-progress/api/hello?v=1.0.0', { method: 'POST', credentials: 'same-origin' }).catch(() => {})
      } catch {
        /* 非 Web 载体 / 离线时忽略 */
      }
      ctx.effect(
        () =>
          ctx.slots.inject('conversation.input.dock', () =>
            ctx.slots.register(
              {
                name: 'conversation.input.dock',
                id: 'work-progress',
                order: 50,
              },
              WorkProgressDock,
            ),
          ),
        'dsh-work-progress: inline progress',
      )
    }

    return { inject, apply }
  },
})
