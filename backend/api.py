import os
from datetime import datetime, timedelta, timezone

import psycopg
from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from psycopg.errors import UniqueViolation
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

# 同印张名互斥：仅 pending/running 占用名字，出结论（done）后自动放行。
# 部分唯一索引是硬门禁，即使两个投递并发落库也只会放进一笔。
OPEN_STATUSES = ("pending", "running")
STATUS_LABEL = {"pending": "待处理", "running": "领取中", "done": "已结论"}
JOB_COLS = "id, sheet, cyan_mm, magenta_mm, status, verdict, reason, created_by, created_at"

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
CREATE UNIQUE INDEX IF NOT EXISTS jobs_sheet_open_uidx
    ON jobs (sheet) WHERE status IN ('pending', 'running');
CREATE TABLE IF NOT EXISTS gate_events (
    id serial PRIMARY KEY,
    sheet text NOT NULL,
    action text NOT NULL,
    job_id integer,
    conflict_ids bigint[] NOT NULL DEFAULT '{}',
    actor text NOT NULL,
    detail text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS gate_events_sheet_id_idx ON gate_events (sheet, id DESC);
"""


def connect():
    return psycopg.connect(DSN, row_factory=dict_row)


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
        raise HTTPException(status_code=403, detail="只读账号不能投递，仅可查看冲突与清单")
    return user


def release_condition(row: dict) -> str:
    return f"编号 #{row['id']}（{STATUS_LABEL[row['status']]}）出具复核结论（套准/套不准）后自动解除"


def conflict_body(sheet: str, conflicts: list[dict]) -> dict:
    ids = [c["id"] for c in conflicts]
    labels = "、".join(f"#{c['id']}（{STATUS_LABEL[c['status']]}）" for c in conflicts)
    return {
        "detail": f"印张「{sheet}」已有同名在途编号 {labels}，互斥门禁退回本笔",
        "sheet": sheet,
        "conflict_ids": ids,
        "conflicts": [{"id": c["id"], "status": c["status"]} for c in conflicts],
        "release": "；".join(release_condition(c) for c in conflicts),
    }


def log_gate(conn, sheet: str, action: str, job_id, conflict_ids: list[int], actor: str, detail: str):
    conn.execute(
        """INSERT INTO gate_events (sheet, action, job_id, conflict_ids, actor, detail, created_at)
           VALUES (%s, %s, %s, %s, %s, %s, %s)""",
        (sheet, action, job_id, conflict_ids, actor, detail, datetime.now(timezone.utc)),
    )


def find_open(conn, sheet: str) -> list[dict]:
    return conn.execute(
        "SELECT id, status FROM jobs WHERE sheet = %s AND status = ANY(%s) ORDER BY id",
        (sheet, list(OPEN_STATUSES)),
    ).fetchall()


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
            f"SELECT {JOB_COLS} FROM jobs ORDER BY id DESC"
        ).fetchall()


@app.get("/api/gate")
def gate_page(sheet: str, _user: dict = Depends(current_user)):
    name = sheet.strip()
    if not name:
        raise HTTPException(status_code=400, detail="印张名不能为空")
    with connect() as conn:
        open_rows = conn.execute(
            f"SELECT {JOB_COLS} FROM jobs WHERE sheet = %s AND status = ANY(%s) ORDER BY id",
            (name, list(OPEN_STATUSES)),
        ).fetchall()
        history = conn.execute(
            f"SELECT {JOB_COLS} FROM jobs WHERE sheet = %s AND status = 'done' ORDER BY id DESC",
            (name,),
        ).fetchall()
        events = conn.execute(
            """SELECT id, action, job_id, conflict_ids, actor, detail, created_at
               FROM gate_events WHERE sheet = %s ORDER BY id DESC LIMIT 100""",
            (name,),
        ).fetchall()
    return {
        "sheet": name,
        "has_conflict": bool(open_rows),
        "open": open_rows,
        "conflicts": [
            {"id": r["id"], "status": r["status"], "release": release_condition(r)} for r in open_rows
        ],
        "history": history,
        "events": events,
    }


@app.post("/api/jobs", status_code=202)
def enqueue(body: JobIn, user: dict = Depends(require_writer)):
    sheet = body.sheet.strip()
    if not sheet:
        raise HTTPException(status_code=400, detail="印张名不能为空")
    with connect() as conn:
        conflicts = find_open(conn, sheet)
        if conflicts:
            log_gate(
                conn, sheet, "blocked", None, [c["id"] for c in conflicts],
                user["username"], "同名在途未结，投递退回",
            )
            conn.commit()
            return JSONResponse(status_code=409, content=conflict_body(sheet, conflicts))
        try:
            row = conn.execute(
                """INSERT INTO jobs (sheet, cyan_mm, magenta_mm, status, created_by, created_at)
                   VALUES (%s, %s, %s, 'pending', %s, %s)
                   RETURNING id, sheet, status, verdict""",
                (sheet, body.cyan_mm, body.magenta_mm, user["username"], datetime.now(timezone.utc)),
            ).fetchone()
        except UniqueViolation:
            # 并发投递抢同名：唯一索引兜底，本笔退回并补记 blocked 流水。
            conn.rollback()
            conflicts = find_open(conn, sheet)
            log_gate(
                conn, sheet, "blocked", None, [c["id"] for c in conflicts],
                user["username"], "并发同名投递，唯一索引退回",
            )
            conn.commit()
            return JSONResponse(status_code=409, content=conflict_body(sheet, conflicts))
        log_gate(
            conn, sheet, "admitted", row["id"], [],
            user["username"], f"放行新编号 #{row['id']} 进入待处理队列",
        )
        conn.commit()
    return row
