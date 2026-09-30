import cytoscape from 'cytoscape'
import { describe, expect, it } from 'vitest'
import { runLayout, setGraphVisibility } from '../src/components/graph-renderer'

const layout = (cy: cytoscape.Core): Promise<void> =>
  new Promise((resolve, reject) =>
    runLayout(
      cy,
      'LR',
      false,
      () => resolve(),
      (message) => reject(new Error(message)),
    ),
  )

describe('graph layout', () => {
  it('packs standalone issues into a grid below the linked graph', async () => {
    const standalone = Array.from({ length: 12 }, (_, index) => `solo-${index}`)
    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      elements: [
        { data: { id: 'source' } },
        { data: { id: 'target' } },
        { data: { id: 'edge', source: 'source', target: 'target' } },
        ...standalone.map((id) => ({ data: { id } })),
      ],
    })
    try {
      await layout(cy)
      const xs = new Set(standalone.map((key) => cy.getElementById(key).position('x')))
      const ys = new Set(standalone.map((key) => cy.getElementById(key).position('y')))
      expect(xs.size).toBeGreaterThan(1)
      expect(ys.size).toBeGreaterThan(1)
      const linkedBottom = cy
        .getElementById('source')
        .union(cy.getElementById('target'))
        .boundingBox().y2
      expect(Math.min(...ys)).toBeGreaterThan(linkedBottom)
    } finally {
      cy.destroy()
    }
  })

  it('relayouts only visible issues after filtering', async () => {
    const cy = cytoscape({
      headless: true,
      styleEnabled: true,
      elements: Array.from({ length: 16 }, (_, index) => ({ data: { id: `solo-${index}` } })),
    })
    try {
      setGraphVisibility(cy, new Set(['solo-1', 'solo-2', 'solo-3', 'solo-4']))
      await layout(cy)
      expect(cy.nodes(':visible')).toHaveLength(4)
      expect(new Set(cy.nodes(':visible').map((node) => node.position('x'))).size).toBeGreaterThan(
        1,
      )
      setGraphVisibility(cy, new Set(['solo-1']))
      await layout(cy)
      expect(cy.nodes(':visible')).toHaveLength(1)
      expect(cy.getElementById('solo-1').position()).toEqual({ x: 0, y: 0 })
    } finally {
      cy.destroy()
    }
  })
})
