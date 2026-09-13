import { ArrowTemplate, Chunk } from './html'
import { Reactive, PropertyObserver, ReactiveTarget } from './reactive'

/**
 * A queue of expressions to run as soon as an async slot opens up.
 */
const queueMarker = Symbol()
type QueuedFunction = CallableFunction & {
  [queueMarker]?: boolean
  /** Pending new value for the queued observer. */
  newValue?: unknown
  /** Pending old value for the queued observer. */
  oldValue?: unknown
}
let queueStack: QueuedFunction[] = []
/**
 * A stack of functions to run on the next tick.
 */
let nextTicks: CallableFunction[] = []
let cleanupCollector: Array<() => void> | null = null

/**
 * Adds the ability to listen to the next tick.
 * @param  {CallableFunction} fn?
 * @returns Promise
 */
export function nextTick(fn?: CallableFunction): Promise<unknown> {
  return !queueStack.length
    ? Promise.resolve(fn?.())
    : new Promise((resolve: (value?: unknown) => void) =>
        nextTicks.push(() => {
          fn?.()
          resolve()
        })
      )
}

export function isArrowTemplate(template: unknown): template is ArrowTemplate {
  return typeof template === 'function' && !!(template as ArrowTemplate).isTemplate
}

export function isObject(obj: unknown): obj is ReactiveTarget {
  return obj !== null && typeof obj === 'object'
}

export function isReactive(obj: unknown): obj is Reactive<ReactiveTarget> {
  return isObject(obj) && '$on' in obj
}

export function isChunk(chunk: unknown): chunk is Chunk {
  return isObject(chunk) && 'ref' in chunk
}

/**
 * Queue an item to execute after all synchronous functions have been run. This
 * is used for `w()` to ensure multiple dependency mutations tracked on the
 * same expression do not result in multiple calls.
 * @param  {CallableFunction} fn
 * @returns PropertyObserver
 */
export function queue<T extends unknown>(
  fn: PropertyObserver<T>
): PropertyObserver<T> {
  const queued = fn as QueuedFunction
  return (newValue?: T, oldValue?: T) => {
    if (!queued[queueMarker]) {
      queued[queueMarker] = true
      queued.newValue = newValue
      queued.oldValue = oldValue
      if (!queueStack.length) {
        queueMicrotask(executeQueue)
      }
      queueStack.push(queued)
    }
  }
}

function executeQueue() {
  const queue = queueStack
  queueStack = []
  const ticks = nextTicks
  nextTicks = []
  for (let i = 0; i < queue.length; i++) {
    const fn = queue[i]
    const newValue = fn.newValue
    const oldValue = fn.oldValue
    fn.newValue = undefined
    fn.oldValue = undefined
    fn[queueMarker] = false
    fn(newValue, oldValue)
  }
  for (let i = 0; i < ticks.length; i++) ticks[i]()
  if (queueStack.length) {
    queueMicrotask(executeQueue)
  }
}

export function swapCleanupCollector(collector: Array<() => void> | null) {
  const previous = cleanupCollector
  cleanupCollector = collector
  return previous
}

export function registerCleanup(fn: () => void) {
  cleanupCollector?.push(fn)
}

export function onCleanup(fn: () => void) {
  const collector = cleanupCollector
  if (!collector) throw Error('onCleanup needs component')

  let active = 1
  const dispose = () =>
    active-- && (collector.splice(collector.indexOf(dispose), 1), fn())

  return collector.push(dispose), dispose
}
