/**
 * Arrow tagged-template renderer (no VDOM).
 *
 * Runtime pipeline:
 *   html`...`  → ArrowTemplate (recipe: strings + expressions)
 *   tpl(parent) → acquire Chunk (instance: cloned DOM + bindings)
 *   createBindings → wire attrs / text / children
 *   watch / createRenderFn → fine-grained updates + list patch
 *   unmount → recycle (stale pool) or destroy (object pool)
 *
 * Key ideas:
 * - Templates are parsed once via the browser HTML parser into a memoized
 *   ChunkProto (`<!--¤-->` marks expression slots).
 * - Expression values live in `expressionPool` (see expressions.ts), not in
 *   per-binding closures, so syncing a reused chunk is `writeExpressions`.
 * - Only function expressions are reactive; plain values bind once.
 * - List updates prefer same-shape sync, then keyed moves, then rebuild.
 */

import { watch } from './reactive'
import { isChunk, isArrowTemplate, swapCleanupCollector } from './common'
import { setAttr } from './dom'
import {
  adoptCapturedChunk,
  getHydrationCapture,
  registerHydrationHook,
} from './hydration'
import type { HydrationCapture, NodeMap } from './hydration'
import {
  createPropsProxy,
  isComponentCall,
} from './component'
import type { ComponentCall } from './component'
import {
  createExpressionBlock,
  expressionPool,
  onExpressionUpdate,
  releaseExpressions,
  writeExpressions,
} from './expressions'

// ---------------------------------------------------------------------------
// Public / internal types
// ---------------------------------------------------------------------------

/**
 * Callable template object returned by `html` / `svg`.
 *
 * Call signatures:
 * - `tpl(parent)` — mount into `parent`, return that parent
 * - `tpl()` — return a DocumentFragment of the rendered nodes
 */
export interface ArrowTemplate {
  (parent: ParentNode): ParentNode
  (): DocumentFragment
  /** Marker used by `isArrowTemplate()` — always true for templates. */
  isTemplate: boolean
  /** List reconciliation key (like React/Vue `:key`). */
  key: (key: ArrowTemplateKey) => ArrowTemplate
  /** Stable identity for stale-chunk reuse across remounts. */
  id: (id: ArrowTemplateId) => ArrowTemplate
  /** Ensure / return the Chunk instance bound to this template. */
  getChunk: () => Chunk
  /** Current list key value (set via `.key()`). */
  listKey: ArrowTemplateKey
  /** Current stable id value (set via `.id()`). */
  stableId?: ArrowTemplateId
}

export type ArrowTemplateKey = string | number | undefined
type ArrowTemplateId = string | number | undefined

/** Values a template expression / render slot may produce. */
export type ArrowRenderable =
  | string
  | number
  | boolean
  | null
  | undefined
  | ComponentCall
  | ArrowTemplate
  | Array<string | number | boolean | ComponentCall | ArrowTemplate>

/** Legacy reactive-expression shape (kept for typing compatibility; unused by current runtime). */
export interface ReactiveFunction {
  (el?: Node): ArrowRenderable
  $on: (observer: ArrowFunction | null) => ArrowFunction | null
  /** Replace the underlying expression. */
  update: (newExpression: ReactiveFunction) => void
  /** Current expression value / getter. */
  expression: ArrowExpression
  /** Whether this slot is treated as static (non-tracking). */
  isStatic: boolean
}

/** Legacy bag of reactive expression slots (unused by current runtime). */
export type ReactiveExpressions = {
  /** Cursor / write index into `expressions`. */
  index: number
  /** Reactive expression functions for each template slot. */
  expressions: ReactiveFunction[]
}

export interface ArrowFragment {
  <T extends ParentNode>(parent?: T): T extends undefined ? DocumentFragment : T
}

export type ParentNode = Node | DocumentFragment

export type RenderGroup =
  | ArrowTemplate
  | ArrowTemplate[]
  | Node
  | Node[]
  | string[]

export type ArrowFunction = (...args: unknown[]) => ArrowRenderable

/** Anything valid inside `${...}` of an `html` template. */
export type ArrowExpression =
  | ArrowRenderable
  | ArrowFunction
  | EventListener
  | ((evt: InputEvent) => void)

/**
 * One live instance of a template in the DOM.
 *
 * Relationship: ArrowTemplate (recipe) + mount → Chunk (product).
 * Many templates sharing the same static strings share one ChunkProto mold.
 */
export interface Chunk {
  /**
   * 绑定位置表：`[pathTape, attrNames]`。
   *
   * - `attrNames`：出现过的属性名列表（如 `"class"`、`"@click"`），供属性槽引用。
   * - `pathTape`：扁平数字带，按顺序编码每一个 `${}` 在克隆 DOM 里的位置。
   *
   * 每个绑定槽在 tape 上是一段变长记录：
   *   `[sharedDepth, remaining, childIndex × remaining, segment]`
   *
   * - `sharedDepth`：与上一个槽共用的祖先深度（可复用 `nodeStack`，少走几层）。
   * - `remaining`：还要再往下走几层。
   * - 随后 `remaining` 个数字：每层取 `childNodes[index]`。
   * - `segment`：`0` = 节点/文本槽（走 createNodeBinding）；
   *   `>0` = 属性槽，属性名是 `attrNames[segment - 1]`（走 createAttrBinding）。
   *
   * 由 createPaths 在解析模板时生成，createBindings 再按 tape 走到真实节点并接线。
   */
  paths: [number[], string[]]
  /** Cloned template content (may be empty after nodes move into the document). */
  dom: DocumentFragment
  /** First/last ChildNode of this chunk's span in the live tree. */
  ref: DOMRef
  /** Template currently bound to this chunk. */
  template: ArrowTemplate
  /** List key for keyed patching. */
  key?: ArrowTemplateKey
  /** Stable id for exact stale reuse. */
  stableId?: ArrowTemplateId
  /** Start index of this chunk's block in `expressionPool`. */
  expressionPointer: number
  /** Shape signature — must match to sync without remount. */
  signature: string
  /** True after `createBindings` has run. */
  isBound: boolean
  /**
   * Recyclable flag. False once the chunk hosts nested templates/components
   * (those need full destroy rather than stale reuse).
   */
  recyclable: boolean
  /** Currently sitting in the stale pool. */
  isStale: boolean
  /** Next chunk in a stale-by-signature linked list. */
  staleNext?: Chunk
  /** Event listener records `[element, eventName]` for cleanup. */
  eventRecords?: Array<[Element, string]> | null
  /** Stop/cleanup callbacks run on destroy. */
  cleanups?: Array<() => void> | null
  /** Component props/emit box when this chunk came from a component. */
  propsBox?: ReturnType<typeof createPropsProxy>[2]
  /** Transient mark used while patching lists to find stale items. */
  renderMark?: number
  /** Free-list link for the chunk object pool. */
  poolNext?: Chunk
}

/** Memoized parse result shared by all chunks of the same template shape. */
interface ChunkProto {
  readonly htmlTemplate: HTMLTemplateElement
  readonly paths: Chunk['paths']
  readonly signature: string
  readonly expressions: number
}

/** Span of sibling nodes belonging to one chunk (first / last). */
interface DOMRef {
  first: ChildNode | null
  last: ChildNode | null
}

/** Per-element store for `@event` bindings → expressionPool slot. */
const eventBindingsKey = Symbol()

interface EventBindingMeta {
  chunk: Chunk
  /** expressionPool index of the listener function */
  expressionPointer: number
}

interface EventBoundElement extends Element {
  [eventBindingsKey]?: Record<string, EventBindingMeta | undefined>
}

type Rendered = Chunk | Text
/** Closure that patches a dynamic child slot; `adopt` remaps nodes after hydrate. */
type RenderController = ((
  renderable: ArrowRenderable
) => DocumentFragment | Text | void) & {
  adopt: (map: NodeMap, visited: WeakSet<Chunk>) => void
}

/** ArrowTemplate plus runtime-only fields used inside this module. */
type InternalTemplate = ArrowTemplate & {
  /** Expression slot values from the tagged-template call. */
  expressionSlots?: ArrayLike<unknown>
  /** Currently attached chunk, if any. */
  boundChunk?: Chunk
  /** Mounted flag (`true` while this template owns a live chunk). */
  mounted?: boolean
  /** Cached ChunkProto for this template instance. */
  chunkProto?: ChunkProto
  /** Static string parts of the tagged template. */
  strings?: TemplateStringsArray | string[]
}

/** Head of a singly-linked stale list for one signature. */
interface StaleBucket {
  head?: Chunk
}

// ---------------------------------------------------------------------------
// Module state: binding walk stacks, delimiter, caches, pools
// ---------------------------------------------------------------------------

/** Scratch stacks reused while walking path tapes (avoids per-bind alloc). */
let bindingStackPos = -1
const bindingStack: Array<Node | number> = []
const nodeStack: Node[] = []

/** Expression placeholder inserted between static HTML string parts. */
const delimiter = '¤'
const delimiterComment = `<!--${delimiter}-->`
const initialChunkPoolSize = 1024

/** signature → ChunkProto, keyed by Document (jsdom / multi-realm safe). */
const chunkMemo = new WeakMap<Document, Record<string, ChunkProto>>()
/** Fast path: TemplateStringsArray identity → ChunkProto (no string join). */
const chunkMemoByRef = new WeakMap<
  ReadonlyArray<string>,
  WeakMap<Document, ChunkProto>
>()
/** Exact reuse by template `.id()`. */
const staleById = new Map<Exclude<ArrowTemplateId, undefined>, Chunk>()
/** Same-shape reuse by signature. */
const staleBySignature = new Map<string, StaleBucket>()
/** Object pool of blank Chunk shells. */
let chunkPoolHead: Chunk | undefined
/** Incrementing stamp for list patch "still in use" marks. */
let renderedMark = 0

growChunkPool(initialChunkPoolSize)

// ---------------------------------------------------------------------------
// DOM span helpers + ChunkProto resolution / chunk lifecycle
// ---------------------------------------------------------------------------

/** Move every node in `ref` (inclusive f→l) under `parent`, before `before`. */
function moveDOMRef(
  ref: DOMRef,
  parent: Node | null,
  before?: ChildNode | null
) {
  let node = ref.first
  if (!parent || !node) return
  const last = ref.last
  while (true) {
    const next: ChildNode | null =
      node === last ? null : (node.nextSibling as ChildNode | null)
    parent.insertBefore(node, before || null)
    if (!next) return
    node = next
  }
}

/** True when template and chunk share the same static HTML shape. */
function canSyncTemplateChunk(template: InternalTemplate, chunk: Chunk) {
  return chunk.signature === getChunkProto(template).signature
}

function getChunkProto(template: InternalTemplate): ChunkProto {
  const cached = template.chunkProto
  if (cached) return cached
  return (template.chunkProto = resolveChunkProto(template.strings as string[]))
}

/**
 * Parse static strings into a reusable ChunkProto.
 *
 * Steps: join with `<!--¤-->` → `template.innerHTML` → walk for paths →
 * replace placeholders with empty text nodes → memoize by strings ref + signature.
 */
function resolveChunkProto(
  rawStrings: TemplateStringsArray | string[],
  svg?: boolean
): ChunkProto {
  const doc = document

  /** signature → ChunkProto, keyed by Document (jsdom / multi-realm safe). */
  // const chunkMemo = new WeakMap<Document, Record<string, ChunkProto>>()

  /** Fast path: TemplateStringsArray identity → ChunkProto (no string join). */
  // const chunkMemoByRef = new WeakMap<
  //   ReadonlyArray<string>,
  //   WeakMap<Document, ChunkProto>
  // >()

  let memoByRef = svg ? undefined : chunkMemoByRef.get(rawStrings)
  const cachedByRef = memoByRef?.get(doc)
  if (cachedByRef) return cachedByRef

  const signature = rawStrings.join(delimiterComment)
  const cacheKey = svg ? `${delimiter}${signature}` : signature
  let signatureMemo = chunkMemo.get(doc)
  if (!signatureMemo) {
    signatureMemo = {}
    chunkMemo.set(doc, signatureMemo)
  }
  const cached = signatureMemo[cacheKey]
  if (cached) {
    if (!svg) {
      memoByRef ??= new WeakMap<Document, ChunkProto>()
      memoByRef.set(doc, cached)
      chunkMemoByRef.set(rawStrings, memoByRef)
    }
    return cached
  }

  const template = document.createElement('template')
  if (svg) {
    // Force SVG namespace, then unwrap so proto content is the inner nodes.
    template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg">${signature}</svg>`
    const root = template.content.firstChild as SVGElement | null
    if (root) {
      const content = template.content
      while (root.firstChild) content.appendChild(root.firstChild)
      content.removeChild(root)
    }
  } else {
    template.innerHTML = signature
  }
  const paths = createPaths(template.content)
  normalizeNodePlaceholders(template.content)
  const expressions = rawStrings.length - 1
  // Count path-tape records; each must correspond to one `${}` slot.
  let count = 0
  for (let i = 0; i < paths[0].length;) {
    i += (paths[0][i + 1] ?? 0) + 3
    count++
  }
  if (count !== expressions) {
    // e.g. expression landed in an illegal HTML position after parsing.
    throw Error('Invalid HTML position')
  }
  const created = {
    htmlTemplate: template,
    paths,
    signature: cacheKey,
    expressions,
  }
  if (!svg) {
    memoByRef ??= new WeakMap<Document, ChunkProto>()
    memoByRef.set(doc, created)
    chunkMemoByRef.set(rawStrings, memoByRef)
  }
  signatureMemo[cacheKey] = created
  return created
}

/**
 * Point `chunk` at `template` and push expression values into the pool.
 * Same-shape reuse updates in place without rebuilding DOM bindings.
 */
function syncTemplateToChunk(
  template: InternalTemplate,
  chunk: Chunk,
  mounted = false 
) {
  if (chunk.template === template) {
    chunk.key = template.listKey
    chunk.stableId = template.stableId
    template.boundChunk = chunk
    template.mounted = mounted
    return
  }
  // Detach previous template ownership if this chunk is being reassigned.
  if (chunk.template && chunk.template !== template) {
    const current = chunk.template as InternalTemplate
    if (current.boundChunk === chunk) {
      current.mounted = false
      current.boundChunk = undefined
    }
  }
  chunk.template = template
  chunk.key = template.listKey
  chunk.stableId = template.stableId
  template.boundChunk = chunk
  template.mounted = mounted
  writeExpressions(template.expressionSlots!, chunk.expressionPointer)
}

/** Clear template↔chunk ownership when unmounting / recycling. */
function releaseTemplate(chunk: Chunk) {
  const template = chunk.template as InternalTemplate
  if (template.boundChunk === chunk) {
    template.mounted = false
    template.boundChunk = undefined
  }
}

/** Preallocate blank Chunk shells linked via `poolNext` onto `chunkPoolHead`. */
function growChunkPool(size: number) {
  let head: Chunk | undefined
  let tail: Chunk | undefined
  for (let i = 0; i < size; i++) {
    const chunk = {
      paths: [[], []],
      dom: null as unknown as DocumentFragment,
      ref: { first: null, last: null },
      template: null as unknown as ArrowTemplate,
      expressionPointer: -1,
      signature: '',
      isBound: false,
      recyclable: true,
      isStale: false,
      cleanups: null,
      eventRecords: null,
      propsBox: undefined,
      key: undefined,
      stableId: undefined,
      staleNext: undefined,
      poolNext: undefined,
    } as Chunk
    if (tail) tail.poolNext = chunk
    else head = chunk
    tail = chunk
  }
  if (tail) tail.poolNext = chunkPoolHead
  chunkPoolHead = head
}

/** Return a destroyed chunk shell to the free list. */
function freeChunk(chunk: Chunk) {
  chunk.poolNext = chunkPoolHead
  chunkPoolHead = chunk
}

/** Fill a pooled shell from proto: clone DOM, alloc expressions, bind template. */
function configureChunk(
  chunk: Chunk,
  proto: ChunkProto,
  template: InternalTemplate
) {
  chunk.paths = proto.paths
  chunk.signature = proto.signature
  chunk.dom = proto.htmlTemplate.content.cloneNode(true) as DocumentFragment
  chunk.ref.first = chunk.dom.firstChild as ChildNode | null
  chunk.ref.last = chunk.dom.lastChild as ChildNode | null
  chunk.expressionPointer = createExpressionBlock(proto.expressions)
  chunk.isBound = chunk.isStale = false
  chunk.recyclable = true
  chunk.cleanups = chunk.eventRecords = null
  chunk.propsBox = chunk.staleNext = undefined
  syncTemplateToChunk(template, chunk)
}

/**
 * Obtain a Chunk for `template`, preferring:
 * 1) exact stale hit by `.id()`
 * 2) same-shape stale hit by signature
 * 3) fresh configure from the object pool
 */
function acquireChunk(template: InternalTemplate): Chunk {
  const proto = getChunkProto(template)
  /** Exact reuse by template `.id()`. */
  // const staleById = new Map<Exclude<ArrowTemplateId, undefined>, Chunk>()
  const exact = staleById.get(template.stableId as Exclude<ArrowTemplateId, undefined>)
  if (exact) {
    if (exact.signature !== proto.signature) throw Error('shape mismatch')
    if (exact.recyclable) {
      removeStaleChunk(exact)
      syncTemplateToChunk(template, exact)
      return exact
    }
  }

  /** Same-shape reuse by signature. */
  // const staleBySignature = new Map<string, StaleBucket>()
  const bucket = staleBySignature.get(proto.signature)
  const reused = bucket?.head
  if (reused) {
    removeStaleChunk(reused)
    syncTemplateToChunk(template, reused)
    return reused
  }

  /** Object pool of blank Chunk shells. */
  // let chunkPoolHead: Chunk | undefined
  if (!chunkPoolHead) growChunkPool(initialChunkPoolSize)
  const chunk = chunkPoolHead!
  chunkPoolHead = chunk.poolNext
  chunk.poolNext = undefined
  configureChunk(chunk, proto, template)
  return chunk
}

/** Unlink `chunk` from staleBySignature / staleById. */
function removeStaleChunk(chunk: Chunk) {
  if (!chunk.isStale) return
  const bucket = staleBySignature.get(chunk.signature)
  if (bucket) {
    let previous: Chunk | undefined
    let current = bucket.head
    while (current && current !== chunk) {
      previous = current
      current = current.staleNext
    }
    if (current) {
      if (previous) previous.staleNext = current.staleNext
      else bucket.head = current.staleNext
      if (!bucket.head) staleBySignature.delete(chunk.signature)
    }
  }
  if (chunk.stableId !== undefined && staleById.get(chunk.stableId) === chunk) {
    staleById.delete(chunk.stableId)
  }
  chunk.isStale = false
  chunk.staleNext = undefined
}

/**
 * Shared listener for all `@event` bindings on an element.
 * Looks up the current handler in expressionPool so updates don't re-addEventListener.
 */
function dispatchChunkEvent(this: Element, evt: Event) {
  const binding = (this as EventBoundElement)[eventBindingsKey]?.[evt.type]
  if (!binding) return
  const chunk = binding.chunk
  // Ignore events after the owning template was unmounted.
  if (!(chunk.template as InternalTemplate).mounted) return
  ;(expressionPool[binding.expressionPointer] as CallableFunction | undefined)?.(evt)
}

function getRenderableKey(
  renderable: ComponentCall | ArrowTemplate
): Exclude<ArrowTemplateKey, undefined> | undefined {
  return (isComponentCall(renderable)
    ? renderable.listKey
    : (renderable as InternalTemplate).listKey) as
    | Exclude<ArrowTemplateKey, undefined>
    | undefined
}

// ---------------------------------------------------------------------------
// Public API: html / svg
// ---------------------------------------------------------------------------

/**
 * Tagged template that builds an ArrowTemplate (does not mount yet).
 *
 * @example
 * html`<button @click="${() => n++}">${() => n}</button>`(document.body)
 */
export function html(
  strings: TemplateStringsArray | string[],
  ...expSlots: ArrowExpression[]
): ArrowTemplate
export function html(
  strings: TemplateStringsArray | string[],
  ...expSlots: ArrowExpression[]
): ArrowTemplate {
  // Callable object: tpl(parent?) → renderTemplate(...)
  const template = ((el?: ParentNode) =>
    renderTemplate(template as InternalTemplate, el)) as InternalTemplate
  template.isTemplate = true
  template.expressionSlots = expSlots
  template.getChunk = ensureChunk
  template.mounted = false
  template.strings = strings
  template.key = setTemplateKey
  template.id = setTemplateId
  return template
}

/** Like `html`, but parses content in the SVG namespace. */
export function svg(
  strings: TemplateStringsArray | string[],
  ...expSlots: ArrowExpression[]
): ArrowTemplate
export function svg(
  strings: TemplateStringsArray | string[],
  ...expSlots: ArrowExpression[]
): ArrowTemplate {
  const template = html(strings, ...expSlots) as InternalTemplate
  template.chunkProto = resolveChunkProto(strings, true)
  return template
}

function ensureChunk(this: InternalTemplate) {
  let chunk = this.boundChunk
  if (!chunk) {
    chunk = acquireChunk(this)
    this.boundChunk = chunk
  }
  return chunk
}

function setTemplateKey(this: InternalTemplate, key: ArrowTemplateKey) {
  this.listKey = key
  if (this.boundChunk) this.boundChunk.key = key
  return this
}

function setTemplateId(this: InternalTemplate, id: ArrowTemplateId) {
  this.stableId = id
  if (this.boundChunk) this.boundChunk.stableId = id
  return this
}

/**
 * Mount / remount entry used by `tpl(el?)`.
 *
 * - First mount, unbound: createBindings
 * - First mount, recycled (already bound): just move DOM into place
 * - Already mounted: move nodes back into chunk.dom then optionally re-append
 */
function renderTemplate(template: InternalTemplate, el?: ParentNode) {
  const chunk = template.getChunk()
  if (!template.mounted) {
    template.mounted = true
    if (!chunk.isBound) {
      return createBindings(chunk, el)
    }
    // Stale reuse: bindings already exist; only place the DOM span.
    moveDOMRef(chunk.ref, el ?? chunk.dom)
    return el ?? chunk.dom
  }
  moveDOMRef(chunk.ref, chunk.dom)
  return el ? el.appendChild(chunk.dom) : chunk.dom
}

// ---------------------------------------------------------------------------
// First-time bindings: walk path tape → node / attr slots
// ---------------------------------------------------------------------------

/**
 * Resolve every expression slot against the cloned DOM and optionally append
 * the fragment to `el`. Marks `chunk.isBound = true`.
 */
function createBindings(
  chunk: Chunk,
  el?: ParentNode
): ParentNode | DocumentFragment {
  const expressionPointer = chunk.expressionPointer
  const totalPaths = expressionPool[expressionPointer] as number
  const [pathTape, attrNames] = chunk.paths
  const stackStart = bindingStackPos + 1
  let tapePos = 0
  nodeStack[0] = chunk.dom
  // Pass 1: decode path tape into (node, segment) pairs on bindingStack.
  for (let i = 0; i < totalPaths; i++) {
    const sharedDepth = pathTape[tapePos++]
    let remaining = pathTape[tapePos++]
    let depth = sharedDepth
    let node = nodeStack[depth] as Node
    while (remaining--) {
      node = node.childNodes[pathTape[tapePos++]] as Node
      nodeStack[++depth] = node
    }
    bindingStack[++bindingStackPos] = node
    bindingStack[++bindingStackPos] = pathTape[tapePos++]
  }
  const stackEnd = bindingStackPos
  // Pass 2: wire each slot; expressionPool[e] holds the value for that slot.
  for (let s = stackStart, e = expressionPointer + 1; s < stackEnd; s++, e++) {
    const node = bindingStack[s] as ChildNode
    const segment = bindingStack[++s] as number
    if (segment) createAttrBinding(node, attrNames[segment - 1], e, chunk)
    else createNodeBinding(node, e, chunk)
  }
  bindingStack.length = stackStart
  bindingStackPos = stackStart - 1
  chunk.isBound = true
  return el ? el.appendChild(chunk.dom) && el : chunk.dom
}

/**
 * Bind a child/text slot.
 *
 * - Static value → Text + expression observer
 * - Function → watch(); text or upgrade to createRenderFn for trees/lists
 * - Template / component / array → createRenderFn immediately
 */
function createNodeBinding(
  node: ChildNode,
  expressionPointer: number,
  parentChunk: Chunk
) {
  let fragment: DocumentFragment | Text
  const expression = expressionPool[expressionPointer]
  const capture = getHydrationCapture()
  const textNode = node.nodeType === 3 ? (node as Text) : null

  if (isComponentCall(expression) || isArrowTemplate(expression) || Array.isArray(expression)) {
    parentChunk.recyclable = false // nested trees are not stale-recyclable
    const render = createRenderFn(capture)
    fragment = render(expression)!
    if (capture) {
      registerHydrationHook(parentChunk, (map, visited) => {
        render.adopt(map, visited)
      })
    }
  } else if (typeof expression === 'function') {
    let target: Text | null = textNode
    let render: RenderController | null = null
    const [frag, stop] = watch(expressionPointer, (value) => {
      if (!render) {
        // First non-text result upgrades this slot to a full render controller.
        if (isComponentCall(value) || isArrowTemplate(value) || Array.isArray(value)) {
          parentChunk.recyclable = false
          render = createRenderFn(capture)
          const next = render(value)!
          if (target) {
            target.parentNode?.replaceChild(next, target)
            target = null
          }
          return next
        }
        if (!target) target = document.createTextNode('')
        const next = renderText(value)
        if (target.nodeValue !== next) target.nodeValue = next
        return target
      }
      return render(value)
    })
    ;(parentChunk.cleanups ??= []).push(stop)
    fragment = frag!
    if (capture) {
      registerHydrationHook(parentChunk, (map, visited) => {
        if (target) {
          const adopted = map.get(target)
          if (adopted) target = adopted as Text
        }
        render?.adopt(map, visited)
      })
    }
  } else {
    let target = textNode ?? document.createTextNode('')
    target.data = renderText(expression)
    fragment = target
    if (capture) {
      onExpressionUpdate(
        expressionPointer,
        (value: string) => (target.data = renderText(value))
      )
      registerHydrationHook(parentChunk, (map) => {
        const adopted = map.get(target)
        if (adopted) target = adopted as Text
      })
    } else {
      onExpressionUpdate(expressionPointer, target)
    }
  }

  // If we replaced the chunk's boundary placeholder, keep ref.first / ref.last accurate.
  if (node === parentChunk.ref.first || node === parentChunk.ref.last) {
    const last =
      fragment.nodeType === 11
        ? (fragment.lastChild as ChildNode | null)
        : (fragment as ChildNode)
    if (node === parentChunk.ref.first) {
      parentChunk.ref.first =
        fragment.nodeType === 11
          ? (fragment.firstChild as ChildNode | null)
          : (fragment as ChildNode)
    }
    if (node === parentChunk.ref.last) parentChunk.ref.last = last
  }

  if (fragment !== node) node.parentNode?.replaceChild(fragment, node)
}

/**
 * Bind an attribute or `@event` on an element.
 * Events use one shared listener; the live handler is always read from the pool.
 */
function createAttrBinding(
  node: ChildNode,
  attrName: string,
  expressionPointer: number,
  parentChunk: Chunk
) {
  if (node.nodeType !== 1) return
  let target = node as Element
  const expression = expressionPool[expressionPointer]
  const capture = getHydrationCapture()

  if (attrName[0] === '@') {
    const event = attrName.slice(1)
    const bindings = ((target as EventBoundElement)[eventBindingsKey] ??= {})
    bindings[event] = { chunk: parentChunk, expressionPointer }
    const record: [Element, string] = [target, event]
    target.addEventListener(event, dispatchChunkEvent)
    target.removeAttribute(attrName)
    ;(parentChunk.eventRecords ??= []).push(record)
    if (capture) {
      // After hydrate: move listener from staged node onto the live DOM node.
      registerHydrationHook(parentChunk, (map) => {
        const adopted = map.get(target)
        if (!adopted) return
        const previousTarget = target as EventBoundElement
        const previousBindings = previousTarget[eventBindingsKey]
        if (previousBindings) {
          delete previousBindings[event]
          let hasBindings = false
          for (const _bindingName in previousBindings) {
            hasBindings = true
            break
          }
          if (!hasBindings) delete previousTarget[eventBindingsKey]
        }
        target.removeEventListener(event, dispatchChunkEvent)
        target = adopted as Element
        record[0] = target
        const nextBindings = ((target as EventBoundElement)[eventBindingsKey] ??= {})
        nextBindings[event] = { chunk: parentChunk, expressionPointer }
        target.addEventListener(event, dispatchChunkEvent)
        target.removeAttribute(attrName)
      })
    }
  } else if (typeof expression === 'function' && !isArrowTemplate(expression)) {
    const [, stop] = watch(expressionPointer, (value) =>
      setAttr(target, attrName, value as string)
    )
    ;(parentChunk.cleanups ??= []).push(stop)
    if (capture) {
      registerHydrationHook(parentChunk, (map) => {
        const adopted = map.get(target)
        if (adopted) target = adopted as Element
      })
    }
  } else {
    setAttr(target, attrName, expression as string | number | boolean | null)
    if (capture) {
      onExpressionUpdate(expressionPointer, (value: string) =>
        setAttr(target, attrName, value)
      )
    } else {
      onExpressionUpdate(expressionPointer, target, attrName)
    }
  }
}

// ---------------------------------------------------------------------------
// Dynamic child updates: createRenderFn (patch / keyed list / components)
// ---------------------------------------------------------------------------

/**
 * Stateful updater for one dynamic child expression.
 * Keeps `previous` (Chunk | Text | Rendered[]) and a key→chunk map for reuse.
 */
function createRenderFn(capture: HydrationCapture | null): RenderController {
  let previous: Chunk | Text | Rendered[]
  let keyedChunks = Object.create(null) as Record<
    Exclude<ArrowTemplateKey, undefined>,
    Chunk
  >

  const render = function render(
    renderable: ArrowRenderable
  ): DocumentFragment | Text | void {
    // ---- First render ----------------------------------------------------
    if (!previous) {
      if (isComponentCall(renderable)) {
        const [fragment, chunk] = renderComponent(renderable)
        previous = mountChunkFragment(fragment, chunk)
        return fragment
      }
      if (isArrowTemplate(renderable)) {
        const fragment = renderable()
        previous = mountChunkFragment(fragment, (renderable as InternalTemplate).boundChunk!)
        return fragment
      }
      if (Array.isArray(renderable)) {
        const [fragment, rendered] = renderList(renderable)
        previous = rendered
        return fragment
      }
      return (previous = document.createTextNode(renderText(renderable)))
    }

    // ---- Subsequent updates ----------------------------------------------
    if (Array.isArray(renderable)) {
      if (!Array.isArray(previous)) {
        // Scalar/tree → list: insert list after old node, then unmount old.
        const [fragment, nextList] = renderList(renderable)
        getNode(previous).after(fragment)
        forgetChunk(previous)
        unmount(previous)
        previous = nextList
      } else {
        let i = 0
        const renderableLength = renderable.length
        const previousLength = previous.length
        // Empty-list placeholder (blank text) → real list.
        if (
          renderableLength &&
          previousLength === 1 &&
          !isChunk(previous[0]) &&
          !(previous[0] as Text).data
        ) {
          const [fragment, rendered] = renderList(renderable)
          ;(previous[0] as Text).replaceWith(fragment)
          previous = rendered
          return
        }
        // Equal length, no keys: try index-aligned sync / patch.
        if (renderableLength === previousLength) {
          const renderedList = new Array(renderableLength) as Rendered[]
          for (; i < renderableLength; i++) {
            const item = renderable[i] as
              | string
              | number
              | boolean
              | ComponentCall
              | ArrowTemplate
            if ((isComponentCall(item) && item.listKey !== undefined) || (isArrowTemplate(item) && item.listKey !== undefined)) {
              i = -1 // bail to keyed path
              break
            }
            const prev = previous[i]
            if (
              isArrowTemplate(item) &&
              isChunk(prev) &&
              prev.template === item &&
              (item as InternalTemplate).boundChunk === prev &&
              (item as InternalTemplate).mounted
            ) {
              renderedList[i] = prev
              continue
            }
            if (isArrowTemplate(item) && isChunk(prev)) {
              const template = item as InternalTemplate
              const proto = template.chunkProto ?? getChunkProto(template)
              if (prev.signature === proto.signature) {
                syncTemplateToChunk(template, prev, true)
                renderedList[i] = prev
                continue
              }
            }
            renderedList[i] = patch(item, prev) as Rendered
          }
          if (i === renderableLength) {
            previous = renderedList
            return
          }
          i = 0
        }
        // Keyed reconciliation (two-ended scan + middle moves).
        const keyedList = patchKeyedList(renderable, previous)
        if (keyedList) {
          previous = keyedList
          return
        }
        if (renderableLength > previousLength && previousLength) {
          // Fast path: prefix unchanged, only append new tail items.
          for (; i < previousLength; i++) {
            const item = renderable[i] as ArrowTemplate
            const prev = previous[i]
            if (
              isArrowTemplate(item) &&
              isChunk(prev) &&
              prev.template === item &&
              (item as InternalTemplate).boundChunk === prev &&
              (item as InternalTemplate).mounted
            ) {
              continue
            }
            i = -1
            break
          }
          if (i === previousLength) {
            const fragment = document.createDocumentFragment()
            const renderedList = previous.slice() as Rendered[]
            for (i = previousLength; i < renderableLength; i++) {
              renderedList[i] = mountItem(renderable[i], fragment)
            }
            getNode(previous[previousLength - 1]).after(fragment)
            previous = renderedList
            return
          }
          i = 0
        }
        // Generic path: patch/mount each index, mark survivors, unmount the rest.
        let anchor: ChildNode | undefined
        const renderedList: Rendered[] = []
        const mark = ++renderedMark
        const updaterFrag =
          renderableLength > previousLength
            ? document.createDocumentFragment()
            : null
        for (; i < renderableLength; i++) {
          let item:
            | string
            | number
            | boolean
            | ComponentCall
            | ArrowTemplate = renderable[i] as ArrowTemplate
          const prev = previous[i]
          let key: ArrowTemplateKey
          if (
            isArrowTemplate(item) &&
            (key = item.listKey) !== undefined &&
            key in keyedChunks
          ) {
            const keyedChunk = keyedChunks[key]
            if (canSyncTemplateChunk(item as InternalTemplate, keyedChunk)) {
              syncTemplateToChunk(item as InternalTemplate, keyedChunk, true)
              item = keyedChunk.template
            }
          }
          if (i > previousLength - 1) {
            renderedList[i] = mountItem(item, updaterFrag!)
            continue
          }
          if (
            isArrowTemplate(item) &&
            isChunk(prev) &&
            prev.template === item &&
            (item as InternalTemplate).boundChunk === prev &&
            (item as InternalTemplate).mounted
          ) {
            anchor = getNode(prev)
            renderedList[i] = prev
            ;(prev as Rendered & { renderMark?: number }).renderMark = mark
            continue
          }
          const used = patch(item, prev, anchor) as Rendered
          anchor = getNode(used)
          renderedList[i] = used
          ;(used as Rendered & { renderMark?: number }).renderMark = mark
        }
        if (!renderableLength) {
          // List cleared → leave a blank text placeholder so the slot stays addressable.
          const placeholder = (renderedList[0] = document.createTextNode(''))
          const sync = canSyncUnmount(previous)
          const detached = sync && replaceListWithPlaceholder(previous, placeholder)
          if (!detached) getNode(previous).after(placeholder)
          keyedChunks = Object.create(null)
          if (sync) removeUnmounted(previous, detached)
          else unmount(previous)
          previous = renderedList
          return
        } else if (renderableLength > previousLength) {
          anchor?.after(updaterFrag!)
        }
        for (i = 0; i < previousLength; i++) {
          const stale = previous[i]
          if ((stale as Rendered & { renderMark?: number }).renderMark === mark) continue
          forgetChunk(stale)
          unmount(stale)
        }
        previous = renderedList
      }
    } else {
      // Non-array update: patch single previous value.
      if (Array.isArray(previous)) keyedChunks = Object.create(null)
      previous = patch(renderable, previous)
    }
  } as RenderController

  render.adopt = capture
    ? (map: NodeMap, visited: WeakSet<Chunk>) => {
        previous = adoptRenderedValue(previous, capture, map, visited) as
          | Chunk
          | Text
          | Rendered[]
      }
    : () => {}

  function renderList(
    renderable: Array<string | number | boolean | ComponentCall | ArrowTemplate>,
  ): [DocumentFragment, Rendered[]] {
    const fragment = document.createDocumentFragment()
    if (!renderable.length) {
      const placeholder = document.createTextNode('')
      fragment.appendChild(placeholder)
      return [fragment, [placeholder]]
    }
    const renderedItems: Rendered[] = new Array(renderable.length)
    for (let i = 0; i < renderable.length; i++) {
      renderedItems[i] = mountItem(renderable[i], fragment)
    }
    return [fragment, renderedItems]
  }

  /** Reuse a component chunk if the factory matches; refresh props/events. */
  function syncComponentChunk(renderable: ComponentCall, chunk: Chunk) {
    if (chunk.propsBox?.factory !== renderable.factory) return false
    if (chunk.propsBox.props !== renderable.props) chunk.propsBox.props = renderable.props
    if (chunk.propsBox.events !== renderable.events) chunk.propsBox.events = renderable.events
    return true
  }

  function syncKeyedRenderable(
    renderable: ComponentCall | ArrowTemplate,
    chunk: Chunk
  ) {
    if (isComponentCall(renderable)) return syncComponentChunk(renderable, chunk)
    if (!canSyncTemplateChunk(renderable as InternalTemplate, chunk)) return false
    syncTemplateToChunk(renderable as InternalTemplate, chunk, true)
    return true
  }

  function moveChunkIntoPlace(
    chunk: Chunk,
    prev: Chunk | Text | Rendered[],
    anchor?: ChildNode
  ) {
    if (anchor) {
      moveDOMRef(chunk.ref, anchor.parentNode, anchor.nextSibling)
      return
    }
    const target = getNode(prev, undefined, true)
    moveDOMRef(chunk.ref, target.parentNode, target)
  }

  /**
   * Keyed list diff. Returns null when the list is not fully keyed / syncable,
   * so the caller falls back to the generic path.
   *
   * Algorithm sketch (similar to Vue keyed):
   * 1) shared prefix (same keys in order)
   * 2) two-pointer ends (head/head, tail/tail, cross swaps)
   * 3) middle: map by key, move / mount / unmount
   */
  function patchKeyedList(
    renderable: Array<string | number | boolean | ComponentCall | ArrowTemplate>,
    previousList: Rendered[]
  ): Rendered[] | null {
    const renderableLength = renderable.length
    const previousLength = previousList.length
    if (!renderableLength) {
      const placeholder = document.createTextNode('')
      const sync = canSyncUnmount(previousList)
      const detached =
        sync && replaceListWithPlaceholder(previousList, placeholder)
      if (!detached) getNode(previousList).after(placeholder)
      keyedChunks = Object.create(null)
      if (sync) removeUnmounted(previousList, detached)
      else unmount(previousList)
      return [placeholder]
    }

    const renderedList = new Array(renderableLength) as Rendered[]
    const parent = getNode(previousList[0]).parentNode
    if (!parent) return null

    let sharedPrefix = 0
    const sharedPrefixKeys = Object.create(null) as Record<
      Exclude<ArrowTemplateKey, undefined>,
      1
    >
    // Walk common head while keys match and chunks can sync.
    for (; sharedPrefix < previousLength && sharedPrefix < renderableLength; sharedPrefix++) {
      const rendered = previousList[sharedPrefix]
      if (!isChunk(rendered) || rendered.key === undefined) return null
      const item = renderable[sharedPrefix]
      if (!isComponentCall(item) && !isArrowTemplate(item)) return null
      const key = getRenderableKey(item)
      if (key === undefined || key !== rendered.key) break
      sharedPrefixKeys[key] = 1
      if (
        !(
          isArrowTemplate(item) &&
          rendered.template === item &&
          (item as InternalTemplate).boundChunk === rendered &&
          (item as InternalTemplate).mounted
        ) &&
        !syncKeyedRenderable(item, rendered)
      ) {
        return null
      }
      renderedList[sharedPrefix] = rendered
    }
    if (sharedPrefix === previousLength) {
      if (sharedPrefix === renderableLength) return renderedList
      const fragment = document.createDocumentFragment()
      for (let i = sharedPrefix; i < renderableLength; i++) {
        const item = renderable[i]
        if (!isComponentCall(item) && !isArrowTemplate(item)) return null
        const key = getRenderableKey(item)
        if (key === undefined || key in sharedPrefixKeys) return null
        sharedPrefixKeys[key] = 1
        renderedList[i] = mountItem(item, fragment)
      }
      parent.insertBefore(
        fragment,
        previousLength
          ? (getNode(previousList[previousLength - 1]).nextSibling as ChildNode | null)
          : null
      )
      return renderedList
    }
    if (sharedPrefix === renderableLength) {
      for (let i = sharedPrefix; i < previousLength; i++) {
        const stale = previousList[i]
        forgetChunk(stale)
        unmount(stale)
      }
      return renderedList
    }

    let oldStart = sharedPrefix
    let newStart = sharedPrefix
    let oldEnd = previousLength - 1
    let newEnd = renderableLength - 1

    // Two-ended scan: match heads, tails, or rotate ends into place.
    while (oldStart <= oldEnd && newStart <= newEnd) {
      const startChunk = previousList[oldStart] as Chunk
      const endChunk = previousList[oldEnd] as Chunk
      const startKey = startChunk.key as Exclude<ArrowTemplateKey, undefined>
      const endKey = endChunk.key as Exclude<ArrowTemplateKey, undefined>
      const nextStart = renderable[newStart]
      const nextEnd = renderable[newEnd]
      const nextStartKey =
        isComponentCall(nextStart) || isArrowTemplate(nextStart)
          ? getRenderableKey(nextStart)
          : undefined
      const nextEndKey =
        isComponentCall(nextEnd) || isArrowTemplate(nextEnd) ? getRenderableKey(nextEnd) : undefined
      if (nextStartKey === undefined || nextEndKey === undefined) return null

      if (startKey === nextStartKey) {
        if (
          !(
            isArrowTemplate(nextStart) &&
            startChunk.template === nextStart &&
            (nextStart as InternalTemplate).boundChunk === startChunk &&
            (nextStart as InternalTemplate).mounted
          ) &&
          !syncKeyedRenderable(nextStart as ComponentCall | ArrowTemplate, startChunk)
        ) {
          return null
        }
        renderedList[newStart++] = startChunk
        oldStart++
        continue
      }
      if (endKey === nextEndKey) {
        if (
          !(
            isArrowTemplate(nextEnd) &&
            endChunk.template === nextEnd &&
            (nextEnd as InternalTemplate).boundChunk === endChunk &&
            (nextEnd as InternalTemplate).mounted
          ) &&
          !syncKeyedRenderable(nextEnd as ComponentCall | ArrowTemplate, endChunk)
        ) {
          return null
        }
        renderedList[newEnd--] = endChunk
        oldEnd--
        continue
      }
      if (startKey === nextEndKey) {
        if (
          !(
            isArrowTemplate(nextEnd) &&
            startChunk.template === nextEnd &&
            (nextEnd as InternalTemplate).boundChunk === startChunk &&
            (nextEnd as InternalTemplate).mounted
          ) &&
          !syncKeyedRenderable(nextEnd as ComponentCall | ArrowTemplate, startChunk)
        ) {
          return null
        }
        moveDOMRef(
          startChunk.ref,
          parent,
          getNode(endChunk).nextSibling as ChildNode | null
        )
        renderedList[newEnd--] = startChunk
        oldStart++
        continue
      }
      if (endKey === nextStartKey) {
        if (
          !(
            isArrowTemplate(nextStart) &&
            endChunk.template === nextStart &&
            (nextStart as InternalTemplate).boundChunk === endChunk &&
            (nextStart as InternalTemplate).mounted
          ) &&
          !syncKeyedRenderable(nextStart as ComponentCall | ArrowTemplate, endChunk)
        ) {
          return null
        }
        moveDOMRef(endChunk.ref, parent, getNode(startChunk, undefined, true))
        renderedList[newStart++] = endChunk
        oldEnd--
        continue
      }
      break
    }

    if (newStart > newEnd) {
      // New list exhausted → remaining old items are stale.
      for (let i = oldStart; i <= oldEnd; i++) {
        const stale = previousList[i]
        forgetChunk(stale)
        unmount(stale)
      }
      return renderedList
    }

    if (oldStart > oldEnd) {
      // Old list exhausted → mount remaining new items before the next sibling.
      const fragment = document.createDocumentFragment()
      for (let i = newStart; i <= newEnd; i++) {
        const item = renderable[i]
        if (!isComponentCall(item) && !isArrowTemplate(item)) return null
        renderedList[i] = mountItem(item, fragment)
      }
      parent.insertBefore(
        fragment,
        newEnd + 1 < renderableLength
          ? getNode(renderedList[newEnd + 1], undefined, true)
          : null
      )
      return renderedList
    }

    // Middle segment: index old/new by key (store i+1 so 0 stays "missing").
    const previousIndexByKey = Object.create(null) as Record<
      Exclude<ArrowTemplateKey, undefined>,
      number
    >
    for (let i = oldStart; i <= oldEnd; i++) {
      const rendered = previousList[i]
      if (!isChunk(rendered) || rendered.key === undefined) return null
      const key = rendered.key as Exclude<ArrowTemplateKey, undefined>
      if (key in previousIndexByKey) return null
      previousIndexByKey[key] = i + 1
    }

    const middleIndexByKey = Object.create(null) as Record<
      Exclude<ArrowTemplateKey, undefined>,
      number
    >
    let overlaps = 0
    for (let i = newStart; i <= newEnd; i++) {
      const item = renderable[i]
      const key =
        isComponentCall(item) || isArrowTemplate(item) ? getRenderableKey(item) : undefined
      if (key === undefined || key in middleIndexByKey) return null
      middleIndexByKey[key] = i + 1
      if (key in previousIndexByKey) overlaps++
    }
    if (!overlaps) {
      // No key overlap in the middle → wipe the old range and mount fresh.
      const first = getNode(previousList[oldStart], undefined, true)
      const last = getNode(previousList[oldEnd])
      const fragment = document.createDocumentFragment()
      for (let i = newStart; i <= newEnd; i++) {
        const item = renderable[i]
        if (!isComponentCall(item) && !isArrowTemplate(item)) return null
        renderedList[i] = mountItem(item, fragment)
      }
      const parent = first.parentNode
      if (parent && first === parent.firstChild && last === parent.lastChild) {
        parent.replaceChildren(fragment)
      } else {
        const range = document.createRange()
        range.setStartBefore(first)
        range.setEndAfter(last)
        range.deleteContents()
        range.insertNode(fragment)
      }
      for (let i = oldStart; i <= oldEnd; i++) {
        const stale = previousList[i] as Chunk
        forgetChunk(stale)
        destroyChunk(stale, true)
      }
      return renderedList
    }

    // Sync surviving keys into renderedList; unmount keys that disappeared.
    for (let i = oldStart; i <= oldEnd; i++) {
      const stale = previousList[i] as Chunk
      const nextIndex = middleIndexByKey[stale.key as Exclude<ArrowTemplateKey, undefined>]
      if (nextIndex === undefined) {
        forgetChunk(stale)
        unmount(stale)
        continue
      }
      const item = renderable[nextIndex - 1] as ComponentCall | ArrowTemplate
      if (!syncKeyedRenderable(item, stale)) return null
      renderedList[nextIndex - 1] = stale
    }

    // Walk new middle right→left and insert/move nodes so order matches.
    let before =
      newEnd + 1 < renderableLength
        ? getNode(renderedList[newEnd + 1], undefined, true)
        : (getNode(previousList[previousLength - 1]).nextSibling as
            | ChildNode
            | null)
    for (let i = newEnd; i >= newStart; i--) {
      const existing = renderedList[i]
      if (!existing) {
        const item = renderable[i]
        if (!isComponentCall(item) && !isArrowTemplate(item)) return null
        const fragment = document.createDocumentFragment()
        const mounted = mountItem(item, fragment)
        renderedList[i] = mounted
        parent.insertBefore(fragment, before)
        before = getNode(mounted, undefined, true)
        continue
      }
      const start = getNode(existing, undefined, true)
      if (start.parentNode !== parent || start.nextSibling !== before) {
        moveDOMRef((existing as Chunk).ref, parent, before)
      }
      before = start
    }

    return renderedList
  }

  /**
   * Patch a single previous value to match `renderable`.
   * Prefers keyed reuse / same-shape sync before mount+unmount.
   */
  function patch(
    renderable: Exclude<
      ArrowRenderable,
      Array<string | number | boolean | ComponentCall | ArrowTemplate>
    >,
    prev: Chunk | Text | Rendered[],
    anchor?: ChildNode
  ): Chunk | Text | Rendered[] {
    const nodeType = (prev as Node).nodeType ?? 0
    if (isComponentCall(renderable)) {
      const key = renderable.listKey
      if (key !== undefined && key in keyedChunks) {
        const keyedChunk = keyedChunks[key]
        if (syncComponentChunk(renderable, keyedChunk)) {
          if (keyedChunk === prev) return prev
          moveChunkIntoPlace(keyedChunk, prev, anchor)
          return keyedChunk
        }
      } else if (isChunk(prev) && syncComponentChunk(renderable, prev)) {
        if (prev.key !== renderable.listKey) {
          forgetChunk(prev)
          prev.key = renderable.listKey
          rememberKeyedChunk(prev)
        }
        return prev
      }
      const [fragment, chunk] = renderComponent(renderable)
      const mounted = mountChunkFragment(fragment, chunk)
      getNode(prev, anchor).after(fragment)
      forgetChunk(prev)
      unmount(prev)
      rememberKeyedChunk(chunk)
      return mounted
    }
    if (!isArrowTemplate(renderable) && nodeType === 3) {
      const value = renderText(renderable)
      if ((prev as Text).data !== value) (prev as Text).data = value
      return prev
    }
    if (isArrowTemplate(renderable)) {
      const template = renderable as InternalTemplate
      const key = template.listKey
      if (key !== undefined && key in keyedChunks) {
        const keyedChunk = keyedChunks[key]
        if (canSyncTemplateChunk(template, keyedChunk)) {
          syncTemplateToChunk(template, keyedChunk, true)
          if (keyedChunk === prev) return prev
          moveChunkIntoPlace(keyedChunk, prev, anchor)
          return keyedChunk
        }
      }
      const proto = getChunkProto(template)
      if (isChunk(prev) && prev.signature === proto.signature) {
        syncTemplateToChunk(template, prev, true)
        return prev
      }
      const fragment = renderable()
      const chunk = template.boundChunk!
      const mounted = mountChunkFragment(fragment, chunk)
      getNode(prev, anchor).after(fragment)
      forgetChunk(prev)
      unmount(prev)
      rememberKeyedChunk(chunk)
      return mounted
    }
    const text = document.createTextNode(renderText(renderable))
    getNode(prev, anchor).after(text)
    forgetChunk(prev)
    unmount(prev)
    return text
  }

  function mountItem(
    item: string | number | boolean | ComponentCall | ArrowTemplate,
    fragment: DocumentFragment
  ): Rendered {
    if (isComponentCall(item)) {
      const [inner, chunk] = renderComponent(item)
      fragment.appendChild(inner)
      rememberKeyedChunk(chunk)
      return mountChunkFragment(fragment, chunk)
    }
    if (isArrowTemplate(item)) {
      item(fragment)
      const chunk = (item as InternalTemplate).boundChunk!
      rememberKeyedChunk(chunk)
      return mountChunkFragment(fragment, chunk)
    }
    const node = document.createTextNode(renderText(item))
    fragment.appendChild(node)
    return node
  }

  /** Prefer returning the chunk; if it has no DOM span yet, keep a text placeholder. */
  function mountChunkFragment(fragment: DocumentFragment, chunk: Chunk): Rendered {
    if (chunk.ref.first) return chunk
    const placeholder = document.createTextNode('')
    fragment.appendChild(placeholder)
    return placeholder
  }

  function rememberKeyedChunk(chunk: Chunk) {
    if (chunk.key !== undefined) keyedChunks[chunk.key] = chunk
  }

  function forgetChunk(item: Chunk | Text | Rendered[] | undefined) {
    if (isChunk(item) && item.key !== undefined && keyedChunks[item.key] === item) {
      delete keyedChunks[item.key]
    }
  }

  /**
   * Run a component factory once: props proxy + cleanup collector → template().
   * Factory identity is stored on `chunk.propsBox` so later calls can sync without remount.
   */
  function renderComponent(renderable: ComponentCall): [DocumentFragment, Chunk] {
    const [props, emit, box] = createPropsProxy(
      renderable.props,
      renderable.factory,
      renderable.events
    )
    const cleanups: Array<() => void> = []
    const previousCollector = swapCleanupCollector(cleanups)
    let template: InternalTemplate
    let fragment: DocumentFragment

    try {
      template = renderable.factory(props, emit) as InternalTemplate
      fragment = template() as DocumentFragment
    } finally {
      swapCleanupCollector(previousCollector)
    }

    const chunk = template.getChunk()
    if (cleanups.length) {
      ;(chunk.cleanups ??= []).push(...cleanups)
    }
    chunk.recyclable = false
    chunk.propsBox = box
    chunk.key = renderable.listKey
    return [fragment, chunk]
  }

  return render
}

// ---------------------------------------------------------------------------
// Unmount: microtask batch → recycle (stale) or destroy (pool)
// ---------------------------------------------------------------------------

let unmountStack: Array<
  | Chunk
  | Text
  | ChildNode
  | Array<Chunk | Text>
> = []

/**
 * Tear down a chunk completely: events, cleanups, expressions, DOM, free shell.
 * `detached` skips removing nodes that were already taken out of the document.
 */
function destroyChunk(chunk: Chunk, detached = false) {
  if (chunk.isStale) removeStaleChunk(chunk)
  releaseTemplate(chunk)
  if (chunk.eventRecords) {
    for (let i = 0; i < chunk.eventRecords.length; i++) {
      const [target, event] = chunk.eventRecords[i]
      const bindings = (target as EventBoundElement)[eventBindingsKey]
      if (bindings) {
        delete bindings[event]
        let hasBindings = false
        for (const _bindingName in bindings) {
          hasBindings = true
          break
        }
        if (!hasBindings) delete (target as EventBoundElement)[eventBindingsKey]
      }
      target.removeEventListener(event, dispatchChunkEvent)
    }
  }
  if (chunk.cleanups) {
    for (let i = 0; i < chunk.cleanups.length; i++) chunk.cleanups[i]()
    chunk.cleanups = null
  }
  if (chunk.expressionPointer + 1) {
    releaseExpressions(chunk.expressionPointer)
    chunk.expressionPointer = -1
  }
  let node = chunk.ref.first
  if (!detached && node) {
    const last = chunk.ref.last
    if (node === last) node.remove()
    else {
      while (node) {
        const next: ChildNode | null =
          node === last ? null : (node.nextSibling as ChildNode | null)
        node.remove()
        if (!next) break
        node = next
      }
    }
  }
  chunk.dom.textContent = ''
  chunk.ref.first = chunk.ref.last = null
  chunk.key = chunk.stableId = chunk.propsBox = undefined
  chunk.cleanups = chunk.eventRecords = null
  chunk.isBound = chunk.isStale = false
  chunk.recyclable = true
  chunk.signature = ''
  freeChunk(chunk)
}

/**
 * Park a recyclable chunk for later reuse: move DOM back into `chunk.dom`,
 * register in staleBySignature (and staleById if `.id()` was set).
 */
function recycleChunk(chunk: Chunk, detached = false) {
  if (!detached) moveDOMRef(chunk.ref, chunk.dom)
  releaseTemplate(chunk)
  if (chunk.isStale || !chunk.recyclable) return
  chunk.isStale = true
  let bucket = staleBySignature.get(chunk.signature)
  if (!bucket) {
    bucket = {}
    staleBySignature.set(chunk.signature, bucket)
  }
  chunk.staleNext = bucket.head
  bucket.head = chunk
  if (chunk.stableId !== undefined) staleById.set(chunk.stableId, chunk)
}

let unmountQueued = false

/** True when every list item is a recyclable chunk (or text) — safe for sync remove. */
function canSyncUnmount(chunk: Array<Chunk | Text>) {
  for (let i = 0; i < chunk.length; i++) {
    const item = chunk[i]
    if (isChunk(item) && !item.recyclable) return false
  }
  return true
}

/**
 * If the list owns the parent's entire child list, swap it for `placeholder`
 * in one `replaceChildren` (nodes stay detached for recycle).
 */
function replaceListWithPlaceholder(
  chunk: Array<Chunk | Text>,
  placeholder: Text
) {
  if (!chunk.length) return false
  const first = getNode(chunk[0], undefined, true)
  const last = getNode(chunk[chunk.length - 1])
  const parent = first.parentNode
  if (!parent || first !== parent.firstChild || last !== parent.lastChild) {
    return false
  }
  parent.replaceChildren(placeholder)
  return true
}

/** Recycle or destroy one rendered value (or a list of them). */
function removeUnmounted(
  chunk:
    | Chunk
    | Text
    | ChildNode
    | Array<Chunk | Text>,
  detached = false
) {
  if (isChunk(chunk)) {
    if (chunk.recyclable) recycleChunk(chunk, detached)
    else destroyChunk(chunk, detached)
    return
  }
  if (Array.isArray(chunk)) {
    if (!detached && chunk.length) {
      const first = getNode(chunk[0], undefined, true)
      const last = getNode(chunk[chunk.length - 1])
      const parent = first.parentNode
      if (parent) {
        if (first === parent.firstChild && last === parent.lastChild) {
          parent.textContent = ''
        } else {
          const range = document.createRange()
          range.setStartBefore(first)
          range.setEndAfter(last)
          range.deleteContents()
        }
        detached = true
      }
    }
    let bucket: StaleBucket | undefined
    let signature = ''
    for (let i = 0; i < chunk.length; i++) {
      const item = chunk[i]
      if (isChunk(item)) {
        if (!item.recyclable) {
          destroyChunk(item, detached)
          continue
        }
        if (!detached) moveDOMRef(item.ref, item.dom)
        releaseTemplate(item)
        if (item.isStale) continue
        item.isStale = true
        if (signature !== item.signature) {
          signature = item.signature
          bucket = staleBySignature.get(signature)
          if (!bucket) {
            bucket = {}
            staleBySignature.set(signature, bucket)
          }
        }
        item.staleNext = bucket!.head
        bucket!.head = item
        if (item.stableId !== undefined) staleById.set(item.stableId, item)
      } else if (!detached) {
        item.remove()
      }
    }
    return
  }
  if (!detached) chunk.remove()
}

function drainUnmountStack() {
  unmountQueued = false
  const stack = unmountStack
  unmountStack = []
  for (let i = 0; i < stack.length; i++) removeUnmounted(stack[i])
  if (unmountStack.length) scheduleUnmountDrain()
}

function scheduleUnmountDrain() {
  if (unmountQueued) return
  unmountQueued = true
  queueMicrotask(drainUnmountStack)
}

/** Queue a value for teardown on the next microtask (batches nested unmounts). */
function unmount(
  chunk:
    | Chunk
    | Text
    | ChildNode
    | Array<Chunk | Text>
    | undefined
) {
  if (!chunk) return
  unmountStack.push(chunk)
  scheduleUnmountDrain()
}

/** Coerce nullish / falsey values to empty string; keep `0`. */
function renderText(value: unknown) {
  return value || value === 0 ? (value as string) : ''
}

/** Boundary ChildNode for a rendered value (`first` picks ref.firstirst / list head). */
function getNode(
  chunk: Chunk | Text | Array<Chunk | Text>,
  anchor?: ChildNode,
  first?: boolean
): ChildNode {
  if (isChunk(chunk)) {
    return first ? chunk.ref.first! : chunk.ref.last!
  }
  if (Array.isArray(chunk)) {
    return getNode(chunk[first ? 0 : chunk.length - 1], anchor, first)
  }
  return chunk!
}

/** Remap staged render state onto live SSR DOM via the hydrate NodeMap. */
function adoptRenderedValue(
  value: Chunk | Text | Rendered[] | undefined,
  capture: HydrationCapture,
  map: NodeMap,
  visited: WeakSet<Chunk>
): Chunk | Text | Rendered[] | undefined {
  if (!value) return value
  if (isChunk(value)) {
    adoptCapturedChunk(capture, value, map, visited)
    return value
  }
  if (Array.isArray(value)) {
    const next = new Array(value.length) as Rendered[]
    for (let i = 0; i < value.length; i++) {
      next[i] = adoptRenderedValue(value[i], capture, map, visited) as Rendered
    }
    return next
  }
  return (map.get(value) as Text | undefined) ?? value
}

// ---------------------------------------------------------------------------
// Path tape construction (used by resolveChunkProto)
// ---------------------------------------------------------------------------

/**
 * Walk parsed template DOM and encode every `¤` placeholder location.
 *
 * Each record on pathTape:
 *   [sharedDepth, remainingDepth, childIndex..., segment]
 * where segment is 0 (node) or 1-based index into attrNames.
 * sharedDepth compresses paths that share a prefix with the previous record.
 */
function createPaths(dom: DocumentFragment): Chunk['paths'] {
  const pathTape: number[] = []
  const attrNames: string[] = []
  const path: number[] = []
  const previous: number[] = []
  const pushPath = (attrName?: string) => {
    const pathLen = path.length
    const previousLen = previous.length
    const limit = pathLen < previousLen ? pathLen : previousLen
    let sharedDepth = 0
    while (sharedDepth < limit && previous[sharedDepth] === path[sharedDepth]) {
      sharedDepth++
    }
    pathTape.push(sharedDepth, pathLen - sharedDepth)
    for (let i = sharedDepth; i < pathLen; i++) pathTape.push(path[i])
    pathTape.push(attrName ? attrNames.push(attrName) : 0)
    previous.length = pathLen
    for (let i = 0; i < pathLen; i++) previous[i] = path[i]
  }
  const walk = (node: Node) => {
    if (node.nodeType === 1) {
      const attrs = (node as Element).attributes
      for (let i = 0; i < attrs.length; i++) {
        const attr = attrs[i]
        // Attribute slot: value was the delimiter comment string.
        if (attr.value === delimiterComment) pushPath(attr.name)
      }
    } else if (node.nodeType === 8) {
      // Comment placeholder from `<!--¤-->` between tags.
      pushPath()
    } else if (node.nodeType === 3 && node.nodeValue === delimiterComment) {
      // Text node that absorbed the delimiter (e.g. mid-text expression).
      pushPath()
    }
    const children = node.childNodes
    for (let i = 0; i < children.length; i++) {
      path.push(i)
      walk(children[i])
      path.pop()
    }
  }
  const children = dom.childNodes
  for (let i = 0; i < children.length; i++) {
    path.push(i)
    walk(children[i])
    path.pop()
  }
  return [pathTape, attrNames]
}

/**
 * After paths are recorded, turn delimiter comments/text into empty Text nodes
 * so createNodeBinding can replaceChild them at bind time.
 */
function normalizeNodePlaceholders(dom: DocumentFragment) {
  const walk = (node: Node) => {
    const children = node.childNodes
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.nodeType === 8 && (child as Comment).data === delimiter) {
        node.replaceChild(document.createTextNode(''), child)
        continue
      }
      if (child.nodeType === 3 && child.nodeValue === delimiterComment) {
        child.nodeValue = ''
      }
      if (child.firstChild) walk(child)
    }
  }
  walk(dom)
}
