import os
from datetime import datetime, timedelta, timezone

import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel
from psycopg.rows import dict_row

DSN = os.environ.get("DATABASE_URL", "postgresql://app:app@localhost:54394/printreg")
SECRET = os.environ.get("JWT_SECRET", "print-register-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")
security = HTTPBearer(auto_error=False)
USERS = {
    "printer": {"role": "writer", "password_hash": pwd.hash("print123456")},
    "checker": {"role": "reader", "password_hash": pwd.hash("check123456")},
}

IN_FLIGHT_STATUSES = ("pending", "running")


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id serial PRIMARY KEY,
    sheet text NOT NULL,
    cyan_mm double precision NOT NULL,
    magenta_mm double precision NOT NULL,
    status text NOT NULL,
    verdict text NOT NULL DEFAULT '',
    reason text NOT NULL DEFAULT '',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS gate_events (
    id serial PRIMARY KEY,
    sheet text NOT NULL,
    event text NOT NULL,
    actor text NOT NULL,
    job_id integer,
    conflict_ids integer[] NOT NULL DEFAULT '{}',
    detail text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_events_sheet_idx ON gate_events (sheet);
"""


class LoginIn(BaseModel):
    username: str
    password: str


class JobIn(BaseModel):
    sheet: str
    cyan_mm: float
    magenta_mm: float


def current_user(credentials: HTTPAuthorizationCredentials | None = Depends(security)) -> dict:
    if credentials is None:
        raise HTTPException(status_code=401, detail="未登录")
    try:
        payload = jwt.decode(credentials.credentials, SECRET, algorithms=["HS256"])
    except JWTError as exc:
        raise HTTPException(status_code=401, detail="无效令牌") from exc
    if payload.get("sub") not in USERS:
        raise HTTPException(status_code=401, detail="无效令牌")
    return {"username": payload["sub"], "role": payload.get("role")}


def require_writer(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "writer":
        raise HTTPException(status_code=403, detail="仅印刷员可送复核")
    return user


def fmt_ids(ids: list[int]) -> str:
    return "、".join(f"#{i}" for i in ids)


app = FastAPI(title="印刷套准复核台")


@app.on_event("startup")
def startup():
    with connect() as conn:
        conn.execute(SCHEMA)
        n = conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()["n"]
        if n == 0:
            now = datetime.now(timezone.utc)
            conn.execute(
                """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, status, verdict, reason, created_by, created_at)
                   VALUES
                   ('封面-01', 0.05, -0.04, 'pending', '', '', 'printer', %s),
                   ('内页-09', 0.40, 0.02, 'pending', '', '', 'printer', %s)""",
                (now, now),
            )
        conn.commit()


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "print-register-review"}


@app.post("/api/auth/login")
def login(body: LoginIn):
    user = USERS.get(body.username.strip())
    if not user or not pwd.verify(body.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="用户名或密码错误")
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode({"sub": body.username.strip(), "role": user["role"], "exp": exp}, SECRET, algorithm="HS256")
    return {"access_token": token, "username": body.username.strip(), "role": user["role"]}


@app.get("/api/jobs")
def list_jobs(_user: dict = Depends(current_user)):
    with connect() as conn:
        return conn.execute(
            "SELECT id, sheet, cyan_mm, magenta_mm, status, verdict, reason, created_by FROM jobs ORDER BY id DESC"
        ).fetchall()


@app.post("/api/jobs", status_code=202)
def enqueue(body: JobIn, user: dict = Depends(require_writer)):
    sheet = body.sheet.strip()
    if not sheet:
        raise HTTPException(status_code=400, detail="印张名不能为空")
    now = datetime.now(timezone.utc)
    conflict_ids: list[int] = []
    row = None
    with connect() as conn:
        # 同名投递串行化，防止并发下双双放行
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (sheet,))
        inflight = conn.execute(
            "SELECT id FROM jobs WHERE sheet = %s AND status = ANY(%s) ORDER BY id",
            (sheet, list(IN_FLIGHT_STATUSES)),
        ).fetchall()
        if inflight:
            conflict_ids = [r["id"] for r in inflight]
            conn.execute(
                """INSERT INTO gate_events (sheet, event, actor, conflict_ids, detail, created_at)
                   VALUES (%s, 'blocked', %s, %s, %s, %s)""",
                (
                    sheet,
                    user["username"],
                    conflict_ids,
                    f"同名在途（待处理或领取中），退回投递；冲突编号 {fmt_ids(conflict_ids)}",
                    now,
                ),
            )
        else:
            row = conn.execute(
                """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, status, created_by, created_at)
                   VALUES (%s, %s, %s, 'pending', %s, %s)
                   RETURNING id, sheet, status, verdict""",
                (sheet, body.cyan_mm, body.magenta_mm, user["username"], now),
            ).fetchone()
            conn.execute(
                """INSERT INTO gate_events (sheet, event, actor, job_id, conflict_ids, detail, created_at)
                   VALUES (%s, 'released', %s, %s, %s, %s, %s)""",
                (
                    sheet,
                    user["username"],
                    row["id"],
                    [],
                    f"无在途同名，放行新编号 #{row['id']}",
                    now,
                ),
            )
        conn.commit()
    if conflict_ids:
        raise HTTPException(
            status_code=409,
            detail={
                "message": f"印张「{sheet}」已有在途同名（待处理或领取中），本次投递被退回",
                "conflict_ids": conflict_ids,
            },
        )
    return row


@app.get("/api/gate/status")
def gate_status(sheet: str = "", _user: dict = Depends(current_user)):
    name = sheet.strip()
    with connect() as conn:
        inflight = conn.execute(
            """SELECT id, sheet, status, cyan_mm, magenta_mm, created_by, created_at
               FROM jobs WHERE sheet = %s AND status = ANY(%s) ORDER BY id""",
            (name, list(IN_FLIGHT_STATUSES)),
        ).fetchall()
        concluded = conn.execute(
            """SELECT id, sheet, status, verdict, reason, cyan_mm, magenta_mm, created_by, created_at
               FROM jobs WHERE sheet = %s AND status = 'done' ORDER BY id DESC""",
            (name,),
        ).fetchall()
    conflict_ids = [r["id"] for r in inflight]
    if conflict_ids:
        release = f"等冲突编号 {fmt_ids(conflict_ids)} 出结论（状态变为已出结论）后自动解除，届时可再投同名"
    else:
        release = "当前无在途同名，可直接投递；历史已结论不拦截新投递"
    return {
        "sheet": name,
        "blocked": bool(conflict_ids),
        "conflict_ids": conflict_ids,
        "release_condition": release,
        "inflight": inflight,
        "concluded": concluded,
    }


@app.get("/api/gate/events")
def list_gate_events(sheet: str = "", _user: dict = Depends(current_user)):
    name = sheet.strip()
    with connect() as conn:
        if name:
            return conn.execute(
                """SELECT id, sheet, event, actor, job_id, conflict_ids, detail, created_at
                   FROM gate_events WHERE sheet = %s ORDER BY id DESC LIMIT 200""",
                (name,),
            ).fetchall()
        return conn.execute(
            """SELECT id, sheet, event, actor, job_id, conflict_ids, detail, created_at
               FROM gate_events ORDER BY id DESC LIMIT 200"""
        ).fetchall()
