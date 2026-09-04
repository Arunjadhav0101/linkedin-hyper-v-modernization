from datetime import datetime
from uuid import uuid4
from sqlalchemy import (
    Column,
    String,
    Integer,
    Boolean,
    DateTime,
    Text,
    ForeignKey,
    JSON,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


class LinkedInAccount(Base):
    __tablename__ = "LinkedInAccount"

    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    email = Column(String, unique=True, nullable=False, index=True)
    linkedinId = Column(String, unique=True, nullable=True)
    publicIdentifier = Column(String, nullable=True)
    name = Column(String, nullable=True)
    status = Column(String, default="ACTIVE", index=True)
    proxySessionId = Column(String, nullable=True)
    assignedProxyId = Column(String, nullable=True)
    cookies = Column(JSON, nullable=True)
    warmupStartDate = Column(DateTime, default=datetime.utcnow)
    isWarmedUp = Column(Boolean, default=False)

    # Action limits
    hourlyActionLimit = Column(Integer, default=15)
    dailyActionLimit = Column(Integer, default=60)
    hourlyConnectionLimit = Column(Integer, default=5)
    dailyConnectionLimit = Column(Integer, default=20)
    hourlyMessageLimit = Column(Integer, default=10)
    dailyMessageLimit = Column(Integer, default=40)

    lastActionTimestamp = Column(DateTime, nullable=True)
    createdAt = Column(DateTime, default=datetime.utcnow)
    updatedAt = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    jobs = relationship("AutomationJob", back_populates="account", cascade="all, delete-orphan")
    conversations = relationship("Conversation", back_populates="account", cascade="all, delete-orphan")
    messages = relationship("ChatMessage", back_populates="account", cascade="all, delete-orphan")


class AutomationJob(Base):
    __tablename__ = "AutomationJob"

    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    traceId = Column(String, nullable=False, index=True)
    accountId = Column(String, ForeignKey("LinkedInAccount.id", ondelete="CASCADE"), nullable=False, index=True)
    type = Column(String, nullable=False)
    payload = Column(JSON, nullable=False)
    priority = Column(Integer, default=0)
    retryCount = Column(Integer, default=0)
    maxRetries = Column(Integer, default=5)
    status = Column(String, default="QUEUED", index=True)
    scheduledFor = Column(DateTime, default=datetime.utcnow, index=True)
    startedAt = Column(DateTime, nullable=True)
    completedAt = Column(DateTime, nullable=True)
    errorMessage = Column(Text, nullable=True)
    createdAt = Column(DateTime, default=datetime.utcnow)
    updatedAt = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    account = relationship("LinkedInAccount", back_populates="jobs")


class Conversation(Base):
    __tablename__ = "Conversation"

    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    accountId = Column(String, ForeignKey("LinkedInAccount.id", ondelete="CASCADE"), nullable=False, index=True)
    remoteConversationId = Column(String, nullable=False)
    participantIds = Column(ARRAY(String), default=list)
    lastMessageSnippet = Column(String, nullable=True)
    lastActivityAt = Column(DateTime, default=datetime.utcnow)
    createdAt = Column(DateTime, default=datetime.utcnow)
    updatedAt = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    account = relationship("LinkedInAccount", back_populates="conversations")
    messages = relationship("ChatMessage", back_populates="conversation", cascade="all, delete-orphan")


class ChatMessage(Base):
    __tablename__ = "ChatMessage"

    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    accountId = Column(String, ForeignKey("LinkedInAccount.id", ondelete="CASCADE"), nullable=False, index=True)
    conversationId = Column(String, ForeignKey("Conversation.id", ondelete="CASCADE"), nullable=False, index=True)
    remoteMessageId = Column(String, nullable=False)
    senderId = Column(String, nullable=False)
    senderName = Column(String, nullable=True)
    recipientId = Column(String, nullable=False)
    recipientName = Column(String, nullable=True)
    content = Column(Text, nullable=False)
    direction = Column(String, nullable=False)  # 'INBOUND' / 'OUTBOUND'
    idempotencyKey = Column(String, unique=True, nullable=False, index=True)
    syncStatus = Column(String, default="SYNCED", index=True)
    sentAt = Column(DateTime, nullable=False)
    syncedAt = Column(DateTime, default=datetime.utcnow)

    account = relationship("LinkedInAccount", back_populates="messages")
    conversation = relationship("Conversation", back_populates="messages")


class DeadLetterQueue(Base):
    __tablename__ = "DeadLetterQueue"

    id = Column(String, primary_key=True, default=lambda: str(uuid4()))
    originalEventId = Column(String, nullable=False)
    traceId = Column(String, nullable=False)
    eventName = Column(String, nullable=False)
    accountId = Column(String, ForeignKey("LinkedInAccount.id", ondelete="CASCADE"), nullable=False)
    payload = Column(JSON, nullable=False)
    errorName = Column(String, default="AutomationError")
    errorMessage = Column(Text, nullable=False)
    retryCount = Column(Integer, default=0)
    routedAt = Column(DateTime, default=datetime.utcnow)
