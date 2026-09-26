import os
import time

import psycopg
from psycopg.rows import dict_row

from rules import judge

DSN = os.environ["DATABASE_URL"]

# 领取后模拟演算耗时，让“领取中”在页面上可被看到
COMPUTE_SECONDS = 2.0


def connect():
    last = None
    for _ in range(40):
        try:
            return psycopg.connect(DSN, row_factory=dict_row)
        except psycopg.OperationalError as exc:
            last = exc
            time.sleep(1)
    raise last


def ensure():
    with connect() as conn:
        conn.execute(
            """CREATE TABLE IF NOT EXISTS jobs (
                id serial PRIMARY KEY,
                sheet text NOT NULL,
                cyan_mm double precision NOT NULL,
                magenta_mm double precision NOT NULL,
                status text NOT NULL,
                verdict text NOT NULL DEFAULT '',
                reason text NOT NULL DEFAULT '',
                created_by text NOT NULL,
                created_at timestamptz NOT NULL
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS gate_events (
                id serial PRIMARY KEY,
                sheet text NOT NULL,
                event text NOT NULL,
                actor text NOT NULL,
                job_id integer,
                conflict_ids integer[] NOT NULL DEFAULT '{}',
                detail text NOT NULL DEFAULT '',
                created_at timestamptz NOT NULL
            )"""
        )
        conn.commit()


def claim_once(conn):
    row = conn.execute(
        """WITH picked AS (
             SELECT id FROM jobs
             WHERE status = 'pending'
             ORDER BY id
             FOR UPDATE SKIP LOCKED
             LIMIT 1
           )
           UPDATE jobs SET status = 'running'
           FROM picked
           WHERE jobs.id = picked.id
           RETURNING jobs.id, jobs.cyan_mm, jobs.magenta_mm"""
    ).fetchone()
    return row


def main():
    ensure()
    while True:
        with connect() as conn:
            row = claim_once(conn)
            conn.commit()
        if row is None:
            time.sleep(0.4)
            continue
        # 已领走（领取中），演算结束后再写回结论
        time.sleep(COMPUTE_SECONDS)
        verdict, reason = judge(row["cyan_mm"], row["magenta_mm"])
        with connect() as conn:
            conn.execute(
                "UPDATE jobs SET status = 'done', verdict = %s, reason = %s WHERE id = %s",
                (verdict, reason, row["id"]),
            )
            conn.commit()


if __name__ == "__main__":
    main()
