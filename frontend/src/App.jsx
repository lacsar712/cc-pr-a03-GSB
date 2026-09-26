import { useCallback, useEffect, useState } from 'react'

const STATUS_LABEL = { pending: '待处理', running: '领取中', done: '已结论' }
const ACTION_LABEL = { admitted: '放行', blocked: '退回' }

class ApiError extends Error {
  constructor(status, data) {
    super(data.detail || `请求失败（${status}）`)
    this.status = status
    this.data = data
  }
}

export default function App() {
  const [username, setUsername] = useState('printer')
  const [password, setPassword] = useState('print123456')
  const [token, setToken] = useState(localStorage.getItem('print_token') || '')
  const [role, setRole] = useState(localStorage.getItem('print_role') || '')
  const [view, setView] = useState('gate')
  const [gateSheet, setGateSheet] = useState(localStorage.getItem('print_gate_sheet') || '插页-02')

  const api = useCallback(
    async (path, options = {}) => {
      const res = await fetch(path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new ApiError(res.status, data)
      return data
    },
    [token],
  )

  async function enter() {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      alert(data.detail || '登录失败')
      return
    }
    localStorage.setItem('print_token', data.access_token)
    localStorage.setItem('print_role', data.role)
    setToken(data.access_token)
    setRole(data.role)
  }

  function leave() {
    localStorage.clear()
    setToken('')
    setRole('')
  }

  function openGate(name) {
    setGateSheet(name)
    localStorage.setItem('print_gate_sheet', name)
    setView('gate')
  }

  if (!token) {
    return (
      <main className="page">
        <h1>印刷套准复核台</h1>
        <p>同名印张互斥：先到先占，出结论后放行。重名门禁专页展示冲突编号、在途与历史。</p>
        <p>
          <input value={username} onChange={(e) => setUsername(e.target.value)} />
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button onClick={enter}>登录</button>
        </p>
        <p>printer / print123456 可投递；checker / check123456 只读（看得到冲突与清单，不能投递）</p>
      </main>
    )
  }

  return (
    <main className="page">
      <header className="topbar">
        <h1>印刷套准复核台</h1>
        <nav className="nav">
          <button className={view === 'gate' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('gate')}>
            重名门禁
          </button>
          <button className={view === 'board' ? 'nav-btn active' : 'nav-btn'} onClick={() => setView('board')}>
            队列总表
          </button>
        </nav>
        <span className="who">
          {username}（{role === 'writer' ? '印刷员·可投递' : '只读'}）<button onClick={leave}>退出</button>
        </span>
      </header>

      {view === 'gate' ? (
        <GatePage api={api} role={role} sheet={gateSheet} onSheetChange={openGate} />
      ) : (
        <BoardPage api={api} onPickSheet={openGate} />
      )}
    </main>
  )
}

function BoardPage({ api, onPickSheet }) {
  const [rows, setRows] = useState([])

  const load = useCallback(async () => {
    setRows(await api('/api/jobs'))
  }, [api])

  useEffect(() => {
    load()
    const timer = setInterval(load, 1000)
    return () => clearInterval(timer)
  }, [load])

  return (
    <section>
      <h2>队列总表</h2>
      <p className="hint">点印张名可进入该名的重名门禁专页。仅靠本表标红不算门禁，拦截以专页与服务端为准。</p>
      <table>
        <thead>
          <tr>
            <th>编号</th><th>印张</th><th>青偏差mm</th><th>品偏差mm</th>
            <th>状态</th><th>结论</th><th>投递人</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className={row.status !== 'done' ? 'row-open' : ''}>
              <td>#{row.id}</td>
              <td>
                <button className="link" onClick={() => onPickSheet(row.sheet)}>{row.sheet}</button>
              </td>
              <td>{row.cyan_mm}</td>
              <td>{row.magenta_mm}</td>
              <td>{STATUS_LABEL[row.status] || row.status}</td>
              <td>{row.verdict || '—'}</td>
              <td>{row.created_by}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function GatePage({ api, role, sheet, onSheetChange }) {
  const [draft, setDraft] = useState(sheet)
  const [data, setData] = useState(null)
  const [cyan, setCyan] = useState('0.08')
  const [magenta, setMagenta] = useState('0.02')
  const [notice, setNotice] = useState(null)

  useEffect(() => setDraft(sheet), [sheet])

  const load = useCallback(async () => {
    const q = encodeURIComponent(sheet)
    setData(await api(`/api/gate?sheet=${q}`))
  }, [api, sheet])

  useEffect(() => {
    load()
    const timer = setInterval(load, 1000)
    return () => clearInterval(timer)
  }, [load])

  async function submit() {
    setNotice(null)
    try {
      const row = await api('/api/jobs', {
        method: 'POST',
        body: JSON.stringify({ sheet, cyan_mm: Number(cyan), magenta_mm: Number(magenta) }),
      })
      setNotice({ kind: 'ok', text: `已放行：新编号 #${row.id} 进入待处理队列` })
      load()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const ids = (err.data.conflict_ids || []).map((i) => `#${i}`).join('、')
        setNotice({ kind: 'bad', text: `退回：${err.data.detail}　冲突编号：${ids}　解除条件：${err.data.release}` })
      } else {
        setNotice({ kind: 'bad', text: err.message })
      }
      load()
    }
  }

  return (
    <section className="gate">
      <h2>重名门禁台</h2>
      <p className="hint">投递前在此查看该印张名是否已有待处理/领取中的冲突编号；同名在途未结一律退回。</p>
      <p>
        <label>印张名：</label>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} />
        <button onClick={() => onSheetChange(draft.trim() || draft)} disabled={!draft.trim()}>
          查该名门禁
        </button>
      </p>

      {/* 上区：冲突监视 */}
      <section className="zone zone-conflict">
        <h3>① 冲突监视{data && <span className="sheet-tag">{data.sheet}</span>}</h3>
        {!data ? (
          <p>加载中…</p>
        ) : data.has_conflict ? (
          <div className="banner banner-block">
            <div>
              <strong>门禁冲突，同名投递将被退回</strong>
              <div>
                冲突编号：
                {data.conflicts.map((c) => (
                  <span key={c.id} className="chip chip-bad">
                    #{c.id}（{STATUS_LABEL[c.status]}）
                  </span>
                ))}
              </div>
            </div>
            <ul className="release">
              {data.conflicts.map((c) => (
                <li key={c.id}>#{c.id} 解除条件：{c.release}</li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="banner banner-ok">
            <strong>门禁放行中：当前无同名在途编号，允许投递新一笔。</strong>
          </div>
        )}

        {role === 'writer' ? (
          <div className="submit-box">
            <label>青偏差mm <input value={cyan} onChange={(e) => setCyan(e.target.value)} /></label>
            <label>品偏差mm <input value={magenta} onChange={(e) => setMagenta(e.target.value)} /></label>
            <button
              className="submit"
              onClick={submit}
              disabled={!data || data.has_conflict}
              title={data?.has_conflict ? '存在同名冲突编号，先解除才能投递' : ''}
            >
              投递该印张
            </button>
            {data?.has_conflict && <span className="hint">按钮锁定：等冲突编号出结论后自动可投</span>}
          </div>
        ) : (
          <p className="banner banner-readonly">只读账号：可查看本页冲突与两栏清单，不能投递。</p>
        )}
        {notice && <p className={notice.kind === 'ok' ? 'banner banner-ok' : 'banner banner-block'}>{notice.text}</p>}

        <h4>门禁流水（按印张名翻查）</h4>
        <table>
          <thead>
            <tr><th>时间</th><th>动作</th><th>关联编号</th><th>冲突编号</th><th>操作人</th><th>说明</th></tr>
          </thead>
          <tbody>
            {(data?.events || []).map((ev) => (
              <tr key={ev.id}>
                <td>{fmtTime(ev.created_at)}</td>
                <td className={ev.action === 'blocked' ? 'text-bad' : 'text-ok'}>
                  {ACTION_LABEL[ev.action] || ev.action}
                </td>
                <td>{ev.job_id ? `#${ev.job_id}` : '—'}</td>
                <td>{(ev.conflict_ids || []).length ? ev.conflict_ids.map((i) => `#${i}`).join('、') : '—'}</td>
                <td>{ev.actor}</td>
                <td>{ev.detail}</td>
              </tr>
            ))}
            {data && data.events.length === 0 && (
              <tr><td colSpan={6} className="empty">该名暂无门禁流水</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* 中区：在途同名 */}
      <section className="zone zone-open">
        <h3>② 在途同名（待处理 / 领取中）</h3>
        <JobTable rows={data?.open || []} loading={!data} empty="在途栏为空：该名当前没有未结编号" />
      </section>

      {/* 下区：历史已结论 */}
      <section className="zone zone-done">
        <h3>③ 历史已结论（可同名再开新一笔）</h3>
        <JobTable rows={data?.history || []} loading={!data} empty="暂无已结论历史" showReason />
      </section>
    </section>
  )
}

function JobTable({ rows, loading, empty, showReason }) {
  return (
    <table>
      <thead>
        <tr>
          <th>编号</th><th>青偏差mm</th><th>品偏差mm</th>
          <th>状态</th><th>结论</th>{showReason && <th>理由</th>}<th>投递人</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>#{row.id}</td>
            <td>{row.cyan_mm}</td>
            <td>{row.magenta_mm}</td>
            <td>{STATUS_LABEL[row.status] || row.status}</td>
            <td>{row.verdict || '—'}</td>
            {showReason && <td>{row.reason || '—'}</td>}
            <td>{row.created_by}</td>
          </tr>
        ))}
        {!loading && rows.length === 0 && (
          <tr><td colSpan={showReason ? 7 : 6} className="empty">{empty}</td></tr>
        )}
      </tbody>
    </table>
  )
}

function fmtTime(iso) {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}
