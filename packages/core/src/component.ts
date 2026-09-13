import type { ArrowTemplate, ArrowTemplateKey } from './html'
import { reactive } from './reactive'
import type { Reactive, ReactiveTarget } from './reactive'

export type Props<T extends ReactiveTarget> = {
  [P in keyof T]: T[P] extends ReactiveTarget ? Props<T[P]> | T[P] : T[P]
}
export type EventMap = Record<string, unknown>

export type Events<T extends EventMap> = {
  [K in keyof T]?: (payload: T[K]) => void
}

export type Emit<T extends EventMap> = <K extends keyof T>(
  event: K,
  payload: T[K]
) => void

type SyncFactory<T extends ReactiveTarget, TEvents extends EventMap> =
  | (() => ArrowTemplate)
  | ((props: Props<T>) => ArrowTemplate)
  | ((props: Props<T>, emit: Emit<TEvents>) => ArrowTemplate)
  | ((props: undefined, emit: Emit<TEvents>) => ArrowTemplate)
type AsyncFactory<T extends ReactiveTarget, TValue, TEvents extends EventMap> =
  | (() => Promise<TValue> | TValue)
  | ((props: Props<T>) => Promise<TValue> | TValue)
  | ((props: Props<T>, emit: Emit<TEvents>) => Promise<TValue> | TValue)
  | ((props: undefined, emit: Emit<TEvents>) => Promise<TValue> | TValue)

const AsyncFunction = (async () => {}).constructor as {
  new (...args: unknown[]): unknown
}

export type ComponentFactory = (
  props?: Props<ReactiveTarget>,
  emit?: Emit<EventMap>
) => ArrowTemplate

export interface AsyncComponentOptions<
  TProps extends ReactiveTarget,
  TValue,
  TEvents extends EventMap = EventMap,
  TSnapshot = TValue,
> {
  fallback?: unknown
  onError?: (
    error: unknown,
    props: Props<TProps>,
    emit: Emit<TEvents>
  ) => unknown
  render?: (
    value: TValue,
    props: Props<TProps>,
    emit: Emit<TEvents>
  ) => unknown
  serialize?: (
    value: TValue,
    props: Props<TProps>,
    emit: Emit<TEvents>
  ) => TSnapshot
  deserialize?: (snapshot: TSnapshot, props: Props<TProps>) => TValue
  idPrefix?: string
}

export type AsyncComponentInstaller = <
  TProps extends ReactiveTarget,
  TValue,
  TEvents extends EventMap = EventMap,
  TSnapshot = TValue,
>(
  factory: AsyncFactory<TProps, TValue, TEvents>,
  options?: AsyncComponentOptions<TProps, TValue, TEvents, TSnapshot>
) => Component<TEvents> | ComponentWithProps<TProps, TEvents>

export interface ComponentCall {
  /** Component factory that produced this call. */
  factory: ComponentFactory
  /** Props object passed into the component (may be undefined). */
  props: Props<ReactiveTarget> | undefined
  /** Event handlers map passed as the second argument. */
  events: Events<EventMap> | undefined
  /** List reconciliation key (set via `.key()`). */
  listKey: ArrowTemplateKey
  key: (key: ArrowTemplateKey) => ComponentCall
}

export interface Component<TEvents extends EventMap = EventMap> {
  (props?: undefined, events?: Events<TEvents>): ComponentCall
}

export interface ComponentWithProps<
  T extends ReactiveTarget,
  TEvents extends EventMap = EventMap,
> {
  <S extends T>(props: S, events?: Events<TEvents>): ComponentCall
}

let asyncComponentInstaller: AsyncComponentInstaller | null = null

type SourceBox = Reactive<{
  props: Props<ReactiveTarget> | undefined
  factory: ComponentFactory
  events: Events<EventMap> | undefined
}>
function setComponentKey(this: ComponentCall, key: ArrowTemplateKey) {
  this.listKey = key
  return this
}

const propsProxyHandler: ProxyHandler<SourceBox> = {
  get(target, key) {
    return (target.props as Record<PropertyKey, unknown> | undefined)?.[
      key as PropertyKey
    ]
  },
  has(target, key) {
    return key in (target.props || {})
  },
  ownKeys(target) {
    return Reflect.ownKeys(target.props || {})
  },
  getOwnPropertyDescriptor(target, key) {
    const source = target.props
    return source && {
      configurable: true,
      enumerable: true,
      writable: true,
      value: (source as Record<PropertyKey, unknown>)[key as PropertyKey],
    }
  },
  set(target, key, value) {
    return !!target.props && Reflect.set(target.props as object, key, value)
  },
}

const narrowedPropsHandler: ProxyHandler<{
  keys: PropertyKey[]
  source: object
}> = {
  get(target, key) {
    return target.keys.includes(key)
      ? (target.source as Record<PropertyKey, unknown>)[key as PropertyKey]
      : undefined
  },
  set(target, key, value) {
    if (!target.keys.includes(key)) return false
    return Reflect.set(target.source, key, value)
  },
}

export function pick<T extends object, K extends keyof T>(
  source: T,
  ...keys: K[]
): Pick<T, K>
export function pick<T extends object>(
  source: T
): T
export function pick<T extends object, K extends keyof T>(
  source: T,
  ...keys: K[]
): T | Pick<T, K> {
  return keys.length
    ? (new Proxy({
        keys: keys as PropertyKey[],
        source,
      }, narrowedPropsHandler) as unknown as Pick<T, K>)
    : source
}

export function component(factory: () => ArrowTemplate): Component
export function component<TEvents extends EventMap>(
  factory: (props: undefined, emit: Emit<TEvents>) => ArrowTemplate
): Component<TEvents>
export function component<T extends ReactiveTarget>(
  factory: (props: Props<T>) => ArrowTemplate
): ComponentWithProps<T>
export function component<T extends ReactiveTarget, TEvents extends EventMap>(
  factory: (props: Props<T>, emit: Emit<TEvents>) => ArrowTemplate
): ComponentWithProps<T, TEvents>
export function component<TValue, TEvents extends EventMap, TSnapshot = TValue>(
  factory:
    | (() => Promise<TValue> | TValue)
    | ((props: undefined, emit: Emit<TEvents>) => Promise<TValue> | TValue),
  options?: AsyncComponentOptions<ReactiveTarget, TValue, TEvents, TSnapshot>
): Component
export function component<
  T extends ReactiveTarget,
  TValue,
  TEvents extends EventMap,
  TSnapshot = TValue,
>(
  factory:
    | ((props: Props<T>) => Promise<TValue> | TValue)
    | ((props: Props<T>, emit: Emit<TEvents>) => Promise<TValue> | TValue),
  options?: AsyncComponentOptions<T, TValue, TEvents, TSnapshot>
): ComponentWithProps<T, TEvents>
export function component<
  T extends ReactiveTarget,
  TValue,
  TEvents extends EventMap = EventMap,
  TSnapshot = TValue,
>(
  factory: SyncFactory<T, TEvents> | AsyncFactory<T, TValue, TEvents>,
  options?: AsyncComponentOptions<T, TValue, TEvents, TSnapshot>
): Component<TEvents> | ComponentWithProps<T, TEvents> {
  if (options || factory.constructor === AsyncFunction) {
    if (!asyncComponentInstaller) {
      throw Error('Async runtime missing.')
    }

    return asyncComponentInstaller(
      factory as AsyncFactory<T, TValue, TEvents>,
      options
    ) as Component<TEvents> | ComponentWithProps<T, TEvents>
  }

  return ((input?: Props<T>, events?: Events<TEvents>) =>
    ({
      factory: factory as SyncFactory<T, TEvents> as ComponentFactory,
      listKey: undefined,
      props: input as Props<ReactiveTarget> | undefined,
      events: events as Events<EventMap> | undefined,
      key: setComponentKey,
    })) as Component<TEvents> | ComponentWithProps<T, TEvents>
}

export function installAsyncComponentInstaller(
  installer: AsyncComponentInstaller | null
) {
  asyncComponentInstaller = installer
}

export function isComponentCall(value: unknown): value is ComponentCall {
  return !!value && typeof value === 'object' && 'factory' in value
}

export function createPropsProxy(
  source: Props<ReactiveTarget> | undefined,
  factory: ComponentFactory,
  events?: Events<EventMap>
): [Props<ReactiveTarget>, Emit<EventMap>, SourceBox] {
  const box = reactive({ props: source, factory, events })
  const emit = ((event: keyof EventMap, payload: unknown) => {
    const handler = box.events?.[event]
    if (typeof handler === 'function') handler(payload)
  }) as Emit<EventMap>

  return [
    new Proxy(box, propsProxyHandler) as unknown as Props<ReactiveTarget>,
    emit,
    box,
  ]
}
