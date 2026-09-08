import asyncio
import os
import urllib.parse
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from uuid import uuid4
from typing import Optional, Dict, Any, List

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session
from sqlalchemy import desc

from .database import init_db, get_db
from .models import LinkedInAccount, AutomationJob, ChatMessage, Conversation, DeadLetterQueue
from .worker import run_worker_loop, redis_client
from .crypto import encrypt_token, decrypt_token, redact_token
from .oauth_service import oauth_service, validate_account_auth
from .circuit_breaker import circuit_breaker


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Initialize DB tables and migrate schema
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
    description="Python Control Plane with Secure LinkedIn OAuth 2.0 Integration",
    version="2.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------------------------

class CreateAccountRequest(BaseModel):
    email: str
    name: Optional[str] = None


class DisconnectRequest(BaseModel):
    accountId: str


class ReconnectRequest(BaseModel):
    accountId: str


class JobDispatchRequest(BaseModel):
    accountId: str
    type: str
    payload: Dict[str, Any]
    priority: Optional[int] = 0


class SyncRequest(BaseModel):
    accountId: str
    limit: Optional[int] = 20


class MaintenanceRequest(BaseModel):
    action: str  # 'RETRY_DLQ' | 'CLEAR_DLQ' | 'CLEAR_JOBS'


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

    accounts = db.query(LinkedInAccount).all()
    account_count = len(accounts)

    connected_count = sum(1 for a in accounts if a.authStatus == "CONNECTED")
    expired_count = sum(1 for a in accounts if a.authStatus == "AUTHORIZATION_EXPIRED")
    not_connected_count = sum(1 for a in accounts if (a.authStatus or "NOT_CONNECTED") == "NOT_CONNECTED")
    error_count = sum(1 for a in accounts if a.authStatus == "ERROR")

    if connected_count > 0:
        overall_status = "CONNECTED"
    elif expired_count > 0:
        overall_status = "AUTHORIZATION_EXPIRED"
    elif error_count > 0:
        overall_status = "ERROR"
    else:
        overall_status = "NOT_CONNECTED"

    infra_healthy = (db_status == "connected")

    return {
        "status": "healthy" if infra_healthy else "degraded",
        "database": db_status,
        "redis": redis_status,
        "activeAccounts": account_count,
        "infrastructure": {
            "database": db_status,
            "redis": redis_status,
            "worker": "active",
            "api": "healthy",
        },
        "externalIntegration": {
            "provider": "LinkedIn OAuth 2.0 (OpenID Connect)",
            "connectedAccounts": connected_count,
            "notConnectedAccounts": not_connected_count,
            "expiredAccounts": expired_count,
            "errorAccounts": error_count,
            "overallStatus": overall_status,
        },
        "circuitBreaker": circuit_breaker.to_dict(),
        "timestamp": datetime.utcnow().isoformat(),
    }


# ---------------------------------------------------------------------------
# Official LinkedIn OAuth 2.0 Endpoints
# ---------------------------------------------------------------------------

@app.get("/api/auth/linkedin/connect")
def connect_linkedin(
    accountId: Optional[str] = None,
    redirect: bool = False,
    db: Session = Depends(get_db),
):
    """
    Generates official LinkedIn OAuth 2.0 authorization URL.
    Optionally redirects browser directly.
    """
    auth_url, state = oauth_service.build_authorization_url(accountId)
    if redirect:
        return RedirectResponse(auth_url)
    return {"success": True, "authUrl": auth_url, "state": state}


@app.get("/api/auth/linkedin/callback")
def linkedin_callback(
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
    error_description: Optional[str] = None,
    db: Session = Depends(get_db),
):
    """
    Handles LinkedIn OAuth 2.0 authorization callback.
    Exchanges code for tokens, retrieves user profile, encrypts tokens, and stores account.
    """
    frontend_base = os.getenv("FRONTEND_BASE_URL", "http://localhost:3000")

    if error:
        err_msg = error_description or error or "LinkedIn authorization rejected"
        return RedirectResponse(f"{frontend_base}/?tab=accounts&auth_error={urllib.parse.quote(err_msg)}")

    if not code:
        return RedirectResponse(f"{frontend_base}/?tab=accounts&auth_error=No_authorization_code_received")

    try:
        tokens = oauth_service.exchange_code_for_tokens(code)
        access_token = tokens.get("access_token")
        refresh_token = tokens.get("refresh_token")
        expires_in = tokens.get("expires_in", 5184000)
        scope = tokens.get("scope", "")

        userinfo = oauth_service.fetch_userinfo(access_token)
        email = userinfo.get("email") or f"{userinfo.get('sub', 'member')}@linkedin.oauth"
        name = userinfo.get("name") or f"{userinfo.get('given_name', '')} {userinfo.get('family_name', '')}".strip()
        linkedin_id = userinfo.get("sub")
        picture = userinfo.get("picture")

        # Parse target account id if passed in state
        account_id = None
        if state and ":" in state:
            possible_id = state.split(":")[0]
            if possible_id != "new":
                account_id = possible_id

        account = None
        if account_id:
            account = db.query(LinkedInAccount).filter(LinkedInAccount.id == account_id).first()
        if not account and email:
            account = db.query(LinkedInAccount).filter(LinkedInAccount.email == email).first()

        if not account:
            account = LinkedInAccount(
                id=str(uuid4()),
                email=email,
                name=name,
                linkedinId=linkedin_id,
                avatarUrl=picture,
                authType="OAUTH2",
                authStatus="CONNECTED",
                status="ACTIVE",
                encryptedAccessToken=encrypt_token(access_token),
                encryptedRefreshToken=encrypt_token(refresh_token) if refresh_token else None,
                tokenExpiresAt=datetime.utcnow() + timedelta(seconds=expires_in),
                tokenScope=scope,
                oauthState=state,
            )
            db.add(account)
        else:
            if name:
                account.name = name
            if linkedin_id:
                account.linkedinId = linkedin_id
            if picture:
                account.avatarUrl = picture
            account.authType = "OAUTH2"
            account.authStatus = "CONNECTED"
            account.status = "ACTIVE"
            account.encryptedAccessToken = encrypt_token(access_token)
            if refresh_token:
                account.encryptedRefreshToken = encrypt_token(refresh_token)
            account.tokenExpiresAt = datetime.utcnow() + timedelta(seconds=expires_in)
            account.tokenScope = scope
            account.oauthState = state

        db.commit()
        return RedirectResponse(f"{frontend_base}/?tab=accounts&connected=1")

    except Exception as exc:
        return RedirectResponse(f"{frontend_base}/?tab=accounts&auth_error={urllib.parse.quote(str(exc))}")


@app.post("/api/auth/linkedin/disconnect")
def disconnect_account(body: DisconnectRequest, db: Session = Depends(get_db)):
    """Safely revokes server-stored tokens and resets account to NOT_CONNECTED."""
    account = db.query(LinkedInAccount).filter(LinkedInAccount.id == body.accountId).first()
    if not account:
        raise HTTPException(status_code=404, detail=f"LinkedInAccount '{body.accountId}' not found")

    account.encryptedAccessToken = None
    account.encryptedRefreshToken = None
    account.tokenExpiresAt = None
    account.tokenScope = None
    account.authStatus = "NOT_CONNECTED"
    db.commit()
    return {"success": True, "message": "LinkedIn account disconnected successfully"}


@app.post("/api/auth/linkedin/reconnect")
def reconnect_account(body: ReconnectRequest, db: Session = Depends(get_db)):
    """Initiates a fresh authorization flow for an account."""
    account = db.query(LinkedInAccount).filter(LinkedInAccount.id == body.accountId).first()
    if not account:
        raise HTTPException(status_code=404, detail=f"LinkedInAccount '{body.accountId}' not found")

    auth_url, state = oauth_service.build_authorization_url(account.id)
    return {"success": True, "authUrl": auth_url, "state": state}


# ---------------------------------------------------------------------------
# Account Management Endpoints (Credentials Protected & Never Exposing Cookies)
# ---------------------------------------------------------------------------

@app.get("/api/accounts")
def list_accounts(db: Session = Depends(get_db)):
    accounts = db.query(LinkedInAccount).order_by(LinkedInAccount.createdAt.asc()).all()
    data = []
    for a in accounts:
        auth_status = a.authStatus or "NOT_CONNECTED"

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
            "authType": a.authType or "OAUTH2",
            "authStatus": auth_status,
            "hasAuthorizedSession": (auth_status == "CONNECTED"),
            "avatarUrl": a.avatarUrl,
            "tokenScope": a.tokenScope,
            "tokenExpiresAt": a.tokenExpiresAt.isoformat() if a.tokenExpiresAt else None,
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
def create_account(body: CreateAccountRequest, db: Session = Depends(get_db)):
    """Registers or updates a LinkedIn account profile ready for OAuth connection."""
    account = db.query(LinkedInAccount).filter(LinkedInAccount.email == body.email).first()
    if not account:
        account = LinkedInAccount(
            id=f"acc_{uuid4().hex[:12]}",
            email=body.email,
            name=body.name,
            authType="OAUTH2",
            authStatus="NOT_CONNECTED",
            status="ACTIVE",
        )
        db.add(account)
    else:
        if body.name:
            account.name = body.name
    db.commit()
    db.refresh(account)

    auth_url, state = oauth_service.build_authorization_url(account.id)
    return {
        "success": True,
        "data": {
            "id": account.id,
            "email": account.email,
            "name": account.name,
            "authStatus": account.authStatus or "NOT_CONNECTED",
            "authType": account.authType,
        },
        "authUrl": auth_url,
    }


# ---------------------------------------------------------------------------
# Job Dispatch & Synchronization (Strict Pre-flight Authorization Enforcement)
# ---------------------------------------------------------------------------

@app.post("/api/jobs/dispatch")
def dispatch_job(body: JobDispatchRequest, db: Session = Depends(get_db)):
    account = db.query(LinkedInAccount).filter(LinkedInAccount.id == body.accountId).first()
    if not account:
        raise HTTPException(
            status_code=404,
            detail=f"LinkedIn account is not authorized for this operation. Account '{body.accountId}' not found.",
        )

    # Strict pre-flight authorization check
    auth_res = validate_account_auth(db, account, operation=body.type)
    if not auth_res.valid:
        raise HTTPException(
            status_code=400,
            detail=auth_res.reason or "LinkedIn account is not authorized for this operation.",
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


@app.get("/api/conversations")
def list_conversations(
    accountId: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=100),
    db: Session = Depends(get_db),
):
    query = db.query(Conversation)
    if accountId:
        query = query.filter(Conversation.accountId == accountId)
    conversations = query.order_by(desc(Conversation.lastActivityAt)).limit(limit).all()

    data = []
    for c in conversations:
        partner_name = None
        for pid in (c.participantIds or []):
            if pid != c.accountId and not pid.startswith("acc_"):
                partner_name = pid
                break
        if not partner_name:
            partner_name = c.remoteConversationId[:16]

        msg_count = db.query(ChatMessage).filter(ChatMessage.conversationId == c.id).count()

        data.append({
            "id": c.id,
            "accountId": c.accountId,
            "remoteConversationId": c.remoteConversationId,
            "partnerName": partner_name,
            "participantIds": c.participantIds or [],
            "lastMessageSnippet": c.lastMessageSnippet or "No messages yet",
            "lastActivityAt": c.lastActivityAt.isoformat() if c.lastActivityAt else None,
            "messagesCount": msg_count,
        })

    return {"success": True, "data": data, "timestamp": datetime.utcnow().isoformat()}


@app.get("/api/messages")
def list_messages(
    accountId: Optional[str] = Query(None),
    conversationId: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=500),
    db: Session = Depends(get_db),
):
    query = db.query(ChatMessage)
    if accountId:
        query = query.filter(ChatMessage.accountId == accountId)
    if conversationId:
        conv = (
            db.query(Conversation)
            .filter(
                (Conversation.id == conversationId) | (Conversation.remoteConversationId == conversationId)
            )
            .first()
        )
        if conv:
            query = query.filter(ChatMessage.conversationId == conv.id)
        else:
            query = query.filter(ChatMessage.conversationId == conversationId)

    msgs = query.order_by(ChatMessage.sentAt.asc()).limit(limit).all()
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
        raise HTTPException(
            status_code=404,
            detail=f"LinkedIn account is not authorized for this operation. Account '{body.accountId}' not found.",
        )

    # Strict pre-flight authorization check
    auth_res = validate_account_auth(db, account, operation="SYNC_MESSAGES")
    if not auth_res.valid:
        raise HTTPException(
            status_code=400,
            detail=auth_res.reason or "LinkedIn account is not authorized for this operation.",
        )

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

    elif action == "CLEAR_JOBS":
        db.query(DeadLetterQueue).delete()
        db.query(AutomationJob).delete()
        db.commit()
        return {"success": True, "message": "All automation jobs and DLQ records cleared"}

    else:
        raise HTTPException(status_code=400, detail=f"Unsupported maintenance action: '{action}'")
