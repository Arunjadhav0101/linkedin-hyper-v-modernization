from dataclasses import dataclass
from typing import Optional, Union
from sqlalchemy.orm import Session
from .models import LinkedInAccount
from .voyager import VoyagerClient, VoyagerApiError, MissingIntegrationError


@dataclass
class AccountValidationResult:
    valid: bool
    status: str  # "AUTHORIZED" | "SESSION_INVALID" | "NOT_CONFIGURED" | "DISABLED"
    reason: Optional[str] = None
    account: Optional[LinkedInAccount] = None


def validate_account(
    db: Session,
    account_or_id: Union[str, LinkedInAccount],
    force_live_check: bool = False,
    voyager_client: Optional[VoyagerClient] = None,
) -> AccountValidationResult:
    """
    Centralized, canonical session validation service for LinkedIn accounts.
    Enforces lifecycle states: NOT_CONFIGURED, AUTHORIZED, SESSION_INVALID, DISABLED.
    Uniformly utilized by:
      - API dispatch route (/api/jobs/dispatch)
      - API sync route (/api/sync)
      - Worker pre-flight execution check (worker.py)
      - Account listing and status probes (/api/accounts, /health)
    """
    if isinstance(account_or_id, LinkedInAccount):
        account = account_or_id
    else:
        account = db.query(LinkedInAccount).filter(LinkedInAccount.id == str(account_or_id)).first()

    if not account:
        return AccountValidationResult(
            valid=False,
            status="NOT_CONFIGURED",
            reason=f"Account '{account_or_id}' was not found in the system.",
            account=None,
        )

    # 1. Disabled Check
    if account.status == "DISABLED":
        return AccountValidationResult(
            valid=False,
            status="DISABLED",
            reason=f"Account '{account.email}' is currently disabled.",
            account=account,
        )

    cookies = account.cookies or {}
    li_at = (cookies.get("li_at") or "").strip().strip('"\'')

    # 2. Not Configured Check (missing cookie)
    if not li_at:
        return AccountValidationResult(
            valid=False,
            status="NOT_CONFIGURED",
            reason="Missing required 'li_at' session cookie. Please configure credentials in Accounts & Cookies.",
            account=account,
        )

    # 3. Malformed / Placeholder Token Check
    if len(li_at) < 50:
        if account.status != "SESSION_INVALID":
            account.status = "SESSION_INVALID"
            db.commit()
        return AccountValidationResult(
            valid=False,
            status="SESSION_INVALID",
            reason=(
                f"Invalid 'li_at' cookie format ({len(li_at)} characters). "
                "Real LinkedIn session cookies are ~150 characters starting with 'AQED...'."
            ),
            account=account,
        )

    # 4. Previously Flagged Session Invalid (fast-fail unless forced live check)
    if account.status == "SESSION_INVALID" and not force_live_check:
        return AccountValidationResult(
            valid=False,
            status="SESSION_INVALID",
            reason=(
                "LinkedIn session was previously invalidated or rejected by LinkedIn auth servers (401/302). "
                "Please update your session cookies in Accounts & Cookies."
            ),
            account=account,
        )

    # 5. Live Check with LinkedIn Voyager API (if forced)
    if force_live_check:
        client = voyager_client or VoyagerClient()
        try:
            res = client.verify_session(account)
            account.status = "ACTIVE"
            if res.get("publicIdentifier"):
                account.publicIdentifier = res["publicIdentifier"]
            if res.get("plainId"):
                account.linkedinId = str(res["plainId"])
            db.commit()
            return AccountValidationResult(
                valid=True,
                status="AUTHORIZED",
                reason="LinkedIn session verified successfully with LinkedIn servers.",
                account=account,
            )
        except VoyagerApiError as exc:
            if exc.status_code in (401, 302):
                account.status = "SESSION_INVALID"
                db.commit()
                return AccountValidationResult(
                    valid=False,
                    status="SESSION_INVALID",
                    reason=f"LinkedIn session rejected by remote auth server (HTTP {exc.status_code}): {exc.message}",
                    account=account,
                )
            elif exc.status_code == 403:
                account.status = "SESSION_INVALID"
                db.commit()
                return AccountValidationResult(
                    valid=False,
                    status="SESSION_INVALID",
                    reason=f"LinkedIn checkpoint or challenge required (HTTP 403): {exc.message}",
                    account=account,
                )
            else:
                return AccountValidationResult(
                    valid=False,
                    status=account.status,
                    reason=f"Remote LinkedIn communication failed (HTTP {exc.status_code}): {exc.message}",
                    account=account,
                )
        except Exception as exc:
            return AccountValidationResult(
                valid=False,
                status=account.status,
                reason=f"Failed to verify session: {str(exc)}",
                account=account,
            )

    # 6. Default Authorized State
    return AccountValidationResult(
        valid=True,
        status="AUTHORIZED",
        reason="Session cookie configured and valid.",
        account=account,
    )
