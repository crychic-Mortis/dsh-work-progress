/**
 * dsh-work-progress · 浏览器半端冒烟测试
 * ============================================================================
 * 不用真实浏览器：用最小 React Hook 引擎 + 假 session 数据驱动组件，
 * 覆盖「空闲 / 思考 / 生成 / 工具 / 等待确认 / 完成」六种状态。
 *
 *   node --test test/client.test.mjs
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'client.js'), 'utf8')

// ── 浏览器环境最小桩 ──────────────────────────────────────────────────────
function installEnv() {
  globalThis.window = globalThis
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({
      textContent: '',
      setAttribute() {},
      remove() {},
    }),
    head: { appendChild() {} },
    body: {},
  }
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
  }
  globalThis.fetch = async () => ({ ok: true })
  globalThis.Element = class Element {}
}

// ── 最小 React Hook 引擎 ──────────────────────────────────────────────────
function createHookEngine(React) {
  const state = { hooks: [], index: 0, effects: [] }

  function beginRender() {
    state.index = 0
    state.effects = []
  }

  function endRender() {
    return state.effects
  }

  React.useState = (initial) => {
    const index = state.index++
    if (!(index in state.hooks)) state.hooks[index] = typeof initial === 'function' ? initial() : initial
    const setter = (value) => {
      const current = state.hooks[index]
      state.hooks[index] = typeof value === 'function' ? value(current) : value
    }
    return [state.hooks[index], setter]
  }
  React.useRef = (initial) => {
    const index = state.index++
    if (!(index in state.hooks)) state.hooks[index] = { current: initial }
    return state.hooks[index]
  }
  React.useEffect = (effect) => {
    state.index++
    state.effects.push(effect)
  }
  React.useMemo = (factory) => factory()
  React.memo = (component) => component
  React.createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), ...(children.length > 0 ? { children: children.length === 1 ? children[0] : children } : {}) },
  })

  return { beginRender, endRender }
}

/** 把 portal 结果转成可断言的纯对象。 */
function flatten(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flatten).join(' ')
  if (typeof node === 'object') {
    if (node.__portal === true) return flatten(node.children)
    const props = node.props ?? {}
    const children = props.children ?? node.children ?? null
    return [flatten(children), typeof props.title === 'string' ? props.title : ''].join(' ')
  }
  return ''
}

/** 找到卡片节点，读它的 data-* 属性。 */
function findCard(node) {
  if (node === null || typeof node !== 'object') return null
  if (node.__portal === true) return findCard(node.children)
  if (node.props?.className === 'dwp-card') return node
  const children = node.props?.children ?? node.children
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findCard(child)
      if (found !== null) return found
    }
    return null
  }
  return findCard(children)
}

// ── 载入客户端 bundle ─────────────────────────────────────────────────────
function loadPlugin() {
  const React = {}
  const ReactDOM = { createPortal: (children) => ({ __portal: true, children }) }
  let captured = null
  const hooks = createHookEngine(React)

  globalThis.window.__ModuleLoader__ = {
    load: ({ id, factory }) => {
      const exports = factory((request) => {
        if (request === 'react') return React
        if (request === 'react-dom') return ReactDOM
        throw new Error(`unexpected require: ${request}`)
      })
      assert.equal(id, 'dsh-work-progress')
      const ctx = {
        effect: (fn) => {
          const dispose = fn()
          return () => dispose?.()
        },
        slots: {
          inject: (_name, fn) => {
            fn()
            return () => {}
          },
          register: (_def, component) => {
            captured = component
            return () => {}
          },
        },
      }
      exports.apply(ctx)
    },
  }

  // 在隔离函数里执行 bundle（它只依赖 window / document）
  const run = new Function('window', 'document', 'localStorage', 'fetch', source)
  run(globalThis.window, globalThis.document, globalThis.localStorage, globalThis.fetch)

  assert.notEqual(captured, null, '插件应向 composer.dock 注册组件')
  return { component: captured, hooks }
}

function baseChat(overrides = {}) {
  return {
    legacy: { partial: null, runningCalls: [], ...(overrides.legacy ?? {}) },
    timeline: {
      turnOrder: [1],
      turns: new Map([[1, { start: { time: Date.now() - 42_000 } }]]),
      ...(overrides.timeline ?? {}),
    },
  }
}

const SESSION_ID = 'session-test'

function propsFor({ running, chat, pending, stats, todos }) {
  return {
    sessionId: SESSION_ID,
    useSession: (selector) => selector({ running }),
    useChat: (selector) => selector(chat),
    useProjection: (key) => {
      if (key === 'sessionStats') return stats ?? { steps: 2 }
      if (key === 'todos') return todos
      return undefined
    },
    useSessionStatus: (selector) => selector(new Map([[SESSION_ID, { pendingInteraction: pending }]])),
  }
}

function render(engine, component, props) {
  engine.beginRender()
  const tree = component(props)
  const effects = engine.endRender()
  for (const effect of effects) {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanup()
  }
  return tree
}

test('空闲时不渲染任何东西', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const tree = render(hooks, component, propsFor({ running: false, chat: baseChat() }))
  assert.equal(tree, null)
})

test('思考中：显示转圈、第 N 步与已用时', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat({ legacy: { partial: { turn: 1, step: 2, blocks: [{ kind: 'reasoning', text: '先看看目录结构' }] } } })
  const props = propsFor({ running: true, chat })
  render(hooks, component, props)
  const tree = render(hooks, component, props)
  const text = flatten(tree)
  assert.match(text, /正在思考/)
  assert.match(text, /第 3 步/)
  assert.match(text, /0:4\d/)
  assert.match(text, /字/)
})

test('生成回复：识别正文流', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat({ legacy: { partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: '这是一段正在生成的回复'.repeat(30) }] } } })
  const tree = render(hooks, component, propsFor({ running: true, chat }))
  const text = flatten(tree)
  assert.match(text, /正在生成回复/)
  assert.match(text, /第 2 步/)
})

test('工具执行：显示人话标签与原始工具名', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat({ legacy: { runningCalls: [{ name: 'ops_bash', step: 3, phase: 'preparing' }] } })
  const tree = render(hooks, component, propsFor({ running: true, chat }))
  const text = flatten(tree)
  assert.match(text, /正在执行命令/)
  assert.match(text, /ops_bash/)
  assert.match(text, /第 4 步/)
})

test('等待确认：黄色等待态', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat()
  const tree = render(hooks, component, propsFor({ running: true, chat, pending: { kind: 'approval' } }))
  const text = flatten(tree)
  assert.match(text, /等待你的确认/)
  assert.equal(findCard(tree)?.props?.['data-phase'], 'waiting')
})

test('有 todo 清单：显示真实完成百分比', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat({ legacy: { partial: { turn: 1, step: 3, blocks: [{ kind: 'text', text: '正在写第三个模块' }] } } })
  const todos = [
    { content: '读代码', status: 'completed' },
    { content: '改接口', status: 'completed' },
    { content: '补测试', status: 'completed' },
    { content: '写文档', status: 'in_progress' },
    { content: '打包', status: 'pending' },
    { content: '发布', status: 'pending' },
    { content: '复盘', status: 'pending' },
  ]
  const tree = render(hooks, component, propsFor({ running: true, chat, todos }))
  const text = flatten(tree)
  assert.match(text, /43%/)
  assert.match(text, /3\/7 项/)
  assert.match(text, /写文档/)
  assert.equal(findCard(tree)?.props?.['data-mode'], 'todo')
})

test('没有 todo 清单：百分比带「≈」并标注为估算', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat()
  const tree = render(hooks, component, propsFor({ running: true, chat }))
  const text = flatten(tree)
  assert.match(text, /≈\d+%/)
  assert.equal(findCard(tree)?.props?.['data-mode'], 'estimate')
})

test('同一轮内步骤号回退时，百分比不回退', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat({ legacy: { partial: { turn: 1, step: 8, blocks: [] } } })
  const props = propsFor({ running: true, chat })
  render(hooks, component, props)
  const first = flatten(render(hooks, component, props))
  const before = Number(first.match(/(\d+)%/)?.[1])
  assert.ok(Number.isFinite(before))
  chat.legacy.partial = { turn: 1, step: 0, blocks: [] }
  const second = flatten(render(hooks, component, props))
  const after = Number(second.match(/(\d+)%/)?.[1])
  assert.ok(Number.isFinite(after))
  assert.ok(after >= before, `百分比不应回退：${before}% → ${after}%`)
})

test('完成后短暂显示「本轮已完成」再隐藏', () => {
  installEnv()
  const { component, hooks } = loadPlugin()
  const chat = baseChat()

  // 第一次：运行中（记录 wasRunning）
  let tree = render(hooks, component, propsFor({ running: true, chat }))
  assert.match(flatten(tree), /正在/)

  // 第二次：运行结束，effect 里把 done 置为 true
  render(hooks, component, propsFor({ running: false, chat }))

  // 第三次：读到 done 态
  tree = render(hooks, component, propsFor({ running: false, chat }))
  const text = flatten(tree)
  assert.match(text, /本轮已完成/)
  assert.match(text, /用时 0:4\d/)
  assert.equal(findCard(tree)?.props?.['data-phase'], 'done')
})
