import type { Core } from 'cytoscape'
import type { routeEdges } from './libavoid-runtime.mjs'

export interface RoutePoint {
  x: number
  y: number
}

type GraphInput = Parameters<typeof routeEdges>[0]
type Route = Awaited<ReturnType<typeof routeEdges>> extends Map<string, infer Value> ? Value : never

interface WorkerResponse {
  id: number
  routes?: [string, Route][]
  error?: string
}

let worker: Worker | null = null
let nextId = 0
const pending = new Map<
  number,
  { resolve: (routes: Map<string, Route>) => void; reject: (error: Error) => void }
>()

const routingWorker = (): Worker => {
  if (worker !== null) return worker
  worker = new Worker(new URL('./libavoid-worker.ts', import.meta.url), { type: 'module' })
  worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
    const { id, routes, error } = event.data
    const request = pending.get(id)
    if (request === undefined) return
    pending.delete(id)
    if (error !== undefined) request.reject(new Error(error))
    else request.resolve(new Map(routes ?? []))
  })
  worker.addEventListener('error', () => {
    for (const request of pending.values()) request.reject(new Error('Routing worker failed.'))
    pending.clear()
    worker?.terminate()
    worker = null
  })
  return worker
}

const routeInWorker = (graph: GraphInput): Promise<Map<string, Route>> =>
  new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    routingWorker().postMessage({ id, graph })
  })

const pointStyle = (point: RoutePoint, center: RoutePoint): string =>
  `${point.x - center.x}px ${point.y - center.y}px`

export const segmentControls = (
  source: RoutePoint,
  target: RoutePoint,
  bends: readonly RoutePoint[],
): { weights: number[]; distances: number[] } => {
  const dx = target.x - source.x
  const dy = target.y - source.y
  const squaredLength = dx * dx + dy * dy
  if (squaredLength < 1) return { weights: [], distances: [] }
  const length = Math.sqrt(squaredLength)
  return {
    weights: bends.map(
      (point) => ((point.x - source.x) * dx + (point.y - source.y) * dy) / squaredLength,
    ),
    distances: bends.map(
      (point) => ((point.y - source.y) * dx - (point.x - source.x) * dy) / length,
    ),
  }
}

export const routeVisibleEdges = async (
  cy: Core,
  isCurrent: () => boolean = () => true,
): Promise<void> => {
  const visible = cy.elements(':visible')
  const nodes = visible.nodes()
  const edges = visible.edges().filter((edge) => edge.data('source') !== edge.data('target'))
  if (edges.empty()) return

  const routes = await routeInWorker({
    id: 'issue-graph',
    children: nodes.map((node) => {
      const box = node.boundingBox({
        includeLabels: false,
        includeOverlays: false,
        includeUnderlays: false,
      })
      return { id: node.id(), x: box.x1, y: box.y1, width: box.w, height: box.h }
    }),
    edges: edges.map((edge) => ({
      id: edge.id(),
      source: String(edge.data('source')),
      target: String(edge.data('target')),
    })),
  })

  if (!isCurrent() || cy.destroyed()) return

  cy.batch(() => {
    edges.forEach((edge) => {
      const route = routes.get(edge.id())
      if (route === undefined) return
      const { sourcePoint, targetPoint, bendPoints } = route
      const controls = segmentControls(sourcePoint, targetPoint, bendPoints)
      edge.data('routePoints', [sourcePoint, ...bendPoints, targetPoint])
      edge.style({
        'curve-style': bendPoints.length > 0 ? 'segments' : 'straight',
        'edge-distances': 'endpoints',
        'source-endpoint': pointStyle(sourcePoint, edge.source().position()),
        'target-endpoint': pointStyle(targetPoint, edge.target().position()),
        'segment-weights': controls.weights.join(' '),
        'segment-distances': controls.distances.join(' '),
      })
    })
  })
}
