import { createServer } from 'node:http'

const port = Number(process.env.API_PORT)
const server = createServer((req, res) => {
  if (req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, service: 'local-process-test' }))
    return
  }
  res.writeHead(404)
  res.end()
})

server.listen(port, '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)))
