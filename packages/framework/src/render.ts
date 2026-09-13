import { html, nextTick } from '@arrow-js/core'
import type { ArrowTemplate } from '@arrow-js/core'
import { withRenderContext } from './context'

export interface RenderOptions {
  clear?: boolean
  hydrationSnapshots?: Record<string, unknown>
}

export interface RenderPayload {
  async: Record<string, unknown>
  boundaries: string[]
}

export interface RenderResult {
  root: ParentNode
  template: ArrowTemplate
  payload: RenderPayload
}

export async function render(
  root: ParentNode,
  view: unknown,
  options: RenderOptions = {}
): Promise<RenderResult> {
  return withRenderContext(
    async (context) => {
      if (options.clear !== false && 'replaceChildren' in root) {
        root.replaceChildren()
      }

      const template = toTemplate(view)
      template(root)
      await context.flush()
      await nextTick()

      return {
        root,
        template,
        payload: {
          async: { ...context.asyncSnapshots },
          boundaries: [...context.boundaries],
        },
      }
    },
    {
      hydrationSnapshots: options.hydrationSnapshots,
    }
  )
}

export function toTemplate(view: unknown): ArrowTemplate {
  if (isTemplate(view)) return view as ArrowTemplate
  if (typeof view === 'function') return html`${view as () => unknown}` as ArrowTemplate
  return html`${view as string | number | boolean | null | undefined}` as ArrowTemplate
}

function isTemplate(value: unknown): value is ArrowTemplate {
  return typeof value === 'function' && !!(value as { isTemplate?: boolean }).isTemplate
}
