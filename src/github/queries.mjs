export const REPOSITORY_PAGE_QUERY = `
  query RepositoryIssueDependencies($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      url
      description
      isPrivate
      issues(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: ASC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          id number title url state stateReason createdAt updatedAt closedAt
          author { login avatarUrl url }
          assignees(first: 20) { nodes { login avatarUrl url } }
          labels(first: 50) { nodes { name color description } }
          milestone { title url }
          blockedBy(first: 100) {
            totalCount
            nodes { number state title url repository { nameWithOwner } }
          }
          blocking(first: 100) {
            totalCount
            nodes { number state title url repository { nameWithOwner } }
          }
        }
      }
    }
    rateLimit { cost remaining resetAt }
  }
`

export const ISSUE_DETAILS_QUERY = `
  query IssueDetails($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) { number body updatedAt }
    }
    rateLimit { cost remaining resetAt }
  }
`
