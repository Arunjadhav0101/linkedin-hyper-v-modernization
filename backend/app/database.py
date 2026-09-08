import os
from contextlib import contextmanager
from uuid import uuid4
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from .models import Base, LinkedInAccount, SystemConfig

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgrespassword@localhost:5432/linkedin_hyper_v?sslmode=disable"
)

# Convert prisma-style query params if needed
if "schema=" in DATABASE_URL:
    DATABASE_URL = DATABASE_URL.split("?")[0]

engine = create_engine(
    DATABASE_URL,
    pool_size=10,
    max_overflow=20,
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


def get_db():
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_context():
    db: Session = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


def init_db():
    """Initializes tables, migrates schema for OAuth2 fields, and seeds defaults."""
    try:
        from sqlalchemy import text
        with engine.connect() as conn:
            conn.execute(text('ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS \'SESSION_INVALID\';'))
            # Add OAuth2 and encrypted token columns if they do not exist
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "authType" VARCHAR DEFAULT \'OAUTH2\';'))
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "authStatus" VARCHAR DEFAULT \'NOT_CONNECTED\';'))
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "encryptedAccessToken" TEXT;'))
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "encryptedRefreshToken" TEXT;'))
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "tokenExpiresAt" TIMESTAMP;'))
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "tokenScope" VARCHAR;'))
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "avatarUrl" VARCHAR;'))
            conn.execute(text('ALTER TABLE "LinkedInAccount" ADD COLUMN IF NOT EXISTS "oauthState" VARCHAR;'))
            conn.commit()
    except Exception as e:
        print(f"Schema migration note: {e}")

    Base.metadata.create_all(bind=engine)
    with get_db_context() as db:
        existing = db.query(LinkedInAccount).first()
        if not existing:
            demo1 = LinkedInAccount(
                id=str(uuid4()),
                email="enterprise-lead-1@company.com",
                name="Sarah Connor (Executive Sales)",
                status="ACTIVE",
                hourlyActionLimit=20,
                dailyActionLimit=60,
                cookies={},
            )
            demo2 = LinkedInAccount(
                id=str(uuid4()),
                email="recruiter-east@company.com",
                name="John Miller (Talent Acquisition)",
                status="ACTIVE",
                hourlyActionLimit=15,
                dailyActionLimit=40,
                cookies={},
            )
            db.add_all([demo1, demo2])
