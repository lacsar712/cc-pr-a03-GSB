import { useEffect, useState } from 'react'

const STATUS_LABEL = { pending: '待处理', running: '领取中', done: '已出结论' }
const EVENT_LABEL = { released: '放行', blocked: '拦截' }

function fmtTime(t) {
  if (!t) return ''
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

export default function App() {
  const [username, setUsername] = useState('printer')
  const [password, setPassword] = useState('print123456')
  const [token, setToken] = useState(localStorage.getItem('print_token') || '')
  const [role, setRole] = useState(localStorage.getItem('print_role') || '')
  const [name, setName] = useState(localStorage.getItem('print_name') || '')
  const [view, setView] = useState('queue')
  const [rows, setRows] = useState([])
  const [sheet, setSheet] = useState('样张甲')
  const [cyan, setCyan] = useState('0.08')
  const [magenta, setMagenta] = useState('0.02')
  const [error, setError] = useState('')
  const [conflictIds, setConflictIds] = useState([])
  const [gateSheet, setGateSheet] = useState('样张甲')

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      const detail = data.detail
      const message =
        detail && typeof detail === 'object' ? detail.message || '请求失败' : detail || '请求失败'
      const err = new Error(message)
      if (detail && typeof detail === 'object' && Array.isArray(detail.conflict_ids)) {
        err.conflictIds = detail.conflict_ids
      }
      throw err
    }
    return data
  }

  async function load() {
    try {
      setRows(await api('/api/jobs'))
    } catch {
      /* 轮询失败下轮再试 */
    }
  }

  useEffect(() => {
    if (!token) return
    load()
    const timer = setInterval(load, 1000)
    return () => clearInterval(timer)
  }, [token])

  async function enter() {
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
    localStorage.setItem('print_token', data.access_token)
    localStorage.setItem('print_role', data.role)
    localStorage.setItem('print_name', data.username)
    setToken(data.access_token)
    setRole(data.role)
    setName(data.username)
  }

  async function send() {
    setError('')
    setConflictIds([])
    try {
      await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({
          sheet,
          cyan_mm: Number(cyan),
          magenta_mm: Number(magenta),
        }),
      })
    } catch (err) {
      setError(err.message)
      if (err.conflictIds) setConflictIds(err.conflictIds)
    }
  }

  function leave() {
    localStorage.clear()
    setToken('')
    setRole('')
    setName('')
  }

  function openGate(target) {
    setGateSheet(target)
    setView('gate')
  }

  if (!token) {
    return (
      <main>
        <h1>印刷套准复核台</h1>
        <p>提交后接口只入队。另一进程领走偏差并写结论，页面轮询到结论出现。同名在途时投递会被门禁退回。</p>
        <input value={username} onChange={(e) => setUsername(e.target.value)} />
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button onClick={enter}>登录</button>
        <p>printer / print123456 可送复核；checker / check123456 只看</p>
      </main>
    )
  }

  return (
    <main>
      <h1>印刷套准复核台</h1>
      <nav>
        <button className={view === 'queue' ? 'active' : ''} onClick={() => setView('queue')}>
          复核队列
        </button>
        <button className={view === 'gate' ? 'active' : ''} onClick={() => setView('gate')}>
          重名门禁
        </button>
        <span className="who">
          {name}（{role === 'writer' ? '印刷员' : '只读'}）
        </span>
        <button onClick={leave}>退出</button>
      </nav>

      {view === 'queue' && (
        <section>
          {role === 'writer' ? (
            <p>
              <input value={sheet} onChange={(e) => setSheet(e.target.value)} placeholder="印张名" />
              <input value={cyan} onChange={(e) => setCyan(e.target.value)} placeholder="青偏差" />
              <input value={magenta} onChange={(e) => setMagenta(e.target.value)} placeholder="品偏差" />
              <button onClick={send}>送复核</button>
              <button onClick={() => openGate(sheet)}>投递前查同名门禁</button>
            </p>
          ) : (
            <p className="hint">只读账号：可查看队列与重名门禁台，不能投递。</p>
          )}
          {error && (
            <p className="error-box">
              {error}
              {conflictIds.length > 0 && (
                <>
                  {'　冲突编号：'}
                  {conflictIds.map((id) => (
                    <span key={id} className="chip">
                      #{id}
                    </span>
                  ))}
                  <button className="link-btn" onClick={() => openGate(sheet)}>
                    打开重名门禁台
                  </button>
                </>
              )}
            </p>
          )}
          <table>
            <thead>
              <tr>
                <th>编号</th>
                <th>印张</th>
                <th>青</th>
                <th>品</th>
                <th>状态</th>
                <th>结论</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>#{row.id}</td>
                  <td>{row.sheet}</td>
                  <td>{row.cyan_mm}</td>
                  <td>{row.magenta_mm}</td>
                  <td>{STATUS_LABEL[row.status] || row.status}</td>
                  <td>{row.verdict || '等待'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {view === 'gate' && (
        <GateView api={api} role={role} sheet={gateSheet} onSheetChange={setGateSheet} />
      )}
    </main>
  )
}

function GateView({ api, role, sheet, onSheetChange }) {
  const [status, setStatus] = useState(null)
  const [events, setEvents] = useState([])
  const [onlyThis, setOnlyThis] = useState(true)

  useEffect(() => {
    const name = sheet.trim()
    if (!name) {
      setStatus(null)
      setEvents([])
      return
    }
    let dead = false
    async function load() {
      try {
        const s = await api(`/api/gate/status?sheet=${encodeURIComponent(name)}`)
        const ev = await api(
          onlyThis ? `/api/gate/events?sheet=${encodeURIComponent(name)}` : '/api/gate/events'
        )
        if (!dead) {
          setStatus(s)
          setEvents(ev)
        }
      } catch {
        /* 轮询失败下轮再试 */
      }
    }
    load()
    const timer = setInterval(load, 1000)
    return () => {
      dead = true
      clearInterval(timer)
    }
  }, [sheet, onlyThis])

  return (
    <section>
      <p>
        印张名：
        <input value={sheet} onChange={(e) => onSheetChange(e.target.value)} placeholder="输入印张名查看门禁" />
        {role !== 'writer' && <span className="hint">　只读账号：门禁台仅供查看，不能投递。</span>}
      </p>
      {!status && <p className="hint">输入印张名后展示该名的门禁状态。</p>}
      {status && (
        <>
          <div className="zone">
            <h3>上区 · 冲突监视</h3>
            <p className={`gate-banner ${status.blocked ? 'blocked' : 'open'}`}>
              {status.blocked
                ? `⛔ 「${status.sheet}」当前有在途同名，现在投递会被退回`
                : `✅ 「${status.sheet}」当前无在途同名，可以投递`}
            </p>
            {status.blocked && (
              <p>
                冲突编号：
                {status.conflict_ids.map((id) => (
                  <span key={id} className="chip">
                    #{id}
                  </span>
                ))}
              </p>
            )}
            <p>解除条件：{status.release_condition}</p>
          </div>

          <div className="zone">
            <h3>中区 · 在途同名（待处理 / 领取中）</h3>
            {status.inflight.length === 0 ? (
              <p className="hint">当前无在途同名。</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>编号</th>
                    <th>状态</th>
                    <th>青</th>
                    <th>品</th>
                    <th>投递人</th>
                    <th>投递时间</th>
                  </tr>
                </thead>
                <tbody>
                  {status.inflight.map((row) => (
                    <tr key={row.id}>
                      <td>#{row.id}</td>
                      <td>{STATUS_LABEL[row.status] || row.status}</td>
                      <td>{row.cyan_mm}</td>
                      <td>{row.magenta_mm}</td>
                      <td>{row.created_by}</td>
                      <td>{fmtTime(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="zone">
            <h3>下区 · 历史已结论</h3>
            {status.concluded.length === 0 ? (
              <p className="hint">暂无已结论记录。</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>编号</th>
                    <th>结论</th>
                    <th>理由</th>
                    <th>青</th>
                    <th>品</th>
                    <th>投递人</th>
                    <th>投递时间</th>
                  </tr>
                </thead>
                <tbody>
                  {status.concluded.map((row) => (
                    <tr key={row.id}>
                      <td>#{row.id}</td>
                      <td>{row.verdict}</td>
                      <td>{row.reason}</td>
                      <td>{row.cyan_mm}</td>
                      <td>{row.magenta_mm}</td>
                      <td>{row.created_by}</td>
                      <td>{fmtTime(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="zone">
            <h3>门禁流水</h3>
            <p>
              <label>
                <input type="checkbox" checked={onlyThis} onChange={(e) => setOnlyThis(e.target.checked)} />
                只看「{status.sheet}」
              </label>
            </p>
            {events.length === 0 ? (
              <p className="hint">暂无流水。</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>印张</th>
                    <th>事件</th>
                    <th>操作人</th>
                    <th>新编号</th>
                    <th>冲突编号</th>
                    <th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((ev) => (
                    <tr key={ev.id}>
                      <td>{fmtTime(ev.created_at)}</td>
                      <td>{ev.sheet}</td>
                      <td className={`event-${ev.event}`}>{EVENT_LABEL[ev.event] || ev.event}</td>
                      <td>{ev.actor}</td>
                      <td>{ev.job_id ? `#${ev.job_id}` : ''}</td>
                      <td>
                        {ev.conflict_ids.map((id) => (
                          <span key={id} className="chip">
                            #{id}
                          </span>
                        ))}
                      </td>
                      <td>{ev.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </section>
  )
}
