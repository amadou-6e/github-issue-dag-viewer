import { init, routeEdges } from './libavoid-runtime.mjs'

interface WorkerRequest {
  id: number
  graph: Parameters<typeof routeEdges>[0]
}

const wasmUrl = new URL('../../node_modules/libavoid-js/dist/libavoid.wasm', import.meta.url).href
let initialized: Promise<void> | null = null

self.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
  const { id, graph } = event.data
  initialized ??= init(wasmUrl)
  void initialized
    .then(async () => {
      const allRoutes = new Map<
        string,
        Awaited<ReturnType<typeof routeEdges>> extends Map<string, infer Route> ? Route : never
      >()
      // Bound the connector count per solve; dense all-at-once routing can stall the UI.
      for (let offset = 0; offset < graph.edges.length; offset += 16) {
        const batch = graph.edges.slice(offset, offset + 16)
        const routes = await routeEdges(
          { ...graph, edges: batch },
          {
            routingType: 'orthogonal',
            shapeBufferDistance: 12,
            idealNudgingDistance: 10,
            crossingPenalty: 100,
            segmentPenalty: 10,
            anglePenalty: 10,
            selfLoopHandling: 'fallback',
          },
        )
        for (const [edgeId, route] of routes) allRoutes.set(edgeId, route)
      }
      return allRoutes
    })
    .then((routes) => {
      self.postMessage({ id, routes: [...routes] })
    })
    .catch((error: unknown) => {
      self.postMessage({ id, error: error instanceof Error ? error.message : 'Routing failed.' })
    })
})
