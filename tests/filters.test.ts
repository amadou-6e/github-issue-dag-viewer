import { describe, expect, it } from 'vitest'
import { demoSnapshot } from '../src/demo/demo-data'
import {
  availableLabels,
  filterIssueKeys,
  formatFilterQuery,
  graphIssueKeys,
  parseFilterQuery,
} from '../src/domain/filters'
import { analyzeGraph } from '../src/domain/graph'

const analysis = analyzeGraph(demoSnapshot.issues)

describe('issue filters', () => {
  it('searches titles, numbers, repositories, and labels', () => {
    const results = filterIssueKeys(analysis, {
      query: 'critical path',
      state: 'all',
      readiness: 'all',
      labels: new Set(),
      showExternal: true,
    })

    expect([...results]).toEqual(['ccheney/github-issue-dag-viewer#16'])
  })

  it('combines state and label filters', () => {
    const results = filterIssueKeys(analysis, {
      query: '',
      state: 'closed',
      readiness: 'all',
      labels: new Set(['area:docs']),
      showExternal: true,
    })

    expect([...results].toSorted()).toEqual([
      'ccheney/github-issue-dag-viewer#31',
      'ccheney/github-issue-dag-viewer#39',
    ])
  })

  it('parses GitHub-style qualifiers without treating them as search text', () => {
    const parsed = parseFilterQuery('is:issue state:open is:ready label:"area:delivery" deployment')

    expect(parsed).toEqual({
      text: 'deployment',
      state: 'open',
      readiness: 'ready',
      labels: new Set(['area:delivery']),
      showExternal: true,
    })
  })

  it('formats menu selections as a GitHub-style query', () => {
    expect(
      formatFilterQuery({
        query: 'deployment',
        state: 'open',
        readiness: 'ready',
        labels: new Set(['area:delivery']),
        showExternal: false,
      }),
    ).toBe('is:issue deployment state:open is:ready label:"area:delivery" -is:external')
  })

  it('filters directly from GitHub-style qualifiers', () => {
    const query = 'is:issue state:closed label:"area:docs"'
    const parsed = parseFilterQuery(query)
    const results = filterIssueKeys(analysis, {
      query,
      state: parsed.state,
      readiness: parsed.readiness,
      labels: parsed.labels,
      showExternal: parsed.showExternal,
    })

    expect([...results]).toEqual([
      'ccheney/github-issue-dag-viewer#31',
      'ccheney/github-issue-dag-viewer#39',
    ])
  })

  it('returns a stable sorted label catalog', () => {
    expect(availableLabels(analysis)).toEqual([
      'area:api',
      'area:delivery',
      'area:docs',
      'area:foundation',
      'area:graph',
      'area:performance',
      'area:quality',
      'area:security',
      'area:ui',
    ])
  })

  it('keeps standalone issues in the list and reveals one when selected in linked-only graph view', () => {
    const edge = analysis.edges[0]
    if (edge === undefined) throw new Error('Demo graph has no edge')
    const standalone = 'example/standalone#1'
    const filtered = new Set([edge.source, edge.target, standalone])
    expect(graphIssueKeys(analysis, filtered, true, null)).toEqual(
      new Set([edge.source, edge.target]),
    )
    expect(graphIssueKeys(analysis, filtered, true, standalone)).toEqual(filtered)
    expect(graphIssueKeys(analysis, filtered, false, null)).toEqual(filtered)
    expect(graphIssueKeys(analysis, new Set([edge.source, standalone]), true, null)).toEqual(
      new Set(),
    )
  })
})
