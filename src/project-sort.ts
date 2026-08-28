function createdAtTimestamp(value?: string) {
  if (!value) return 0
  const timestamp = new Date(value.replace(' ', 'T')).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function sortProjectsByCreatedAtDesc<T extends { createdAt?: string }>(projects: T[]) {
  return [...projects].sort((left, right) => createdAtTimestamp(right.createdAt) - createdAtTimestamp(left.createdAt))
}
