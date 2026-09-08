import os
import secrets
import urllib.parse
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Dict, Any, Optional, Tuple, Union
import httpx
from sqlalchemy.orm import Session

from uuid import uuid4
from .models import LinkedInAccount, SystemConfig
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

    def get_client_credentials(self, db: Optional[Session] = None) -> Tuple[str, str, str]:
        """
        Resolves (client_id, client_secret, redirect_uri).
        Prefers database SystemConfig if available, falling back to environment variables / instance attributes.
        """
        client_id = self.client_id or ""
        client_secret = self.client_secret or ""
        redirect_uri = self.redirect_uri or "http://localhost:8088/api/auth/linkedin/callback"

        if db:
            try:
                cfg_id = db.query(SystemConfig).filter(SystemConfig.key == "LINKEDIN_CLIENT_ID").first()
                if cfg_id and cfg_id.value and cfg_id.value.strip():
                    client_id = cfg_id.value.strip()

                cfg_sec = db.query(SystemConfig).filter(SystemConfig.key == "LINKEDIN_CLIENT_SECRET").first()
                if cfg_sec and cfg_sec.value and cfg_sec.value.strip():
                    if cfg_sec.isEncrypted:
                        dec = decrypt_token(cfg_sec.value)
                        if dec:
                            client_secret = dec
                    else:
                        client_secret = cfg_sec.value.strip()

                cfg_red = db.query(SystemConfig).filter(SystemConfig.key == "LINKEDIN_REDIRECT_URI").first()
                if cfg_red and cfg_red.value and cfg_red.value.strip():
                    redirect_uri = cfg_red.value.strip()
            except Exception:
                pass

        return client_id, client_secret, redirect_uri

    def get_config(self, db: Optional[Session] = None) -> Dict[str, Any]:
        """
        Returns sanitized configuration state for frontend and health checks.
        Never exposes the secret in plaintext.
        """
        client_id, client_secret, redirect_uri = self.get_client_credentials(db)
        is_cfg = bool(client_id and client_id not in ("CONFIG_REQUIRED", "", "[NOT_CONFIGURED]"))
        has_secret = bool(client_secret and client_secret not in ("CONFIG_REQUIRED", "", "[NOT_CONFIGURED]"))

        return {
            "configured": is_cfg and has_secret,
            "clientId": client_id if is_cfg else None,
            "hasSecret": has_secret,
            "redirectUri": redirect_uri,
            "scopes": self.scopes,
        }

    def is_configured(self, db: Optional[Session] = None) -> bool:
        client_id, _, _ = self.get_client_credentials(db)
        return bool(client_id and client_id not in ("CONFIG_REQUIRED", "", "[NOT_CONFIGURED]"))

    def save_config(
        self,
        db: Session,
        client_id: str,
        client_secret: Optional[str] = None,
        redirect_uri: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Saves OAuth app configuration into SystemConfig with AES-256 encrypted secret.
        """
        clean_id = client_id.strip() if client_id else ""
        if clean_id:
            cfg_id = db.query(SystemConfig).filter(SystemConfig.key == "LINKEDIN_CLIENT_ID").first()
            if not cfg_id:
                cfg_id = SystemConfig(key="LINKEDIN_CLIENT_ID", value=clean_id, isEncrypted=False)
                db.add(cfg_id)
            else:
                cfg_id.value = clean_id
            self.client_id = clean_id

        if client_secret and client_secret.strip():
            clean_secret = client_secret.strip()
            enc_secret = encrypt_token(clean_secret)
            cfg_sec = db.query(SystemConfig).filter(SystemConfig.key == "LINKEDIN_CLIENT_SECRET").first()
            if not cfg_sec:
                cfg_sec = SystemConfig(key="LINKEDIN_CLIENT_SECRET", value=enc_secret, isEncrypted=True)
                db.add(cfg_sec)
            else:
                cfg_sec.value = enc_secret
                cfg_sec.isEncrypted = True
            self.client_secret = clean_secret

        if redirect_uri and redirect_uri.strip():
            clean_uri = redirect_uri.strip()
            cfg_red = db.query(SystemConfig).filter(SystemConfig.key == "LINKEDIN_REDIRECT_URI").first()
            if not cfg_red:
                cfg_red = SystemConfig(key="LINKEDIN_REDIRECT_URI", value=clean_uri, isEncrypted=False)
                db.add(cfg_red)
            else:
                cfg_red.value = clean_uri
            self.redirect_uri = clean_uri

        db.commit()
        return self.get_config(db)

    def build_authorization_url(
        self,
        account_id: Optional[str] = None,
        db: Optional[Session] = None,
    ) -> Tuple[str, str]:
        """
        Builds the official LinkedIn OAuth 2.0 authorization URL.
        Guarantees that unconfigured / placeholder client IDs are rejected before reaching LinkedIn.
        Returns: (authorization_url, state)
        """
        client_id, _, redirect_uri = self.get_client_credentials(db)
        if not client_id or client_id in ("CONFIG_REQUIRED", "", "[NOT_CONFIGURED]"):
            raise ValueError(
                "LinkedIn Developer App Client ID is not configured. "
                "Please configure your Client ID and Client Secret in App Settings."
            )

        nonce = secrets.token_urlsafe(16)
        state_payload = f"{account_id or 'new'}:{nonce}"

        params = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "state": state_payload,
            "scope": self.scopes,
        }
        query_string = urllib.parse.urlencode(params)
        auth_url = f"{self.AUTH_URL}?{query_string}"
        return auth_url, state_payload

    def exchange_code_for_tokens(self, code: str, db: Optional[Session] = None) -> Dict[str, Any]:
        """
        Exchanges authorization code for access and refresh tokens.
        """
        client_id, client_secret, redirect_uri = self.get_client_credentials(db)
        if not client_id or not client_secret:
            raise ValueError(
                "LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET must be configured in server environment or database."
            )

        payload = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": redirect_uri,
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
                try:
                    err_json = resp.json()
                    err_detail = err_json.get("message") or err_json.get("error_description") or f"HTTP {resp.status_code}"
                except Exception:
                    err_detail = f"HTTP {resp.status_code}"
                raise ValueError(f"Failed to fetch user profile from LinkedIn ({err_detail})")
            return resp.json()

    def direct_token_auth(
        self,
        db: Session,
        account_id: Optional[str],
        raw_token: str,
    ) -> LinkedInAccount:
        """
        Directly authorizes an account with a developer OAuth 2.0 Bearer token.
        Validates token against LinkedIn userinfo endpoint, retrieves identity,
        and saves token encrypted with AES-256.
        """
        clean_token = raw_token.strip()
        if not clean_token:
            raise ValueError("LinkedIn OAuth Access Token cannot be empty.")

        # Validate with LinkedIn API
        userinfo = self.fetch_userinfo(clean_token)
        email = userinfo.get("email") or f"{userinfo.get('sub', 'member')}@linkedin.oauth"
        name = userinfo.get("name") or f"{userinfo.get('given_name', '')} {userinfo.get('family_name', '')}".strip()
        linkedin_id = userinfo.get("sub")
        picture = userinfo.get("picture")

        account = None
        if account_id:
            account = db.query(LinkedInAccount).filter(LinkedInAccount.id == account_id).first()
        if not account and linkedin_id:
            account = db.query(LinkedInAccount).filter(LinkedInAccount.linkedinId == linkedin_id).first()
        if not account and email:
            account = db.query(LinkedInAccount).filter(LinkedInAccount.email == email).first()


        encrypted_tok = encrypt_token(clean_token)
        expires_at = datetime.utcnow() + timedelta(days=60)

        if not account:
            account = LinkedInAccount(
                id=str(uuid4()),
                email=email,
                name=name or "LinkedIn Member",
                linkedinId=linkedin_id,
                avatarUrl=picture,
                authType="OAUTH2",
                authStatus="CONNECTED",
                status="ACTIVE",
                encryptedAccessToken=encrypted_tok,
                tokenExpiresAt=expires_at,
                tokenScope="openid profile email",
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
            account.encryptedAccessToken = encrypted_tok
            account.tokenExpiresAt = expires_at
            account.tokenScope = "openid profile email"

        db.commit()
        db.refresh(account)
        return account

    def refresh_access_token(self, db: Session, account: LinkedInAccount) -> bool:
        """
        Refreshes an expired access token using stored encrypted refresh token.
        """
        if not account.encryptedRefreshToken:
            return False

        refresh_token = decrypt_token(account.encryptedRefreshToken)
        if not refresh_token:
            return False

        client_id, client_secret, redirect_uri = self.get_client_credentials(db)
        if not client_id or not client_secret:
            return False

        payload = {
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
            "client_secret": client_secret,
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
