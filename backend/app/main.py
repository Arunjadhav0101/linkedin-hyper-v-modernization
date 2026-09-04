import asyncio
from contextlib import asynccontextmanager
from datetime import datetime
from uuid import uuid4
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc

from .database import init_db, get_db
from .models import LinkedInAccount, AutomationJob, ChatMessage, Conversation, DeadLetterQueue
from .voyager import VoyagerClient, VoyagerApiError, MissingIntegrationError, ValidationError
from .worker import run_worker_loop, redis_client


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB tables and demo seeds
    try:
        init_db()
    except Exception as e:
        print(f"Warning: Database init encountered: {e}")

    # Start background automation worker loop
    worker_task = asyncio.create_task(run_worker_loop())
    yield
    worker_task.cancel()


app = FastAPI(
    title="LinkedIn Hyper-V 2.0 Automation Engine",
    description="Python Control Plane and Background Automation Worker for LinkedIn",
    version="2.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

voyager_client = VoyagerClient()


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class AccountSaveRequest(BaseModel):
    email: str
    name: Optional[str] = None
    cookies: Optional[Dict[str, str]] = None


class VerifySessionRequest(BaseModel):
    accountId: Optional[str] = None
    li_at: Optional[str] = None
    JSESSIONID: Optional[str] = None


class JobDispatchRequest(BaseModel):
    accountId: str
    type: str
    payload: Dict[str, Any]
    priority: Optional[int] = 0


class SyncRequest(BaseModel):
    accountId: str
    limit: Optional[int] = 20


class MaintenanceRequest(BaseModel):
    action: str  # 'RETRY_DLQ' | 'CLEAR_DLQ'


# ---------------------------------------------------------------------------
# API Endpoints
# ---------------------------------------------------------------------------

@app.get("/health")
def get_health(db: Session = Depends(get_db)):
    db_status = "connected"
    try:
        db.query(LinkedInAccount).first()
    except Exception:
        db_status = "disconnected"

    redis_status = "connected"
    if redis_client:
        try:
            redis_client.ping()
        except Exception:
            redis_status = "disconnected"
    else:
        redis_status = "disabled (in-memory lock fallback)"

    account_count = db.query(LinkedInAccount).count()

    return {
        "status": "healthy" if db_status == "connected" else "degraded",
        "database": db_status,
        "redis": redis_status,
        "activeAccounts": account_count,
        "activeProxies": 0,
        "circuitBreaker": {
            "state": "CLOSED",
            "failureCount": 0,
            "nextAttemptTime": 0,
        },
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/api/accounts")
def list_accounts(db: Session = Depends(get_db)):
    accounts = db.query(LinkedInAccount).order_by(LinkedInAccount.createdAt.asc()).all()
    data = []
    for a in accounts:
        cookies = a.cookies or {}
        li_at = cookies.get("li_at", "")
        has_session = bool(li_at and len(li_at) >= 50)

        if not li_at:
            auth_status = "NOT_CONFIGURED"
        elif len(li_at) < 50:
            auth_status = "SESSION_INVALID"
        else:
            auth_status = "AUTHORIZED"

        pending_count = (
            db.query(AutomationJob)
            .filter(
                AutomationJob.accountId == a.id,
                AutomationJob.status.in_(["QUEUED", "RUNNING", "RETRYING"]),
            )
            .count()
        )

        last_failed_job = (
            db.query(AutomationJob)
            .filter(AutomationJob.accountId == a.id, AutomationJob.status.in_(["FAILED", "DLQ_ROUTED"]))
            .order_by(AutomationJob.updatedAt.desc())
            .first()
        )

        data.append({
            "id": a.id,
            "email": a.email,
            "name": a.name,
            "status": a.status,
            "authStatus": auth_status,
            "hasAuthorizedSession": has_session,
            "pendingJobsCount": pending_count,
            "lastError": last_failed_job.errorMessage if last_failed_job else None,
            "hourlyActionLimit": a.hourlyActionLimit,
            "dailyActionLimit": a.dailyActionLimit,
            "hourlyConnectionLimit": a.hourlyConnectionLimit,
            "dailyConnectionLimit": a.dailyConnectionLimit,
            "hourlyMessageLimit": a.hourlyMessageLimit,
            "dailyMessageLimit": a.dailyMessageLimit,
            "lastActionTimestamp": a.lastActionTimestamp.isoformat() if a.lastActionTimestamp else None,
            "createdAt": a.createdAt.isoformat() if a.createdAt else None,
        })

    return {"success": True, "data": data, "timestamp": datetime.utcnow().isoformat()}


@app.post("/api/accounts")
def save_account(body: AccountSaveRequest, db: Session = Depends(get_db)):
    cookies = body.cookies or {}
    li_at = (cookies.get("li_at") or "").strip().strip('"\'')
    jsessionid = (cookies.get("JSESSIONID") or "").strip().strip('"\'')

    account = db.query(LinkedInAccount).filter(LinkedInAccount.email == body.email).first()
    if not account:
        account = LinkedInAccount(
            id=str(uuid4()),
            email=body.email,
            name=body.name,
            status="ACTIVE",
            cookies={"li_at": li_at, "JSESSIONID": jsessionid},
        )
        db.add(account)
    else:
        if body.name:
            account.name = body.name
        existing_cookies = account.cookies or {}
        if li_at:
            existing_cookies["li_at"] = li_at
        if jsessionid:
            existing_cookies["JSESSIONID"] = jsessionid
        account.cookies = existing_cookies

    db.commit()
    db.refresh(account)

    return {
        "success": True,
        "data": {
            "id": account.id,
            "email": account.email,
            "name": account.name,
            "hasAuthorizedSession": bool(li_at and len(li_at) >= 50),
        },
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/api/accounts/verify")
def verify_session_cookie(body: VerifySessionRequest, db: Session = Depends(get_db)):
    li_at = (body.li_at or "").strip().strip('"\'')
    jsessionid = (body.JSESSIONID or "").strip().strip('"\'')

    target_account = None
    if body.accountId:
        target_account = db.query(LinkedInAccount).filter(LinkedInAccount.id == body.accountId).first()
        if target_account and not li_at:
            c = target_account.cookies or {}
            li_at = c.get("li_at", "")
            jsessionid = c.get("JSESSIONID", "")

    if not li_at or len(li_at) < 50:
        raise HTTPException(
            status_code=400,
            detail="The 'li_at' cookie must be at least 50 characters long (real LinkedIn tokens start with 'AQED...' and are ~150 chars).",
        )

    # Test session live with LinkedIn
    temp_account = LinkedInAccount(
        email=target_account.email if target_account else "test@verify.com",
        cookies={"li_at": li_at, "JSESSIONID": jsessionid},
    )

    try:
        result = voyager_client.verify_session(temp_account)
        if target_account:
            if result.get("publicIdentifier"):
                target_account.publicIdentifier = result["publicIdentifier"]
            if result.get("plainId"):
                target_account.linkedinId = str(result["plainId"])
            db.commit()

        return {
            "success": True,
            "data": result,
            "timestamp": datetime.utcnow().isoformat(),
        }
    except VoyagerApiError as err:
        return {
            "success": False,
            "error": {"code": f"HTTP_{err.status_code}", "message": err.message},
            "timestamp": datetime.utcnow().isoformat(),
        }
    except Exception as exc:
        return {
            "success": False,
            "error": {"code": "VERIFICATION_ERROR", "message": str(exc)},
            "timestamp": datetime.utcnow().isoformat(),
        }


@app.post("/api/jobs/dispatch")
def dispatch_job(body: JobDispatchRequest, db: Session = Depends(get_db)):
    account = db.query(LinkedInAccount).filter(LinkedInAccount.id == body.accountId).first()
    if not account:
        raise HTTPException(status_code=404, detail=f"LinkedInAccount '{body.accountId}' not found")

    # Pre-flight account check
    cookies = account.cookies or {}
    li_at = (cookies.get("li_at") or "").strip()
    if not li_at or len(li_at) < 50:
        raise HTTPException(
            status_code=400,
            detail=f"Account '{account.email}' is not authorized for live actions. Enter a valid 'li_at' session cookie in Accounts tab.",
        )

    job_id = str(uuid4())
    trace_id = str(uuid4())

    job = AutomationJob(
        id=job_id,
        traceId=trace_id,
        accountId=account.id,
        type=body.type,
        payload=body.payload,
        priority=body.priority or 0,
        status="QUEUED",
        scheduledFor=datetime.utcnow(),
    )
    db.add(job)
    db.commit()

    return {
        "success": True,
        "data": {
            "jobId": job.id,
            "traceId": job.traceId,
            "status": "QUEUED",
            "type": job.type,
        },
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.get("/api/jobs")
def list_jobs(limit: int = Query(50, ge=1, le=100), db: Session = Depends(get_db)):
    jobs = (
        db.query(AutomationJob)
        .order_by(desc(AutomationJob.createdAt))
        .limit(limit)
        .all()
    )

    account_ids = list(set([j.accountId for j in jobs]))
    accounts = db.query(LinkedInAccount).filter(LinkedInAccount.id.in_(account_ids)).all() if account_ids else []
    account_map = {a.id: a.email for a in accounts}

    data = []
    for j in jobs:
        data.append({
            "id": j.id,
            "traceId": j.traceId,
            "accountId": j.accountId,
            "accountEmail": account_map.get(j.accountId, "Unknown"),
            "type": j.type,
            "payload": j.payload,
            "status": j.status,
            "priority": j.priority,
            "retryCount": j.retryCount,
            "maxRetries": j.maxRetries,
            "errorMessage": j.errorMessage,
            "scheduledFor": j.scheduledFor.isoformat() if j.scheduledFor else None,
            "startedAt": j.startedAt.isoformat() if j.startedAt else None,
            "completedAt": j.completedAt.isoformat() if j.completedAt else None,
            "createdAt": j.createdAt.isoformat() if j.createdAt else None,
        })

    return {"success": True, "data": data, "timestamp": datetime.utcnow().isoformat()}


@app.get("/api/messages")
def list_messages(limit: int = Query(50, ge=1, le=200), db: Session = Depends(get_db)):
    msgs = (
        db.query(ChatMessage)
        .order_by(ChatMessage.sentAt.asc())
        .limit(limit)
        .all()
    )
    data = []
    for m in msgs:
        data.append({
            "id": m.id,
            "conversationId": m.conversationId,
            "senderId": m.senderId,
            "senderName": m.senderName,
            "recipientId": m.recipientId,
            "recipientName": m.recipientName,
            "content": m.content,
            "direction": m.direction,
            "syncStatus": m.syncStatus,
            "sentAt": m.sentAt.isoformat() if m.sentAt else None,
            "idempotencyKey": m.idempotencyKey,
        })

    return {"success": True, "data": data, "timestamp": datetime.utcnow().isoformat()}


@app.post("/api/sync")
def trigger_sync(body: SyncRequest, db: Session = Depends(get_db)):
    account = db.query(LinkedInAccount).filter(LinkedInAccount.id == body.accountId).first()
    if not account:
        raise HTTPException(status_code=404, detail=f"LinkedInAccount '{body.accountId}' not found")

    job_id = str(uuid4())
    trace_id = str(uuid4())

    job = AutomationJob(
        id=job_id,
        traceId=trace_id,
        accountId=account.id,
        type="SYNC_MESSAGES",
        payload={"limit": body.limit or 20},
        status="QUEUED",
        scheduledFor=datetime.utcnow(),
    )
    db.add(job)
    db.commit()

    return {
        "success": True,
        "data": {"jobId": job.id, "status": "QUEUED", "type": "SYNC_MESSAGES"},
        "timestamp": datetime.utcnow().isoformat(),
    }


@app.post("/api/maintenance/reset")
def maintenance_action(body: MaintenanceRequest, db: Session = Depends(get_db)):
    action = body.action

    if action == "CLEAR_DLQ":
        db.query(DeadLetterQueue).delete()
        failed_jobs = db.query(AutomationJob).filter(AutomationJob.status == "DLQ_ROUTED").all()
        for j in failed_jobs:
            j.status = "FAILED"
        db.commit()
        return {"success": True, "message": "DLQ records cleared"}

    elif action == "RETRY_DLQ":
        retried_jobs = (
            db.query(AutomationJob)
            .filter(AutomationJob.status.in_(["FAILED", "DLQ_ROUTED", "TIMED_OUT"]))
            .all()
        )
        for j in retried_jobs:
            j.status = "QUEUED"
            j.retryCount = 0
            j.errorMessage = None
            j.scheduledFor = datetime.utcnow()
        db.commit()
        return {"success": True, "message": f"Re-queued {len(retried_jobs)} failed/DLQ jobs"}

    else:
        raise HTTPException(status_code=400, detail=f"Unsupported maintenance action: '{action}'")
