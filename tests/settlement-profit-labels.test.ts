import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('settlement screen does not present estimates or invoice totals as distributable profit', async () => {
  const source = await readFile(new URL('../src/App.vue', import.meta.url), 'utf8')
  const settlement = source.slice(source.indexOf("currentPage === 'settlement'"), source.indexOf('data-testid="settlement-invoice-upload-card"'))

  assert.match(settlement, /预计项目利润/)
  assert.match(settlement, /实际可分配利润/)
  assert.match(settlement, /待实收、补款及成本核实后计算/)
  assert.match(settlement, /累计已确认凭证金额/)
  assert.match(settlement, /label="预估收益"/)
  assert.doesNotMatch(settlement, /projectProfitAmount\(selectedProject\) \* 0\.1/)
  assert.doesNotMatch(settlement, /formatMoney\(row\.profit\)/)
})
