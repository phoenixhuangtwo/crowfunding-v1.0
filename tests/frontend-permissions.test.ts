import assert from 'node:assert/strict'
import test from 'node:test'

import { allowedPageKeys, canApi, canUi } from '../src/auth/permissions.ts'

test('allowedPageKeys follows IAM menu order and ignores unknown/duplicate components', () => {
  const info = {
    menus: [
      { componentName: 'rules', children: [{ component: 'unknown' }] },
      { component: 'projects' },
      { component: 'rules' },
      { component: 'adminProjects', children: [{ componentName: 'audit' }] }
    ]
  }
  assert.deepEqual(allowedPageKeys(info), ['rules', 'projects', 'adminProjects', 'audit'])
})

test('allowedPageKeys returns no local defaults when IAM menus are empty or unknown', () => {
  assert.deepEqual(allowedPageKeys({ menus: [] }), [])
  assert.deepEqual(allowedPageKeys({ menus: [{ component: 'rbac' }, { component: 'local-default' }] }), [])
  assert.deepEqual(allowedPageKeys(null), [])
})

test('canApi and canUi require explicit IAM permission codes', () => {
  const info = {
    permissions: ['crowdfunding:access'],
    apiPermissions: ['crowdfunding:project:query'],
    uiPermissions: ['crowdfunding:project:open']
  }
  assert.equal(canApi(info, 'crowdfunding:project:query'), true)
  assert.equal(canApi(info, 'crowdfunding:project:open'), false)
  assert.equal(canUi(info, 'crowdfunding:project:open'), true)
  assert.equal(canUi(info, 'crowdfunding:project:query'), false)
  assert.equal(canApi(info, 'crowdfunding:*'), false)
  assert.equal(canApi({ permissions: ['crowdfunding:project:open'], uiPermissions: ['crowdfunding:project:open'] }, 'crowdfunding:project:open'), false)
  assert.equal(canUi({ permissions: ['crowdfunding:project:query'], apiPermissions: ['crowdfunding:project:query'] }, 'crowdfunding:project:query'), false)
})

test('App uses API permission guards for actions and renders an empty state for unauthorized menus', async () => {
  const { readFile } = await import('node:fs/promises')
  const app = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(app, /function requireApiPermission\(code: string\)/)
  assert.doesNotMatch(app, /function requireUiPermission/)
  assert.match(app, /data-testid="iam-empty-navigation"/)
  assert.match(app, /currentPage\.value = firstPage \?\? ''/)
  assert.match(app, /if \(firstPage\) void loadData\(\)/)
})
