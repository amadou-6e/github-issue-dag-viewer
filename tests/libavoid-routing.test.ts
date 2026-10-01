// @vitest-environment node

import { describe, expect, it } from 'vitest'
import { segmentControls } from '../src/components/libavoid-routing'
import { routeEdges } from '../src/components/libavoid-runtime.mjs'

describe('fixed-node obstacle routing', () => {
  it('preserves the route bend coordinates when converted to Cytoscape segments', () => {
    const source = { x: 80, y: 50 }
    const target = { x: 320, y: 50 }
    const bends = [
      { x: 80, y: 65 },
      { x: 320, y: 65 },
    ]
    const { weights, distances } = segmentControls(source, target, bends)
    expect(weights).toEqual([0, 1])
    expect(distances).toEqual([15, 15])
  })

  it('routes around an unrelated fixed card instead of through its box', async () => {
    const obstacle = { x: 150, y: -5, width: 100, height: 60 }
    const routes = await routeEdges(
      {
        id: 'root',
        children: [
          { id: 'source', x: 0, y: 0, width: 100, height: 50 },
          { id: 'target', x: 300, y: 0, width: 100, height: 50 },
          { id: 'obstacle', ...obstacle },
        ],
        edges: [{ id: 'blocked', source: 'source', target: 'target' }],
      },
      { routingType: 'orthogonal', shapeBufferDistance: 10 },
    )
    const route = routes.get('blocked')
    expect(route).toBeDefined()
    if (route === undefined) return
    const points = [route.sourcePoint, ...route.bendPoints, route.targetPoint]
    expect(route.bendPoints.length).toBeGreaterThan(0)
    for (const [index, point] of points.entries()) {
      const next = points[index + 1]
      if (next === undefined) continue
      const crossesInterior =
        Math.max(point.x, next.x) > obstacle.x &&
        Math.min(point.x, next.x) < obstacle.x + obstacle.width &&
        Math.max(point.y, next.y) > obstacle.y &&
        Math.min(point.y, next.y) < obstacle.y + obstacle.height
      expect(crossesInterior).toBe(false)
    }
  })
})
