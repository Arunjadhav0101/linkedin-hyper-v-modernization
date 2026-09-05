import asyncio
import hashlib
import json
import logging
import os
import random
from datetime import datetime, timedelta
from typing import Optional
import redis
from sqlalchemy import or_, and_
from sqlalchemy.orm import Session

from .database import get_db_context
from .models import LinkedInAccount, AutomationJob, Conversation, ChatMessage, DeadLetterQueue
from .voyager import VoyagerClient, VoyagerApiError, MissingIntegrationError, ValidationError

logger = logging.getLogger("hyperv.worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379/0")

try:
    redis_client = redis.Redis.from_url(REDIS_URL, decode_responses=True)
    redis_client.ping()
    logger.info("Connected to Redis for distributed locking")
except Exception:
    redis_client = None
    logger.warning("Redis not available; proceeding with in-process lock fallback")


class JobProcessor:
    def __init__(self):
        self.voyager = VoyagerClient()

    @staticmethod
    def is_permanent_error(exc: Exception) -> bool:
        """Determines if an error is permanent (4xx / validation / config) and should NOT be retried."""
        if isinstance(exc, (MissingIntegrationError, ValidationError)):
            return True
        if isinstance(exc, VoyagerApiError):
            if 400 <= exc.status_code < 500:
                return True
        return False

    def acquire_lock(self, account_id: str, timeout_sec: int = 30) -> bool:
        if not redis_client:
            return True
        try:
            return bool(redis_client.set(f"lock:account:{account_id}", "locked", ex=timeout_sec, nx=True))
        except Exception:
            return True

    def release_lock(self, account_id: str):
        if not redis_client:
            return
        try:
            redis_client.delete(f"lock:account:{account_id}")
        except Exception:
            pass

    def cleanup_timed_out_jobs(self, db: Session):
        """Marks any RUNNING jobs older than 60 seconds as TIMED_OUT."""
        cutoff = datetime.utcnow() - timedelta(seconds=60)
        timed_out = (
            db.query(AutomationJob)
            .filter(AutomationJob.status == "RUNNING", AutomationJob.startedAt < cutoff)
            .all()
        )
        for job in timed_out:
            job.status = "TIMED_OUT"
            job.errorMessage = "Job timed out after exceeding 60s processing threshold"
            job.completedAt = datetime.utcnow()
        if timed_out:
            db.commit()
            logger.warning(f"Cleaned up {len(timed_out)} stuck jobs to TIMED_OUT status")

    def execute_job(self, db: Session, job: AutomationJob):
        account = db.query(LinkedInAccount).filter(LinkedInAccount.id == job.accountId).first()
        if not account:
            job.status = "FAILED"
            job.errorMessage = f"LinkedInAccount '{job.accountId}' does not exist"
            job.completedAt = datetime.utcnow()
            db.commit()
            return

        # Pre-flight authorization check
        try:
            self.voyager.validate_session(account)
        except MissingIntegrationError as err:
            logger.warning(f"Pre-flight failed for job {job.id}: {err}")
            job.status = "FAILED"
            job.errorMessage = str(err)
            job.completedAt = datetime.utcnow()
            db.commit()
            return

        # Acquire lock
        if not self.acquire_lock(account.id):
            logger.info(f"Account {account.id} is currently locked by another task; deferring job {job.id}")
            return

        job.status = "RUNNING"
        job.startedAt = datetime.utcnow()
        db.commit()

        try:
            payload = job.payload or {}
            job_type = job.type

            if job_type == "SEND_MESSAGE":
                recipient_id = payload.get("recipientId")
                content = payload.get("content")
                conv_id = payload.get("conversationId")

                if not recipient_id or not content:
                    raise ValidationError("Missing recipientId or content in SEND_MESSAGE payload")

                res = self.voyager.send_message(account, recipient_id, content, conv_id)
                remote_msg_id = res["remoteMessageId"]
                resolved_conv_id = res["conversationId"]

                # Upsert conversation
                conv = (
                    db.query(Conversation)
                    .filter(
                        Conversation.accountId == account.id,
                        Conversation.remoteConversationId == resolved_conv_id,
                    )
                    .first()
                )
                if not conv:
                    conv = Conversation(
                        accountId=account.id,
                        remoteConversationId=resolved_conv_id,
                        participantIds=[account.id, recipient_id],
                        lastMessageSnippet=content[:100],
                    )
                    db.add(conv)
                    db.flush()
                else:
                    conv.lastMessageSnippet = content[:100]
                    conv.lastActivityAt = datetime.utcnow()

                # Idempotent ChatMessage insert
                idempotency_key = hashlib.sha256(
                    f"{account.id}:{conv.id}:{remote_msg_id}".encode()
                ).hexdigest()

                existing_msg = db.query(ChatMessage).filter(ChatMessage.idempotencyKey == idempotency_key).first()
                if not existing_msg:
                    chat_msg = ChatMessage(
                        accountId=account.id,
                        conversationId=conv.id,
                        remoteMessageId=remote_msg_id,
                        senderId=account.id,
                        senderName=account.name or account.email,
                        recipientId=recipient_id,
                        content=content,
                        direction="OUTBOUND",
                        idempotencyKey=idempotency_key,
                        syncStatus="SYNCED",
                        sentAt=datetime.utcnow(),
                    )
                    db.add(chat_msg)

                job.status = "COMPLETED"
                job.completedAt = datetime.utcnow()
                job.errorMessage = None
                logger.info(f"Job {job.id} (SEND_MESSAGE) completed successfully")

            elif job_type == "SEND_CONNECTION_REQUEST":
                target_profile_id = payload.get("targetProfileId")
                custom_note = payload.get("customNote")

                if not target_profile_id:
                    raise ValidationError("Missing targetProfileId in SEND_CONNECTION_REQUEST payload")

                res = self.voyager.send_connection_request(account, target_profile_id, custom_note)
                clean_target = self.voyager.clean_profile_identifier(target_profile_id)

                # Persist note in chat history if provided
                if custom_note and custom_note.strip():
                    conv = (
                        db.query(Conversation)
                        .filter(
                            Conversation.accountId == account.id,
                            Conversation.remoteConversationId == clean_target,
                        )
                        .first()
                    )
                    if not conv:
                        conv = Conversation(
                            accountId=account.id,
                            remoteConversationId=clean_target,
                            participantIds=[account.id, clean_target],
                            lastMessageSnippet=custom_note[:100],
                        )
                        db.add(conv)
                        db.flush()

                    idempotency_key = hashlib.sha256(
                        f"{account.id}:{clean_target}:inv_note_{datetime.utcnow().strftime('%Y%m%d')}".encode()
                    ).hexdigest()
                    if not db.query(ChatMessage).filter(ChatMessage.idempotencyKey == idempotency_key).first():
                        db.add(
                            ChatMessage(
                                accountId=account.id,
                                conversationId=conv.id,
                                remoteMessageId=f"inv_{int(datetime.utcnow().timestamp())}",
                                senderId=account.id,
                                senderName=account.name or account.email,
                                recipientId=clean_target,
                                content=custom_note,
                                direction="OUTBOUND",
                                idempotencyKey=idempotency_key,
                                syncStatus="SYNCED",
                                sentAt=datetime.utcnow(),
                            )
                        )

                job.status = "COMPLETED"
                job.completedAt = datetime.utcnow()
                job.errorMessage = None
                logger.info(f"Job {job.id} (SEND_CONNECTION_REQUEST) completed successfully")

            elif job_type == "SYNC_MESSAGES":
                limit = payload.get("limit", 20)
                conversations_data = self.voyager.fetch_conversations(account, limit=limit)
                ingested = 0

                for c_data in conversations_data:
                    c_id = c_data["conversationId"]
                    partner_name = c_data.get("partnerName") or "LinkedIn Member"
                    partner_id = c_data.get("partnerIdentifier") or c_id
                    participant_ids = c_data.get("participantIds") or [account.id, partner_id]
                    last_snippet = c_data.get("lastMessageSnippet")
                    last_activity = c_data.get("lastActivityAt") or datetime.utcnow()

                    conv = (
                        db.query(Conversation)
                        .filter(
                            Conversation.accountId == account.id,
                            Conversation.remoteConversationId == c_id,
                        )
                        .first()
                    )
                    if not conv:
                        conv = Conversation(
                            accountId=account.id,
                            remoteConversationId=c_id,
                            participantIds=participant_ids,
                            lastMessageSnippet=last_snippet,
                            lastActivityAt=last_activity,
                        )
                        db.add(conv)
                        db.flush()
                    else:
                        conv.participantIds = participant_ids
                        if last_snippet:
                            conv.lastMessageSnippet = last_snippet
                        if last_activity:
                            conv.lastActivityAt = last_activity

                    for msg in c_data.get("messages", []):
                        ev_id = msg.get("remoteMessageId")
                        content = msg.get("content")
                        sender_id = msg.get("senderId", "unknown")
                        sender_name = msg.get("senderName")
                        sent_dt = msg.get("sentAt") or datetime.utcnow()

                        if not ev_id or not content:
                            continue

                        key = hashlib.sha256(f"{account.id}:{conv.id}:{ev_id}".encode()).hexdigest()
                        if not db.query(ChatMessage).filter(ChatMessage.idempotencyKey == key).first():
                            # Determine direction
                            is_self = False
                            if account.publicIdentifier and account.publicIdentifier.lower() in sender_id.lower():
                                is_self = True
                            if account.linkedinId and account.linkedinId in sender_id:
                                is_self = True

                            direction = "OUTBOUND" if is_self else "INBOUND"
                            recipient_id = partner_id if is_self else account.id
                            recipient_name = partner_name if is_self else (account.name or account.email)

                            db.add(
                                ChatMessage(
                                    accountId=account.id,
                                    conversationId=conv.id,
                                    remoteMessageId=ev_id,
                                    senderId=sender_id,
                                    senderName=sender_name or (account.name if is_self else partner_name),
                                    recipientId=recipient_id,
                                    recipientName=recipient_name,
                                    content=content,
                                    direction=direction,
                                    idempotencyKey=key,
                                    syncStatus="SYNCED",
                                    sentAt=sent_dt,
                                )
                            )
                            ingested += 1

                job.status = "COMPLETED"
                job.completedAt = datetime.utcnow()
                job.errorMessage = None
                logger.info(f"Job {job.id} (SYNC_MESSAGES) synced {ingested} messages across {len(conversations_data)} conversations")

            else:
                raise ValidationError(f"Unknown job action type: '{job_type}'")

            db.commit()

        except Exception as exc:
            db.rollback()
            err_msg = str(exc)
            logger.error(f"Job {job.id} execution failed: {err_msg}")

            if self.is_permanent_error(exc):
                # Permanent failure: DO NOT retry blindly, terminate immediately
                job.status = "FAILED"
                job.errorMessage = err_msg
                job.completedAt = datetime.utcnow()
                if "401" in err_msg or "Unauthorized" in err_msg or isinstance(exc, MissingIntegrationError):
                    account.status = "SESSION_INVALID"
                db.commit()
                logger.warning(f"Job {job.id} marked as FAILED without retries (Permanent Error)")
            else:
                # Transient failure: retry with exponential backoff
                if job.retryCount + 1 < job.maxRetries:
                    job.retryCount += 1
                    job.status = "RETRYING"
                    job.errorMessage = err_msg
                    delay = (2 ** job.retryCount) + random.uniform(1.0, 3.0)
                    job.scheduledFor = datetime.utcnow() + timedelta(seconds=delay)
                    db.commit()
                    logger.info(f"Job {job.id} scheduled for RETRYING in {delay:.1f}s (Attempt {job.retryCount}/{job.maxRetries})")
                else:
                    job.retryCount += 1
                    job.status = "DLQ_ROUTED"
                    job.errorMessage = err_msg
                    job.completedAt = datetime.utcnow()

                    dlq = DeadLetterQueue(
                        originalEventId=job.id,
                        traceId=job.traceId,
                        eventName="AUTOMATION_JOB_FAILED",
                        accountId=account.id,
                        payload=job.payload or {},
                        errorName=type(exc).__name__,
                        errorMessage=err_msg,
                        retryCount=job.retryCount,
                    )
                    db.add(dlq)
                    db.commit()
                    logger.error(f"Job {job.id} exhausted retries and routed to DLQ")

        finally:
            self.release_lock(account.id)


async def run_worker_loop():
    """Background polling loop that continuously processes automation jobs."""
    processor = JobProcessor()
    logger.info("Background automation worker loop started")

    while True:
        try:
            with get_db_context() as db:
                processor.cleanup_timed_out_jobs(db)

                # Query next pending job
                now = datetime.utcnow()
                job = (
                    db.query(AutomationJob)
                    .filter(
                        or_(
                            AutomationJob.status == "QUEUED",
                            and_(
                                AutomationJob.status == "RETRYING",
                                AutomationJob.scheduledFor <= now,
                            ),
                        )
                    )
                    .order_by(AutomationJob.priority.desc(), AutomationJob.createdAt.asc())
                    .first()
                )

                if job:
                    processor.execute_job(db, job)

        except Exception as e:
            logger.error(f"Worker loop encountered exception: {e}")

        await asyncio.sleep(1.5)
