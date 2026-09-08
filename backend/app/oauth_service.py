import os
import secrets
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Tuple, Union
import httpx
from sqlalchemy.orm import Session

from .models import LinkedInAccount
from .crypto import encrypt_token, decrypt_token, redact_token

LINKEDIN_CLIENT_ID = os.getenv("LINKEDIN_CLIENT_ID", "")
LINKEDIN_CLIENT_SECRET = os.getenv("LINKEDIN_CLIENT_SECRET", "")
LINKEDIN_REDIRECT_URI = os.getenv(
    "LINKEDIN_REDIRECT_URI",
    "http://localhost:8088/api/auth/linkedin/callback",
)
LINKEDIN_OAUTH_SCOPES = os.getenv(
    "LINKEDIN_OAUTH_SCOPES",
    "openid profile email w_member_social",
)


@dataclass
class AccountAuthResult:
    valid: bool
    auth_status: str  # "CONNECTED" | "NOT_CONNECTED" | "AUTHORIZATION_EXPIRED" | "ERROR"
    reason: Optional[str] = None
    account: Optional[LinkedInAccount] = None
    decrypted_token: Optional[str] = None


class LinkedInOAuthService:
    AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization"
    TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken"
    USERINFO_URL = "https://api.linkedin.com/v2/userinfo"

    def __init__(
        self,
        client_id: Optional[str] = None,
        client_secret: Optional[str] = None,
        redirect_uri: Optional[str] = None,
        scopes: Optional[str] = None,
    ):
        self.client_id = client_id or LINKEDIN_CLIENT_ID
        self.client_secret = client_secret or LINKEDIN_CLIENT_SECRET
        self.redirect_uri = redirect_uri or LINKEDIN_REDIRECT_URI
        self.scopes = scopes or LINKEDIN_OAUTH_SCOPES

    def build_authorization_url(self, account_id: Optional[str] = None) -> Tuple[str, str]:
        """
        Builds the official LinkedIn OAuth 2.0 authorization URL.
        Returns: (authorization_url, state)
        """
        nonce = secrets.token_urlsafe(16)
        state_payload = f"{account_id or 'new'}:{nonce}"

        params = {
            "response_type": "code",
            "client_id": self.client_id or "CONFIG_REQUIRED",
            "redirect_uri": self.redirect_uri,
            "state": state_payload,
            "scope": self.scopes,
        }
        query_string = urllib.parse.urlencode(params)
        auth_url = f"{self.AUTH_URL}?{query_string}"
        return auth_url, state_payload

    def exchange_code_for_tokens(self, code: str) -> Dict[str, Any]:
        """
        Exchanges authorization code for access and refresh tokens.
        """
        if not self.client_id or not self.client_secret:
            raise ValueError(
                "LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be configured in server environment."
            )

        payload = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri,
        }

        with httpx.Client(timeout=20.0) as client:
            resp = client.post(
                self.TOKEN_URL,
                data=payload,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )

            if resp.status_code != 200:
                try:
                    err_data = resp.json()
                    err_msg = err_data.get("error_description") or err_data.get("error") or f"HTTP {resp.status_code}"
                except Exception:
                    err_msg = f"HTTP {resp.status_code}"
                raise ValueError(f"LinkedIn token exchange failed: {err_msg}")

            return resp.json()

    def fetch_userinfo(self, access_token: str) -> Dict[str, Any]:
        """
        Retrieves authenticated user profile using official OpenID Connect userinfo endpoint.
        """
        with httpx.Client(timeout=15.0) as client:
            resp = client.get(
                self.USERINFO_URL,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if resp.status_code != 200:
                raise ValueError(f"Failed to fetch userinfo from LinkedIn (HTTP {resp.status_code})")
            return resp.json()

    def refresh_access_token(self, db: Session, account: LinkedInAccount) -> bool:
        """
        Refreshes an expired access token using stored encrypted refresh token.
        """
        if not account.encryptedRefreshToken:
            return False

        refresh_token = decrypt_token(account.encryptedRefreshToken)
        if not refresh_token:
            return False

        if not self.client_id or not self.client_secret:
            return False

        payload = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }

        try:
            with httpx.Client(timeout=20.0) as client:
                resp = client.post(
                    self.TOKEN_URL,
                    data=payload,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    new_access_token = data.get("access_token")
                    expires_in = data.get("expires_in", 5184000)
                    account.encryptedAccessToken = encrypt_token(new_access_token)
                    account.tokenExpiresAt = datetime.utcnow() + timedelta(seconds=expires_in)
                    account.authStatus = "CONNECTED"
                    account.status = "ACTIVE"
                    db.commit()
                    return True
        except Exception:
            pass

        account.authStatus = "AUTHORIZATION_EXPIRED"
        db.commit()
        return False


oauth_service = LinkedInOAuthService()


def validate_account_auth(
    db: Session,
    account_or_id: Union[str, LinkedInAccount],
    operation: Optional[str] = None,
) -> AccountAuthResult:
    """
    Validates that an account possesses active, valid, official LinkedIn authorization.
    Enforces canonical lifecycle states:
      - CONNECTED
      - NOT_CONNECTED
      - AUTHORIZATION_EXPIRED
      - ERROR
    Returns 'LinkedIn account is not authorized for this operation.' whenever invalid.
    """
    if isinstance(account_or_id, LinkedInAccount):
        account = account_or_id
    else:
        account = db.query(LinkedInAccount).filter(LinkedInAccount.id == str(account_or_id)).first()

    if not account:
        return AccountAuthResult(
            valid=False,
            auth_status="NOT_CONNECTED",
            reason="LinkedIn account is not authorized for this operation.",
            account=None,
        )

    # 1. Check if OAuth access token exists or explicitly not connected
    if not account.encryptedAccessToken or account.authStatus == "NOT_CONNECTED":
        return AccountAuthResult(
            valid=False,
            auth_status="NOT_CONNECTED",
            reason="LinkedIn account is not authorized for this operation.",
            account=account,
        )

    # 2. Check for explicit error status
    if account.authStatus == "ERROR":
        return AccountAuthResult(
            valid=False,
            auth_status="ERROR",
            reason="LinkedIn account is not authorized for this operation.",
            account=account,
        )

    # 3. Attempt Decrypt
    decrypted_token = decrypt_token(account.encryptedAccessToken)
    if not decrypted_token:
        account.authStatus = "ERROR"
        db.commit()
        return AccountAuthResult(
            valid=False,
            auth_status="ERROR",
            reason="LinkedIn account is not authorized for this operation.",
            account=account,
        )

    # 4. Expiration Check & Auto-Refresh
    if (account.tokenExpiresAt and account.tokenExpiresAt <= datetime.utcnow()) or account.authStatus == "AUTHORIZATION_EXPIRED":
        refreshed = oauth_service.refresh_access_token(db, account)
        if not refreshed:
            account.authStatus = "AUTHORIZATION_EXPIRED"
            db.commit()
            return AccountAuthResult(
                valid=False,
                auth_status="AUTHORIZATION_EXPIRED",
                reason="LinkedIn account is not authorized for this operation. Authorization has expired.",
                account=account,
            )
        decrypted_token = decrypt_token(account.encryptedAccessToken)

    # 5. Scope & Capability Assessment for Official API
    # Standard OpenID/Consumer scopes: openid profile email w_member_social
    # Personal DMs and 1-on-1 invitations are not part of LinkedIn's public Consumer API.
    if operation in ("SEND_MESSAGE", "SEND_CONNECTION_REQUEST", "SYNC_MESSAGES"):
        scope_str = account.tokenScope or ""
        # Check if an enterprise partner messaging scope is present
        has_partner_messaging = any(
            s in scope_str for s in ("r_messages", "w_messages", "community_management")
        )
        if not has_partner_messaging:
            return AccountAuthResult(
                valid=False,
                auth_status="CONNECTED",
                reason=(
                    f"LinkedIn account is not authorized for this operation. "
                    f"Operation '{operation}' requires LinkedIn Enterprise Partner API approval and messaging scopes."
                ),
                account=account,
                decrypted_token=decrypted_token,
            )

    account.authStatus = "CONNECTED"
    return AccountAuthResult(
        valid=True,
        auth_status="CONNECTED",
        reason="Account is actively authorized via official LinkedIn OAuth 2.0.",
        account=account,
        decrypted_token=decrypted_token,
    )
