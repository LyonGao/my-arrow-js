import {
  adoptCapturedChunk,
  type ArrowTemplate,
  type HydrationCapture,
  type ParentNode as ArrowParentNode,
} from '@arrow-js/core/internal'

export interface HydrationStats {
  mismatches: number
}

export function hydrateTemplate(
  capture: HydrationCapture,
  template: ArrowTemplate,
  parent: ArrowParentNode,
  sourceRoot?: ArrowParentNode,
  stats?: HydrationStats
): boolean {
  const stage = sourceRoot ?? document.createDocumentFragment()

  if (!sourceRoot) {
    template(stage)
  }

  const hydration = createNodeMap(stage.childNodes, parent)
  if (!hydration) return false

  adoptCapturedChunk(capture, template.getChunk(), hydration.map)
  if (stats) stats.mismatches = hydration.mismatches
  stage.textContent = ''
  return true
}

function createNodeMap(
  sourceNodes: NodeListOf<ChildNode> | NodeList | ChildNode[],
  targetParent: ArrowParentNode
): { map: WeakMap<Node, Node>; mismatches: number } | null {
  const source = Array.from(sourceNodes)
  const map = new WeakMap<Node, Node>()

  try {
    return {
      map,
      mismatches: reconcileChildNodes(source, targetParent, map),
    }
  } catch {
    return null
  }
}

function reconcileChildNodes(
  sourceChildren: Node[],
  targetParent: ArrowParentNode,
  map: WeakMap<Node, Node>
): number {
  alignTargetChildNodes(sourceChildren, targetParent)

  let mismatches = 0
  let sourceIndex = 0
  let targetIndex = 0
  let targetChildren = Array.from(targetParent.childNodes)

  while (sourceIndex < sourceChildren.length || targetIndex < targetChildren.length) {
    const source = sourceChildren[sourceIndex]
    const target = targetChildren[targetIndex]

    if (!source) {
      target?.remove()
      mismatches += 1
      targetChildren = Array.from(targetParent.childNodes)
      continue
    }

    if (!target) {
      targetParent.appendChild(source)
      mapDetachedSubtree(source, map)
      mismatches += 1
      sourceIndex += 1
      targetIndex += 1
      targetChildren = Array.from(targetParent.childNodes)
      continue
    }

    const reconciled = reconcileNode(source, target, map)

    if (reconciled.reused) {
      mismatches += reconciled.mismatches
      sourceIndex += 1
      targetIndex += 1
      targetChildren = Array.from(targetParent.childNodes)
      continue
    }

    const sourceMatchIndex = findReusableNodeIndex(
      sourceChildren,
      sourceIndex + 1,
      target
    )
    const targetMatchIndex = findReusableNodeIndex(
      targetChildren,
      targetIndex + 1,
      source
    )

    if (
      sourceMatchIndex !== -1 &&
      (targetMatchIndex === -1 ||
        sourceMatchIndex - sourceIndex <= targetMatchIndex - targetIndex)
    ) {
      targetParent.insertBefore(source, target)
      mapDetachedSubtree(source, map)
      mismatches += 1
      sourceIndex += 1
      targetIndex += 1
      targetChildren = Array.from(targetParent.childNodes)
      continue
    }

    if (targetMatchIndex !== -1) {
      target.remove()
      mismatches += 1
      targetChildren = Array.from(targetParent.childNodes)
      continue
    }

    targetParent.replaceChild(source, target)
    mapDetachedSubtree(source, map)
    mismatches += 1
    sourceIndex += 1
    targetIndex += 1
    targetChildren = Array.from(targetParent.childNodes)
  }

  return mismatches
}

function reconcileNode(
  source: Node,
  target: Node,
  map: WeakMap<Node, Node>
): { reused: boolean; mismatches: number } {
  if (!canReuseNode(source, target)) {
    return {
      reused: false,
      mismatches: 0,
    }
  }

  map.set(source, target)

  if (source.nodeType === Node.ELEMENT_NODE && target.nodeType === Node.ELEMENT_NODE) {
    return {
      reused: true,
      mismatches: reconcileChildNodes(Array.from(source.childNodes), target as ArrowParentNode, map),
    }
  }

  return {
    reused: true,
    mismatches: 0,
  }
}

function canReuseNode(source: Node, target: Node): boolean {
  if (source.nodeType !== target.nodeType) {
    return false
  }

  if (source.nodeType === Node.ELEMENT_NODE && target.nodeType === Node.ELEMENT_NODE) {
    const sourceEl = source as Element
    const targetEl = target as Element

    if (sourceEl.tagName !== targetEl.tagName) {
      return false
    }

    if (sourceEl.attributes.length !== targetEl.attributes.length) {
      return false
    }

    for (const attribute of sourceEl.getAttributeNames()) {
      if (sourceEl.getAttribute(attribute) !== targetEl.getAttribute(attribute)) {
        return false
      }
    }

    return true
  }

  if (source.nodeType === Node.TEXT_NODE && target.nodeType === Node.TEXT_NODE) {
    return (
      source.nodeValue === target.nodeValue ||
      (isWhitespaceText(source.nodeValue) && isWhitespaceText(target.nodeValue))
    )
  }

  return source.nodeValue === target.nodeValue
}

function alignTargetChildNodes(sourceChildren: Node[], targetParent: Node): boolean {
  let targetChildren = Array.from(targetParent.childNodes)
  let sourceIndex = 0
  let targetIndex = 0

  while (sourceIndex < sourceChildren.length && targetIndex < targetChildren.length) {
    const sourceChild = sourceChildren[sourceIndex]
    const targetChild = targetChildren[targetIndex]

    if (sourceChild.nodeType === Node.TEXT_NODE) {
      if (targetChild.nodeType !== Node.TEXT_NODE) {
        return false
      }

      const segments: string[] = []
      let expected = ''
      while (
        sourceIndex < sourceChildren.length &&
        sourceChildren[sourceIndex].nodeType === Node.TEXT_NODE
      ) {
        const value = sourceChildren[sourceIndex].nodeValue ?? ''
        segments.push(value)
        expected += value
        sourceIndex += 1
      }

      if ((targetChild.nodeValue ?? '') !== expected) {
        if (
          isWhitespaceText(expected) &&
          isWhitespaceText(targetChild.nodeValue)
        ) {
          targetChild.nodeValue = expected
        } else {
          return false
        }
      }

      if (segments.length > 1) {
        splitTextNode(targetChild as Text, segments)
        targetChildren = Array.from(targetParent.childNodes)
      }

      targetIndex += segments.length
      continue
    }

    if (targetChild.nodeType === Node.TEXT_NODE) {
      return false
    }

    sourceIndex += 1
    targetIndex += 1
  }

  return sourceIndex === sourceChildren.length && targetIndex === targetChildren.length
}

function splitTextNode(node: Text, segments: string[]) {
  let current = node

  for (let index = 0; index < segments.length - 1; index += 1) {
    current = current.splitText(segments[index].length)
  }
}

function mapDetachedSubtree(node: Node, map: WeakMap<Node, Node>) {
  map.set(node, node)

  for (const child of Array.from(node.childNodes)) {
    mapDetachedSubtree(child, map)
  }
}

function findReusableNodeIndex(
  nodes: Node[],
  startIndex: number,
  candidate: Node
): number {
  for (let index = startIndex; index < nodes.length; index += 1) {
    if (canReuseNode(nodes[index], candidate)) {
      return index
    }
  }

  return -1
}

function isWhitespaceText(value: string | null | undefined) {
  return value == null || /^[\t\n\f\r ]*$/.test(value)
}
