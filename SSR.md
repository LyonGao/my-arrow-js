# Arrow.js SSR 是怎么实现的

这份文档把 Arrow 的服务端渲染从头到尾拆开讲。读完你应该能回答：

- 服务端到底有没有「第二套渲染器」？（没有）
- HTML 是拼出来的，还是真 DOM 序列化出来的？（真 DOM）
- 异步数据怎么到浏览器、又为什么不用再 fetch？
- 浏览器怎么把已有 HTML 接上交互，而不是整页重画？

相关源码以当前仓库为准，核心入口：

| 你 import 的 | 真正干活的文件 |
|---|---|
| `@arrow-js/ssr` 的 `renderToString` | `packages/framework/src/ssr.ts` |
| `@arrow-js/ssr` 的 `serializePayload` | 同上 |
| `@arrow-js/framework` 的 `render` | `packages/framework/src/render.ts` |
| `@arrow-js/framework` 的 `boundary` | `packages/framework/src/boundary.ts` |
| 异步组件 | `packages/framework/src/async.ts` |
| 浏览器 `hydrate` | `packages/hydrate/src/index.ts` |
| 模板绑定本身 | `packages/core/src/html.ts` |

`packages/ssr/src/index.ts` 几乎是空壳：它只是把 framework 的 SSR API 再 export 一遍，方便应用只依赖 `@arrow-js/ssr`。

---

## 0. 先用一张图建立直觉

React SSR 大致是：

```
组件树 ──► 虚拟树 / 字符串拼接 ──► HTML 文本
                ▲
                └── 服务端没有真 DOM
```

Arrow SSR 是：

```
同一份 html`...` 模板
        │
        ▼
在 Node 里启动一个 JSDOM（假浏览器）
        │
        ▼
调用和客户端一模一样的 template(root)
（createBindings、watch、async 组件全跑）
        │
        ▼
等所有异步结束
        │
        ├── root.innerHTML  ──────────►  发给浏览器的 HTML
        └── { async, boundaries }  ──►  塞进 <script type="application/json">
```

一句话：**Arrow 没有独立的「字符串 SSR 引擎」。它在服务器上给 core 配了一个假 `document`，让现有 DOM 渲染器自己跑完，再把结果序列化。**

所以后面看到的 `createBindings`、`html`、`component()`，服务端和客户端是同一条路。差别只是：

- 服务端的 `document` 来自 JSDOM
- 服务端会等到异步组件全部 settle，再读 HTML
- 服务端把异步结果和 boundary id 打进 payload
- 客户端用 payload + 已有 DOM 做 hydrate，而不是 `replaceChildren` 重画

---

## 1. 一次完整请求长什么样

以 `create-arrow-js` 模板为例（`packages/create-arrow-js/template/`）。

页面壳 `index.html` 里预先留了三个槽：

```html
<head>
  <!--app-head-->
</head>
<body>
  <div id="app"><!--app-html--></div>
  <!--app-payload-->
  <script type="module" src="/src/entry-client.ts"></script>
</body>
```

浏览器请求 `/` 时，Node 大致做这些事：

```
1. routeToPage('/')          得到 { title, view: App() }
2. renderToString(page.view) 得到 { html, payload }
3. serializePayload(payload) 得到 <script id="arrow-ssr-payload">...</script>
4. 字符串替换三个槽
5. 把完整 HTML 响应给浏览器
```

对应代码：

```ts
// packages/create-arrow-js/template/src/entry-server.ts
export async function renderPage(url: string) {
  const page = routeToPage(url)
  const result = await renderToString(page.view)

  return {
    head: `<title>${page.title}</title>...`,
    html: result.html,
    payloadScript: serializePayload(result.payload),
    status: page.status,
  }
}
```

服务器（docs 站的 `docs/server.mjs`、Vite 插件同理）再做：

```ts
template
  .replace('<!--app-head-->', page.head)
  .replace('<!--app-html-->', page.html)
  .replace('<!--app-payload-->', page.payloadScript)
```

浏览器拿到的已经是「画好的页面 + 一份 JSON + 客户端脚本」。脚本启动后：

```ts
// packages/create-arrow-js/template/src/entry-client.ts
const payload = readPayload()
await hydrate(document.getElementById('app')!, page.view, payload)
```

`hydrate` 的任务不是再画一遍，而是：**承认 `#app` 里已经有 DOM，把事件、watch、组件状态接到这些节点上。**

---

## 2. 用一个最小例子把每一步钉死

下面这个例子比真实 App 小，但足够覆盖 SSR 的全部机制。请对着它想象内存里发生了什么。

```ts
import { component, html, reactive } from '@arrow-js/core'
import { boundary } from '@arrow-js/framework'

const UserCard = component(async () => {
  const user = await fetchUser() // { name: 'Ada' }
  return html`<p id="name">${user.name}</p>`
})

const Counter = component(() => {
  const state = reactive({ n: 0 })
  return html`<button @click="${() => state.n++}">${() => state.n}</button>`
})

const App = () => html`
  <main>
    ${Counter()}
    ${boundary(UserCard(), { idPrefix: 'user' })}
  </main>
`
```

应用这样调用：

```ts
const { html, payload } = await renderToString(App())
const script = serializePayload(payload)
```

### 2.1 刚进 `renderToString`

`packages/framework/src/ssr.ts` 做的第一件事：用 JSDOM 造一个最小文档。

```ts
const dom = new JSDOM(`<!doctype html><div id="app"></div>`, {
  url: 'http://arrow.local/',
})
const root = dom.window.document.getElementById('app')
```

此时假页面是：

```html
<html>
  <body>
    <div id="app"></div>
  </body>
</html>
```

还没有任何 Arrow 节点。

### 2.2 把假 window 接到 `globalThis`

core 里到处写着 `document.createTextNode`、`el.addEventListener`，它不知道自己在 Node 里。所以 SSR 必须让这些全局名在这次调用期间指向 JSDOM。

`packages/framework/src/dom.ts` 的 `withDomWindow`：

1. 第一次调用时，给 `globalThis.window / document / Node / Element / ...` 装上 getter。
2. getter 内部读 `AsyncLocalStorage`：当前异步调用栈绑定的是哪一个 JSDOM window，就返回哪一个。
3. 然后 `storage.run(window, fn)` 执行真正的渲染。

为什么要用 `AsyncLocalStorage`，而不是直接 `global.document = dom.window.document`？

因为服务器会并发处理很多请求。如果写死一个全局 `document`，请求 A 和请求 B 会抢同一棵 DOM。ALS 让「这次 `renderToString` 的所有 await 后面」都还能拿到**自己那份** window。

可以把它想成：

```
请求 A:  storage = JSDOM-A    ──►  A 的 html`...` 用 A 的 document
请求 B:  storage = JSDOM-B    ──►  B 的 html`...` 用 B 的 document
请求外:  storage 为空         ──►  回落到 Node 原来的全局（通常没有 document）
```

### 2.3 `render(root, view)`：和浏览器 mount 是同一句话

`packages/framework/src/render.ts`：

```ts
return withRenderContext(async (context) => {
  const template = toTemplate(view)
  template(root)          // ← 就是 tpl(parent)
  await context.flush()   // ← 等所有异步组件
  await nextTick()        // ← 再等一拍，让 DOM 更新写完
  return { payload: { async: ..., boundaries: ... } }
})
```

`template(root)` 会走进 `packages/core/src/html.ts` 的 `renderTemplate` → `createBindings`。也就是：

1. 按静态字符串解析出一份 HTML 模具（`ChunkProto`）
2. `cloneNode` 出这次实例（`Chunk`）
3. 把 `${}` 表达式写进 `expressionPool`
4. 按 path tape 找到占位节点，绑定文本 / 属性 / `@click`

此时 JSDOM 里的 `#app` 已经开始长出真实节点。但 `UserCard` 是 async 的：第一次绑定时它可能还是空的 fallback，要等 loader 结束、`watch` 把内容补进去。

### 2.4 为什么必须 `flush()` + `nextTick()`

时间线（简化）：

```
t0  template(root)
    Counter 立刻画出 <button>0</button>
    UserCard 状态 = pending，先渲染 fallback（默认是空字符串）
    同时 fetchUser() 被 context.track(promise) 登记

t1  await context.flush()
    flush 的实现：while (还有 pending) 就 Promise.allSettled
    fetchUser 结束 → 状态改为 resolved → recordSnapshot('c:0', { name: 'Ada' })
    响应式 watch 安排一次 DOM 更新（微任务）

t2  await nextTick()
    微任务跑完，<p id="name">Ada</p> 已经在 JSDOM 里了

t3  这时才读 root.innerHTML
```

如果不等，`innerHTML` 会把 fallback（空白）发给浏览器，客户端还得再 fetch 一次，SSR 就白做了。

`flush` 见 `packages/framework/src/context.ts`：它循环等到 `context.pending` 清空。异步组件每次 `start()` 都会 `context.track(task)`，所以「页面上所有 async 组件」都会被等到。

### 2.5 此时 JSDOM 里的 HTML 长什么样

`root.innerHTML` 大约是：

```html
<main>
  <button>0</button>
  <template data-arrow-boundary-start="user:0"></template>
  <p id="name">Ada</p>
  <template data-arrow-boundary-end="user:0"></template>
</main>
```

注意几件「看起来怪、其实是故意的」事：

- `@click` **不会**出现在 HTML 里。事件是 JS 监听器，序列化 DOM 时带不走。浏览器 hydrate 时会重新 `addEventListener`。
- `UserCard` 外面多了两个空的 `<template>`。这是 `boundary()` 插入的标记，给 hydrate 失败时做局部替换用。
- 按钮文本是 `0`，即服务端执行 `reactive({ n: 0 })` 的初始值。SSR 不会把「用户之后点了几次」算进去——那是客户端状态。

### 2.6 payload 里有什么

`renderToString` 返回：

```ts
{
  html: '<main>...</main>',          // 和 innerHTML 同一份
  payload: {
    rootId: 'app',
    html: '<main>...</main>',        // 再存一份，hydrate 用来对比 mismatch
    async: {
      'c:0': { name: 'Ada' }         // UserCard 的 snapshot
    },
    boundaries: ['user:0']           // 声明过的 boundary id
  }
}
```

`serializePayload` 把它变成：

```html
<script id="arrow-ssr-payload" type="application/json">{"rootId":"app","html":"...","async":{"c:0":{"name":"Ada"}},"boundaries":["user:0"]}</script>
```

`<` 会被替换成 `\u003c`，防止 JSON 里出现 `</script>` 提前关掉标签。

客户端 `readPayload()` 就是：找到这个 script，`JSON.parse(textContent)`。

---

## 3. 异步组件：HTML 管样子，payload 管数据

这是 SSR 里最容易漏掉的一半。

`WelcomeCard`（模板项目里的真实代码）长这样：

```ts
export const WelcomeCard = component(async () => {
  const note = await loadWelcomeCard()
  return html`<div class="card">...</div>`
})
```

framework 启动时（`packages/framework/src/install.ts`）会给 core 安装 async 组件实现。于是这个 `component(async ...)` 实际走到 `packages/framework/src/async.ts` 的 `asyncComponent`。

每个实例做四件事：

### 3.1 领一个稳定 id

```ts
state.id = context.claimComponentId(options.idPrefix)
// 默认类似 "c:0"、"c:1"
```

服务端按出现顺序发号。客户端 hydrate 时按**同一份组件树、同一个顺序**再领一次，所以 id 对得上。

### 3.2 服务端：跑 loader，记下 snapshot

```ts
loader(props, emit)
  → 得到 value
  → context.recordSnapshot(id, snapshot)
```

默认 snapshot 就是 value 本身（必须 JSON 可序列化）。不能 `JSON.stringify` 的（函数、循环引用、DOM 节点）会被丢掉。这时要自己提供：

```ts
component(async () => fetchSomething(), {
  serialize: (value) => value.id,           // 只把能过 JSON 的部分写入 payload
  deserialize: (snapshot) => lookup(snapshot) // 客户端用 snapshot 还原
})
```

### 3.3 客户端：先看 payload，有就不 fetch

`hydrate()` 会用 `withRenderContext({ hydrationSnapshots: payload.async })` 包一层。async 组件创建时：

```ts
const snapshot = context.consumeSnapshot(state.id)
if (snapshot !== undefined) {
  state.value = deserialize(snapshot)
  state.status = 'resolved'   // 直接当已经加载完
}
```

命中之后 `start()` 不会跑，网络请求不会发第二次。这就是「SSR 数据复活」。

### 3.4 没命中才走客户端加载

没有 SSR payload、id 对不上、或 snapshot 无法还原时，状态停在 `idle`，照常 `start()` → 显示 `fallback` → resolved 后再画。

整条数据桥：

```
服务端 loader()
    │
    ▼
recordSnapshot('c:0', data)
    │
    ▼
payload.async['c:0'] 写进页面 JSON
    │
    ▼
客户端 consumeSnapshot('c:0')
    │
    ▼
组件直接 resolved，DOM 已经是 SSR 画好的那份
```

---

## 4. `boundary()`：给 hydrate 留可拆的缝

```ts
html`${boundary(UserCard(), { idPrefix: 'user' })}`
```

实现（`packages/framework/src/boundary.ts`）很短：它不改变内部 UI，只在两边插标记：

```html
<template data-arrow-boundary-start="user:0"></template>
  ...UserCard 的真实 DOM...
<template data-arrow-boundary-end="user:0"></template>
```

同时 `context.registerBoundary('user:0')`，id 进入 `payload.boundaries`。

为什么需要它？

Arrow 的 hydrate 会拿「客户端重新 mount 出来的离屏 DOM」和「页面上已有的 SSR DOM」逐节点对比。大多数时候对得上，就 reuse 原节点。

对不上时有三档退路（`packages/hydrate/src/index.ts`）：

```
1. 整棵还能对上（小修小补）     → adopted: true，尽量保留 SSR 节点
2. 整棵对不上，但 boundary 能对  → 只替换这一对 <template> 之间的内容
3. boundary 也救不了             → #app.replaceChildren(客户端 DOM)，等于客户端渲染
```

没有 `boundary()` 的子树，一旦结构 mismatch，更容易触发第 3 档整根替换。异步区域、依赖数据的卡片，通常都应该包一层。

`<template>` 在 HTML 里是惰性的：浏览器当它是标记，不会当成可见 UI。所以你在页面上看不到这两个标签的「方框」，但 DOM 里它们在。

---

## 5. 浏览器 hydrate：和 SSR 怎么握手

服务端做完以后，客户端**不会**直接 `App()(root)`。那会再造一棵 DOM 塞进去，SSR HTML 就浪费了。

`hydrate()` 的步骤：

```
1. withRenderContext({ hydrationSnapshots: payload.async })
2. createHydrationCapture()
   context.hydrationCapture = capture
3. template(stage)          // mount 到一个离屏 DocumentFragment，不是 #app
   await context.flush()    // 异步组件从 snapshot 恢复，不再 fetch
4. 把 capture 清掉，避免泄漏到之后的普通渲染
5. hydrateTemplate(capture, template, root, stage)
      createNodeMap(stage 的子节点, #app)
      对得上 → WeakMap: 离屏节点 → 页面上的旧节点
      adoptCapturedChunk(...) 把绑定里握着的 Node 引用全部换掉
6. 对不上 → boundary 局部替换，或整根替换
```

这里有个和 React 很不一样的点，值得单独说清。

### 5.1 为什么要先画一棵离屏树？

Arrow **没有 VDOM**。绑定直接握着真实 `Node`：

- 文本更新改 `textNode.data`
- `@click` 的 listener 挂在具体 Element 上
- chunk 用 `ref.first / ref.last` 记住自己在文档里的起止节点

如果 hydrate 时对着 SSR 节点「盲绑」，core 还是会先按模具 `cloneNode` 出一份新 DOM，再 `replaceChild`。那就会把服务端节点换掉。

所以 Arrow 选择：

1. 允许这次绑定发生在离屏 `stage` 上（正常 `createBindings`）
2. 绑定过程中如果 `getHydrationCapture()` 非空，就把「以后怎么 remap」登记成 hook
3. 对比结束后，用 `NodeMap` 把 hook 闭包里的 `target`、listener、`ref.first` 全部改到页面上已有的节点

`getHydrationCapture()`（`packages/core/src/hydration.ts`）就是这个开关：

- 普通 `tpl(el)`：provider 没有，或当前 context 没有 capture → 返回 `null` → 当普通渲染
- `hydrate()` 期间：framework 装的 provider 读 `getRenderContext().hydrationCapture` → 返回这次的 capture → 绑定会登记 remap hook

core 因此不依赖 `@arrow-js/hydrate`。hydrate 是外挂会话，不是 core 的一条内建通道。

### 5.2 对节点时 `NodeMap` 在干什么

`packages/hydrate/src/reconcile.ts` 同步走两棵树：

```
离屏 stage:  div.main > button + p#name
页面 #app:   div.main > button + p#name
                 │         │
                 └─ map ───┘  同一个位置、同一标签 → reuse
```

对得上：`map.set(stageButton, liveButton)`。  
对不上：插入 / 删除 / 换成 stage 上的新节点，并记一次 mismatch。

`adoptCapturedChunk` 然后：

- chunk.ref.first/last 换成 live 节点
- 跑该 chunk 的 hydration hooks（把 event listener 从 stage 按钮挪到 live 按钮，watch 的 target 也换过去）
- 最后 `stage.textContent = ''`，离屏树丢掉

成功时，你在 DevTools 里看到的还是服务端那些节点对象（`===` 相同），只是它们现在能点、能更新了。

---

## 6. 服务端为什么能直接跑 core？

把依赖方向摊开：

```
@arrow-js/core
  只认 document / Node
  通过 installHydrationCaptureProvider 预留一个「可选会话」
  通过 installAsyncComponentInstaller 预留异步组件实现

@arrow-js/framework   （import 它就会 installFrameworkRuntime）
  装上 asyncComponent
  装上 hydrationCaptureProvider = () => getRenderContext()?.hydrationCapture
  提供 render / boundary / RenderContext
  提供 JSDOM 版 renderToString（放在 framework/ssr）

@arrow-js/ssr
  再 export framework 的 renderToString / serializePayload
  应用在 Node 里 import 这个包

@arrow-js/hydrate
  import framework/internal（确保 runtime 已安装）
  提供 hydrate / readPayload
  应用在浏览器里 import 这个包
```

因此：

- 纯客户端、只用 core：完全不碰 JSDOM、不碰 payload
- 服务端：import `@arrow-js/ssr` → 间接装上 framework → `renderToString` 可用
- 浏览器带 SSR：import `@arrow-js/hydrate` → 同一套组件树，走 hydrate 而不是 `tpl(root)`

`@arrow-js/compiler` **不参与 SSR**。Arrow 的 `html\`...\`` 是运行时解析（浏览器 HTML 解析器 / JSDOM 的解析器），没有 JSX → 字符串那种编译步。

---

## 7. 和 React SSR 对照（只为建立位置感）

| 问题 | React | Arrow |
|---|---|---|
| 服务端怎么得到 HTML？ | 走渲染栈拼字符串，没有真 DOM | JSDOM 里真 mount，再 `innerHTML` |
| 组件代码服务端/客户端是否同一套？ | 是（加上环境分支） | 是，而且连「造 DOM」的代码都是同一份 |
| 异步怎么等？ | `renderToPipeableStream` + Suspense，可以流式 | `flush()` 等全部完成，一次吐完整 HTML |
| 数据怎么到客户端？ | 你自己序列化，或 RSC payload | async 组件 snapshot 自动进 `payload.async` |
| 客户端怎么接 HTML？ | Fiber 边走边认领已有节点 | 先离屏再 mount，再 NodeMap remap |
| mismatch 怎么办？ | 子树客户端渲染；Suspense 可局部 | 先修 map，再 boundary 替换，再整根替换 |
| 有没有 SSR 编译器？ | JSX 编译是前提 | 没有；tagged template 运行时解析 |

Arrow 选择 JSDOM 的代价很明确：Node 上要扛一份浏览器实现，内存和 CPU 比「纯拼字符串」贵。换来的是：**不为 SSR 维护第二套渲染器**，hydrate 对比的也是「同一套绑定造出来的 DOM」，而不是另一套字符串模板。

---

## 8. 源码阅读顺序（按执行路径）

建议按这个顺序看，和运行时一致：

1. `packages/ssr/src/index.ts`  
   确认它只是 re-export。

2. `packages/framework/src/ssr.ts`  
   `renderToString`、`serializePayload`。整份 SSR 的外壳。

3. `packages/framework/src/dom.ts`  
   `withDomWindow`：假 `document` 怎么接到本次请求。

4. `packages/framework/src/render.ts`  
   `render` / `toTemplate`：mount + flush。

5. `packages/framework/src/context.ts`  
   `RenderContext`：pending、snapshot、boundary id、hydrationCapture。

6. `packages/framework/src/async.ts`  
   服务端 recordSnapshot、客户端 consumeSnapshot。

7. `packages/framework/src/boundary.ts`  
   那对 `<template>` 标记从哪来。

8. `packages/core/src/html.ts` 里的 `renderTemplate` / `createBindings`  
   假 DOM 上真正长出节点的地方。和客户端相同。

9. `packages/core/src/hydration.ts`  
   capture / hook / `adoptCapturedChunk`。core 为 hydrate 留的针孔。

10. `packages/hydrate/src/index.ts` + `reconcile.ts`  
    浏览器怎么认领 SSR HTML。

测试里有可运行的缩影：`packages/framework/src/render.spec.ts` 的 `framework ssr` / `framework hydrate` 两组。想看「async 内容会出现在 html 里」「boundary id 会进 payload」「hydrate 复用同一个 DOM 节点」，直接读这些用例最快。

---

## 9. 写 SSR 页面时容易踩的坑

1. **在工厂顶层用 `window` / `localStorage` / `document.querySelector`**  
   `renderToString` 期间这些要么不存在，要么是 JSDOM 的。需要浏览器 API 的逻辑放到事件处理、`watch` 的客户端分支，或 `typeof window !== 'undefined'` 之后。

2. **async 组件不包 `boundary()`**  
   SSR 能出 HTML，但 hydrate 一旦对不上，没有局部锚点，整块 root 可能被替换。

3. **snapshot 不能 JSON 化**  
   默认 `recordSnapshot` 会静默丢掉。客户端会重新跑 loader。Date、Map、class 实例都要自己 `serialize` / `deserialize`。

4. **服务端和客户端树形状不一致**  
   例如服务端 `if (isServer) html\`A\``、客户端 `html\`B\``。hydrate 会 mismatch。id 顺序也会乱，async snapshot 对不上。

5. **把 `tpl(root)` 当 hydrate 用**  
   客户端入口必须走 `hydrate(root, view, readPayload())`。直接 mount 会丢掉 SSR 节点。

6. **以为 `@click` 会出现在 HTML 里**  
   不会。HTML 只有结构、文本、属性。监听器是 hydrate 阶段挂上的。

7. **并发 SSR 自己去改 `global.document`**  
   不要绕过 `withDomWindow`。并发隔离靠的就是 ALS。

---

## 10. 收成一句

Arrow 的 SSR 是这条闭合回路：

```
同一份模板
  在 JSDOM 里按客户端方式 mount
  等异步结束
  抽出 innerHTML + async snapshot + boundary id
  放进页面
  浏览器再 mount 一棵离屏树
  用 NodeMap 把绑定搬到已有 DOM 上
```

没有第二套模板语言，没有 VDOM diff 出来的 HTML。  
**服务器借一个 DOM 实现来跑 core；浏览器借 payload 和 capture hook 来认领那次运行的结果。**
