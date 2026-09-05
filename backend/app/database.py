import os
from contextlib import contextmanager
from uuid import uuid4
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session
from .models import Base, LinkedInAccount

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
    """Initializes tables and seeds default demo accounts if none exist."""
    try:
        from sqlalchemy import text
        with engine.connect() as conn:
            conn.execute(text('ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS \'SESSION_INVALID\';'))
            conn.commit()
    except Exception:
        pass

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
