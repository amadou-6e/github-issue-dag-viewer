interface Point {
  x: number
  y: number
}

interface Node {
  id: string
  x: number
  y: number
  width: number
  height: number
}

interface Edge {
  id: string
  source: string
  target: string
}

interface Route {
  sourcePoint: Point
  targetPoint: Point
  bendPoints: Point[]
}

export function init(wasmPath?: string): Promise<void>
export function routeEdges(
  graph: { id: string; children: Node[]; edges: Edge[] },
  options?: {
    routingType?: 'orthogonal' | 'polyline'
    shapeBufferDistance?: number
    idealNudgingDistance?: number
    crossingPenalty?: number
    segmentPenalty?: number
    anglePenalty?: number
    selfLoopHandling?: 'skip' | 'fallback'
  },
): Promise<Map<string, Route>>
