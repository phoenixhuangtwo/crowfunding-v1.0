import assert from 'node:assert/strict'
import test from 'node:test'

test('project management defaults to newest creation time and keeps missing times last', async () => {
  const projectSort = await import('../src/project-sort.ts') as {
    sortProjectsByCreatedAtDesc?: <T extends { id: string; createdAt?: string }>(projects: T[]) => T[]
  }
  assert.equal(typeof projectSort.sortProjectsByCreatedAtDesc, 'function')

  const sorted = projectSort.sortProjectsByCreatedAtDesc!([
    { id: 'older', createdAt: '2026-08-01 09:00:00' },
    { id: 'missing' },
    { id: 'newer', createdAt: '2026-08-28 18:30:00' }
  ])

  assert.deepEqual(sorted.map(project => project.id), ['newer', 'older', 'missing'])
})
